/// OpenAI-compatible provider — works with any service that implements the
/// OpenAI REST wire format: POST /v1/chat/completions and /v1/images/generations.
///
/// Compatible services: OpenAI, Groq, Fireworks AI, Together AI, Mistral AI,
/// and others. Swap in a different base_url and api_key to target any of them.
use async_trait::async_trait;
use serde_json::{json, Value};

use crate::models::{
    GenerationResponse, ImageGenerationRequest, ModelSummary, TextGenerationRequest,
    UsageSummary, VideoGenerationRequest,
};
use crate::providers::GenerativeModel;

pub struct OpenAICompatProvider {
    name: String,
    base_url: String,
    api_key: String,
    http_client: reqwest::Client,
    default_text_model: String,
    default_image_model: Option<String>,
}

impl OpenAICompatProvider {
    pub fn new(name: impl Into<String>, base_url: impl Into<String>, api_key: String) -> Self {
        Self {
            name: name.into(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key,
            http_client: reqwest::Client::new(),
            default_text_model: "gpt-4o-mini".to_string(),
            default_image_model: None,
        }
    }

    pub fn with_text_model(mut self, model: impl Into<String>) -> Self {
        self.default_text_model = model.into();
        self
    }

    pub fn with_image_model(mut self, model: impl Into<String>) -> Self {
        self.default_image_model = Some(model.into());
        self
    }

    async fn post(&self, path: &str, body: Value) -> anyhow::Result<Value> {
        let url = format!("{}/{}", self.base_url, path.trim_start_matches('/'));
        let resp = self
            .http_client
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let data: Value = resp.json().await.unwrap_or_else(|_| json!({}));
        if !status.is_success() {
            anyhow::bail!("{} API error ({}): {}", self.name, status, data);
        }
        Ok(data)
    }

    /// Map aspect_ratio API string to the closest DALL-E size string.
    /// DALL-E 3 supports 1024x1024, 1792x1024, and 1024x1792 only.
    fn aspect_to_size(aspect: &str) -> &'static str {
        match aspect {
            "16:9" => "1792x1024",
            "9:16" => "1024x1792",
            _ => "1024x1024",
        }
    }

