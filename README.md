# 🤖 ai-visitor-widget

> A lightweight, self-hosted visitor counter widget that distinguishes **human/SEO** traffic from **AI agent/GEO** traffic. Built in Rust + Axum + SQLite. Zero runtime dependencies, single binary, ~5 MB.

![Rust](https://img.shields.io/badge/Rust-1.83+-orange)
![License: MIT](https://img.shields.io/badge/License-MIT-blue)
![SQLite](https://img.shields.io/badge/SQLite-bundled-003B57)

---

## ⚡ 1-Prompt Quick Deploy (copy-paste to any AI agent)

> Paste this prompt to any AI coding assistant (Cursor, Claude, Copilot, etc.) and it will deploy the entire widget on your server:

```
Clone https://github.com/localhost94/ai-visitor-widget and deploy it:
1. Build the Rust binary: cargo build --release
2. Install binary to /opt/ai-visitor-widget/ + create data/ dir
3. Install systemd service from systemd/ai-visitor-widget.service
4. Set env DB_PATH=/opt/ai-visitor-widget/data/visitors.db, PORT=4009, IP_SALT=<random-string>
5. Enable + start the service: sudo systemctl enable --now ai-visitor-widget
6. Add reverse proxy in Caddy/Nginx for widget.<your-domain> → 127.0.0.1:4009
7. Add DNS A record widget.<your-domain> → <server-ip>
8. Verify: curl https://widget.<your-domain>/api/health → {"status":"ok"}
9. Add this snippet before </body> on my site:
   <script>
   (function(){window.AIVW_CONFIG={server:"https://widget.<your-domain>",site:"<your-domain>",position:"bottom-right",theme:"dark",showLabel:true};var s=document.createElement("script");s.src="https://widget.<your-domain>/embed.js";s.async=true;document.head.appendChild(s);})();
   </script>
10. Rebuild + deploy my site
11. Open my site in browser, verify widget badge shows at bottom-right
Replace <your-domain> and <server-ip> with my actual domain and server IP.
```

---

## Why?

Traditional analytics (Plausible, GA, Umami) blend all pageviews together. But in 2026 a significant slice of your traffic is AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Bytespider, …) and GEO/LLM-search agents. This widget shows you — at a glance, on your own site — how many of your visitors are real humans vs AI agents, with:

- 🧑 **Humans counter** — real browsers + SEO crawlers (Googlebot, Bingbot for search indexing)
- 🤖 **AI counter** — LLM training bots, AI search crawlers, programmatic/headless clients
- 📊 Floating widget badge on any website
- 🔒 Privacy-respecting: IP addresses are hashed with a server salt and discarded, never stored raw
- 🚫 **No refresh inflation** — dedup on both client (sessionStorage) and server (1-hour cooldown per IP hash)
- ⚡ Single Rust binary, SQLite database, no external services

---

## Quick Start

### Option A — Binary (fastest)

```bash
git clone https://github.com/localhost94/ai-visitor-widget.git
cd ai-visitor-widget
cargo build --release

# Run
DB_PATH=./visitors.db PORT=4009 ./target/release/ai-visitor-widget
```

The server now listens on `http://0.0.0.0:4009`.

### Option B — Docker

```bash
git clone https://github.com/localhost94/ai-visitor-widget.git
cd ai-visitor-widget
docker compose up -d
```

### Option C — systemd (production)

```bash
sudo cp target/release/ai-visitor-widget /opt/ai-visitor-widget/
sudo mkdir -p /opt/ai-visitor-widget/data
sudo cp systemd/ai-visitor-widget.service /etc/systemd/system/
sudo systemctl enable --now ai-visitor-widget
```

See [`systemd/ai-visitor-widget.service`](systemd/ai-visitor-widget.service).

---

## Integration — any website (1 snippet)

Add this before `</body>` on any HTML page (Astro, Next.js, plain HTML, WordPress, Ghost, etc.):

```html
<script>
  (function () {
    window.AIVW_CONFIG = {
      server: "https://widget.yourdomain.com",
      site: "yourdomain.com",
      position: "bottom-right",
      theme: "dark",
      showLabel: true
    };
    var s = document.createElement("script");
    s.src = "https://widget.yourdomain.com/embed.js";
    s.async = true;
    document.head.appendChild(s);
  })();
</script>
```

### Field Reference

| Field | Required | Default | Values |
|-------|----------|---------|--------|
| `server` | ✅ | — | URL to your widget server, e.g. `https://widget.yourdomain.com` |
| `site` | ✅ | `location.hostname` | Unique site ID, same string across all your pages |
| `position` | option | `bottom-right` | `top-left`, `top-right`, `bottom-left`, `bottom-right` |
| `theme` | option | `dark` | `dark`, `light` |
| `showLabel` | option | `true` | `true` / `false` — show "Humans" / "AI" labels under numbers |

---

## API Endpoints

All endpoints accept and return JSON. CORS is enabled for any origin.

### `POST /api/track`

Records a pageview.

```bash
curl -X POST https://widget.yourdomain.com/api/track \
  -H "Content-Type: application/json" \
  -d '{
    "site": "yourdomain.com",
    "visitorType": "",          // "human" | "ai" | "" (auto-classify from UA)
    "userAgent": "GPTBot/1.0",
    "path": "/blog/ai-search",
    "referrer": "https://google.com"
  }'
```

If `visitorType` is empty, the server classifies based on `userAgent` (see classification list below).

**Response (new visit):** `{"ok": true}`

**Response (dedup — same IP within 1 hour):** `{"ok": true, "dedup": true}`

### `GET /api/stats/:site`

Returns aggregate count for a site.

```bash
curl https://widget.yourdomain.com/api/stats/yourdomain.com
```

```json
{
  "site": "yourdomain.com",
  "human": 1842,
  "ai": 317,
  "total": 2159
}
```

### `GET /api/health`

```json
{"status":"ok","version":"1.0.0"}
```

### `GET /embed.js`

Serves the widget JavaScript (CNAMED anywhere).

### `GET /demo`

Live HTML demo page with the widget showing.

---

## Dedup: How It Works

Refreshing the page should NOT increment the counter. Two layers of dedup prevent this:

### Layer 1 — Client-side (sessionStorage)

1. When `track()` fires, the widget checks `sessionStorage` for key `aivw_tracked_<site>`.
2. If found → **skip the track request entirely** (no network call).
3. If not found → fire `POST /api/track`, then on success set the flag.
4. Session storage clears automatically when the browser tab/session closes.

**Effect:** Reload the same page 100x → counter increments once. Open a new tab or incognito → new visitor.

### Layer 2 — Server-side (1-hour cooldown)

1. On every `POST /api/track`, the server hashes the visitor's IP + its salt.
2. Checks: `SELECT COUNT(*) FROM visitors WHERE site = ? AND ip_hash = ? AND created_at >= datetime('now', '-1 hour')`
3. If a row exists within the last hour → **returns `{"ok":true,"dedup":true}`** without inserting.
4. If no row → inserts the visit.

**Effect:** Even if a script bypasses client-side dedup (curl, bots), the server still blocks duplicates from the same IP within an hour.

---

## Classification Rules

The widget classifies each visitor based on their User-Agent. The logic lives in three places that stay in sync:

| Layer | File | Role |
|-------|------|------|
| Client detector | `widget/embed.js` → `classifyUA()` | Pre-classifies for instant server ping |
| Server classifier | `src/main.rs` → `classify_ua()` | Re-classifies if `visitorType` is empty/invalid |

### Classified as **AI** 🤖 (agents, LLM training, GEO)

- OpenAI: `chatgpt-user`, `gptbot`, `oai-searchbot`, `oai-embedder`
- Anthropic: `anthropic-ai`, `claudebot`, `claude-web`, `claude-user`
- Google AI: `googleother`, `google-extended`
- Perplexity: `perplexitybot`, `perplexity-ur`
- Meta AI: `metaexternalagent`, `meta-externalfetcher`
- ByteDance/TikTok: `bytedance`, `tiktokinsightbot`
- Common crawl: `ccbot`, `commoncrawl`
- Bing/Copilot AI: (bingbot marked separately if you prefer — see "Tuning")
- AI/GEO startups: `turnitinbot`, `youbot`, `diffbot`, `imagesiftbot`, `tractable-smart-crawl`, `velenpublicwebcrawler`
- Programmatic clients: `python-requests`, `httpx`, `node-fetch`, `undici`, `axios`, `curl/`
- Headless/empty UA: `headless`, `phantom`, empty string
- Catch-all: `bot`, `crawler`, `spider`

### Classified as **Human** 🧑 (real browsers + SEO crawlers)

- Real browsers: anything containing `mozilla/`, `chrome/`, `safari/`, `edge/`, `firefox/`, `samsung`, `opera`, `vivaldi` that does **not** match an AI signature first.

> 💡 **Note on SEO:** Classics like Googlebot and Bingbot are not in the AI list — they are treated as human (SEO). The widget name "Humans" doubles for "humans + SEO". If you want SEO separated, add a `seo` category and move those UAs accordingly — see [Tuning](#tuning-the-classifier).

### Classification Order

1. If UA matches any AI signature → `ai`
2. Else if UA matches any human-browser signature → `human`
3. Else if UA is empty or headless → `ai`
4. Else → `human` (default)

---

## Integrating with Frameworks

### Astro

Put the snippet in your base layout, e.g. `src/layouts/Layout.astro`:

```astro
<!-- before </body> -->
<script is:inline>
  (function () {
    window.AIVW_CONFIG = {
      server: "https://widget.yourdomain.com",
      site: "yourdomain.com",
      position: "bottom-right",
      theme: "dark"
    };
    var s = document.createElement("script");
    s.src = "https://widget.yourdomain.com/embed.js";
    s.async = true;
    document.head.appendChild(s);
  })();
</script>
```

### Next.js (App Router) / React

Create `app/_widget.tsx`:

```tsx
export default function VisitorWidget() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `(function(){
          window.AIVW_CONFIG = {
            server: "https://widget.yourdomain.com",
            site: "yourdomain.com"
          };
          var s = document.createElement("script");
          s.src = "https://widget.yourdomain.com/embed.js";
          s.async = true;
          document.head.appendChild(s);
        })();`,
      }}
    />
  );
}
```

Then `<VisitorWidget />` in your root layout.

### Plain HTML / WordPress

Add the snippet before `</body>` in `header.php` or `footer.php`.

### Ghost / Webflow / no-code

Insert > Site Footer > Code Injection — paste the snippet, save.

---

## Deployment Patterns

### Pattern 1: Subdomain (recommended)

DNS A record: `widget.yourdomain.com → your server IP`

Caddy:

```caddy
widget.yourdomain.com {
    reverse_proxy localhost:4009
}
```

Nginx:

```nginx
server {
    server_name widget.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:4009;
    }
}
```

### Pattern 2: Same origin

Run on the same domain as your site at a path prefix. Adjust Caddy/Nginx to route `/widget/*` to port 4009 and update `server` in the snippet accordingly.

---

## Tuning the Classifier

To add a new AI bot you spotted in logs:

1. Open `src/main.rs` → find `ai_signatures` in `classify_ua()`.
2. Add the lowercased UA signature string.
3. Open `widget/embed.js` → find `AI_SIGNATURES` array near the top.
4. Add the same string there.
5. Rebuild (`cargo build --release`) and redeploy.

To reclassify e.g. SEO bots separately:

1. Add a `seo` variant to `visitor_type`.
2. Move SEO UAs (Googlebot, Bingbot) above the human signatures.
3. Add a UI counter pill.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `visitors.db` | SQLite database path |
| `PORT` | `4009` | TCP port to listen |
| `IP_SALT` | random per startup | Salt for one-way IP hash. **Set a fixed value** in production. |

---

## Privacy

- IPs are hashed (SipHash via `DefaultHasher`) with a server-side salt before storage. The original IP is never written to disk.
- No cookies. No fingerprinting beyond UA + IP hash.
- All data is yours — SQLite in your directory. No external service, no telemetry, no cloud.

---

## Project Structure

```
ai-visitor-widget/
├── src/
│   └── main.rs                # Rust server — Axum + SQLite
├── widget/
│   ├── embed.js               # Embeddable widget (1 file, no deps)
│   └── demo.html              # Standalone demo page
├── systemd/
│   └── ai-visitor-widget.service  # systemd unit file
├── Dockerfile
├── docker-compose.yml
├── Cargo.toml
├── .env.example
├── .gitignore
└── README.md                  # (this file)
```

---

## Development

```bash
# Run dev server
cargo run

# Watch and recompile on changes
cargo watch -x run  # requires: cargo install cargo-watch

# Test API
curl -X POST http://localhost:4009/api/track \
  -H "Content-Type: application/json" \
  -d '{"site":"demo","visitorType":"ai","userAgent":"GPTBot/1.0","path":"/","referrer":""}'

curl http://localhost:4009/api/stats/demo

# Open the live demo
open http://localhost:4009/demo
```

---

## License

MIT — see [LICENSE](LICENSE).

---

## Contributing

PRs welcome. Especially:
- New AI crawler UA signatures
- Framework integrations (Astro components, Next.js packages, WP plugin)
- Theme variants
- Language support

Open an issue first for significant structural changes.

---

## Author

**Arya Kusuma** — [GitHub @localhost94](https://github.com/localhost94)

---

*Built to scratch the itch: "How much of my traffic is real humans vs AI agents?" — now you know.*