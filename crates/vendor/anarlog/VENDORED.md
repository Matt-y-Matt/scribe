# Vendored from Anarlog

Source: `https://github.com/fastrepl/anarlog`, commit `9c1cbe287019e7ca199ee77bd5f6d095cf076ad8` (2026-11-17), copied 2026-11-19.
Licence: MIT (`LICENSE` in this folder; Anarlog's `LICENSING.md` puts everything outside `enterprise/` under it). Nothing here comes from `enterprise/`.

Scribe uses these crates for microphone and system-audio capture, echo cancellation and voice activity detection. The capture, AEC and VAD code is as upstream wrote it. To update, copy the same paths from a newer commit and reapply the changes listed below.

## Crates

| Folder | Upstream path | What it is |
| --- | --- | --- |
| `audio-actual` | `crates/audio-actual` | Microphone (cpal) and loopback (WASAPI) capture, joined into one stream, with recovery when a device goes away |
| `aec` | `crates/aec` | Echo cancellation (two small ONNX models) |
| `vad` | `crates/vad` | Silero VAD v6.2 |
| `audio` | `crates/audio` | Capture types: config, frame, events, errors |
| `audio-device` | `crates/audio-device` | Default device and Bluetooth input handling |
| `audio-interface` | `crates/audio-interface` | The `AsyncSource` trait |
| `audio-sync` | `crates/audio-sync` | Lag estimate between microphone and loopback, for the AEC reference |
| `audio-utils` | `crates/audio-utils` | PCM conversion and the playback sink (trimmed, see below) |
| `resampler` | `crates/resampler` | Resampling to 16 kHz (rubato) |
| `onnx` | `crates/onnx` | ONNX Runtime session helpers (`ort`) |

## Changes to the copy

1. **Manifests.** Every `Cargo.toml` is rewritten to stand outside Anarlog's workspace: each `workspace = true` dependency carries the version Anarlog's root `Cargo.toml` pins, and `anlg-*` dependencies point at the sibling folders. Dev-dependencies, benches, examples and the macOS and Linux dependency sections are removed.
2. **Warnings off.** Each manifest ends with `[lints.rust] warnings = "allow"`, so upstream's compiler warnings do not bury Scribe's own.
3. **`rodio` without its default features** (`playback`, `hound`, `tracing` only), in `audio-actual`, `audio-interface` and `audio-utils`. Upstream's defaults bring in Symphonia, which is MPL-2.0.
4. **`ort` without `copy-dylibs`**, in `onnx`. That feature copies `DirectML.dll` next to the build output, and its build script assumes the folder layout of older Cargo versions: with Cargo 1.100 it panics during `cargo clippy`. Scribe runs these models on the CPU, and Windows 10 and 11 carry their own `DirectML.dll`.
5. **`audio-utils` is trimmed** to `pcm.rs` and `playback.rs`, with a new three-line `lib.rs`. Upstream's `lib.rs`, `error.rs` and `vorbis.rs` (decoding, resampling and Vorbis helpers) are not copied; `audio-actual` does not call them, and they need Symphonia, `vorbis_rs` (a C build) and `audio-mime`. `audio-mime` is therefore not vendored.
6. **`aec` models.** Only `data/models/model_128_1.onnx` and `model_128_2.onnx` are copied, and the `256` and `512` features are removed from the manifest. The 256 and 512 pairs are 57 MB.
7. **Not copied:** `benches/`, `examples/`, `tests/`, test audio and snapshot files (`aec/data/inputs`, `aec/data/snapshots`, `vad/data/snapshots`, `audio-sync/tests`). The `#[cfg(test)]` modules inside `src/` are left in place but cannot be built here, because they need Anarlog's test crates (`data`, `audio-snapshot`, `audacity`). Scribe's own tests cover how it uses these crates.

No `.rs` file under `audio-actual`, `aec`, `vad`, `audio`, `audio-device`, `audio-interface`, `audio-sync`, `resampler` or `onnx` is edited.
