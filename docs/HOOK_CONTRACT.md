# AgentCall · Hook Contract

Base URL: `http://127.0.0.1:32147`

## `GET /health`

Response:

```json
{"ok": true, "service": "AgentCall", "port": 32147, "dnd": false}
```

## `POST /hooks/user-prompt-submit`

Claude event: `UserPromptSubmit`.
Purpose: remember the latest session topic for the incoming-call context.
Response: `{}`.

## `POST /hooks/ask-user`

Claude event: `PreToolUse`, matcher `AskUserQuestion`. Synchronous/held request.
Direct option answers return `hookSpecificOutput` with `permissionDecision: allow` and the updated answers. Natural-language clarification is returned to Claude as hook feedback rather than being forced into a fake option.

## `POST /hooks/permission`

Claude event: `PermissionRequest`. Synchronous/held request.
Allows or denies based on the user's voice/text answer. Clarification questions safely deny the current attempt and let Claude explain/re-request if needed.

## `POST /hooks/stop`

Claude event: `Stop`. Synchronous/held request.
- User hangs up → `{}` and Claude is allowed to stop.
- User replies → `hookSpecificOutput.additionalContext` and Claude continues the same conversation.

## `POST /hooks/stop-failure`

Claude event: `StopFailure`. Notification only. Response `{}`.
