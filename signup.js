/* ============================================================================
   MergeSight — signup.js · generic signup form handler (DORMANT LOCALLY)

   Ships with every page variant, but it is completely inert unless a live
   signup-config.js has defined window.__SHADOW_SIGNUP_CONFIG__. On local
   engineering pages the stub config keeps that key undefined, so this file
   exits before doing anything: no listeners bound, no requests, no storage,
   no DOM changes, no success/error state.

   Live-variant behaviour (frozen live-signup contract, docs/backend-architecture.md
   §12; 2026-09-26 validation-messaging direction; 2026-10-01 status-region
   hardening; 2026-10-03 r2 transport revision — this file POSTs exactly the
   frozen contract fields and reads the canonical config keys, matching the
   deployed SignupCreate schema (extra: "forbid"); 2026-10-03 r3 Enter-keydown
   revision — pressing Enter in a text-like field submits (QA finding F-1,
   fixed with the proven-live DocuPlow keydown pattern)):
   - binds to every <form data-signup> on the page;
   - canonical config keys: backendUrl, siteKey, source, consentVersion,
     captchaRequired (quoted-key one-liner per §12; optional messages seam
     overrides the status wording per key at wiring time);
   - collects ALL named form fields into one form_data object (§12 step 1:
     inputs/selects/textareas, shared-name checkboxes as arrays, file inputs
     skipped); the repo-context field flows through form_data;
   - email is extracted separately (§12 step 2: first input[type=email], else
     the first collected field whose name contains "email") and the top-level
     key is sent/stored only when the visitor typed one (email optional);
   - loads the reCAPTCHA Enterprise loader ONLY when config.captchaRequired
     (§12 step 3 — the ONLY external request, never on inert pages), then
     executes a token with action "signup";
   - POSTs JSON to `${backendUrl}/api/v1/signups` (§12 step 4) with exactly
     {email?, source, source_url, session_id, captcha_token?, consent_version,
     form_data}; the backend accepts every well-formed attempt (200 always —
     duplicates included, each attempt stored as its own row), so there is no
     client-side dedupe;
   - renders the backend's verdict in the form's [role="status"] element with
     a DISTINCT plain-language message per rejection class — 200 success;
     422 "please check the form" naming what to fix from the backend's
     per-field detail (never a generic error); 429 rate limit; 400
     verification/captcha; captcha or network failure its own retry wording;
   - the backend owns validation: this script never validates locally.
   ========================================================================== */