    /// Pull image URLs / base64 out of an OpenAI-style `{ "data": [...] }` body.
    fn extract_image_urls(raw: &Value) -> Vec<String> {
        raw["data"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        item["url"].as_str().map(ToString::to_string).or_else(|| {
                            item["b64_json"]
                                .as_str()
                                .map(|b| format!("data:image/png;base64,{b}"))
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Resolve an image reference to (mime, bytes). Accepts `data:` URLs
    /// (uploads / prior outputs from this app) and public http(s) URLs.
    async fn decode_image(&self, src: &str) -> anyhow::Result<(String, Vec<u8>)> {
        if let Some(rest) = src.strip_prefix("data:") {
            let (meta, data) = rest
                .split_once(',')
                .ok_or_else(|| anyhow::anyhow!("malformed data URL"))?;
            let mime = meta.split(';').next().unwrap_or("image/png").to_string();
            if !meta.contains("base64") {
                anyhow::bail!("only base64 data URLs are supported for image input");
            }
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.trim())
                .map_err(|e| anyhow::anyhow!("invalid base64 image: {e}"))?;
            Ok((mime, bytes))
        } else {
            let resp = self.http_client.get(src).send().await?;
            let mime = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/png")
                .to_string();
            let bytes = resp.bytes().await?.to_vec();
            Ok((mime, bytes))
        }
    }

    /// Image-to-image / editing via the OpenAI-compatible `/v1/images/edits`
    /// endpoint (multipart). Used by services that support it — e.g. Pollinations
    /// FLUX.2 (klein), OpenAI gpt-image-1. The input image(s) are sent as file
    /// parts so `data:` URLs work without a public-hosting step.
    async fn generate_image_edit(
        &self,
        request: &ImageGenerationRequest,
        model: &str,
        images: &[String],
    ) -> anyhow::Result<GenerationResponse> {
        let url = format!("{}/v1/images/edits", self.base_url);
        let size = Self::aspect_to_size(request.aspect_ratio.as_deref().unwrap_or("1:1"));

        let mut form = reqwest::multipart::Form::new()
            .text("model", model.to_string())
            .text("prompt", request.prompt.clone())
            .text("size", size.to_string())
            .text(
                "response_format",
                request.response_format.clone().unwrap_or_else(|| "url".to_string()),
            );

        for (i, img) in images.iter().enumerate() {
            let (mime, bytes) = self.decode_image(img).await?;
            let ext = mime.rsplit('/').next().unwrap_or("png");
            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(format!("image_{i}.{ext}"))
                .mime_str(&mime)?;
            form = form.part("image", part);
        }

        let resp = self
            .http_client
            .post(&url)
            .bearer_auth(&self.api_key)
            .multipart(form)
            .send()
            .await?;
        let status = resp.status();
        let raw: Value = resp.json().await.unwrap_or_else(|_| json!({}));
        if !status.is_success() {
            anyhow::bail!("{} image edit error ({}): {}", self.name, status, raw);
        }

        let media_urls = Self::extract_image_urls(&raw);
        Ok(GenerationResponse {
            provider: self.name.clone(),
            model: model.to_string(),
            status: if media_urls.is_empty() { "failed" } else { "completed" }.to_string(),
            id: None,
            text: None,
            usage: None,
            media_urls,
            raw,
        })
    }
}

#[async_trait]
impl GenerativeModel for OpenAICompatProvider {
    fn provider_name(&self) -> &str {
        &self.name
    }

    async fn list_models(&self) -> anyhow::Result<Vec<ModelSummary>> {
        // /v1/models is optional; not all compat services expose it
        let url = format!("{}/v1/models", self.base_url);
        if let Ok(resp) = self.http_client.get(&url).bearer_auth(&self.api_key).send().await {
            if resp.status().is_success() {
                let data: Value = resp.json().await.unwrap_or_default();
                let models = data["data"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|m| {
                                Some(ModelSummary {
                                    id: m["id"].as_str()?.to_string(),
                                    owned_by: m["owned_by"].as_str().unwrap_or("").to_string(),
                                    created: m["created"].as_u64().unwrap_or(0),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                return Ok(models);
            }
        }
        Ok(vec![ModelSummary {
            id: self.default_text_model.clone(),
            owned_by: self.name.clone(),
            created: 0,
        }])
    }

    async fn generate_text(
        &self,
        request: TextGenerationRequest,
    ) -> anyhow::Result<GenerationResponse> {
        let model = request.model.as_deref().unwrap_or(&self.default_text_model);

        let mut messages = Vec::new();
        if let Some(sys) = &request.system_prompt {
            if !sys.trim().is_empty() {
                messages.push(json!({"role": "system", "content": sys}));
            }
        }
        messages.push(json!({"role": "user", "content": request.prompt}));

        let mut body = json!({ "model": model, "messages": messages });
        if let Some(t) = request.temperature { body["temperature"] = json!(t); }
        if let Some(mt) = request.max_tokens { body["max_tokens"] = json!(mt); }

        let raw = self.post("/v1/chat/completions", body).await?;

        let text = raw["choices"]
            .as_array()
            .and_then(|c| c.first())
            .and_then(|c| c["message"]["content"].as_str())
            .unwrap_or("")
            .to_string();

        let usage = raw["usage"].as_object().map(|u| UsageSummary {
            prompt_tokens:     u["prompt_tokens"].as_u64().unwrap_or(0) as u32,
            completion_tokens: u["completion_tokens"].as_u64().unwrap_or(0) as u32,
            total_tokens:      u["total_tokens"].as_u64().unwrap_or(0) as u32,
        });

        Ok(GenerationResponse {
            provider: self.name.clone(),
            model: model.to_string(),
            status: "completed".to_string(),
            id: raw["id"].as_str().map(ToString::to_string),
            text: Some(text),
            usage,
            media_urls: Vec::new(),
            raw,
        })
    }

    async fn generate_image(
        &self,
        request: ImageGenerationRequest,
    ) -> anyhow::Result<GenerationResponse> {
        let model = match request.model.as_deref().or(self.default_image_model.as_deref()) {
            Some(m) => m.to_string(),
            None => anyhow::bail!("{}: no image model configured", self.name),
        };

        // Image-to-image / editing when reference image(s) are supplied — routes
        // to the multipart `/v1/images/edits` endpoint instead of text-to-image.
        if let Some(images) = request.image_urls.as_deref() {
            if !images.is_empty() {
                return self.generate_image_edit(&request, &model, images).await;
            }
        }

        let size = Self::aspect_to_size(request.aspect_ratio.as_deref().unwrap_or("1:1"));
        let body = json!({
            "model": model,
            "prompt": request.prompt,
            "n": 1,
            "size": size,
            "response_format": request.response_format.as_deref().unwrap_or("url"),
        });

        let raw = self.post("/v1/images/generations", body).await?;

        let media_urls = Self::extract_image_urls(&raw);

        Ok(GenerationResponse {
            provider: self.name.clone(),
            model,
            status: if media_urls.is_empty() { "failed" } else { "completed" }.to_string(),
            id: None,
            text: None,
            usage: None,
            media_urls,
            raw,
        })
    }

    async fn generate_video(
        &self,
        _request: VideoGenerationRequest,
    ) -> anyhow::Result<GenerationResponse> {
        anyhow::bail!(
            "{} does not support video generation via the OpenAI-compatible API",
            self.name
        )
    }

    async fn video_status(&self, _id: &str) -> anyhow::Result<GenerationResponse> {
        anyhow::bail!("{} video status not supported", self.name)
    }
}
