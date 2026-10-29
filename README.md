# Better Call Claude

AgentCall is a Windows-first companion for Claude Code that turns important Claude interactions into phone-style calls.

It is designed for people running several Claude sessions at once: Claude works in the background and calls you only when it needs attention or has reached a meaningful final result.

## What the prototype includes

- Incoming call UI for Claude Code events.
- Different call patterns for decisions/attention vs final results.
- 30-second unanswered-call timeout to Pending.
- Snooze for 1–10, 15, 20, 30, 45, 60 and 120 minutes.
- Pending calls can be called back later.
- Visible call queue when several Claude sessions need attention.
- Do Not Disturb toggle.
- Hands-free conversation with mute.
- Live transcript of Claude and the user.
- Text input as a fallback for technical terms and corrections.
- Minimal local persistence only for operational call state; no audio archive by default.
- Claude Code plugin/hooks bundled in `claude-plugin/`.

## Windows quick start

Requirements:

- Windows 10/11
- Node.js 20+
- Claude Code installed and authenticated

```powershell
npm install
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
npm start
```

Speech recognition runs locally with Whisper (faster-whisper, CPU, int8). `setup-windows.ps1` installs it into `%LOCALAPPDATA%\AgentCall` (Python venv + ~0.5 GB model, once). If Whisper is missing AgentCall falls back to Windows dictation and then to System.Speech. Engine override: `AGENTCALL_STT_ENGINE=whisper|winrt|classic`; model: `AGENTCALL_WHISPER_MODEL` (default `small`); extra vocabulary: `AGENTCALL_STT_VOCAB`.

Then use the helper to start Claude with AgentCall:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-claude-with-agentcall.ps1
```

## Use it in every Claude Code session

Install the plugin once for your user. It is read straight from this folder, so updates apply without reinstalling:

```powershell
claude plugin marketplace add E:\CODE_feliz\BETTER-CALL-CLAUDE
claude plugin install agentcall@better-call-claude
copy claude-plugin\commands\better-call-saul.md $env:USERPROFILE\.claude\commands\
```

Calls are **off by default** in every session. Inside any Claude Code session:

- `/better-call-saul on` — Claude calls you in this session (questions, permissions, finished work).
- `/better-call-saul off` — back to normal terminal behaviour.
- `/better-call-saul` — shows the current state.

The plugin also exposes it as `/agentcall:better-call-saul`. Sessions started with `scripts/run-claude-with-agentcall.ps1`
are on from the start; `{"defaultMode": "on"}` in `%LOCALAPPDATA%\AgentCall\config.json` makes every session call.
The choice is remembered per session, and if AgentCall is closed Claude Code works exactly as without the plugin.

## Documentation

- `docs/SYSTEM_SPEC.md` — product and system specification
- `docs/HOOK_CONTRACT.md` — Claude hook integration contract
- `docs/TEST_PLAN.md` — validation plan

## Status

Prototype / v0.1. The architecture intentionally keeps the agent adapter separate so support for other coding agents can be added later without redesigning the call system.
