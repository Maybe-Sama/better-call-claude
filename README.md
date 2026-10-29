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

Then use the helper to start Claude with AgentCall:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-claude-with-agentcall.ps1
```

## Documentation

- `docs/SYSTEM_SPEC.md` — product and system specification
- `docs/HOOK_CONTRACT.md` — Claude hook integration contract
- `docs/TEST_PLAN.md` — validation plan

## Status

Prototype / v0.1. The architecture intentionally keeps the agent adapter separate so support for other coding agents can be added later without redesigning the call system.
