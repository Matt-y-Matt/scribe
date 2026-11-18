// Trimmed for Scribe (see ../../VENDORED.md): upstream also has decoding,
// resampling and Vorbis helpers that `audio-actual` does not use.
mod pcm;
mod playback;

pub use pcm::*;
pub use playback::open_default_playback_sink;
