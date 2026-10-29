param(
    [string]$Model = 'small',
    [string]$Python = ''
)
# Installs the local Whisper speech engine for AgentCall (free, offline after the first model download).
#   - Python venv in %LOCALAPPDATA%\AgentCall\whisper-venv (does not touch the system Python)
#   - faster-whisper (CTranslate2, int8 on CPU) + sounddevice for the microphone
#   - downloads the Whisper model once into %LOCALAPPDATA%\AgentCall\models
# Pure ASCII on purpose (Windows PowerShell 5.1 reads BOM-less scripts as ANSI).
$ErrorActionPreference = 'Stop'

$Base = Join-Path $env:LOCALAPPDATA 'AgentCall'
$Venv = Join-Path $Base 'whisper-venv'
$Models = Join-Path $Base 'models'
New-Item -ItemType Directory -Force -Path $Base, $Models | Out-Null

if (-not $Python) {
    foreach ($v in @('3.13', '3.12', '3.11')) {
        & py "-$v" -c "import sys" 2>$null
        if ($LASTEXITCODE -eq 0) { $Python = "py -$v"; break }
    }
}
if (-not $Python) { throw 'No encuentro Python 3.11+ (py launcher). Instala Python desde python.org y repite.' }

Write-Host "AgentCall Whisper: usando $Python" -ForegroundColor Cyan
if (-not (Test-Path (Join-Path $Venv 'Scripts\python.exe'))) {
    Invoke-Expression "$Python -m venv `"$Venv`""
}
$py = Join-Path $Venv 'Scripts\python.exe'

& $py -m pip install --disable-pip-version-check --upgrade pip | Out-Null
& $py -m pip install --disable-pip-version-check 'faster-whisper>=1.1' 'sounddevice>=0.5' 'numpy'
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }

Write-Host "Descargando los modelos Whisper '$Model' y 'base' (solo la primera vez)..." -ForegroundColor Cyan
& $py -c "from faster_whisper import WhisperModel; [WhisperModel(m, device='cpu', compute_type='int8', download_root=r'$Models') for m in ('$Model', 'base')]; print('models ok')"
if ($LASTEXITCODE -ne 0) { throw 'model download failed' }

Write-Host "Whisper listo: $py" -ForegroundColor Green
