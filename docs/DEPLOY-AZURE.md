# Deploy QueryMind to Azure App Service

Phase 3 guide: container image → Azure Web App → secrets in App Settings (never in git).

## Prerequisites

- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) (`az login`)
- Duke LiteLLM API key and (recommended) Databricks PAT + SQL warehouse HTTP path
- Docker optional — **recommended:** build in the cloud with `az acr build` (see script below)

### Azure for Students (Duke)

| Issue | Fix |
|--------|-----|
| ACR blocked in `eastus` | Use **`LOCATION=centralus`** for ACR and App Service |
| `MissingSubscriptionRegistration` for ACR | Run `az provider register --namespace Microsoft.ContainerRegistry --wait` |
| `TasksOperationsNotAllowed` on `az acr build` | **Normal on Azure for Students** — use local `docker buildx build --platform linux/amd64 --push` (deploy script does this by default) |
| `no matching manifest for linux/amd64` | Image was built on Apple Silicon (arm64). Rebuild with `docker buildx build --platform linux/amd64 --push` (see script) |
| Doubled ACR URL (`acr.io/acr.io/...`) | Use **short** image name `querymind:latest` with `--container-registry-url`; never pass full `acr.io/...` to `az webapp create --container-image-name` |
| `DOCKER_REGISTRY_SERVER_PASSWORD` empty | Prefer managed identity: script assigns **AcrPull** to the web app identity |
| `export: not valid in this context` (zsh) | **Do not put `# comments` on the same line as `export`** |
| Empty plan name `''` | Re-run exports; confirm with `echo $PLAN_NAME $APP_NAME` |
| `InvalidResourceGroupLocation` | RG already exists in **eastus** — keep it; set `LOCATION=centralus` only for ACR/App Service (script handles this) |

**One-command deploy** (after `az login` and `.env` is filled):

```bash
chmod +x scripts/deploy-azure.sh
./scripts/deploy-azure.sh
```

## 1. Test the container locally

```bash
cd QueryMind
cp .env.example .env   # fill in secrets
docker build -t querymind .
docker run --rm -p 8000:8000 --env-file .env querymind
```

Open `http://127.0.0.1:8000` and run a sample question. Health check: `http://127.0.0.1:8000/health`.

## 2. Azure resources (one-time)

Replace placeholders: `RESOURCE_GROUP`, `LOCATION`, `ACR_NAME` (lowercase alphanumeric only), `APP_NAME` (globally unique).

```bash
RESOURCE_GROUP=querymind-rg
LOCATION=centralus
ACR_NAME=querymindacr$(openssl rand -hex 3)
APP_NAME=querymind-$(openssl rand -hex 4)
PLAN_NAME=querymind-plan

az group create --name "$RESOURCE_GROUP" --location "$LOCATION"

az provider register --namespace Microsoft.ContainerRegistry --wait
az provider register --namespace Microsoft.Web --wait

az acr create --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --sku Basic --location "$LOCATION" --admin-enabled true

az appservice plan create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$PLAN_NAME" \
  --is-linux \
  --sku F1 \
  --location "$LOCATION"

az webapp create \
  --resource-group "$RESOURCE_GROUP" \
  --plan "$PLAN_NAME" \
  --name "$APP_NAME" \
  --container-image-name "querymind:latest" \
  --container-registry-url "https://$ACR_LOGIN_SERVER" \
  --container-registry-user "$ACR_USER" \
  --container-registry-password "$ACR_PASS"
```

## 3. Build and push image to ACR

**Option A — local Docker (required on Azure for Students):**

```bash
az acr login --name "$ACR_NAME"
ACR_LOGIN_SERVER=$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)
# App Service is linux/amd64 — on Mac use buildx:
docker buildx build --platform linux/amd64 -t "$ACR_LOGIN_SERVER/querymind:latest" --push .
```

**Option B — build in Azure** (often blocked on student subscriptions):

```bash
USE_ACR_BUILD=1 ./scripts/deploy-azure.sh
```

Configure the web app to pull from ACR:

```bash
ACR_USER=$(az acr credential show --name "$ACR_NAME" --query username -o tsv)
ACR_PASS=$(az acr credential show --name "$ACR_NAME" --query "passwords[0].value" -o tsv)

az webapp config container set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --container-image-name "querymind:latest" \
  --container-registry-url "https://$ACR_LOGIN_SERVER" \
  --container-registry-user "$ACR_USER" \
  --container-registry-password "$ACR_PASS"
```

## 4. App settings (secrets)

Set in Azure Portal → Web App → **Configuration** → **Application settings**, or via CLI:

```bash
az webapp config appsettings set --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --settings \
  WEBSITES_PORT=8000 \
  EXECUTOR=databricks \
  DUKE_API_KEY="<your-key>" \
  DUKE_BASE_URL="https://litellm.oit.duke.edu" \
  LLM_MODEL="gpt-5.5" \
  DATABRICKS_HOST="https://<workspace>.cloud.databricks.com" \
  DATABRICKS_TOKEN="<pat>" \
  DATABRICKS_HTTP_PATH="/sql/1.0/warehouses/<id>" \
  DATABRICKS_TABLE="workspace.querymind.wells" \
  GUNICORN_TIMEOUT=300 \
  FLASK_ENV=production
```

Restart the app:

```bash
az webapp restart --resource-group "$RESOURCE_GROUP" --name "$APP_NAME"
```

Public URL: `https://$APP_NAME.azurewebsites.net`

## 5. Verify deployment

```bash
curl -s "https://$APP_NAME.azurewebsites.net/health" | python3 -m json.tool
curl -s "https://$APP_NAME.azurewebsites.net/health/databricks" | python3 -m json.tool
```

Run a query from the UI or:

```bash
curl -s -X POST "https://$APP_NAME.azurewebsites.net/query" \
  -H "Content-Type: application/json" \
  -d '{"question": "Show total production by field"}'
```

## Notes

| Topic | Detail |
|--------|--------|
| **F1 plan** | Free tier sleeps when idle; first request may be slow. LLM + Databricks queries need `GUNICORN_TIMEOUT=300`. |
| **Query history** | SQLite file lives in the container filesystem and resets on redeploy. Use external storage for persistence later. |
| **CSV import** | Updates local `sample_data/wells.csv` inside the container only; Databricks mode still queries Delta unless you load data there. |
| **HTTPS** | Provided by App Service by default. |
| **CI/CD** | Optional: GitHub Actions build → `az acr build` → `az webapp restart`. |

## Alternative: Zip deploy (no Docker)

Not recommended for production parity, but possible with `gunicorn` on App Service Python runtime. Prefer the container path above so local and Azure match.
