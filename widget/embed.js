/**
 * ai-visitor-widget — Embeddable visitor counter widget
 * https://github.com/localhost94/ai-visitor-widget
 * MIT License
 *
 * Detects whether the current pageview comes from a human/SEO browser
 * or an AI agent / GEO crawler, sends a ping to the tracking server,
 * and renders two counter badges.
 *
 * ---- Usage ----
 *
 * ① Host the Rust server (see README) at e.g. https://widget.yourdomain.com
 *
 * ② Add this snippet before </body> on any website:
 *
 *     <script>
 *       (function () {
 *         window.AIVW_CONFIG = {
 *           server: "https://widget.yourdomain.com", // required
 *           site: "yourdomain.com",                   // required — your site ID
 *           position: "bottom-right",                 // optional: top-left | top-right | bottom-left | bottom-right
 *           theme: "dark",                            // optional: dark | light
 *           showLabel: true                           // optional: show "Humans" / "AI" labels
 *         };
 *         var s = document.createElement("script");
 *         s.src = "https://widget.yourdomain.com/embed.js";
 *         s.async = true;
 *         document.head.appendChild(s);
 *       })();
 *     </script>
 *
 * The script reads window.AIVW_CONFIG.
 */

(function (window, document) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  var cfg = window.AIVW_CONFIG || {};
  var server = (cfg.server || "").replace(/\/$/, "");
  var site = cfg.site || (window.location && window.location.hostname) || "default";
  var position = cfg.position || "bottom-right";
  var theme = cfg.theme || "dark";
  var showLabel = cfg.showLabel !== false;

  if (!server) {
    if (window.console && console.warn) {
      console.warn("[AIVW] window.AIVW_CONFIG.server is required");
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // AI / human UA classification — mirrors server classify_ua()
  // ---------------------------------------------------------------------------

  var AI_SIGNATURES = [
    // OpenAI
    "chatgpt-user", "gptbot", "oai-searchbot", "oai-embedder",
    // Anthropic
    "anthropic-ai", "claudebot", "claude-web", "claude-user",
    // Google AI
    "googleother", "google-extended", "googlebot-image",
    // Perplexity
    "perplexity", "perplexitybot", "perplexity-ur",
    // Meta
    "metaexternalagent", "meta-externalfetcher", "meta-externalagent",
    "facebookexternalhit",
    // ByteDance / TikTok
    "bytedance", "tiktokinsightbot",
    // Common crawl / LLM training
    "commoncrawl", "ccbot",
    // Bing/Copilot
    "bingbot", ".microsoft.com",
    // AI search / GEO startups
    "turnitinbot", "timpi", "youbot", "velenpublicwebcrawler",
    "kangaroobot", "ai-crawler", "tractable-smart-crawl",
    "awariobot", "diffbot", "imagesiftbot",
    // Generic bot/crawler/spider catch-all
    "bot", "crawler", "spider",
    // Headless / programmatic clients
    "python-requests", "httpx", "node-fetch", "undici", "axios", "got/", "curl/",
    "headless", "phantom"
  ];

  var HUMAN_SIGNATURES = [
    "mozilla/", "chrome/", "safari/", "edge/",
    "firefox/", "samsung", "opera", "vivaldi"
  ];

  function classifyUA(ua) {
    var u = (ua || "").toLowerCase();

    var i;
    for (i = 0; i < AI_SIGNATURES.length; i++) {
      if (u.indexOf(AI_SIGNATURES[i]) !== -1) {
        return "ai";
      }
    }
    for (i = 0; i < HUMAN_SIGNATURES.length; i++) {
      if (u.indexOf(HUMAN_SIGNATURES[i]) !== -1) {
        return "human";
      }
    }
    return u.length === 0 ? "ai" : "human";
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  function el(tag, className, styles) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (styles) {
      var k;
      for (k in styles) {
        if (styles.hasOwnProperty(k)) e.style[k] = styles[k];
      }
    }
    return e;
  }

  function formatNumber(n) {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  }

  // ---------------------------------------------------------------------------
  // Dedup — one pageview per browser session, not per refresh
  // ---------------------------------------------------------------------------
  // We store a session key in sessionStorage so that reloading the same page
  // or navigating around the site within the same browser session does NOT
  // fire a second track request. A new browser session will count as a new
  // visitor.

  var DEDUP_KEY = "aivw_tracked_" + site;

  function isAlreadyTracked() {
    try {
      return sessionStorage.getItem(DEDUP_KEY) === "1";
    } catch (e) {
      // sessionStorage can throw in privacy / incognito / embedded contexts
      return false;
    }
  }

  function markTracked() {
    try {
      sessionStorage.setItem(DEDUP_KEY, "1");
    } catch (e) {
      // ignore — worst case we double-count for this one session
    }
  }

  // ---------------------------------------------------------------------------
  // Widget container
  // ---------------------------------------------------------------------------

  var THEMES = {
    dark: {
      bg: "#1a1a2e",
      card: "rgba(255,255,255,0.06)",
      border: "rgba(255,255,255,0.1)",
      humanColor: "#22c55e",
      humanIcon: "\uD83D\uDC68",
      aiColor: "#a855f7",
      aiIcon: "\uD83E\uDD17",
      text: "#e2e8f0",
      subtext: "#94a3b8"
    },
    light: {
      bg: "#ffffff",
      card: "rgba(0,0,0,0.04)",
      border: "rgba(0,0,0,0.1)",
      humanColor: "#16a34a",
      humanIcon: "\uD83D\uDC68",
      aiColor: "#8b5cf6",
      aiIcon: "\uD83E\uDD17",
      text: "#1e293b",
      subtext: "#64748b"
    }
  };

  var t = THEMES[theme] || THEMES.dark;

  var posStyles = {
    "top-left": { top: "16px", left: "16px" },
    "top-right": { top: "16px", right: "16px" },
    "bottom-left": { bottom: "16px", left: "16px" },
    "bottom-right": { bottom: "16px", right: "16px" }
  };

  var container = el("div", "aivw-widget", {
    position: "fixed",
    zIndex: "9999",
    fontFamily: "'Plus Jakarta Sans', 'Segoe UI', system-ui, -apple-system, sans-serif",
    display: "flex",
    gap: "8px",
    padding: "10px",
    borderRadius: "14px",
    background: t.bg,
    border: "1px solid " + t.border,
    boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
    backdropFilter: "blur(8px)",
    transition: "opacity .4s"
  });
  var ps = posStyles[position] || posStyles["bottom-right"];
  var pk;
  for (pk in ps) { if (ps.hasOwnProperty(pk)) container.style[pk] = ps[pk]; }
  container.style.opacity = "0";

  function makeCounter(icon, label, color, valueStream) {
    var wrap = el("div", null, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "6px 10px",
      borderRadius: "10px",
      background: t.card,
      minWidth: showLabel ? "96px" : "48px"
    });

    var iconSpan = el("span", null, {
      fontSize: "18px",
      lineHeight: "1"
    });
    iconSpan.textContent = icon;

    var textWrap = el("div", null, { display: "flex", flexDirection: "column" });
    var num = el("span", null, {
      fontSize: "16px",
      fontWeight: "800",
      color: color,
      lineHeight: "1.2"
    });
    num.textContent = "\u2026";
    var lbl = el("span", null, {
      fontSize: "10px",
      fontWeight: "600",
      color: t.subtext,
      textTransform: "uppercase",
      letterSpacing: ".5px",
      lineHeight: "1"
    });
    lbl.textContent = label;
    textWrap.appendChild(num);
    if (showLabel) textWrap.appendChild(lbl);

    wrap.appendChild(iconSpan);
    wrap.appendChild(textWrap);
    return { wrap: wrap, num: num };
  }

  var humanCounter = makeCounter(t.humanIcon, "Humans", t.humanColor);
  var aiCounter = makeCounter(t.aiIcon, "AI Agents", t.aiColor);
  container.appendChild(humanCounter.wrap);
  container.appendChild(aiCounter.wrap);

  document.body.appendChild(container);
  // fade in
  requestAnimationFrame(function () {
    container.style.opacity = "1";
  });

  // ---------------------------------------------------------------------------
  // API calls
  // ---------------------------------------------------------------------------

  function track() {
    // Dedup: only track once per browser session, not every pageview/refresh
    if (isAlreadyTracked()) return;

    var ua = navigator.userAgent;
    var visitorType = classifyUA(ua);

    var body = {
      site: site,
      visitorType: visitorType,
      userAgent: ua,
      path: window.location.pathname,
      referrer: document.referrer
    };

    fetch(server + "/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      mode: "cors"
    })
      .then(function (r) {
        if (r.ok) markTracked();
      })
      .catch(function (e) {
        if (console && console.warn) console.warn("[AIVW] track failed:", e);
      });
  }

  function loadStats() {
    fetch(server + "/api/stats/" + encodeURIComponent(site), {
      method: "GET",
      credentials: "omit",
      mode: "cors"
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        humanCounter.num.textContent = formatNumber(data.human || 0);
        aiCounter.num.textContent = formatNumber(data.ai || 0);
      })
      .catch(function (e) {
        if (console && console.warn) console.warn("[AIVW] stats failed:", e);
        humanCounter.num.textContent = "\u2014";
        aiCounter.num.textContent = "\u2014";
      });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  track();       // fires once per session (dedup via sessionStorage)
  loadStats();   // always loads current counters
  // refresh every 60s
  setInterval(loadStats, 60_000);

  // bounce-in on hover
  container.addEventListener("mouseenter", function () {
    container.style.transform = "scale(1.05)";
    container.style.transition = "transform .2s";
  });
  container.addEventListener("mouseleave", function () {
    container.style.transform = "scale(1)";
  });
})(window, document);