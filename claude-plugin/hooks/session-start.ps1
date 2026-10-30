# AgentCall SessionStart hook. Claude Code does not run HTTP hooks for SessionStart, so this forwards the
# event to AgentCall, which answers with the call rules only when calls are ON for the session
# (launcher sessions, or "/saul on"). AgentCall closed -> no output, Claude starts normally.
# Pure ASCII and \uXXXX output: Windows PowerShell 5.1 would otherwise corrupt accents.
$ErrorActionPreference = 'SilentlyContinue'
$payload = [Console]::In.ReadToEnd()
try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:32147/hooks/session-start' -Method Post -UseBasicParsing `
        -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 2 `
        -Headers @{ 'X-AgentCall-Mode' = "$env:AGENTCALL_SESSION_MODE" }
    $json = [Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())
    $json = [regex]::Replace($json, '[^\x20-\x7e]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
    [Console]::Out.Write($json)
}
catch { }
