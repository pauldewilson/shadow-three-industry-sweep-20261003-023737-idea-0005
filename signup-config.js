/* ============================================================================
   MergeSight — signup-config.js · LOCAL STUB (comment-only, no code)

   This file intentionally defines nothing. window.__SHADOW_SIGNUP_CONFIG__
   stays undefined, which keeps signup.js fully dormant on this local page:
   no form wiring, no requests, no storage, no reCAPTCHA, no success or error
   state. Nothing leaves the device.

   A live variant (shadow-launches--deployed/ and publish repos ONLY — never
   this local shadow-launches/ directory) replaces this file with a real
   config carrying at least:

     window.__SHADOW_SIGNUP_CONFIG__ = {
       endpoint: "https://<backend>/api/v1/signups",
       source: "<page identifier>",
       recaptcha: { siteKey: "<site key>", action: "signup" },  // only when required
       messages: {                                               // optional overrides
         success: "...", pending: "...", invalid: "...",
         rate_limited: "...", verification: "...", network: "...", server: "..."
       },
       fieldLabels: { email: "...", repo: "..." }                // optional, for 422 detail
     };

   Live strings: the copy report's S7-10 (success) / S7-11 (error) belong in
   messages.success / messages.invalid at wiring time — see the live-signup
   contract in docs/backend-architecture.md §12.
   ========================================================================== */
