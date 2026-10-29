$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Push-Location $Root
try {
    if (-not (Test-Path "$Root\node_modules\electron")) {
        Write-Host "Faltan dependencias. Ejecutando npm install…" -ForegroundColor Yellow
        & npm install
    }
    & npm start
}
finally {
    Pop-Location
}
