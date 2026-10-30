# AgentCall (Better Call Claude) - one-command installer for Windows 10/11.
#
#   irm https://raw.githubusercontent.com/Maybe-Sama/better-call-claude/main/install.ps1 | iex
#
# Re-running it updates an existing install. Optional environment variables:
#   AGENTCALL_GPU=1      also install Whisper large-v3-turbo on the GPU (DirectML: AMD/NVIDIA/Intel, ~1.9 GB)
#   AGENTCALL_DIR=<dir>  install folder (default %LOCALAPPDATA%\AgentCall\app)
#   AGENTCALL_BRANCH=<b> git branch (default main)
# Installs missing Git / Node.js / Python with winget. Needs Claude Code already installed.
# Pure ASCII on purpose: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.

& {
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'https://github.com/Maybe-Sama/better-call-claude.git'
$Branch = if ($env:AGENTCALL_BRANCH) { $env:AGENTCALL_BRANCH } else { 'main' }
$Data = Join-Path $env:LOCALAPPDATA 'AgentCall'
$Dir = if ($env:AGENTCALL_DIR) { $env:AGENTCALL_DIR } else { Join-Path $Data 'app' }

function Say($text) { Write-Host "  $text" }
function Step($text) { Write-Host ''; Write-Host "> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host ''; Write-Host "  ERROR: $text" -ForegroundColor Red; throw "AgentCall: $text" }
function Find-Exe([string[]]$Names) {
    foreach ($n in $Names) {
        $c = Get-Command $n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($c) { return $c.Source }
    }
    return $null
}
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Find-Python {
    if (-not (Find-Exe @('py.exe'))) { return $null }
    foreach ($v in @('3.13', '3.12', '3.11')) {
        & py.exe "-$v" -c "import sys" 2>$null
        if ($LASTEXITCODE -eq 0) { return $v }
    }
    return $null
}
function Ensure-Tool($Label, [scriptblock]$Present, $WingetId) {
    if (& $Present) { Say "$Label OK"; return }
    if (-not (Find-Exe @('winget.exe'))) { Fail "Falta $Label y no hay winget para instalarlo. Instalalo a mano y repite." }
    Say "Instalando $Label con winget..."
    & winget.exe install -e --id $WingetId --silent --accept-package-agreements --accept-source-agreements | Out-Host
    Refresh-Path
    if (-not (& $Present)) { Fail "No se pudo instalar $Label. Instalalo a mano (winget install $WingetId), abre otra terminal y repite." }
    Say "$Label instalado"
}
function Run-Script($Path, [string[]]$ScriptArgs = @()) {
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Path @ScriptArgs | Out-Host
    return ($LASTEXITCODE -eq 0)
}

Write-Host ''
Write-Host '  AgentCall - Claude Code te llama por telefono' -ForegroundColor Yellow
Write-Host '  ---------------------------------------------' -ForegroundColor Yellow
Say "Carpeta: $Dir"

if ($env:OS -ne 'Windows_NT') { Fail 'AgentCall solo funciona en Windows.' }

Step 'Requisitos'
Ensure-Tool 'Git' { Find-Exe @('git.exe') } 'Git.Git'
Ensure-Tool 'Node.js 22.12+' {
    $node = Find-Exe @('node.exe')
    if (-not $node) { return $false }
    $parts = ((& $node --version) -replace '^v', '') -split '\.'
    return ([int]$parts[0] -gt 22) -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -ge 12)  # Electron 45 needs 22.12+
} 'OpenJS.NodeJS.LTS'
Ensure-Tool 'Python 3.11-3.13' { [bool](Find-Python) } 'Python.Python.3.12'
$claude = Find-Exe @('claude.exe', 'claude.cmd')
if (-not $claude) { Fail 'No encuentro Claude Code (comando claude). Instalalo desde https://claude.com/claude-code y repite.' }
Say 'Claude Code OK'

Step 'Descargando AgentCall'
if (Test-Path (Join-Path $Dir '.git')) {
    & git.exe -C $Dir fetch --quiet --depth 1 origin $Branch
    if ($LASTEXITCODE -eq 0) { & git.exe -C $Dir checkout --quiet -B $Branch FETCH_HEAD }
    if ($LASTEXITCODE -ne 0) { Fail "No se pudo actualizar $Dir a la rama $Branch. Si lo has modificado, borralo y repite." }
    Say 'Actualizado'
} else {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Dir) | Out-Null
    & git.exe clone --quiet --depth 1 --branch $Branch $Repo $Dir
    if ($LASTEXITCODE -ne 0) { Fail 'git clone ha fallado.' }
    Say 'Descargado'
}

