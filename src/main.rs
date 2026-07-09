use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{Html, Json, IntoResponse},
    routing::{get, post},
    Router,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::env;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

// ============================================================================
// Data structures
// ============================================================================

#[derive(Serialize, Deserialize, Debug)]
struct TrackRequest {
    site: String,
    #[serde(rename = "visitorType")]
    visitor_type: String, // "human" | "ai"
    #[serde(rename = "userAgent")]
    user_agent: Option<String>,
    path: Option<String>,
    referrer: Option<String>,
}

#[derive(Serialize)]
struct StatsResponse {
    site: String,
    human: i64,
    ai: i64,
    total: i64,
}

#[derive(Serialize)]
struct HealthResponse {
    status: String,
    version: String,
}

// ============================================================================
// Database
// ============================================================================

fn init_db(db_path: &str) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS visitors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site TEXT NOT NULL,
            visitor_type TEXT NOT NULL,
            user_agent TEXT,
            page_path TEXT,
            referrer TEXT,
            ip_hash TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_visitors_site
            ON visitors(site);

        CREATE INDEX IF NOT EXISTS idx_visitors_site_type
            ON visitors(site, visitor_type);

        CREATE INDEX IF NOT EXISTS idx_visitors_created
            ON visitors(created_at);

        -- Dedup index: one row per (site, ip_hash) per hour
        -- prevents refresh spam from same visitor inflating counts
        CREATE INDEX IF NOT EXISTS idx_visitors_dedup
            ON visitors(site, ip_hash, created_at);
        "#,
    )?;
    Ok(conn)
}

// ============================================================================
// Classification logic — used both server-side and documented for client JS
// ============================================================================

/// Classify a User-Agent string as either "ai" or "human".
///
/// This list is maintained to match the client-side detection in
/// `widget/embed.js` so that both sides agree on classification
/// regardless of whichever layer makes the final call.
fn classify_ua(ua: &str) -> &'static str {
    let ua_lower = ua.to_lowercase();

    // --- AI crawlers / agents / GEO / LLM training ---
    let ai_signatures: &[&str] = &[
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
        // Generic
        "bot", "crawler", "spider",
        // Programmatic / headless clients
        "python-requests", "httpx", "node-fetch", "undici",
        "axios", "got/", "curl/",
    ];

    let human_signatures: &[&str] = &[
        "mozilla/", "chrome/", "safari/", "edge/",
        "firefox/", "samsung", "opera", "vivaldi",
    ];

    // 1) explicit AI match wins
    for sig in ai_signatures {
        if ua_lower.contains(sig) {
            return "ai";
        }
    }

    // 2) if it looks like a human browser and met no AI match → human (SEO counts human)
    for sig in human_signatures {
        if ua_lower.contains(sig) {
            return "human";
        }
    }

    // 3) Unknown / headless / empty UA → treat conservatively as ai
    if ua_lower.is_empty() || ua_lower.contains("headless") || ua_lower.contains("phantom") {
        return "ai";
    }

    // 4) default: human
    "human"
}

// ============================================================================
// Hash IP for privacy
// ============================================================================

fn hash_ip(ip: &str, salt: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    ip.hash(&mut hasher);
    salt.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

// ============================================================================
// Handlers
// ============================================================================

async fn track(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<TrackRequest>,
) -> impl IntoResponse {
    // If visitorType is missing or empty, classify from UA
    let vtype = match req.visitor_type.as_str() {
        "human" | "ai" => req.visitor_type.clone(),
        _ => {
            let ua = req
                .user_agent
                .clone()
                .or_else(|| headers.get("user-agent").and_then(|v| v.to_str().ok()).map(String::from))
                .unwrap_or_default();
            classify_ua(&ua).to_string()
        }
    };

    let ua = req
        .user_agent
        .or_else(|| headers.get("user-agent").and_then(|v| v.to_str().ok()).map(String::from))
        .unwrap_or_default();

    let ip_raw = headers
        .get("x-forwarded-for")
        .or_else(|| headers.get("x-real-ip"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .split(',')
        .next()
        .unwrap_or("unknown")
        .trim();

    let ip_hash = hash_ip(ip_raw, &state.salt);

    // ── Server-side dedup ──
    // Block if this (site, ip_hash) already has a row within the last hour.
    // Double safety alongside client-side sessionStorage dedup.
    let db = state.db.lock().unwrap();
    let recent_count: i64 = db
        .query_row(
            r#"SELECT COUNT(*) FROM visitors
               WHERE site = ?1 AND ip_hash = ?2
                 AND created_at >= datetime('now', '-1 hour')"#,
            params![req.site, &ip_hash],
            |row| row.get(0),
        )
        .unwrap_or(0);

    if recent_count > 0 {
        // Duplicate visit — silently acknowledge without inserting
        return (
            StatusCode::OK,
            Json(serde_json::json!({"ok": true, "dedup": true})),
        );
    }

    let result = db.execute(
        r#"
        INSERT INTO visitors (site, visitor_type, user_agent, page_path, referrer, ip_hash)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
        params![
            req.site,
            vtype,
            ua,
            req.path,
            req.referrer,
            ip_hash
        ],
    );

    match result {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))),
        Err(e) => {
            tracing::error!("DB insert error: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"ok": false, "error": e.to_string()})),
            )
        }
    }
}

async fn stats(
    State(state): State<Arc<AppState>>,
    Path(site): Path<String>,
) -> impl IntoResponse {
    let db = state.db.lock().unwrap();
    let human: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM visitors WHERE site = ?1 AND visitor_type = 'human'",
            params![site],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let ai: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM visitors WHERE site = ?1 AND visitor_type = 'ai'",
            params![site],
            |row| row.get(0),
        )
        .unwrap_or(0);

    Json(StatsResponse {
        site,
        human,
        ai,
        total: human + ai,
    })
}

async fn health() -> impl IntoResponse {
    Json(HealthResponse {
        status: "ok".into(),
        version: env!("CARGO_PKG_VERSION").into(),
    })
}

async fn serve_embed() -> impl IntoResponse {
    let js = include_str!("../widget/embed.js");
    (
        StatusCode::OK,
        [
            ("content-type", "application/javascript"),
            ("cache-control", "public, max-age=300"),
        ],
        js,
    )
}

async fn serve_demo() -> impl IntoResponse {
    let html = include_str!("../widget/demo.html");
    Html(html)
}

// ============================================================================
// App state
// ============================================================================

struct AppState {
    db: std::sync::Mutex<Connection>,
    salt: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ai_visitor_widget=info,tower_http=info".into()),
        )
        .init();

    let db_path = env::var("DB_PATH").unwrap_or_else(|_| "visitors.db".to_string());
    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(4009);
    let salt = env::var("IP_SALT").unwrap_or_else(|_| {
        use std::time::{SystemTime, UNIX_EPOCH};
        format!(
            "salt-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    });

    let db = init_db(&db_path).expect("Failed to initialize database");
    let state = Arc::new(AppState {
        db: std::sync::Mutex::new(db),
        salt,
    });

    let cors = CorsLayer::very_permissive();

    let app = Router::new()
        .route("/api/track", post(track))
        .route("/api/stats/{site}", get(stats))
        .route("/api/health", get(health))
        .route("/embed.js", get(serve_embed))
        .route("/demo", get(serve_demo))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    tracing::info!("🚀 ai-visitor-widget listening on http://{addr}");
    tracing::info!("   DB: {db_path}");

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}