use async_trait::async_trait;
use serde_json::{json, Value};

use crate::models::{
    GenerationResponse, ImageGenerationRequest, ModelSummary, TextGenerationRequest,
    VideoGenerationRequest,
};
use crate::providers::GenerativeModel;

pub struct GeminiProvider {
    api_key: String,
    http_client: reqwest::Client,
    text_model: String,
    image_model: String,
    image_edit_model: String,
}

impl GeminiProvider {
    const BASE_URL: &'static str = "https://generativelanguage.googleapis.com/v1beta";

    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            http_client: reqwest::Client::new(),
            text_model: "gemini-1.5-flash".to_string(),
            image_model: "imagen-4.0-generate-001".to_string(),
            // Multimodal model that accepts image input and returns images
            // ("Nano Banana") — used for img2img / editing via :generateContent.
            image_edit_model: "gemini-2.5-flash-image".to_string(),
        }
    }

    async fn post_json(&self, url: &str, payload: Value) -> anyhow::Result<Value> {
        let resp = self
            .http_client
            .post(url)
            .json(&payload)
            .send()
            .await?;
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or_else(|_| json!({}));
        if !status.is_success() {
            let public_url = url.split('?').next().unwrap_or(url);
            anyhow::bail!("Gemini API error ({}) {}: {}", status, public_url, body);
        }
        Ok(body)
    }

    /// Resolve an image reference to (mime, base64-data). Accepts `data:` URLs
    /// (uploads / prior outputs from this app) and public http(s) URLs. Gemini's
    /// `:generateContent` wants images as inline base64, so http(s) refs are
    /// fetched and re-encoded.
    async fn decode_image_b64(&self, src: &str) -> anyhow::Result<(String, String)> {
        use base64::Engine;
        let engine = base64::engine::general_purpose::STANDARD;
        if let Some(rest) = src.strip_prefix("data:") {
            let (meta, data) = rest
                .split_once(',')
                .ok_or_else(|| anyhow::anyhow!("malformed data URL"))?;
            let mime = meta.split(';').next().unwrap_or("image/png").to_string();
            if !meta.contains("base64") {
                anyhow::bail!("only base64 data URLs are supported for image input");
            }
            // Re-encode after a decode round-trip to normalize whitespace/padding.
            let bytes = engine
                .decode(data.trim())
                .map_err(|e| anyhow::anyhow!("invalid base64 image: {e}"))?;
            Ok((mime, engine.encode(bytes)))
        } else {
            let resp = self.http_client.get(src).send().await?;
            let mime = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/png")
                .to_string();
            let bytes = resp.bytes().await?.to_vec();
            Ok((mime, engine.encode(bytes)))
        }
    }

    /// Image-to-image / editing via the multimodal `:generateContent` endpoint.
    /// The reference image(s) ride along as inline base64 parts next to the text
    /// prompt; the model returns an edited image in the response parts.
    async fn generate_image_edit(
        &self,
        request: &ImageGenerationRequest,
        images: &[String],
    ) -> anyhow::Result<GenerationResponse> {
        // Always the multimodal image-output model — the registry's Google model
        // ids (e.g. gemini-2.0-flash) can't emit images, so we don't trust a
        // passed id here, mirroring the Imagen text-to-image path above.
        let model = &self.image_edit_model;
        let url = format!(
            "{}/models/{}:generateContent?key={}",
            Self::BASE_URL,
            model,
            self.api_key
        );

        let mut parts = vec![json!({ "text": request.prompt })];
        for img in images {
            let (mime, data) = self.decode_image_b64(img).await?;
            parts.push(json!({ "inline_data": { "mime_type": mime, "data": data } }));
        }

        let payload = json!({
            "contents": [{ "parts": parts }],
            "generationConfig": { "responseModalities": ["IMAGE"] }
        });

        let raw = self.post_json(&url, payload).await?;

        // Returned image(s) live in candidates[].content.parts[].inlineData.
        let media_urls: Vec<String> = raw["candidates"]
            .as_array()
            .map(|cands| {
                cands
                    .iter()
                    .flat_map(|c| c["content"]["parts"].as_array().cloned().unwrap_or_default())
                    .filter_map(|part| {
                        let inline = part.get("inlineData").or_else(|| part.get("inline_data"))?;
                        let b64 = inline["data"].as_str()?;
                        let mime = inline["mimeType"]
                            .as_str()
                            .or_else(|| inline["mime_type"].as_str())
                            .unwrap_or("image/png");
                        Some(format!("data:{};base64,{}", mime, b64))
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(GenerationResponse {
            provider: "google".to_string(),
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
impl GenerativeModel for GeminiProvider {
    fn provider_name(&self) -> &str {
        "google"
    }

    async fn list_models(&self) -> anyhow::Result<Vec<ModelSummary>> {
        Ok(vec![
            ModelSummary {
                id: "gemini-2.0-flash".to_string(),
                owned_by: "google".to_string(),
                created: 0,
            },
            ModelSummary {
                id: "gemini-2.0-flash-thinking-exp".to_string(),
                owned_by: "google".to_string(),
                created: 0,
            },
            ModelSummary {
                id: "imagen-3.0-generate-002".to_string(),
                owned_by: "google".to_string(),
                created: 0,
            },
        ])
    }

    async fn generate_text(
        &self,
        request: TextGenerationRequest,
    ) -> anyhow::Result<GenerationResponse> {
        let model = request.model.as_deref().unwrap_or(&self.text_model);
        let url = format!(
            "{}/models/{}:generateContent?key={}",
            Self::BASE_URL,
            model,
            self.api_key
        );

        let mut parts = Vec::new();
        if let Some(sys) = &request.system_prompt {
            if !sys.trim().is_empty() {
                parts.push(json!({ "text": sys }));
            }
        }
        parts.push(json!({ "text": request.prompt }));

        let payload = json!({
            "contents": [{ "parts": parts }],
            "generationConfig": {
                "maxOutputTokens": request.max_tokens.unwrap_or(1024)
            }
        });

        let raw = self.post_json(&url, payload).await?;

        let text = raw["candidates"]
            .as_array()
            .and_then(|c| c.first())
            .and_then(|c| c["content"]["parts"].as_array())
            .and_then(|p| p.first())
            .and_then(|p| p["text"].as_str())
            .unwrap_or("")
            .to_string();

        Ok(GenerationResponse {
            provider: "google".to_string(),
            model: model.to_string(),
            status: "completed".to_string(),
            id: None,
            text: Some(text),
            usage: None,
            media_urls: Vec::new(),
            raw,
        })
    }

    async fn generate_image(
        &self,
        request: ImageGenerationRequest,
    ) -> anyhow::Result<GenerationResponse> {
        // Img2img / editing when reference image(s) are supplied — routes to the
        // multimodal :generateContent endpoint instead of Imagen text-to-image.
        if let Some(images) = request.image_urls.as_deref() {
            if !images.is_empty() {
                return self.generate_image_edit(&request, images).await;
            }
        }

        let url = format!(
            "{}/models/{}:predict?key={}",
            Self::BASE_URL,
            self.image_model,
            self.api_key
        );

        let aspect = request.aspect_ratio.as_deref().unwrap_or("1:1");
        let payload = json!({
            "instances": [{ "prompt": request.prompt }],
            "parameters": {
                "sampleCount": 1,
                "aspectRatio": aspect
            }
        });

        let raw = self.post_json(&url, payload).await?;

        // Imagen returns base64-encoded images; convert to data URLs so the
        // existing gallery renderer can display them without a separate upload step.
        let media_urls: Vec<String> = raw["predictions"]
            .as_array()
            .map(|preds| {
                preds
                    .iter()
                    .filter_map(|pred| {
                        let b64 = pred["bytesBase64Encoded"].as_str()?;
                        let mime = pred["mimeType"].as_str().unwrap_or("image/png");
                        Some(format!("data:{};base64,{}", mime, b64))
                    })
                    .collect()
            })
            .unwrap_or_default();

        let status = if media_urls.is_empty() {
            "failed".to_string()
        } else {
            "completed".to_string()
        };

        Ok(GenerationResponse {
            provider: "google".to_string(),
            model: self.image_model.clone(),
            status,
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
            "Gemini video generation is not yet implemented — use xAI provider for video"
        )
    }

    async fn video_status(&self, _id: &str) -> anyhow::Result<GenerationResponse> {
        anyhow::bail!("Gemini video status is not yet implemented")
    }
}
