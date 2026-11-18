//! The speech models Scribe can run, and how they reach the PC (PRD F3.4).
//!
//! Models are not shipped with the app. Each file is fetched from Hugging
//! Face at a pinned revision, resumed where a cancelled download stopped,
//! and checked against its SHA-256 before it is used. The download carries
//! no audio and no text, and happens only when the user asks for it.

use std::io::Read;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    /// NVIDIA Parakeet-TDT, a transducer: encoder, decoder, joiner.
    Parakeet,
    /// OpenAI Whisper: encoder, decoder.
    Whisper,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelFile {
    pub name: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelSpec {
    pub id: &'static str,
    pub title: &'static str,
    pub engine: Engine,
    pub languages: &'static str,
    pub licence: &'static str,
    /// Hugging Face repository and the commit the hashes below belong to.
    pub repo: &'static str,
    pub revision: &'static str,
    pub files: &'static [ModelFile],
}

impl ModelSpec {
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.bytes).sum()
    }
}

/// The default comes first (DECISIONS 2026-11-17: Parakeet locally).
pub const CATALOGUE: &[ModelSpec] = &[
    ModelSpec {
        id: "parakeet-tdt-0.6b-v3-int8",
        title: "Parakeet-TDT 0.6B v3",
        engine: Engine::Parakeet,
        languages: "English and 24 other European languages",
        licence: "CC-BY-4.0",
        repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        revision: "ed5d745623472f97cfc2e6c2916ee248798fc5a8",
        files: &[
            ModelFile {
                name: "encoder.int8.onnx",
                bytes: 652_282_294,
                sha256: "1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479",
            },
            ModelFile {
                name: "decoder.int8.onnx",
                bytes: 11_845_274,
                sha256: "0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5",
            },
            ModelFile {
                name: "joiner.int8.onnx",
                bytes: 6_355_277,
                sha256: "cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98",
            },
            ModelFile {
                name: "tokens.txt",
                bytes: 93_939,
                sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
            },
        ],
    },
    ModelSpec {
        id: "whisper-large-v3-turbo-int8",
        title: "Whisper large-v3-turbo",
        engine: Engine::Whisper,
        languages: "Multilingual (99 languages)",
        licence: "MIT",
        repo: "csukuangfj/sherpa-onnx-whisper-turbo",
        revision: "2ca6ff69fc878651b770880507669577ac41c2ff",
        files: &[
            ModelFile {
                name: "turbo-encoder.int8.onnx",
                bytes: 674_716_297,
                sha256: "b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b",
            },
            ModelFile {
                name: "turbo-decoder.int8.onnx",
                bytes: 361_080_764,
                sha256: "20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547",
            },
            ModelFile {
                name: "turbo-tokens.txt",
                bytes: 816_730,
                sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
            },
        ],
    },
];

pub const DEFAULT_MODEL: &str = CATALOGUE[0].id;

pub fn spec(id: &str) -> Option<&'static ModelSpec> {
    CATALOGUE.iter().find(|spec| spec.id == id)
}

/// Where a model's files live under the app data folder.
pub fn model_dir(data_dir: &Path, spec: &ModelSpec) -> PathBuf {
    data_dir.join("models").join(spec.id)
}

/// A model is installed when every file is there at its full size. The hash
/// was checked before the file got its final name.
pub fn is_installed(data_dir: &Path, spec: &ModelSpec) -> bool {
    let dir = model_dir(data_dir, spec);
    spec.files.iter().all(|file| {
        std::fs::metadata(dir.join(file.name)).is_ok_and(|meta| meta.len() == file.bytes)
    })
}

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("the download was cancelled")]
    Cancelled,
    #[error("{file} did not match its checksum after two downloads")]
    Checksum { file: String },
    #[error("the server answered {status} for {file}")]
    Status { file: String, status: u16 },
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("disk error: {0}")]
    Disk(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub bytes: u64,
    pub total: u64,
}

pub struct Downloader {
    /// `https://huggingface.co`, or a local server in tests.
    pub base_url: String,
    pub client: reqwest::Client,
}

impl Default for Downloader {
    fn default() -> Self {
        Self {
            base_url: "https://huggingface.co".to_string(),
            client: reqwest::Client::new(),
        }
    }
}