Step 'Instalando la aplicacion (Electron)'
# An open AgentCall from this folder locks electron.exe; close it (it is reopened at the end).
$appDist = Join-Path $Dir 'node_modules\electron\dist'
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($appDist, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
Push-Location $Dir
try {
    # npm ci: exact versions from package-lock.json and never rewrites it (keeps updates clean).
    & npm.cmd ci --no-audit --no-fund --loglevel=error | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail 'npm ci ha fallado.' }
} finally { Pop-Location }
$electron = Join-Path $Dir 'node_modules\electron\dist\electron.exe'
# Electron 45+ downloads its binary on first run instead of at npm install time. install.js skips the
# download when dist\version already matches, so always running it also repairs a stale binary.
Say 'Comprobando Electron...'
& node.exe (Join-Path $Dir 'node_modules\electron\install.js') | Out-Host
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $electron)) { Fail 'Electron no se ha instalado correctamente.' }

Step 'Reconocimiento de voz local (Whisper)'
if (-not (Run-Script (Join-Path $Dir 'scripts\setup-whisper.ps1'))) {
    Fail 'No se pudo instalar Whisper.'
}

Step 'Voz de Claude (Edge + Kokoro)'
if (-not (Run-Script (Join-Path $Dir 'scripts\setup-voice.ps1'))) { Fail 'No se pudo instalar la voz.' }

$gpu = $false
if ($env:AGENTCALL_GPU -eq '1') {
    Step 'Whisper en la GPU (large-v3-turbo, DirectML)'
    $gpu = Run-Script (Join-Path $Dir 'scripts\setup-whisper-gpu.ps1')
    if (-not $gpu) { Say 'GPU no disponible: se usara Whisper en la CPU.' }
}

Step 'Configuracion'
$cfgPath = Join-Path $Data 'config.json'
$cfg = [ordered]@{}
if (Test-Path $cfgPath) {
    try {
        $old = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($p in $old.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
    } catch { Say 'config.json no era valido; se crea de nuevo.' }
}
if (-not $cfg.Contains('ttsProvider')) { $cfg['ttsProvider'] = 'edge' }
if ($gpu) { $cfg['whisperBackend'] = 'dml' }
[IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Say $cfgPath

Step 'Conectando con Claude Code'
$markets = (& $claude plugin marketplace list 2>&1 | Out-String)
if ($markets -match 'better-call-claude') { & $claude plugin marketplace update better-call-claude | Out-Host }
else { & $claude plugin marketplace add $Dir | Out-Host }
if ($LASTEXITCODE -ne 0) { Fail 'No se pudo registrar el marketplace del plugin.' }
$plugins = (& $claude plugin list 2>&1 | Out-String)
if ($plugins -notmatch 'agentcall@better-call-claude') {
    & $claude plugin install agentcall@better-call-claude | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail 'No se pudo instalar el plugin agentcall.' }
}
$commands = Join-Path $env:USERPROFILE '.claude\commands'
New-Item -ItemType Directory -Force -Path $commands | Out-Null
$saul = Join-Path $commands 'saul.md'
if ((Test-Path $saul) -and -not (Select-String -Path $saul -Pattern 'agentcall-saul-command|El usuario ha escrito "/saul' -Quiet)) {
    # Someone else's /saul command: keep a copy instead of silently replacing it.
    Copy-Item -Force $saul "$saul.bak"
    Say "Ya tenias un comando /saul: copia guardada en $saul.bak"
}
Copy-Item -Force (Join-Path $Dir 'claude-commands\saul.md') $saul
Say 'Plugin agentcall y comando /saul instalados'

Step 'Accesos directos'
$shell = New-Object -ComObject WScript.Shell
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), $startMenu)) {
    $lnk = $shell.CreateShortcut((Join-Path $folder 'AgentCall.lnk'))
    $lnk.TargetPath = $electron
    $lnk.Arguments = '"' + $Dir + '"'
    $lnk.WorkingDirectory = $Dir
    $lnk.Description = 'AgentCall - Claude Code te llama'
    $lnk.Save()
}
Say 'Escritorio y menu Inicio: AgentCall'

$running = $false
try { $running = [bool](Invoke-RestMethod -Uri 'http://127.0.0.1:32147/health' -TimeoutSec 1).ok } catch { }
if ($running) { Say 'AgentCall ya estaba abierto: cierralo y abrelo de nuevo para usar esta version.' }
else { Start-Process -FilePath $electron -ArgumentList ('"' + $Dir + '"') -WorkingDirectory $Dir }

Write-Host ''
Write-Host '  Listo.' -ForegroundColor Green
Write-Host '  1. Deja AgentCall abierto (acceso directo AgentCall).'
Write-Host '  2. En cualquier sesion NUEVA de Claude Code escribe:  /saul on'
Write-Host '  3. Claude te llamara cuando te necesite o termine algo importante.  /saul off  para parar.'
Write-Host ''
}
