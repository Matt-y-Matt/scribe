//! Speech to text (ARCHITECTURE §2): one finished utterance in, its text out.
//!
//! [`LocalSherpa`] runs a model from the catalogue on this PC through
//! sherpa-onnx. Nothing here touches the network.

pub mod models;

use std::path::Path;

use sherpa_onnx::{
    OfflineQwen3ASRModelConfig, OfflineRecognizer, OfflineRecognizerConfig,
    OfflineTransducerModelConfig, OfflineWhisperModelConfig,
};

use crate::audio::SAMPLE_RATE;
use models::{Engine, ModelSpec};

#[derive(Debug, Clone, PartialEq)]
pub struct Transcript {
    pub text: String,
    /// 0 to 1. sherpa-onnx gives no score for these models, so a local
    /// transcript is always 1.0.
    pub confidence: f32,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SttError {
    #[error("the speech model is not installed")]
    NotInstalled,
    #[error("the speech model could not be loaded")]
    LoadFailed,
}

pub trait Transcriber: Send + Sync {
    /// Transcribes one utterance of 16 kHz mono audio. An utterance with no
    /// words in it gives an empty text.
    /// Called from one thread per audio source, so two utterances may be
    /// in flight at once.
    fn transcribe(&self, samples: &[f32]) -> Transcript;
}

pub struct LocalSherpa {
    recognizer: OfflineRecognizer,
}

/// Threads for one recognition. More than the physical cores of a small CPU
/// only adds contention with capture and the UI.
pub fn default_threads() -> i32 {
    std::thread::available_parallelism()
        .map(|cores| (cores.get() / 2).clamp(2, 6) as i32)
        .unwrap_or(2)
}

impl LocalSherpa {
    /// Loads `spec` from the app data folder. `provider` is `cpu`, or an
    /// ONNX Runtime provider the linked sherpa-onnx build supports.
    pub fn load(
        spec: &ModelSpec,
        data_dir: &Path,
        threads: i32,
        provider: &str,
    ) -> Result<Self, SttError> {
        if !models::is_installed(data_dir, spec) {
            return Err(SttError::NotInstalled);
        }
        let dir = models::model_dir(data_dir, spec);
        let file = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());

        let mut config = OfflineRecognizerConfig::default();
        match spec.engine {
            Engine::Parakeet => {
                config.model_config.transducer = OfflineTransducerModelConfig {
                    encoder: file("encoder.int8.onnx"),
                    decoder: file("decoder.int8.onnx"),
                    joiner: file("joiner.int8.onnx"),
                };
                config.model_config.tokens = file("tokens.txt");
                config.model_config.model_type = Some("nemo_transducer".to_string());
            }
            Engine::Whisper => {
                config.model_config.whisper = OfflineWhisperModelConfig {
                    encoder: file("turbo-encoder.int8.onnx"),
                    decoder: file("turbo-decoder.int8.onnx"),
                    // Empty: Whisper detects the language of each utterance.
                    language: Some(String::new()),
                    task: Some("transcribe".to_string()),
                    ..Default::default()
                };
                config.model_config.tokens = file("turbo-tokens.txt");
            }
            Engine::Qwen3 => {
                config.model_config.qwen3_asr = OfflineQwen3ASRModelConfig {
                    conv_frontend: file("conv_frontend.onnx"),
                    encoder: file("encoder.int8.onnx"),
                    decoder: file("decoder.int8.onnx"),
                    tokenizer: file("tokenizer"),
                    // An utterance is at most 30 s: well under this.
                    max_new_tokens: 512,
                    ..Default::default()
                };
                // The tokenizer folder stands in for a tokens file.
                config.model_config.tokens = Some(String::new());
            }
        }
        config.model_config.num_threads = threads;
        config.model_config.provider = Some(provider.to_string());
        config.model_config.debug = false;

        OfflineRecognizer::create(&config)
            .map(|recognizer| Self { recognizer })
            .ok_or(SttError::LoadFailed)
    }
}

impl Transcriber for LocalSherpa {
    fn transcribe(&self, samples: &[f32]) -> Transcript {
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(SAMPLE_RATE as i32, samples);
        self.recognizer.decode(&stream);
        let text = stream
            .get_result()
            .map(|result| result.text.trim().to_string())
            .unwrap_or_default();
        Transcript {
            text,
            confidence: 1.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_model_that_is_not_on_disk_is_not_loaded() {
        let nowhere = std::env::temp_dir().join("scribe-stt-no-models");
        let result = LocalSherpa::load(&models::CATALOGUE[0], &nowhere, 2, "cpu");
        assert_eq!(result.err(), Some(SttError::NotInstalled));
    }

    #[test]
    fn threads_stay_between_two_and_six() {
        assert!((2..=6).contains(&default_threads()));
    }
}