pub fn sha256_of(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

impl Downloader {
    fn url(&self, spec: &ModelSpec, file: &ModelFile) -> String {
        format!(
            "{}/{}/resolve/{}/{}",
            self.base_url, spec.repo, spec.revision, file.name
        )
    }

    /// Fetches every missing file of `spec` into the app data folder.
    /// `on_progress` hears the bytes on disk so far across all files.
    pub async fn download(
        &self,
        spec: &ModelSpec,
        data_dir: &Path,
        cancel: &CancellationToken,
        mut on_progress: impl FnMut(Progress),
    ) -> Result<(), DownloadError> {
        let dir = model_dir(data_dir, spec);
        tokio::fs::create_dir_all(&dir).await?;
        let total = spec.total_bytes();
        let mut done_before = 0u64;

        for file in spec.files {
            let target = dir.join(file.name);
            let have = tokio::fs::metadata(&target).await.map(|meta| meta.len());
            if !have.is_ok_and(|len| len == file.bytes) {
                let mut attempts = 0;
                loop {
                    attempts += 1;
                    self.fetch(spec, file, &dir, cancel, &mut |in_file| {
                        on_progress(Progress {
                            bytes: done_before + in_file,
                            total,
                        });
                    })
                    .await?;
                    let part = part_path(&dir, file);
                    let check = part.clone();
                    let hash = tokio::task::spawn_blocking(move || sha256_of(&check))
                        .await
                        .map_err(std::io::Error::other)??;
                    if hash == file.sha256 {
                        tokio::fs::rename(&part, &target).await?;
                        break;
                    }
                    // A corrupt file is downloaded again, once.
                    tokio::fs::remove_file(&part).await?;
                    if attempts == 2 {
                        return Err(DownloadError::Checksum {
                            file: file.name.to_string(),
                        });
                    }
                }
            }
            done_before += file.bytes;
            on_progress(Progress {
                bytes: done_before,
                total,
            });
        }
        Ok(())
    }

    /// Downloads one file into its `.part`, carrying on from what is there.
    async fn fetch(
        &self,
        spec: &ModelSpec,
        file: &ModelFile,
        dir: &Path,
        cancel: &CancellationToken,
        on_bytes: &mut impl FnMut(u64),
    ) -> Result<(), DownloadError> {
        let part = part_path(dir, file);
        let mut have = tokio::fs::metadata(&part)
            .await
            .map(|meta| meta.len())
            .unwrap_or(0);
        if have > file.bytes {
            // More than the whole file: not a download of this file.
            tokio::fs::remove_file(&part).await?;
            have = 0;
        }
        if have == file.bytes {
            return Ok(());
        }

        if cancel.is_cancelled() {
            return Err(DownloadError::Cancelled);
        }
        let mut request = self.client.get(self.url(spec, file));
        if have > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let response = request.send().await?;
        let status = response.status();
        let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT;
        if !status.is_success() {
            return Err(DownloadError::Status {
                file: file.name.to_string(),
                status: status.as_u16(),
            });
        }

        let mut out = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(&part)
            .await?;
        // A server that ignores the range sends the whole file again.
        let mut written = if resumed { have } else { 0 };
        on_bytes(written);

        let mut body = response.bytes_stream();
        loop {
            let chunk = tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    out.flush().await?;
                    return Err(DownloadError::Cancelled);
                }
                chunk = body.next() => chunk,
            };
            let Some(chunk) = chunk else { break };
            let chunk = chunk?;
            out.write_all(&chunk).await?;
            written += chunk.len() as u64;
            on_bytes(written);
        }
        out.flush().await?;
        Ok(())
    }
}

