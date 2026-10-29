param(
    [string]$Python = ''
)
# Optional GPU speech recognition for AgentCall: Whisper large-v3-turbo through ONNX Runtime + DirectML.
# Works with AMD, Intel and NVIDIA GPUs on Windows 10/11, no CUDA/ROCm needed. Everything stays local.
#   - venv: %LOCALAPPDATA%\AgentCall\gpu-venv (onnxruntime-directml cannot share a venv with faster-whisper)
#   - model: onnx-community/whisper-large-v3-turbo fp16 (~1.9 GB) in %LOCALAPPDATA%\AgentCall\models\whisper-turbo-onnx
# Enable it with {"whisperBackend": "dml"} in %LOCALAPPDATA%\AgentCall\config.json.
# Pure ASCII on purpose (Windows PowerShell 5.1 reads BOM-less scripts as ANSI).
$ErrorActionPreference = 'Stop'

$Base = Join-Path $env:LOCALAPPDATA 'AgentCall'
$Venv = Join-Path $Base 'gpu-venv'
$ModelDir = Join-Path $Base 'models\whisper-turbo-onnx'
New-Item -ItemType Directory -Force -Path (Join-Path $ModelDir 'onnx') | Out-Null

if (-not $Python) {
    foreach ($v in @('3.13', '3.12', '3.11')) {
        & py "-$v" -c "import sys" 2>$null
        if ($LASTEXITCODE -eq 0) { $Python = "py -$v"; break }
    }
}
if (-not $Python) { throw 'No encuentro Python 3.11+ (py launcher).' }
if (-not (Test-Path (Join-Path $Venv 'Scripts\python.exe'))) { Invoke-Expression "$Python -m venv `"$Venv`"" }
$py = Join-Path $Venv 'Scripts\python.exe'
& $py -m pip install --disable-pip-version-check --upgrade pip | Out-Null
& $py -m pip install --disable-pip-version-check onnxruntime-directml transformers tokenizers sounddevice numpy
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }

$base = 'https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main'
$files = @('config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json',
           'special_tokens_map.json', 'added_tokens.json', 'vocab.json', 'merges.txt', 'normalizer.json',
           'onnx/encoder_model_fp16.onnx', 'onnx/decoder_model_fp16.onnx', 'onnx/decoder_with_past_model_fp16.onnx')
foreach ($f in $files) {
    $dest = Join-Path $ModelDir $f
    if ((Test-Path $dest) -and (Get-Item $dest).Length -gt 0) { continue }
    Write-Host "Descargando $f ..." -ForegroundColor Cyan
    & curl.exe -sL --retry 3 -o $dest "$base/$f"
    if ($LASTEXITCODE -ne 0) { throw "download failed: $f" }
}

& $py -c "import onnxruntime as o; p=o.get_available_providers(); print(p); assert 'DmlExecutionProvider' in p"
if ($LASTEXITCODE -ne 0) { throw 'DirectML no disponible en este equipo' }
Write-Host 'Whisper GPU listo. Activalo con {"whisperBackend": "dml"} en config.json' -ForegroundColor Green
