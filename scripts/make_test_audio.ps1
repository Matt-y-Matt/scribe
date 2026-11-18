# Reads a transcript fixture aloud with Windows' built-in voices and writes
# one 16 kHz mono 16-bit WAV of the whole meeting, plus a JSON file saying
# where each line starts and ends in it.
#
#   powershell -File scripts/make_test_audio.ps1 [-Fixture fixtures/meeting-custore-weekly.jsonl] [-Out .test-audio]
#
# The audio is for testing capture and transcription without a room
# (docs/NOTES.md, M2). It is generated on this PC, sent nowhere, and
# git-ignored. Windows PowerShell 5.1 only: System.Speech is not in PowerShell 7.
param(
  [string]$Fixture = "fixtures/meeting-custore-weekly.jsonl",
  [string]$Out = ".test-audio"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$rate = 16000
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo($rate, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
if ($voices.Count -eq 0) { throw "No Windows speech voice is installed." }

$lines = Get-Content -LiteralPath $Fixture -Encoding UTF8 | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json }
$speakers = @($lines | ForEach-Object { $_.speaker } | Select-Object -Unique)

New-Item -ItemType Directory -Force $Out | Out-Null
$name = [IO.Path]::GetFileNameWithoutExtension($Fixture)
$pcm = New-Object System.IO.MemoryStream
$marks = @()

foreach ($line in $lines) {
  # Keep the fixture's own pauses: each line starts where the fixture says,
  # or straight after the previous one when the voice took longer.
  $wanted = [int64]([double]$line.t0 * $rate) * 2
  if ($pcm.Length -lt $wanted) {
    $gap = New-Object byte[] ($wanted - $pcm.Length)
    $pcm.Write($gap, 0, $gap.Length)
  } elseif ($pcm.Length -gt 0) {
    # At least 0.8 s between lines, so each one is its own utterance.
    $gap = New-Object byte[] ([int]($rate * 0.8) * 2)
    $pcm.Write($gap, 0, $gap.Length)
  }

  $synth.SelectVoice($voices[[array]::IndexOf($speakers, $line.speaker) % $voices.Count])
  $spoken = New-Object System.IO.MemoryStream
  $synth.SetOutputToAudioStream($spoken, $format)
  $synth.Speak([string]$line.text)
  $synth.SetOutputToNull()

  $t0 = $pcm.Length / 2 / $rate
  $bytes = $spoken.ToArray()
  $pcm.Write($bytes, 0, $bytes.Length)
  $marks += [pscustomobject]@{
    id = $line.id; speaker = $line.speaker; text = $line.text
    t0 = [math]::Round($t0, 3); t1 = [math]::Round($pcm.Length / 2 / $rate, 3)
  }
}
# A second of silence at the end closes the last utterance.
$tail = New-Object byte[] ($rate * 2)
$pcm.Write($tail, 0, $tail.Length)

$data = $pcm.ToArray()
$wav = Join-Path $Out "$name.wav"
$stream = [IO.File]::Create($wav)
$writer = New-Object System.IO.BinaryWriter($stream)
$writer.Write([Text.Encoding]::ASCII.GetBytes("RIFF")); $writer.Write([int](36 + $data.Length))
$writer.Write([Text.Encoding]::ASCII.GetBytes("WAVEfmt ")); $writer.Write([int]16)
$writer.Write([int16]1); $writer.Write([int16]1); $writer.Write([int]$rate); $writer.Write([int]($rate * 2))
$writer.Write([int16]2); $writer.Write([int16]16)
$writer.Write([Text.Encoding]::ASCII.GetBytes("data")); $writer.Write([int]$data.Length); $writer.Write($data)
$writer.Close()

$json = $marks | ConvertTo-Json -Depth 3
[IO.File]::WriteAllText((Join-Path $Out "$name.marks.json"), $json, (New-Object Text.UTF8Encoding($false)))

"{0}: {1} lines, {2:N1} s, {3:N1} MB" -f $wav, $marks.Count, ($data.Length / 2 / $rate), ($data.Length / 1MB)
