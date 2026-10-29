$ErrorActionPreference = 'SilentlyContinue'
$null = [Console]::In.ReadToEnd()

$context = @'
AgentCall is active for this session. User-facing handoffs are delivered as voice calls on Windows.

Interaction rules:
- Work autonomously through ordinary implementation details. Do not ask the user about trivial choices you can make safely yourself.
- When you genuinely need a decision, missing information, or clarification from the user, prefer AskUserQuestion so AgentCall can collect the answer by voice/text and return it to this session.
- Treat answers returned through AskUserQuestion as normal natural-language user input. If the answer is itself a clarification question (for example “why not option A?”), answer that clarification first; if a decision is still required afterwards, call AskUserQuestion again.
- At the end of a meaningful turn, make the first paragraph a concise, natural handoff suitable for being read aloud: what happened, the outcome, and what matters next. Put technical detail after that paragraph.
- Do not add special AgentCall tags or boilerplate to messages. Write normally.
'@

$output = @{
    hookSpecificOutput = @{
        hookEventName = 'SessionStart'
        additionalContext = $context.Trim()
    }
}

[Console]::Out.WriteLine(($output | ConvertTo-Json -Compress -Depth 6))
