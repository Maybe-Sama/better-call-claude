# AgentCall SessionStart hook: adds interaction guidance to the session context.
# Keep this file pure ASCII: Windows PowerShell 5.1 reads BOM-less scripts as ANSI and writes
# stdout in the OEM code page, which corrupts any accented or curly-quote character.
$ErrorActionPreference = 'SilentlyContinue'
$null = [Console]::In.ReadToEnd()

$context = @'
AgentCall is active for this session: the user supervises Claude Code from a Windows voice-call app.
Questions, permission prompts and the final message of a turn are spoken aloud to the user in a phone-style call, in Spanish, and the user answers by voice or text.

Interaction rules:
- Work autonomously through ordinary implementation details. Do not ask about trivial choices you can safely make yourself.
- When you genuinely need a decision, missing information or a clarification, use AskUserQuestion. Keep 2-4 options with short, distinct labels that are easy to say aloud ("la primera", "la segunda" or the label itself).
- An AskUserQuestion answer may be free text instead of an option. If it is itself a question or doubt (for example "why not the first one?"), answer it first; ask again only if a decision is still needed. Never assume a choice the user did not make.
- When a turn ends with something the user should hear (a finished piece of work, a blocker, a result), start the final message with one short spoken-style paragraph (1-3 sentences, no markdown, no code, no file paths, no URLs) saying what happened, the outcome and what matters next. Put technical detail after that paragraph.
- If the user replies during the result call, their reply arrives as additional context of this same session: treat it as a new user request.
- Do not mention AgentCall or add special tags or boilerplate. Write normally.
'@

$output = @{
    hookSpecificOutput = @{
        hookEventName = 'SessionStart'
        additionalContext = $context.Trim()
    }
}

$json = $output | ConvertTo-Json -Compress -Depth 6
# Escape anything outside printable ASCII so the output is encoding-proof.
$json = [regex]::Replace($json, '[^\x20-\x7e]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
[Console]::Out.Write($json)
