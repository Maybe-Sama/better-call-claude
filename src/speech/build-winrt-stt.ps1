param(
    [string]$OutDir = (Join-Path $env:LOCALAPPDATA 'AgentCall')
)
# Compiles WinRtStt.cs with the C# compiler that ships with Windows (.NET Framework 4.x) against the
# system WinRT metadata. No SDK or extra download needed. Output: %LOCALAPPDATA%\AgentCall\agentcall-stt.exe
# Pure ASCII on purpose (Windows PowerShell 5.1 reads BOM-less scripts as ANSI).
$ErrorActionPreference = 'Stop'

$fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $fw 'csc.exe'
$winmd = Join-Path $env:WINDIR 'System32\WinMetadata'
$source = Join-Path $PSScriptRoot 'WinRtStt.cs'
$out = Join-Path $OutDir 'agentcall-stt.exe'

if (-not (Test-Path $csc)) { throw "No encuentro csc.exe en $fw" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if ((Test-Path $out) -and ((Get-Item $out).LastWriteTimeUtc -ge (Get-Item $source).LastWriteTimeUtc)) {
    Write-Output $out
    exit 0
}

$refs = @(
    (Join-Path $fw 'System.Runtime.dll'),
    (Join-Path $fw 'System.Runtime.InteropServices.WindowsRuntime.dll'),
    (Join-Path $fw 'System.Threading.Tasks.dll'),
    (Join-Path $winmd 'Windows.Foundation.winmd'),
    (Join-Path $winmd 'Windows.Globalization.winmd'),
    (Join-Path $winmd 'Windows.Media.winmd')
) | ForEach-Object { "/r:$_" }

$log = & $csc /nologo /optimize+ /target:exe /platform:x64 "/out:$out" @refs $source 2>&1
if ($LASTEXITCODE -ne 0) {
    $log | Write-Error
    exit 1
}
Write-Output $out
