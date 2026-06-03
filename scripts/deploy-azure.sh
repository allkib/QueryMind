#!/usr/bin/env bash
# Deploy QueryMind to Azure App Service (Azure for Students / Duke).
# Usage: ./scripts/deploy-azure.sh
# Requires: az login, .env with secrets, Docker Desktop (push to ACR).
# Azure for Students cannot use `az acr build`; local docker buildx push is used by default.
#
# Important: App Service runs linux/amd64. On Apple Silicon, plain `docker build` pushes arm64
# and the site will fail with "no matching manifest for linux/amd64".

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example and fill in secrets."
  exit 1
fi

# Duke / Azure for Students: use centralus (eastus ACR is often blocked by policy).
RESOURCE_GROUP="${RESOURCE_GROUP:-querymind-rg}"
LOCATION="${LOCATION:-centralus}"
PLAN_NAME="${PLAN_NAME:-querymind-plan}"
ACR_NAME="${ACR_NAME:-querymindacr$(openssl rand -hex 3)}"
APP_NAME="${APP_NAME:-querymind-$(openssl rand -hex 4)}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

echo "==> Subscription"
az account show --query "{name:name, id:id}" -o table

echo "==> Register providers (first time only; may take a few minutes)"
az provider register --namespace Microsoft.ContainerRegistry --wait >/dev/null 2>&1 || true
az provider register --namespace Microsoft.Web --wait >/dev/null 2>&1 || true

if az group show --name "$RESOURCE_GROUP" &>/dev/null; then
  RG_LOCATION="$(az group show --name "$RESOURCE_GROUP" --query location -o tsv)"
  echo "==> Resource group: $RESOURCE_GROUP (existing, region: $RG_LOCATION)"
else
  echo "==> Resource group: $RESOURCE_GROUP (new, region: $LOCATION)"
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" -o none
fi

echo "==> ACR: $ACR_NAME in $LOCATION"
if ! az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
  az acr create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$ACR_NAME" \
    --sku Basic \
    --location "$LOCATION" \
    --admin-enabled true
fi

ACR_LOGIN_SERVER="$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)"
ACR_ID="$(az acr show --name "$ACR_NAME" --query id -o tsv)"
IMAGE="${ACR_LOGIN_SERVER}/querymind:${IMAGE_TAG}"
# Azure CLI prepends registry URL — never pass the full ACR hostname here.
CONTAINER_IMAGE="querymind:${IMAGE_TAG}"

build_and_push_amd64() {
  az acr login --name "$ACR_NAME"
  if docker buildx version &>/dev/null; then
    docker buildx create --use --name querymindbuilder 2>/dev/null \
      || docker buildx use querymindbuilder 2>/dev/null \
      || docker buildx use default
    echo "==> buildx push linux/amd64 -> $IMAGE"
    docker buildx build --platform linux/amd64 -t "$IMAGE" --push .
  else
    echo "==> docker build --platform linux/amd64 -> $IMAGE"
    docker build --platform linux/amd64 -t "$IMAGE" .
    docker push "$IMAGE"
  fi
}

if [[ "${SKIP_IMAGE_BUILD:-}" == "1" ]]; then
  echo "==> Skipping image build (SKIP_IMAGE_BUILD=1)"
elif [[ "${USE_ACR_BUILD:-}" == "1" ]]; then
  echo "==> Build image in Azure (az acr build — produces amd64)"
  az acr build --registry "$ACR_NAME" --image "querymind:${IMAGE_TAG}" .
else
  echo "==> Build linux/amd64 image locally and push to ACR"
  if ! docker info &>/dev/null; then
    echo "ERROR: Docker is not running. Start Docker Desktop, then rerun this script."
    exit 1
  fi
  build_and_push_amd64
fi

echo "==> App Service plan: $PLAN_NAME"
if ! az appservice plan show --name "$PLAN_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
  az appservice plan create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$PLAN_NAME" \
    --is-linux \
    --sku F1 \
    --location "$LOCATION"
fi

ACR_USER="$(az acr credential show --name "$ACR_NAME" --query username -o tsv)"
ACR_PASS="$(az acr credential show --name "$ACR_NAME" --query 'passwords[0].value' -o tsv)"

echo "==> Web app: $APP_NAME"
if ! az webapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
  # Short image name only — registry host is supplied separately (avoids doubled ACR URL).
  az webapp create \
    --resource-group "$RESOURCE_GROUP" \
    --plan "$PLAN_NAME" \
    --name "$APP_NAME" \
    --container-image-name "$CONTAINER_IMAGE" \
    --container-registry-url "https://${ACR_LOGIN_SERVER}" \
    --container-registry-user "$ACR_USER" \
    --container-registry-password "$ACR_PASS"
fi

echo "==> Container + registry (managed identity preferred for ACR pull)"
PRINCIPAL_ID="$(az webapp identity assign \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --query principalId -o tsv)"

az role assignment create \
  --assignee-object-id "$PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role AcrPull \
  --scope "$ACR_ID" \
  -o none 2>/dev/null || true

az webapp config container set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --container-image-name "$CONTAINER_IMAGE" \
  --container-registry-url "https://${ACR_LOGIN_SERVER}" \
  --container-registry-user "$ACR_USER" \
  --container-registry-password "$ACR_PASS" \
  -o none

SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
az rest --method PATCH \
  --uri "https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Web/sites/${APP_NAME}/config/web?api-version=2023-12-01" \
  --body "{\"properties\":{\"acrUseManagedIdentityCreds\":true,\"linuxFxVersion\":\"DOCKER|${ACR_LOGIN_SERVER}/querymind:${IMAGE_TAG}\"}}" \
  -o none

echo "==> App settings from .env"
set -a
# shellcheck disable=SC1091
source .env
set +a

az webapp config appsettings set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --settings \
    WEBSITES_PORT=8000 \
    WEBSITES_ENABLE_APP_SERVICE_STORAGE=false \
    EXECUTOR="${EXECUTOR:-databricks}" \
    DUKE_API_KEY="${DUKE_API_KEY:?set DUKE_API_KEY in .env}" \
    DUKE_BASE_URL="${DUKE_BASE_URL:-https://litellm.oit.duke.edu}" \
    LLM_MODEL="${LLM_MODEL:-gpt-5.5}" \
    DATABRICKS_HOST="${DATABRICKS_HOST:-}" \
    DATABRICKS_TOKEN="${DATABRICKS_TOKEN:-}" \
    DATABRICKS_HTTP_PATH="${DATABRICKS_HTTP_PATH:-}" \
    DATABRICKS_TABLE="${DATABRICKS_TABLE:-workspace.querymind.wells}" \
    GUNICORN_TIMEOUT="${GUNICORN_TIMEOUT:-300}" \
    FLASK_ENV=production \
  -o none

az webapp restart --resource-group "$RESOURCE_GROUP" --name "$APP_NAME"

URL="https://${APP_NAME}.azurewebsites.net"
echo ""
echo "Deployed: $URL"
echo "Health:   ${URL}/health"
echo ""
echo "First request after deploy can take 1–2 minutes (cold start + image pull)."
echo ""
echo "Save these for later:"
echo "  export RESOURCE_GROUP=$RESOURCE_GROUP"
echo "  export ACR_NAME=$ACR_NAME"
echo "  export APP_NAME=$APP_NAME"
echo "  export PLAN_NAME=$PLAN_NAME"
