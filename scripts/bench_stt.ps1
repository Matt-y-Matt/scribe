# Speech-to-text bench (docs/TEST_PLAN.md §1, BUILD_PLAN M2 task 7): real-time
# factor, per-utterance decode time and peak memory for a speech model on
# this PC.
#
#   powershell -File scripts/bench_stt.ps1 [-Wav <file>] [-Model <id>] [-Threads 2,4,6] [-Text]
#
# The audio defaults to the synthetic meeting from scripts/make_test_audio.ps1.
# The model is read from the app's data folder; download it in the app
# (Settings, Speech) or with the fetch_model example first.
param(
  [string]$Wav = ".test-audio/meeting-custore-weekly.wav",
  [string]$Model = "parakeet-tdt-0.6b-v3-int8",
  [string]$Threads = "2,4,6",
  [string]$Data = (Join-Path $env:LOCALAPPDATA "co.custore.scribe"),
  [switch]$Text
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $Wav)) { throw "No audio at $Wav. Run scripts/make_test_audio.ps1 first, or pass -Wav." }

# A debug build: the recogniser is sherpa-onnx's own optimised library either
# way, and the release profile (LTO, one codegen unit) takes many minutes.
cargo build --manifest-path src-tauri/Cargo.toml --example bench_stt
if ($LASTEXITCODE -ne 0) { throw "The bench did not build." }

$arguments = @("--wav", "`"$Wav`"", "--data", "`"$Data`"", "--model", $Model, "--threads", $Threads)
if ($Text) { $arguments += "--text" }
$out = New-TemporaryFile
$process = Start-Process -FilePath "src-tauri/target/debug/examples/bench_stt.exe" -ArgumentList $arguments `
  -NoNewWindow -PassThru -RedirectStandardOutput $out
# Keep a handle so the peak is still readable after the process has gone.
$null = $process.Handle
$process.WaitForExit()
Get-Content $out
Remove-Item $out

$cpu = (Get-CimInstance Win32_Processor).Name.Trim()
""
"peak memory  {0:N0} MB" -f ($process.PeakWorkingSet64 / 1MB)
"processor    $cpu"
