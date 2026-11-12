/*
 * Adonis Kitchen & Bath: Meta Pixel + advertising-consent controls.
 *
 * Consent model: notice + opt-out.
 *   - Advertising tracking is on by default, with a notice banner that lets the
 *     visitor opt out. The choice is stored in localStorage ("akb_ads_consent").
 *   - A browser Global Privacy Control signal (navigator.globalPrivacyControl)
 *     is always treated as an opt-out.
 *   - When opted out, the Pixel is never loaded (or is revoked if already
 *     loaded), Meta cookies are cleared, and the consultation form tells the
 *     server not to send a Conversions API event.
 *
 * Script tag options (data attributes):
 *   data-pixel="off"    : consent controls only, never load the Pixel (e.g. privacy page)
 *   data-banner="off"   : never show the notice banner automatically
 *
 * Public API: window.AKBMeta
 */
(function () {
  "use strict";

  if (window.AKBMeta) return; // Guard against the script being included twice.

  var PIXEL_ID = "1651831621924792";
  var CONSENT_KEY = "akb_ads_consent"; // "granted" | "denied"
  var DRAFT_LEAD_KEY = "akb_meta_lead_id"; // event ID for enquiries from this session
  var READY_LEAD_KEY = "akb_meta_lead_ready"; // event ID of a submission Netlify accepted
  var FIRED_LEADS_KEY = "akb_meta_leads_fired"; // event IDs already sent from this browser
  var PRIVACY_URL = "/privacy-policy/#advertising-choices";

  var script = document.currentScript;
  var pixelAllowedOnPage = !script || script.getAttribute("data-pixel") !== "off";
  var bannerAllowedOnPage = !script || script.getAttribute("data-banner") !== "off";

  var safeStorage = function (name) {
    try {
      var store = window[name];
      store.setItem("__akb", "1");
      store.removeItem("__akb");
      return store;
    } catch (error) {
      return null;
    }
  };
  var local = safeStorage("localStorage");
  var session = safeStorage("sessionStorage");

  var read = function (store, key) {
    return store ? store.getItem(key) : null;
  };
  var write = function (store, key, value) {
    if (store) store.setItem(key, value);
  };
  var remove = function (store, key) {
    if (store) store.removeItem(key);
  };

  /* ---------------------------------------------------------------- consent */

  var gpcEnabled = function () {
    return navigator.globalPrivacyControl === true;
  };

  var storedChoice = function () {
    var value = read(local, CONSENT_KEY);
    return value === "granted" || value === "denied" ? value : null;
  };

  var hasAdConsent = function () {
    if (gpcEnabled()) return false;
    return storedChoice() !== "denied";
  };

  var getCookie = function (name) {
    var match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : "";
  };

  var clearMetaCookies = function () {
    var host = window.location.hostname;
    var parts = host.split(".");
    var domains = ["", host];
    for (var i = 1; i < parts.length - 1; i++) domains.push("." + parts.slice(i).join("."));
    ["_fbp", "_fbc"].forEach(function (name) {
      domains.forEach(function (domain) {
        document.cookie =
          name + "=; Max-Age=0; path=/" + (domain ? "; domain=" + domain : "") + "; SameSite=Lax";
      });
    });
  };

  /* ------------------------------------------------------------------ pixel */

  var pixelLoaded = false;

  var loadPixel = function () {
    if (pixelLoaded || !pixelAllowedOnPage || !hasAdConsent()) return;
    pixelLoaded = true;

    /* Standard Meta Pixel base code. It is a no-op if fbq already exists. */
    /* eslint-disable */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
    document,'script','https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */

    window.fbq("consent", "grant");
    window.fbq("init", PIXEL_ID);
    window.fbq("track", "PageView");
  };

  var track = function (eventName, params, options) {
    if (!pixelLoaded || !hasAdConsent() || typeof window.fbq !== "function") return false;
    window.fbq("track", eventName, params || {}, options || {});
    return true;
  };

  /* --------------------------------------------------------------- event ids */

  var uuid = function () {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.prototype.map
      .call(bytes, function (b) {
        return ("0" + b.toString(16)).slice(-2);
      })
      .join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  };

  var firedLeads = function () {
    try {
      var list = JSON.parse(read(session, FIRED_LEADS_KEY) || "[]");
      return Array.isArray(list) ? list : [];
    } catch (error) {
      return [];
    }
  };

  // One event ID per browser session: retries and repeat submissions reuse it,
  // so they can never produce two different Leads.
  var draftLeadId = function () {
    var id = read(session, DRAFT_LEAD_KEY);
    if (!id) {
      id = uuid();
      write(session, DRAFT_LEAD_KEY, id);
    }
    return id;
  };

  var fbcFromUrl = function () {
    var fbclid = new URLSearchParams(window.location.search).get("fbclid");
    return fbclid ? "fb.1." + Date.now() + "." + fbclid : "";
  };

  var setHidden = function (form, name, value) {
    var input = form.querySelector('input[name="' + name + '"]');
    if (input) input.value = value || "";
  };

  /**
   * Call immediately before the form data is serialised. Fills the hidden
   * tracking fields. Returns the event ID (or "" when opted out).
   */
  var prepareLead = function (form) {
    if (!form) return "";
    if (!hasAdConsent()) {
      ["meta_event_id", "meta_fbp", "meta_fbc", "meta_ua"].forEach(function (name) {
        setHidden(form, name, "");
      });
      setHidden(form, "meta_consent", "denied");
      return "";
    }
    var id = draftLeadId();
    setHidden(form, "meta_event_id", id);
    setHidden(form, "meta_consent", "granted");
    setHidden(form, "meta_fbp", getCookie("_fbp"));
    setHidden(form, "meta_fbc", getCookie("_fbc") || fbcFromUrl());
    setHidden(form, "meta_ua", navigator.userAgent.slice(0, 512));
    return id;
  };

  /**
   * Call only after Netlify Forms has accepted the submission (response.ok).
   * Hands the event ID to the thank-you page. The ID is deliberately kept for
   * the rest of the browser session, so a repeat submission (back button,
   * double enquiry) reuses it and is discarded as a duplicate both here and on
   * the server instead of counting as a second Lead.
   */
  var markLeadSucceeded = function (eventId) {
    if (eventId && hasAdConsent()) write(session, READY_LEAD_KEY, eventId);
  };

  /**
   * Runs on the thank-you page: fires the browser Lead exactly once per
   * accepted submission. Visiting or reloading the thank-you page directly
   * never fires a Lead.
   */
  var trackPendingLead = function () {
    var eventId = read(session, READY_LEAD_KEY);
    if (!eventId) return false;
    remove(session, READY_LEAD_KEY);

    var fired = firedLeads();
    if (fired.indexOf(eventId) !== -1) return false;

    if (track("Lead", {}, { eventID: eventId })) {
      fired.push(eventId);
      write(session, FIRED_LEADS_KEY, JSON.stringify(fired.slice(-20)));
      return true;
    }
    return false;
  };

  /* ---------------------------------------------------------------- contact */

  var bindPhoneClicks = function () {
    document.querySelectorAll('a[href^="tel:"]').forEach(function (link) {
      if (link.dataset.metaContactBound === "true") return;
      link.dataset.metaContactBound = "true";
      // Passive listener: never prevents or delays the call.
      link.addEventListener(
        "click",
        function () {
          track("Contact", { contact_method: "phone" });
        },
        { passive: true }
      );
    });
  };

  /* ----------------------------------------------------------------- banner */

  var bannerEl = null;

  var injectStyles = function () {
    if (document.getElementById("akb-consent-styles")) return;
    var style = document.createElement("style");
    style.id = "akb-consent-styles";
    style.textContent =
      ".akb-consent{position:fixed;z-index:60;left:16px;right:16px;bottom:16px;max-width:560px;margin:0 auto;" +
      "padding:18px 20px;border:1px solid rgba(255,255,255,.18);border-radius:6px;background:rgba(6,18,29,.97);" +
      "color:#fff;box-shadow:0 18px 48px rgba(0,0,0,.35);font:14px/1.5 'Open Sans',Arial,sans-serif}" +
      ".akb-consent p{margin:0 0 12px;color:rgba(255,255,255,.9)}" +
      ".akb-consent a{color:#7cc2ff}" +
      ".akb-consent .akb-consent-status{font-size:13px;color:rgba(255,255,255,.72)}" +
      ".akb-consent-actions{display:flex;flex-wrap:wrap;gap:10px}" +
      ".akb-consent button{min-height:42px;padding:0 18px;border-radius:4px;font:700 14px 'Open Sans',Arial,sans-serif;cursor:pointer}" +
      ".akb-consent .akb-ok{border:0;color:#fff;background:linear-gradient(180deg,#0677d8,#006fc9)}" +
      ".akb-consent .akb-optout{border:1px solid rgba(255,255,255,.42);color:#fff;background:transparent}" +
      "@media (max-width:760px){.akb-consent{bottom:84px;left:12px;right:12px}}";
    document.head.appendChild(style);
  };

  var closeBanner = function () {
    if (bannerEl) {
      bannerEl.remove();
      bannerEl = null;
    }
  };

  var setChoice = function (choice) {
    write(local, CONSENT_KEY, choice);
    if (choice === "denied") {
      if (pixelLoaded && typeof window.fbq === "function") window.fbq("consent", "revoke");
      clearMetaCookies();
      remove(session, READY_LEAD_KEY);
    } else {
      loadPixel();
    }
    closeBanner();
  };

  var showBanner = function () {
    closeBanner();
    injectStyles();

    bannerEl = document.createElement("div");
    bannerEl.className = "akb-consent";
    bannerEl.setAttribute("role", "dialog");
    bannerEl.setAttribute("aria-live", "polite");
    bannerEl.setAttribute("aria-label", "Advertising cookie choices");

    var text = document.createElement("p");
    text.innerHTML =
      "We use cookies and similar technologies, including the Meta Pixel, to measure and improve our advertising. " +
      "You can opt out of advertising tracking at any time. " +
      '<a href="' + PRIVACY_URL + '">Privacy Policy</a>';
    bannerEl.appendChild(text);

    var status = document.createElement("p");
    status.className = "akb-consent-status";
    if (gpcEnabled()) {
      status.textContent =
        "Your browser is sending a Global Privacy Control signal, so advertising tracking is turned off.";
    } else if (storedChoice() === "denied") {
      status.textContent = "You have opted out of advertising tracking.";
    } else {
      status.textContent = "Advertising tracking is currently on.";
    }
    bannerEl.appendChild(status);

    var actions = document.createElement("div");
    actions.className = "akb-consent-actions";

    if (gpcEnabled()) {
      var close = document.createElement("button");
      close.type = "button";
      close.className = "akb-ok";
      close.textContent = "Close";
      close.addEventListener("click", function () {
        write(local, CONSENT_KEY, "denied");
        closeBanner();
      });
      actions.appendChild(close);
    } else {
      var ok = document.createElement("button");
      ok.type = "button";
      ok.className = "akb-ok";
      ok.textContent = storedChoice() === "denied" ? "Allow advertising cookies" : "OK";
      ok.addEventListener("click", function () {
        setChoice("granted");
      });

      var optOut = document.createElement("button");
      optOut.type = "button";
      optOut.className = "akb-optout";
      optOut.textContent = "Opt out";
      optOut.addEventListener("click", function () {
        setChoice("denied");
      });

      actions.appendChild(ok);
      actions.appendChild(optOut);
    }

    bannerEl.appendChild(actions);
    document.body.appendChild(bannerEl);
  };

  var bindSettingsLinks = function () {
    document.querySelectorAll("[data-ad-choices]").forEach(function (link) {
      link.addEventListener("click", function (event) {
        event.preventDefault();
        showBanner();
      });
    });
  };

  /* ------------------------------------------------------------------- init */

  window.AKBMeta = {
    pixelId: PIXEL_ID,
    hasAdConsent: hasAdConsent,
    prepareLead: prepareLead,
    markLeadSucceeded: markLeadSucceeded,
    trackPendingLead: trackPendingLead,
    track: track,
    showChoices: showBanner
  };

  loadPixel();

  var onReady = function () {
    bindPhoneClicks();
    bindSettingsLinks();
    if (bannerAllowedOnPage && !storedChoice() && !gpcEnabled()) showBanner();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    onReady();
  }
})();
