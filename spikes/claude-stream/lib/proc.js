// Windows process helpers for the spike (PowerShell + CIM; no dependencies).
'use strict';
const { execFileSync } = require('node:child_process');

function ps(script) {
  let out;
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  } catch (err) {
    out = err.stdout || ''; // Get-Process exits 1 when some ids are gone, but still prints the live ones
  }
  const trimmed = out.trim();
  if (!trimmed) return [];
  const v = JSON.parse(trimmed);
  return Array.isArray(v) ? v : [v];
}

// Processes whose command line contains `needle` (single quotes are escaped for PowerShell).
function findByCommandLine(needle) {
  const n = needle.replace(/'/g, "''");
  return ps(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${n}*' -and $_.Name -ne 'powershell.exe' } | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress`);
}

// The process tree under pid (pid included): ids, names, working set and CPU seconds.
function tree(pid) {
  return ps(`$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime
$ids = New-Object System.Collections.Generic.HashSet[int]; [void]$ids.Add(${pid})
do { $added = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { [void]$ids.Add([int]$p.ProcessId); $added = $true } } } while ($added)
$all | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; wsMB = [math]::Round($_.WorkingSetSize / 1MB, 1); cpuS = [math]::Round(($_.KernelModeTime + $_.UserModeTime) / 1e7, 2) } } | ConvertTo-Json -Compress`);
}

function alive(pids) {
  if (!pids.length) return [];
  return ps(`Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName | ConvertTo-Json -Compress`);
}

module.exports = { ps, findByCommandLine, tree, alive };
