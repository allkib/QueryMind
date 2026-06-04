// Frontend-only auth UI. Accounts are not implemented yet: any submission shows
// a friendly "in development" notice rather than authenticating.
(function () {
  "use strict";

  const modal = document.getElementById("authModal");
  if (!modal) return;

  const forms = document.getElementById("authForms");
  const notice = document.getElementById("authNotice");
  const form = document.getElementById("authForm");
  const tabSignIn = document.getElementById("tabSignIn");
  const tabSignUp = document.getElementById("tabSignUp");
  const nameField = modal.querySelector(".auth-field--name");
  const nameInput = document.getElementById("authName");
  const emailInput = document.getElementById("authEmail");
  const passwordInput = document.getElementById("authPassword");
  const title = document.getElementById("authTitle");
  const sub = document.getElementById("authSub");
  const submit = document.getElementById("authSubmit");

  const signInBtn = document.getElementById("signInBtn");
  const signUpBtn = document.getElementById("signUpBtn");

  let lastFocused = null;

  const COPY = {
    signin: {
      tab: tabSignIn,
      title: "Welcome back",
      sub: "Sign in to save queries, dashboards, and reports.",
      submit: "Sign in",
      passwordAutocomplete: "current-password",
      showName: false,
    },
    signup: {
      tab: tabSignUp,
      title: "Create your account",
      sub: "Start turning plain-English questions into instant analytics.",
      submit: "Create account",
      passwordAutocomplete: "new-password",
      showName: true,
    },
  };

  function setMode(mode) {
    const cfg = COPY[mode] || COPY.signin;
    title.textContent = cfg.title;
    sub.textContent = cfg.sub;
    submit.textContent = cfg.submit;
    passwordInput.setAttribute("autocomplete", cfg.passwordAutocomplete);
    nameField.classList.toggle("hidden", !cfg.showName);
    nameInput.required = cfg.showName;

    [tabSignIn, tabSignUp].forEach((tab) => {
      const active = tab === cfg.tab;
      tab.classList.toggle("auth-tab--active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function showForms() {
    notice.classList.add("hidden");
    forms.classList.remove("hidden");
  }

  function showNotice() {
    forms.classList.add("hidden");
    notice.classList.remove("hidden");
    const cta = notice.querySelector("a, button");
    if (cta) cta.focus();
  }

  function openModal(mode) {
    lastFocused = document.activeElement;
    setMode(mode);
    showForms();
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("auth-open");
    window.requestAnimationFrame(function () {
      const first = COPY[mode] && COPY[mode].showName ? nameInput : emailInput;
      if (first) first.focus();
    });
  }

  function closeModal() {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("auth-open");
    if (form) form.reset();
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    }
    lastFocused = null;
  }

  if (signInBtn) signInBtn.addEventListener("click", () => openModal("signin"));
  if (signUpBtn) signUpBtn.addEventListener("click", () => openModal("signup"));

  tabSignIn.addEventListener("click", () => {
    showForms();
    setMode("signin");
  });
  tabSignUp.addEventListener("click", () => {
    showForms();
    setMode("signup");
  });

  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      showNotice();
    });
  }

  modal.querySelectorAll("[data-auth-sso]").forEach((btn) => {
    btn.addEventListener("click", showNotice);
  });

  modal.querySelectorAll("[data-auth-close]").forEach((el) => {
    el.addEventListener("click", function (e) {
      e.preventDefault();
      closeModal();
    });
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) {
      closeModal();
    }
  });
})();
