param(
    [string]$Project = (Get-Location).Path,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ClaudeArgs
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Plugin = "$Root\claude-plugin"

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw "No encuentro 'claude' en PATH." }

try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:32147/health' -TimeoutSec 1
    Write-Host "AgentCall conectado." -ForegroundColor Green
}
catch {
    Write-Warning "AgentCall no está escuchando en 127.0.0.1:32147. Claude seguirá funcionando, pero las llamadas no aparecerán."
}

# Sessions started from here call from the first moment; elsewhere use "/saul on".
$env:AGENTCALL_SESSION_MODE = 'on'
Push-Location $Project
try { & claude --plugin-dir $Plugin @ClaudeArgs }
finally { Pop-Location }
