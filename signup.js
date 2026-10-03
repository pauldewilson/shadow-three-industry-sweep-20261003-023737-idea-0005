/* ============================================================================
   MergeSight — signup.js · generic signup form handler (DORMANT LOCALLY)

   Ships with every page variant, but it is completely inert unless a live
   signup-config.js has defined window.__SHADOW_SIGNUP_CONFIG__. On local
   engineering pages the stub config keeps that key undefined, so this file
   exits before doing anything: no listeners bound, no requests, no storage,
   no DOM changes, no success/error state.

   Live-variant behaviour (live-signup contract, docs/backend-architecture.md
   §12; 2026-09-26 validation-messaging direction; 2026-10-01 status-region
   hardening):
   - binds to every <form data-signup> on the page;
   - collects ALL named form fields into one form_data object; email is
     extracted separately and sent/stored only when the visitor typed one
     (email optional by contract);
   - loads the reCAPTCHA Enterprise loader ONLY when the config requires it;
   - posts to the configured endpoint and renders the backend's verdict in
     the form's [role="status"] element with a DISTINCT plain-language
     message per rejection class — 200 success; 422 "please check the form"
     naming what to fix (never a generic error); 429 rate limit; 400
     verification/captcha; captcha or network failure its own retry wording;
   - the backend owns validation: this script never validates locally.
   ========================================================================== */