fn part_path(dir: &Path, file: &ModelFile) -> PathBuf {
    dir.join(format!("{}.part", file.name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;

    const BODY: &[u8] = b"the quick brown fox jumps over the lazy dog, twice over";
    fn body_sha() -> String {
        Sha256::digest(BODY)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn test_spec(sha: &'static str) -> ModelSpec {
        let files: &'static [ModelFile] = Box::leak(Box::new([ModelFile {
            name: "model.bin",
            bytes: BODY.len() as u64,
            sha256: sha,
        }]));
        ModelSpec {
            id: "test-model",
            title: "Test",
            engine: Engine::Parakeet,
            languages: "",
            licence: "",
            repo: "owner/repo",
            revision: "abc",
            files,
        }
    }

    struct Server {
        base_url: String,
        /// The `Range` header of each request, in order.
        ranges: Arc<std::sync::Mutex<Vec<Option<String>>>>,
    }

    /// Serves `body` for any path, honouring `Range: bytes=N-`. When
    /// `corrupt_first` is set, the first full response has one byte wrong.
    async fn serve(body: &'static [u8], corrupt_first: bool) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let ranges = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = ranges.clone();
        let served = Arc::new(AtomicUsize::new(0));
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let seen = seen.clone();
                let served = served.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 1024];
                    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                        let Ok(read) = socket.read(&mut buffer).await else {
                            return;
                        };
                        if read == 0 {
                            return;
                        }
                        request.extend_from_slice(&buffer[..read]);
                    }
                    let text = String::from_utf8_lossy(&request).to_ascii_lowercase();
                    let range = text
                        .lines()
                        .find_map(|line| line.strip_prefix("range: bytes="))
                        .map(|value| value.trim().to_string());
                    seen.lock().unwrap().push(range.clone());
                    let start: usize = range
                        .and_then(|value| value.trim_end_matches('-').parse().ok())
                        .unwrap_or(0);
                    let mut payload = body[start.min(body.len())..].to_vec();
                    if corrupt_first && served.fetch_add(1, Ordering::SeqCst) == 0 {
                        payload[0] ^= 0xff;
                    }
                    let status = if start > 0 {
                        format!(
                            "206 Partial Content\r\ncontent-range: bytes {start}-{}/{}",
                            body.len() - 1,
                            body.len()
                        )
                    } else {
                        "200 OK".to_string()
                    };
                    let head = format!(
                        "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        payload.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&payload).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Server { base_url, ranges }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("scribe-models-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn downloader(server: &Server) -> Downloader {
        Downloader {
            base_url: server.base_url.clone(),
            client: reqwest::Client::new(),
        }
    }

    #[test]
    fn the_catalogue_lists_parakeet_first_and_whisper_second() {
        assert_eq!(CATALOGUE[0].engine, Engine::Parakeet);
        assert_eq!(CATALOGUE[1].engine, Engine::Whisper);
        assert_eq!(DEFAULT_MODEL, "parakeet-tdt-0.6b-v3-int8");
        for spec in CATALOGUE {
            assert_eq!(spec.revision.len(), 40, "{}: pin a full commit", spec.id);
            for file in spec.files {
                assert_eq!(file.sha256.len(), 64, "{}/{}", spec.id, file.name);
                assert!(file.bytes > 0);
            }
        }
        assert_eq!(spec("whisper-large-v3-turbo-int8"), Some(&CATALOGUE[1]));
        assert_eq!(spec("nope"), None);
    }

    #[test]
    fn a_model_lives_under_models_in_the_data_folder() {
        let dir = model_dir(Path::new("data"), &CATALOGUE[0]);
        assert_eq!(
            dir,
            Path::new("data")
                .join("models")
                .join("parakeet-tdt-0.6b-v3-int8")
        );
    }

    #[tokio::test]
    async fn a_download_lands_checked_and_is_then_installed() {
        let server = serve(BODY, false).await;
        let data = temp_dir("fresh");
        let spec = test_spec(Box::leak(body_sha().into_boxed_str()));
        assert!(!is_installed(&data, &spec));

        let mut last = None;
        downloader(&server)
            .download(&spec, &data, &CancellationToken::new(), |progress| {
                last = Some(progress)
            })
            .await
            .unwrap();

        assert!(is_installed(&data, &spec));
        let total = BODY.len() as u64;
        assert_eq!(
            last,
            Some(Progress {
                bytes: total,
                total
            })
        );
        assert_eq!(
            std::fs::read(model_dir(&data, &spec).join("model.bin")).unwrap(),
            BODY
        );
        std::fs::remove_dir_all(data).unwrap();
    }

    #[tokio::test]
    async fn a_cancelled_download_resumes_from_where_it_stopped() {
        let server = serve(BODY, false).await;
        let data = temp_dir("resume");
        let spec = test_spec(Box::leak(body_sha().into_boxed_str()));
        // What a cancelled download leaves: the first 20 bytes, as a .part.
        let dir = model_dir(&data, &spec);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("model.bin.part"), &BODY[..20]).unwrap();

        downloader(&server)
            .download(&spec, &data, &CancellationToken::new(), |_| {})
            .await
            .unwrap();

        assert_eq!(*server.ranges.lock().unwrap(), [Some("20-".to_string())]);
        assert_eq!(std::fs::read(dir.join("model.bin")).unwrap(), BODY);
        assert!(!dir.join("model.bin.part").exists());
        std::fs::remove_dir_all(data).unwrap();
    }

    #[tokio::test]
    async fn a_corrupt_file_is_downloaded_again() {
        let server = serve(BODY, true).await;
        let data = temp_dir("corrupt");
        let spec = test_spec(Box::leak(body_sha().into_boxed_str()));

        downloader(&server)
            .download(&spec, &data, &CancellationToken::new(), |_| {})
            .await
            .unwrap();

        // Two full requests: the bad one, then a clean one from the start.
        assert_eq!(*server.ranges.lock().unwrap(), [None, None]);
        assert!(is_installed(&data, &spec));
        std::fs::remove_dir_all(data).unwrap();
    }

    #[tokio::test]
    async fn a_file_that_never_matches_its_checksum_is_rejected() {
        let server = serve(BODY, false).await;
        let data = temp_dir("mismatch");
        let wrong = "0000000000000000000000000000000000000000000000000000000000000000";
        let spec = test_spec(wrong);

        let result = downloader(&server)
            .download(&spec, &data, &CancellationToken::new(), |_| {})
            .await;

        assert!(matches!(result, Err(DownloadError::Checksum { .. })));
        assert!(!is_installed(&data, &spec));
        // Nothing with the model's name is left for the recogniser to load.
        assert!(!model_dir(&data, &spec).join("model.bin").exists());
        std::fs::remove_dir_all(data).unwrap();
    }

    #[tokio::test]
    async fn cancelling_keeps_the_part_file() {
        let server = serve(BODY, false).await;
        let data = temp_dir("cancel");
        let spec = test_spec(Box::leak(body_sha().into_boxed_str()));
        let cancel = CancellationToken::new();
        cancel.cancel();

        let result = downloader(&server)
            .download(&spec, &data, &cancel, |_| {})
            .await;

        assert!(matches!(result, Err(DownloadError::Cancelled)));
        assert!(!is_installed(&data, &spec));
        std::fs::remove_dir_all(data).unwrap();
    }
}
