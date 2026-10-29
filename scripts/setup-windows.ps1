$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
Write-Host ""
Write-Host "AgentCall · setup de desarrollo" -ForegroundColor Cyan
Write-Host "Ruta: $Root"

if ($env:OS -ne 'Windows_NT') { throw 'Este setup está diseñado para Windows.' }

function Require-Command($Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "No encuentro '$Name' en PATH. Instálalo y vuelve a ejecutar este script."
    }
}

Require-Command node
Require-Command npm

$nodeVersion = (& node --version)
Write-Host "Node: $nodeVersion" -ForegroundColor DarkGray

Push-Location $Root
try {
    Write-Host "Instalando dependencias…" -ForegroundColor Yellow
    & npm install

    Write-Host "Ejecutando validación estática…" -ForegroundColor Yellow
    & npm run check

    Write-Host "Ejecutando tests…" -ForegroundColor Yellow
    & npm test

    if (Get-Command claude -ErrorAction SilentlyContinue) {
        Write-Host "Validando plugin con Claude Code…" -ForegroundColor Yellow
        & claude plugin validate "$Root\claude-plugin"
    }
    else {
        Write-Host "No encuentro el comando 'claude'; omito la validación oficial del plugin." -ForegroundColor DarkYellow
    }

    Write-Host ""
    Write-Host "Comprobando reconocimiento de voz de Windows…" -ForegroundColor Yellow
    & "$PSScriptRoot\check-speech.ps1"

    Write-Host ""
    Write-Host "Listo." -ForegroundColor Green
    Write-Host "1) Ejecuta: .\scripts\run-agentcall.ps1"
    Write-Host "2) En otra terminal, dentro de tu proyecto: <ruta-agentcall>\scripts\run-claude-with-agentcall.ps1"
}
finally { Pop-Location }