(function () {
  "use strict";

  var CONFIG = window.__SHADOW_SIGNUP_CONFIG__;

  /* The absence of a live config switches the whole file off. */
  if (!CONFIG || typeof CONFIG.endpoint !== "string" || CONFIG.endpoint === "") {
    return;
  }

  var MESSAGES = CONFIG.messages || {};
  var LABELS = CONFIG.fieldLabels || {};

  var DEFAULT_MESSAGES = {
    success: "Thanks — you're on the list. Watch your inbox for your setup details.",
    pending: "Sending…",
    /* 422 fallback: specific form-level wording naming what to fix — the
       generic "Something went wrong" is never used for a 422. */
    invalid: "Please check the form: enter a valid email address, then try again.",
    rate_limited: "Too many submissions from your network right now — please wait a few minutes and try again.",
    verification: "We couldn't verify that you're a person. Please reload the page and try again.",
    network: "We couldn't reach the signup service — check your connection and try again.",
    server: "The signup service is having a problem right now — please try again in a little while."
  };

  function message(key) {
    var value = MESSAGES[key];
    if (typeof value === "string" && value !== "") { return value; }
    return DEFAULT_MESSAGES[key] || "";
  }

  /* Collect every named field into form_data; extract the email separately
     (optional — null when the visitor left it empty). */
  function collectFields(form) {
    var form_data = {};
    var email = null;
    var fields = form.querySelectorAll("input, select, textarea");
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      if (!field.name || field.disabled) { continue; }
      if (field.type === "submit" || field.type === "button" || field.type === "file" || field.type === "reset") { continue; }
      if (field.type === "checkbox") {
        form_data[field.name] = field.checked;
      } else if (field.type === "radio") {
        if (field.checked) { form_data[field.name] = field.value; }
      } else {
        form_data[field.name] = field.value;
      }
      if (field.type === "email" || field.name === "email") {
        var value = (field.value || "").trim();
        if (value !== "") { email = value; }
      }
    }
    return { form_data: form_data, email: email };
  }

  /* Every message goes to the form's [role="status"] element; when a page
     omits that required element, messages no-op rather than fake feedback. */
  function setStatus(form, text, stateClass) {
    var status = form.querySelector('[role="status"]');
    if (!status) { return; }
    status.classList.remove("signup-status--success", "signup-status--error");
    status.textContent = text;
    if (stateClass) { status.classList.add(stateClass); }
  }

  /* reCAPTCHA Enterprise loader — injected only when the config requires it. */
  function loadRecaptcha(done) {
    if (!(CONFIG.recaptcha && CONFIG.recaptcha.siteKey)) { done(null); return; }
    if (window.grecaptcha && window.grecaptcha.enterprise) { done(null); return; }
    if (document.querySelector("script[data-recaptcha-loader]")) {
      var waited = 0;
      var timer = setInterval(function () {
        waited += 100;
        if (window.grecaptcha && window.grecaptcha.enterprise) {
          clearInterval(timer);
          done(null);
        } else if (waited > 5000) {
          clearInterval(timer);
          done(new Error("recaptcha-load-timeout"));
        }
      }, 100);
      return;
    }
    var script = document.createElement("script");
    script.src = "https://www.google.com/recaptcha/enterprise.js?render=" + encodeURIComponent(CONFIG.recaptcha.siteKey);
    script.async = true;
    script.setAttribute("data-recaptcha-loader", "");
    script.onload = function () { done(null); };
    script.onerror = function () { done(new Error("recaptcha-load-failed")); };
    document.head.appendChild(script);
  }

  function recaptchaToken(done) {
    if (!(CONFIG.recaptcha && CONFIG.recaptcha.siteKey)) { done(null, null); return; }
    var g = window.grecaptcha && window.grecaptcha.enterprise;
    if (!g) { done(new Error("recaptcha-unavailable"), null); return; }
    g.ready(function () {
      g.execute(CONFIG.recaptcha.siteKey, { action: CONFIG.recaptcha.action || "signup" })
        .then(function (token) { done(null, token); })
        .catch(function () { done(new Error("recaptcha-execute-failed"), null); });
    });
  }

  /* 422 renderer: prefer the backend's per-field detail ("work email: value
     is not a valid email address"); fall back to the specific form-level
     wording. Never the generic error. */
  function describeUnprocessable(data) {
    var detail = data && data.detail;
    var items = [];
    if (Array.isArray(detail)) {
      for (var i = 0; i < detail.length; i++) {
        var item = detail[i];
        if (!item || !item.msg) { continue; }
        var field = (Array.isArray(item.loc) && item.loc.length) ? String(item.loc[item.loc.length - 1]) : null;
        var label = (field && LABELS[field]) || field;
        items.push(label ? label + ": " + item.msg : item.msg);
      }
    } else if (typeof detail === "string" && detail.trim() !== "") {
      items.push(detail.trim());
    }
    if (items.length) { return "Please check the form — " + items.join("; ") + "."; }
    return message("invalid");
  }

  function submitSignup(form) {
    if (form.getAttribute("data-submitting") === "true") { return; }
    form.setAttribute("data-submitting", "true");

    var parts = collectFields(form);
    var payload = {
      email: parts.email,
      source: (typeof CONFIG.source === "string" && CONFIG.source !== "") ? CONFIG.source : window.location.href.split("#")[0],
      session: CONFIG.session || null,
      consent: CONFIG.consent === false ? false : true,
      form_data: parts.form_data
    };

    setStatus(form, message("pending"), null);

    loadRecaptcha(function (loadError) {
      if (loadError) {
        form.removeAttribute("data-submitting");
        setStatus(form, message("verification"), "signup-status--error");
        return;
      }
      recaptchaToken(function (tokenError, token) {
        if (tokenError) {
          form.removeAttribute("data-submitting");
          setStatus(form, message("verification"), "signup-status--error");
          return;
        }
        if (token) { payload.recaptcha_token = token; }
        fetch(CONFIG.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify(payload)
        }).then(function (response) {
          return response.json().catch(function () { return null; }).then(function (body) {
            form.removeAttribute("data-submitting");
            var status = response.status;
            if (status === 200) {
              setStatus(form, message("success"), "signup-status--success");
            } else if (status === 422) {
              setStatus(form, describeUnprocessable(body), "signup-status--error");
            } else if (status === 429) {
              setStatus(form, message("rate_limited"), "signup-status--error");
            } else if (status === 400) {
              setStatus(form, message("verification"), "signup-status--error");
            } else {
              setStatus(form, message("server"), "signup-status--error");
            }
          });
        }).catch(function () {
          form.removeAttribute("data-submitting");
          setStatus(form, message("network"), "signup-status--error");
        });
      });
    });
  }

  function bindForms() {
    var forms = document.querySelectorAll("form[data-signup]");
    for (var i = 0; i < forms.length; i++) {
      (function (form) {
        form.addEventListener("submit", function (event) {
          event.preventDefault();
          submitSignup(form);
        });
        /* Pages ship the submit control as type="button" so the page is inert
           without a live config; with one, the click is the submit trigger. */
        var buttons = form.querySelectorAll('button[type="button"]');
        for (var j = 0; j < buttons.length; j++) {
          buttons[j].addEventListener("click", function () { submitSignup(form); });
        }
      })(forms[i]);
    }
  }

  bindForms();
})();
