# AgentCall · Hook Contract

Base URL: `http://127.0.0.1:32147`

Every HTTP hook uses `"onFailure": "continue"`: if AgentCall is closed (connection refused), Claude Code
reports a non-blocking error and behaves exactly as without the plugin.

A reply of `{}` always means "no decision": Claude Code continues natively (terminal permission dialog,
terminal AskUserQuestion dialog, or a normal stop).

## Verified behaviour (Claude Code 2.1.289, Windows 11)

These were checked empirically by driving the interactive TUI through ConPTY against a scripted server:

| Behaviour | Result |
|---|---|
| `type: "http"` hooks, `onFailure`, `statusMessage`, `timeout: 86400` | accepted; held requests work |
| command hook with `args` (exec form) for SessionStart | works; `${CLAUDE_PLUGIN_ROOT}` expanded |
| `type: "http"` hook for SessionStart | **skipped** ("HTTP hooks are not supported for SessionStart") → `session-start.ps1` forwards it |
| http hook `headers` with `${AGENTCALL_SESSION_MODE}` + `allowedEnvVars` | expanded from the session's environment (empty when unset) → per-session `X-AgentCall-Mode` |
| `UserPromptSubmit` for a slash command | `prompt` is the raw text typed (`/saul on`); `additionalContext` reaches the command's turn |
| Plugin commands | namespaced: only `/agentcall:<name>` works; `/saul` unprefixed requires a personal command in `~/.claude/commands` |
| PreToolUse `AskUserQuestion` → `permissionDecision: "allow"` + `updatedInput.answers` | answers the question, **no terminal dialog**; Claude sees `"question"="answer"` |
| `answers` value that is not an option label (free text) | accepted like the terminal's "Other" field; Claude treats it as the user's words |
| `AskUserQuestion` in `claude -p` | not available (interactive sessions only) |
| PermissionRequest held | the **terminal dialog is shown in parallel**; whichever answers first wins |
| Permission answered in the terminal while the hook is held | the hook's HTTP request is **never closed** → AgentCall must detect it (PostToolUse) |
| Stop → `hookSpecificOutput.additionalContext` | **Claude continues** the same turn; next Stop has `stop_hook_active: true` |
| Esc in the terminal while Stop is held | Claude shows "Interrupted", but the HTTP request stays open |
| New prompt typed while Stop is held | `UserPromptSubmit` fires immediately; the prompt waits until Stop is released |
| Payload fields | Stop: `last_assistant_message`, `stop_hook_active`; PermissionRequest: `tool_name`, `tool_input`, `permission_suggestions` (no `tool_use_id`); all: `session_id`, `transcript_path`, `cwd`, `permission_mode` |
| Session title | not in payloads; read from transcript entries `agent-name` / `custom-title` / `ai-title` |
| Windows PowerShell 5.1 | BOM-less scripts are read as ANSI and stdout uses the OEM code page → hook output must be ASCII (`\uXXXX`) |

## `GET /health`

```json
{"ok": true, "service": "AgentCall", "version": "0.1.0", "port": 32147, "dnd": false,
 "activeCall": false, "calls": 0, "counts": {"ringing": 0, "queued": 0, "pending": 0, "snoozed": 0}}
```

## `POST /hooks/user-prompt-submit` — `UserPromptSubmit`

Remembers the session's first/last prompt (fallback context for the incoming call).
Also means "the user is at the terminal": any request still held for that session is released with `{}`.
Response: `{}`.

## `POST /hooks/ask-user` — `PreToolUse`, matcher `AskUserQuestion` (held)

- Option recognised ("la segunda", "azul", "B") → `allow` + `updatedInput: {questions, answers: {question: label}}`.
- Anything else, including clarifications ("¿por qué no la primera?") → the user's words verbatim as the answer.
  For multi-question calls a clarification ends the call; unanswered questions get an explicit "(sin responder…)".

## `POST /hooks/permission` — `PermissionRequest` (held)

- "sí / vale / adelante…" → `decision: {behavior: "allow"}`
- "no / cancela…" → `decision: {behavior: "deny", message, interrupt: false}`
- Doubts/questions → `deny` with a message asking Claude to answer and re-request.
- `tool_name: AskUserQuestion` → `{}` immediately (handled by PreToolUse).

## `POST /hooks/post-tool-use` — `PostToolUse`

Releases a held permission call whose `tool_name` + `tool_input` match (answered in the terminal). Response `{}`.

## `POST /hooks/stop` — `Stop` (held)

- Turn shorter than `AGENTCALL_MIN_RESULT_SECONDS` (default 20) with no question/permission → released at once, no call.
- User hangs up → `{}`; Claude stops.
- User replies → `hookSpecificOutput.additionalContext` with the reply; Claude continues in the same session and
  its next Stop merges into the same call while it is still active.

## `POST /hooks/stop-failure` — `StopFailure`

Informational error call. Response `{}`.

## Stale requests

Claude Code does not close a held request when the user answers in the terminal or presses Esc. AgentCall
releases a held request when: a newer hook of the same session arrives, `UserPromptSubmit` arrives, the matching
`PostToolUse` arrives, or the HTTP connection actually closes. Quitting AgentCall answers every held request with `{}`.