(function () {
  "use strict";

  var CONFIG = window.__SHADOW_SIGNUP_CONFIG__;

  /* The absence of a live config switches the whole file off (two-state
     contract, §12). The gate keys on the canonical backendUrl; a stub config
     (key undefined) or a malformed one means an inert page — nothing binds. */
  if (!CONFIG || typeof CONFIG !== "object" ||
      typeof CONFIG.backendUrl !== "string" || CONFIG.backendUrl === "") {
    return;
  }

  var MESSAGES = CONFIG.messages || {};

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

  /* session_id — generated lazily, once per page load (server schema cap:
     64 chars). A UUID via crypto, with random-bytes and timestamp fallbacks
     so any browser can supply a per-attempt session correlation value. */
  var SESSION_ID = null;
  function ensureSessionId() {
    if (SESSION_ID) { return SESSION_ID; }
    var crypto = window.crypto;
    if (crypto && typeof crypto.randomUUID === "function") {
      SESSION_ID = crypto.randomUUID();
    } else if (crypto && typeof crypto.getRandomValues === "function") {
      var bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      SESSION_ID = Array.prototype.map.call(bytes, function (b) {
        return ("0" + b.toString(16)).slice(-2);
      }).join("");
    } else {
      SESSION_ID = "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
    }
    return SESSION_ID;
  }

  /* source_url — this page's address with the fragment stripped. The query
     string is kept on purpose: campaign parameters (UTM) ride in source_url
     for the launch's paid-vs-organic measurement split (marketing pack
     dependency recorded in the idea handoff). */
  function pageSourceUrl() {
    try {
      var href = window.location.href;
      return href ? href.split("#")[0] : null;
    } catch (err) {
      return null;
    }
  }

  /* §12 step 1 — collect ALL named fields generically into form_data:
     inputs, selects, textareas; a single checkbox → boolean; checkboxes
     sharing a name → array of checked values; radios → the checked value
     (omitted when none is checked); multi-select → array of selections;
     text-like values trimmed. File inputs and buttons are skipped, as are
     nameless and disabled fields. Unknown fields/structure land in form_data
     exactly as received (§6). */
  function collectFormData(form) {
    var groups = {};
    var fields = form.querySelectorAll("input, select, textarea");
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      var type = (field.type || "").toLowerCase();
      if (!field.name || field.disabled) { continue; }
      if (type === "file" || type === "submit" || type === "button" || type === "reset" || type === "image") { continue; }
      if (!groups[field.name]) { groups[field.name] = []; }
      groups[field.name].push(field);
    }
    var data = {};
    for (var name in groups) {
      if (!Object.prototype.hasOwnProperty.call(groups, name)) { continue; }
      var els = groups[name];
      var first = els[0];
      var ftype = (first.type || "").toLowerCase();
      if (ftype === "radio") {
        for (var j = 0; j < els.length; j++) {
          if (els[j].checked) { data[name] = els[j].value; break; }
        }
      } else if (ftype === "checkbox") {
        if (els.length === 1) {
          data[name] = first.checked;
        } else {
          var checked = [];
          for (var k = 0; k < els.length; k++) {
            if (els[k].checked) { checked.push(els[k].value); }
          }
          data[name] = checked;
        }
      } else if (first.tagName === "SELECT" && first.multiple) {
        var selected = [];
        for (var m = 0; m < first.options.length; m++) {
          if (first.options[m].selected) { selected.push(first.options[m].value); }
        }
        data[name] = selected;
      } else {
        data[name] = (first.value || "").trim();
      }
    }
    return data;
  }

  /* §12 step 2 — email is OPTIONAL: extracted from the first
     input[type=email], else from the first collected field whose name
     contains "email" and holds a string value (checkbox booleans/arrays never
     become the email). Returns null when the visitor left it empty; the
     top-level payload key is then omitted entirely. */
  function extractEmail(form, formData) {
    var input = form.querySelector('input[type="email"]');
    var value = input && typeof input.value === "string" ? input.value : "";
    if (!value) {
      for (var key in formData) {
        if (Object.prototype.hasOwnProperty.call(formData, key) &&
            /email/i.test(key) && typeof formData[key] === "string") {
          value = formData[key];
          break;
        }
      }
    }
    value = (value || "").trim();
    return value !== "" ? value : null;
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

  /* §12 step 3 — reCAPTCHA Enterprise loader, injected ONLY when the config
     sets captchaRequired (the ONLY external request the contract allows, and
     it never happens on inert/local pages). Injected at most once per page. */
  function loadRecaptcha(done) {
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
    script.src = "https://www.google.com/recaptcha/enterprise.js?render=" + encodeURIComponent(CONFIG.siteKey);
    script.async = true;
    script.setAttribute("data-recaptcha-loader", "");
    script.onload = function () { done(null); };
    script.onerror = function () { done(new Error("recaptcha-load-failed")); };
    document.head.appendChild(script);
  }

  function recaptchaToken(done) {
    var g = window.grecaptcha && window.grecaptcha.enterprise;
    if (!g) { done(new Error("recaptcha-unavailable"), null); return; }
    g.ready(function () {
      g.execute(CONFIG.siteKey, { action: "signup" })
        .then(function (token) { done(null, token); })
        .catch(function () { done(new Error("recaptcha-execute-failed"), null); });
    });
  }

  /* 422 renderer (2026-09-26 direction): prefer the backend's per-field
     detail — the redacting handler returns detail as an ARRAY, where
     extra-forbid items carry loc ["body", <field>] and model-validator items
     carry loc ["body"] with the body redacted — and fall back to the specific
     form-level wording when the body can't be parsed. Never the generic
     error. A plain-string detail is honored too when present. */
  function describeUnprocessable(data) {
    var detail = data && data.detail;
    var items = [];
    if (Array.isArray(detail)) {
      for (var i = 0; i < detail.length; i++) {
        var item = detail[i];
        if (!item || typeof item.msg !== "string" || item.msg === "") { continue; }
        var msg = item.msg.replace(/^Value error, /, "");
        var loc = Array.isArray(item.loc) ? item.loc : null;
        var field = (loc && loc.length > 1) ? String(loc[loc.length - 1]) : null;
        items.push(field ? field + ": " + msg : msg);
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

    var form_data = collectFormData(form);
    var email = extractEmail(form, form_data);

    /* §12 step 4 — POST body with exactly the frozen contract fields
       (SignupCreate is extra: "forbid"): email only when present; source
       required (from config); source_url; per-page-load session_id;
       consent_version from config; all raw form fields as form_data.
       captcha_token is added below only when the config requires it.
       200-always: every accepted attempt (duplicates included) is its own
       stored row server-side — there is no client-side dedupe. */
    var payload = {};
    if (email !== null) { payload.email = email; }
    payload.source = CONFIG.source;
    payload.source_url = pageSourceUrl();
    payload.session_id = ensureSessionId();
    payload.consent_version = (typeof CONFIG.consentVersion === "string" && CONFIG.consentVersion !== "") ? CONFIG.consentVersion : null;
    payload.form_data = form_data;

    setStatus(form, message("pending"), null);

    var postPayload = function (body) {
      fetch(CONFIG.backendUrl.replace(/\/+$/, "") + "/api/v1/signups", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(body)
      }).then(function (response) {
        return response.json().catch(function () { return null; }).then(function (body2) {
          form.removeAttribute("data-submitting");
          var status = response.status;
          if (status === 200) {
            setStatus(form, message("success"), "signup-status--success");
          } else if (status === 422) {
            setStatus(form, describeUnprocessable(body2), "signup-status--error");
          } else if (status === 429) {
            setStatus(form, message("rate_limited"), "signup-status--error");
          } else if (status === 400) {
            setStatus(form, message("verification"), "signup-status--error");
          } else {
            setStatus(form, message("server"), "signup-status--error");
          }
        });
      }).catch(function (error) {
        form.removeAttribute("data-submitting");
        /* fetch rejects with TypeError on network failure — its own wording;
           anything else unexpected falls to the server-class wording. */
        setStatus(form, message(error && error.name === "TypeError" ? "network" : "server"), "signup-status--error");
      });
    };

    if (CONFIG.captchaRequired) {
      loadRecaptcha(function (loadError) {
        if (loadError) {
          form.removeAttribute("data-submitting");
          setStatus(form, message("verification"), "signup-status--error");
          return;
        }
        recaptchaToken(function (tokenError, token) {
          if (tokenError || !token) {
            form.removeAttribute("data-submitting");
            setStatus(form, message("verification"), "signup-status--error");
            return;
          }
          payload.captcha_token = token;
          postPayload(payload);
        });
      });
    } else {
      postPayload(payload);
    }
  }

  /* Submit triggers beyond the button (QA finding F-1, fixed 2026-10-03 with
     the proven-live DocuPlow pattern): this form has two text inputs and a
     type="button" control, so Chromium fires no implicit submission when Enter
     is pressed in a field. A delegated keydown on the form routes Enter in a
     text-like input to the same submitSignup path the button click uses;
     preventDefault takes over before any browser-specific implicit submission
     could fire, and submitSignup's data-submitting guard makes a double
     trigger (e.g. Enter while a submission is already in flight) a no-op. */
  var TEXTLIKE = /^(text|email|search|tel|url|password|number|date|month|week|time|datetime-local)$/i;

  function onKeyDown(event) {
    if (event.key !== "Enter") { return; }
    var target = event.target;
    if (!target || target.tagName !== "INPUT" || !TEXTLIKE.test(target.type || "")) { return; }
    if (target.form !== event.currentTarget) { return; }
    event.preventDefault(); // take over: implicit native submission never fires
    submitSignup(event.currentTarget);
  }

  function bindForms() {
    var forms = document.querySelectorAll("form[data-signup]");
    for (var i = 0; i < forms.length; i++) {
      (function (form) {
        form.addEventListener("submit", function (event) {
          event.preventDefault();
          submitSignup(form);
        });
        form.addEventListener("keydown", onKeyDown);
        /* Pages ship the submit control as type="button" so the page is inert
           without a live config; with one, the click and Enter-in-field are
           the submit triggers. */
        var buttons = form.querySelectorAll('button[type="button"]');
        for (var j = 0; j < buttons.length; j++) {
          buttons[j].addEventListener("click", function () { submitSignup(form); });
        }
      })(forms[i]);
    }
  }

  bindForms();
})();
