$ErrorActionPreference = 'Stop'
Invoke-RestMethod -Uri 'http://127.0.0.1:32147/health' -TimeoutSec 2 | ConvertTo-Json -Depth 4
