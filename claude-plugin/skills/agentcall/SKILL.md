---
name: agentcall
description: Explain the AgentCall voice-supervision integration and how this Claude Code session should use it.
disable-model-invocation: true
---

# AgentCall

AgentCall turns meaningful Claude Code handoffs into Windows voice calls.

When it is active:
- `AskUserQuestion` is answered through the AgentCall call UI.
- permission prompts can be approved or denied from the call.
- final `Stop` handoffs are spoken aloud; if the user replies during that call, the reply is fed back into the same Claude session and work continues.
- routine tool chatter stays in Claude Code and does not generate a call.

If AgentCall is not running, its HTTP hooks are configured to fail open and Claude Code falls back to its normal terminal interaction.
