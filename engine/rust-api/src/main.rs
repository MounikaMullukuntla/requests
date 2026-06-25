mod config;
mod error;
mod models;
mod providers;
mod task3d;

use std::io::Write;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::{info, Level};
use tracing_subscriber::EnvFilter;

use chrono;

use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use crate::models::{
    HealthResponse, ListModelsResponse, TextGenerationRequest, ImageGenerationRequest,
    ThreeDGenerationRequest, VideoGenerationRequest,
};
use crate::providers::{build_provider, build_provider_dynamic, GenerativeModel};

#[derive(Clone)]
struct AppState {
    provider: Arc<dyn GenerativeModel>,
    available_providers: Vec<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_max_level(Level::INFO)
        .init();

    let config = AppConfig::load()?;
    let provider = build_provider(&config)?;

    let mut available_providers: Vec<String> = Vec::new();
    if !config.xai_api_key.is_empty()        { available_providers.push("xai".to_string()); }
    if config.openai_api_key.is_some()        { available_providers.push("openai".to_string()); }
    if config.gemini_api_key.is_some()        { available_providers.push("google".to_string()); }
    if config.claude_api_key.is_some()
        || config.anthropic_api_key.is_some() { available_providers.push("anthropic".to_string()); }

    let app_state = AppState { provider, available_providers };

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/server-keys", get(server_keys))
        .route("/api/models", get(list_models))
        .route("/api/generate/text", post(generate_text))
        .route("/api/generate/image", post(generate_image))
        .route("/api/generate/video", post(generate_video))
        .route("/api/generate/video/{id}", get(video_status))
        .route("/api/generate/3d", post(generate_3d))
        .route("/api/upload/tripo", post(upload_tripo_image))
        .route("/api/proxy/model", get(proxy_model))
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .layer(TraceLayer::new_for_http())
        .with_state(app_state);

    let bind = format!("{}:{}", config.server_host, config.server_port);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    info!("arts_engine_api listening on http://{bind}");
    axum::serve(listener, app).await?;

    Ok(())
}

/// Return a per-request provider when the frontend supplies X-Provider-Name and
/// X-Provider-Key headers (local storage key takes priority over docker/.env).
/// X-Provider-URL is optional: required only for unknown provider names, which
/// are routed through openai_compat as a fallback.
/// Falls back to the default AppState provider when headers are absent.
fn resolve_request_provider(
    state: &AppState,
    headers: &HeaderMap,
) -> anyhow::Result<Arc<dyn GenerativeModel>> {
    let get = |h| headers.get(h).and_then(|v| v.to_str().ok()).filter(|s| !s.is_empty());
    let name = get("x-provider-name");
    let key  = get("x-provider-key");
    let url  = get("x-provider-url");
    match (name, key) {
        (Some(n), Some(k)) => {
            info!("Using per-request provider '{}' from request headers", n);
            build_provider_dynamic(n, k, url)
        }
        _ => Ok(Arc::clone(&state.provider)),
    }
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        provider: state.provider.provider_name().to_string(),
        available_providers: state.available_providers.clone(),
        message: "Arts Engine API is ready".to_string(),
    })
}

async fn server_keys(State(state): State<AppState>) -> Json<Vec<String>> {
    Json(state.available_providers.clone())
}

async fn list_models(State(state): State<AppState>) -> AppResult<Json<ListModelsResponse>> {
    let models = state.provider.list_models().await?;
    Ok(Json(ListModelsResponse { models }))
}

async fn generate_text(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TextGenerationRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let provider = resolve_request_provider(&state, &headers)?;
    let response = provider.generate_text(payload).await?;
    Ok(Json(serde_json::to_value(response)?))
}

async fn generate_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ImageGenerationRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let provider = resolve_request_provider(&state, &headers)?;
    let response = provider.generate_image(payload).await?;
    Ok(Json(serde_json::to_value(response)?))
}

async fn generate_video(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<VideoGenerationRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let provider = resolve_request_provider(&state, &headers)?;
    let prompt = payload.prompt.clone();
    let response = provider.generate_video(payload).await?;
    if let Some(id) = &response.id {
        append_mycontent_csv(&prompt, id);
    }
    Ok(Json(serde_json::to_value(response)?))
}

/// 3D generation is fully config-driven (see task3d): the request body carries
/// the provider's task-API spec from providers.js, and the API key comes from
/// the X-Provider-Key header. No provider object or routing is involved.
async fn generate_3d(
    headers: HeaderMap,
    Json(payload): Json<ThreeDGenerationRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let key = headers
        .get("x-provider-key")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError(anyhow::anyhow!("3D generation requires a provider API key (X-Provider-Key)")))?;
    let response = task3d::run(payload, key).await?;
    Ok(Json(serde_json::to_value(response)?))
}

