param(
    [string]$Python = ''
)
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
foreach ($f in @('kokoro-v1.0.onnx', 'voices-v1.0.bin')) {
    $dest = Join-Path $ModelDir $f
    if ((Test-Path $dest) -and (Get-Item $dest).Length -gt 1MB) { continue }
    Write-Host "Descargando la voz $f (solo la primera vez)..." -ForegroundColor Cyan
    & curl.exe -fL --retry 3 -o $dest "$release/$f"
    if ($LASTEXITCODE -ne 0) { Remove-Item -Force $dest -ErrorAction SilentlyContinue; throw "download failed: $f" }
}

& $py -c "import kokoro_onnx, edge_tts; print('voice ok')"
if ($LASTEXITCODE -ne 0) { throw 'voice check failed' }
Write-Host "Voz lista: $ModelDir" -ForegroundColor Green
