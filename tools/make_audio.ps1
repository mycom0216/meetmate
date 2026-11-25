# make_audio.ps1 - samples/scripts.json 의 대본을 Windows 한국어 음성(Heami)으로 읽어 wav(16kHz 모노)로 만듭니다.
# 왜? 실제 회의 녹음을 구하기 전에도 "음성 -> 받아쓰기 -> 정리" 전체 흐름을 재현 가능하게 시험하기 위함입니다.
# 한계: 합성음은 또렷해서 실제 회의(잡음·겹침·말 흐림)보다 훨씬 쉽습니다. 그래서 여기서 나온 정확도는 "상한선"으로만 해석합니다.
param([string]$Out = "$PSScriptRoot\..\samples\audio")
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force $Out | Out-Null
$data = Get-Content "$PSScriptRoot\..\samples\scripts.json" -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($m in $data.meetings) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SelectVoice("Microsoft Heami Desktop")
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $file = Join-Path (Resolve-Path $Out) "$($m.id).wav"
  $s.SetOutputToWaveFile($file, $fmt)
  $pb = New-Object System.Speech.Synthesis.PromptBuilder
  foreach ($l in $m.lines) { $pb.AppendText($l.text); $pb.AppendBreak([TimeSpan]::FromMilliseconds(700)) }
  $s.Speak($pb); $s.Dispose()
  Write-Host "$($m.id) -> $file"
}