#[derive(Deserialize)]
struct TripoImageUploadRequest {
    image: String,
}

async fn upload_tripo_image(
    headers: HeaderMap,
    Json(payload): Json<TripoImageUploadRequest>,
) -> AppResult<Json<serde_json::Value>> {
    use base64::Engine;

    let key = headers
        .get("x-provider-key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError(anyhow::anyhow!("Tripo upload requires X-Provider-Key")))?;
    let encoded = payload
        .image
        .strip_prefix("data:")
        .ok_or_else(|| AppError(anyhow::anyhow!("Tripo upload requires a data URL")))?;
    let (metadata, data) = encoded
        .split_once(',')
        .ok_or_else(|| AppError(anyhow::anyhow!("malformed image data URL")))?;
    if !metadata.contains("base64") {
        return Err(AppError(anyhow::anyhow!("image data URL must be base64")));
    }
    let mime = metadata.split(';').next().unwrap_or("image/jpeg");
    let extension = match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        _ => return Err(AppError(anyhow::anyhow!("Tripo supports JPEG or PNG input"))),
    };
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim())?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err(AppError(anyhow::anyhow!("Tripo image input exceeds 20 MB")));
    }
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(format!("node-input.{extension}"))
        .mime_str(mime)?;
    let form = reqwest::multipart::Form::new().part("file", part);
    let response = reqwest::Client::new()
        .post("https://api.tripo3d.ai/v2/openapi/upload")
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await?;
    let status = response.status();
    let raw: serde_json::Value = response.json().await.unwrap_or_default();
    if !status.is_success() || raw["code"].as_i64().unwrap_or(0) != 0 {
        return Err(AppError(anyhow::anyhow!("Tripo upload failed: {raw}")));
    }
    let token = raw["data"]["image_token"]
        .as_str()
        .ok_or_else(|| AppError(anyhow::anyhow!("Tripo upload returned no image token")))?;
    Ok(Json(serde_json::json!({
        "file_token": token,
        "file_type": extension,
    })))
}

#[derive(Deserialize)]
struct ModelProxyQuery {
    url: String,
}

/// Fetch a generated model through the local API so browser viewers are not
/// blocked by provider storage CORS policies.
async fn proxy_model(Query(query): Query<ModelProxyQuery>) -> AppResult<Response> {
    let url = reqwest::Url::parse(&query.url)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError(anyhow::anyhow!("model URL must use http or https")));
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host.is_empty() || host == "localhost" || host.ends_with(".localhost") {
        return Err(AppError(anyhow::anyhow!("invalid model host")));
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        let private = match ip {
            std::net::IpAddr::V4(ip) => ip.is_private() || ip.is_link_local(),
            std::net::IpAddr::V6(ip) => ip.is_unique_local() || ip.is_unicast_link_local(),
        };
        if private || ip.is_loopback() || ip.is_unspecified() {
            return Err(AppError(anyhow::anyhow!("invalid model host")));
        }
    }

    let upstream = reqwest::Client::new().get(url).send().await?;
    if !upstream.status().is_success() {
        return Err(AppError(anyhow::anyhow!(
            "model host returned HTTP {}",
            upstream.status()
        )));
    }
    if upstream.content_length().is_some_and(|length| length > 100 * 1024 * 1024) {
        return Err(AppError(anyhow::anyhow!("model exceeds 100 MB proxy limit")));
    }
    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| header::HeaderValue::from_static("model/gltf-binary"));
    let bytes = upstream.bytes().await?;
    if bytes.len() > 100 * 1024 * 1024 {
        return Err(AppError(anyhow::anyhow!("model exceeds 100 MB proxy limit")));
    }
    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "private, max-age=3600")
        .body(Body::from(bytes))?;
    Ok(response)
}

fn append_mycontent_csv(prompt: &str, request_id: &str) {
    let path = "../mycontent.csv";
    let needs_header = !std::path::Path::new(path).exists();
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path);
    if let Ok(mut f) = file {
        if needs_header {
            let _ = writeln!(f, "DateTime,Prompt,URLPath");
        }
        let dt = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ");
        let url_path = format!("/v1/videos/generations/{}", request_id);
        let escaped = prompt.replace('"', "\"\"");
        let _ = writeln!(f, "{},\"{}\",{}", dt, escaped, url_path);
    }
}

async fn video_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let response = state.provider.video_status(&id).await?;
    Ok(Json(serde_json::to_value(response)?))
}
