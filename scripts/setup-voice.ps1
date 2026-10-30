# Installs the AgentCall voice (text to speech) into the Whisper venv:
#   - kokoro-onnx: Kokoro-82M, local neural voice (~350 MB model, works offline)
#   - edge-tts: Microsoft Edge neural voices (online, free); falls back to Kokoro when offline
# Run setup-whisper.ps1 first: it creates %LOCALAPPDATA%\AgentCall\whisper-venv.
# Pure ASCII on purpose (Windows PowerShell 5.1 reads BOM-less scripts as ANSI).
$ErrorActionPreference = 'Stop'

$Base = Join-Path $env:LOCALAPPDATA 'AgentCall'
$py = Join-Path $Base 'whisper-venv\Scripts\python.exe'
$ModelDir = Join-Path $Base 'models\kokoro'
if (-not (Test-Path $py)) { throw "No encuentro $py. Ejecuta antes scripts\setup-whisper.ps1" }
New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null

& $py -m pip install --disable-pip-version-check 'kokoro-onnx>=0.4' 'edge-tts>=7' 'soundfile'
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }

$release = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'
# Loading the model is the real check: a truncated or corrupt file fails here and is downloaded again.
$check = "import sys, kokoro_onnx, edge_tts; kokoro_onnx.Kokoro(sys.argv[1], sys.argv[2]); print('voice ok')"
$onnx = Join-Path $ModelDir 'kokoro-v1.0.onnx'
$voices = Join-Path $ModelDir 'voices-v1.0.bin'
if ((Test-Path $onnx) -and (Test-Path $voices)) {
    & $py -c $check $onnx $voices 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Host "Voz lista: $ModelDir" -ForegroundColor Green; exit 0 }
    Write-Host 'El modelo de voz estaba incompleto: se descarga de nuevo.' -ForegroundColor Yellow
}
foreach ($f in @('kokoro-v1.0.onnx', 'voices-v1.0.bin')) {
    $dest = Join-Path $ModelDir $f
    Write-Host "Descargando la voz $f (solo la primera vez)..." -ForegroundColor Cyan
    # Download next to the target and rename only once complete.
    & curl.exe -fL --retry 3 -o "$dest.part" "$release/$f"
    if ($LASTEXITCODE -ne 0) { Remove-Item -Force "$dest.part" -ErrorAction SilentlyContinue; throw "download failed: $f" }
    Move-Item -Force "$dest.part" $dest
}

& $py -c $check $onnx $voices
if ($LASTEXITCODE -ne 0) { throw 'voice check failed' }
Write-Host "Voz lista: $ModelDir" -ForegroundColor Green
