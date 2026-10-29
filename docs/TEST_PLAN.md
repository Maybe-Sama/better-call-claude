# AgentCall · Test Plan V0

## Automated

```powershell
npm test
npm run check
```

Coverage includes AskUserQuestion, natural clarification, ordinal/label matching, Stop follow-up, hangup, queue, DND, ring timeout and Spanish permission parsing.

## Windows manual matrix

### A. Companion startup
1. `npm install`
2. `npm start`
3. `Invoke-RestMethod http://127.0.0.1:32147/health`
4. Verify tray icon and Centralita window.

### B. Speech
1. Run `scripts/check-speech.ps1`.
2. Verify an `es-ES` recognizer is present.
3. Trigger an AskUserQuestion call.
4. Confirm TTS speaks first, then STT activates.
5. Speak and verify partial + final captions.
6. Test mute.
7. Test typed fallback.

### C. Claude plugin
1. `claude plugin validate .\claude-plugin`
2. Start with `claude --plugin-dir .\claude-plugin`.
3. Request a task requiring a decision.
4. Verify AskUserQuestion reaches AgentCall.
5. Say `la segunda` and verify Claude continues.
6. Ask `¿por qué no la primera?` and verify Claude explains instead of forcing a choice.

### D. Final-result loop
1. Ask Claude to implement a small page.
2. Wait for Stop and answer AgentCall.
3. Say `ábreme la web`.
4. Verify Claude continues in the same conversation.
5. Let Claude finish again.
6. Hang up and verify the session returns to idle.

### E. Multiple sessions
1. Launch two Claude sessions with AgentCall.
2. Trigger calls in both.
3. Answer first.
4. Verify second is visible as queued.
5. Hang up first and verify second can ring.

### F. Pending / snooze / DND
- Ignore call 30 seconds → Pending.
- Click Pending → active call.
- Snooze 1 minute → rings again.
- Enable DND → new calls go Pending silently.

### G. Failure fallback
1. Start Claude with plugin.
2. Close AgentCall.
3. Continue Claude.
4. Verify hook failures do not make Claude Code unusable.
