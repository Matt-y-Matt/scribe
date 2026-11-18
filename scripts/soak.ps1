# Runs a long meeting through the real session without the app window and
# writes down the process's memory as it goes (docs/TEST_PLAN.md §4, steps 4
# and 5 without a room: a 60-minute run, memory at intervals, a forced kill).
#
#   powershell -File scripts/soak.ps1 [-Minutes 60] [-KillAtMinute 45] [-Devices] [-Loopback]
#
# By default the synthetic meeting from scripts/make_test_audio.ps1 plays in
# a loop as the microphone, and with -Loopback as system audio too. -Devices
# records this PC's real microphone (and, with -Loopback, what it plays).
# Everything is written to a scratch folder, never to the app's own data.
# With -KillAtMinute the process is killed there and then recovered.
param(
  [double]$Minutes = 60,
  [double]$KillAtMinute = 0,
  [double]$SampleMinutes = 5,
  [string]$Wav = ".test-audio/meeting-custore-weekly.wav",
  [string]$Scratch = (Join-Path $env:TEMP "scribe-soak"),
  [switch]$Devices,
  [switch]$Loopback
)

$ErrorActionPreference = "Stop"
$exe = "src-tauri/target/debug/examples/soak.exe"
if (-not (Test-Path $exe)) {
  cargo build --manifest-path src-tauri/Cargo.toml --example soak
  if ($LASTEXITCODE -ne 0) { throw "The soak tool did not build." }
}
if (Test-Path $Scratch) { Remove-Item -Recurse -Force $Scratch }
New-Item -ItemType Directory -Force $Scratch | Out-Null

$arguments = @("--data", "`"$Scratch`"", "--minutes", $Minutes)
if ($Devices) {
  $arguments += "--devices"
  if (-not $Loopback) { $arguments += "--no-loopback" }
} else {
  if (-not (Test-Path $Wav)) { throw "No audio at $Wav. Run scripts/make_test_audio.ps1 first." }
  $arguments += @("--wav", "`"$Wav`"")
  if ($Loopback) { $arguments += @("--system-wav", "`"$Wav`"") }
}

$log = Join-Path $Scratch "soak.txt"
$process = Start-Process -FilePath $exe -ArgumentList $arguments -NoNewWindow -PassThru -RedirectStandardOutput $log
$null = $process.Handle
$started = Get-Date
"minute   working set MB   private MB"
$next = 0
while (-not $process.HasExited) {
  $elapsed = ((Get-Date) - $started).TotalMinutes
  if ($KillAtMinute -gt 0 -and $elapsed -ge $KillAtMinute) {
    Stop-Process -Id $process.Id -Force
    "killed at minute {0:N1}" -f $elapsed
    break
  }
  if ($elapsed -ge $next) {
    $process.Refresh()
    "{0,6:N0}   {1,14:N0}   {2,10:N0}" -f $elapsed, ($process.WorkingSet64 / 1MB), ($process.PrivateMemorySize64 / 1MB)
    $next += $SampleMinutes
  }
  Start-Sleep -Seconds 5
}
$process.WaitForExit()
""
Get-Content $log
if ($KillAtMinute -gt 0) {
  ""
  "--- relaunch and recover"
  & $exe --data $Scratch --recover
}
