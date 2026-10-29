# Better Call Claude / AgentCall · System Spec v0.1

## 1. Goal

Windows-first companion for Claude Code. Claude can work in several terminal sessions in parallel and calls the user only when a meaningful handoff occurs: a decision, missing information, permission, important issue, error, or final result. The interaction is voice-first but always mirrored as live text.

## 2. Product principles

- Claude first; architecture should not prevent a later Codex adapter.
- Fast, understandable, free/local speech is preferred over hyper-realistic voice.
- Routine tool chatter never generates calls.
- Meaningful user-facing handoffs do generate calls.
- Voice is primary; text is a safety/fallback channel.
- Do not duplicate Claude's full conversation history or persist audio by default.

## 3. Call types

### Attention / decision call
Used when Claude needs an answer, missing information, clarification, or permission. Uses the attention ringtone.

### Result / final call
Used when Claude reaches a meaningful final result or completes a requested unit of work. Uses a distinct, softer result ringtone but still attracts attention.

### Error call
Used for meaningful failures that need awareness or intervention.

## 4. Incoming-call UX

The incoming-call card must show:

- descriptive Claude session/project title;
- one- or two-line context describing what is being worked on;
- call type;
- **Contestar** button;
- **Posponer** dropdown.

There is deliberately no Reject button.

Snooze values: `1,2,3,4,5,6,7,8,9,10,15,20,30,45,60,120` minutes.

If unanswered for 30 seconds, ringing stops and the call goes to **Pendientes**. A pending call can later be clicked to "call Claude back" and resume the held interaction when possible.

## 5. Do Not Disturb

DND is a simple boolean toggle, not a timer. While enabled, new calls are placed in Pending silently.

## 6. Active-call UX

The call is hands-free by default.

Visible controls:

- mute/unmute microphone;
- live text input fallback;
- Send;
- Hang up.

Claude is not interrupted while speaking in v0. Once TTS finishes, listening begins automatically.

The screen shows in real time:

- Claude's spoken text;
- the user's partial/final speech recognition;
- a normal message transcript for the duration of the active call.

The user may type at any point when voice recognition struggles with technical terms such as `Supabase` or `Vercel`.

## 7. Conversation semantics

### AskUserQuestion
Claude should prefer `AskUserQuestion` when it genuinely needs the user. AgentCall intercepts the hook and returns the selected/natural-language answer to the same Claude session.

If the user asks a clarification such as "why not A?", AgentCall must not fabricate a choice. Claude receives the clarification, answers it, and may ask again if a decision is still needed.

### PermissionRequest
Natural Spanish approval/denial is accepted. If the user asks why a permission is required, the current attempt is denied safely and Claude can explain/re-request.

### Stop / final result
The Stop hook remains open during the result call.

- Hang up: Claude is allowed to finish.
- User replies: reply is fed back into the same session as additional context so Claude continues.

Example: Claude says the page is finished; user says "ábreme la web"; the same Claude session continues and later calls again with the new result.

## 8. Multi-session behavior

Only one call may be active. Additional calls become visibly queued.

Example:

```text
Session A → ACTIVE
Session B → QUEUED
Session C → QUEUED
```

The active call shows how many calls are waiting. When the current call ends, the next queued call can ring.

Events from the same Claude session should be merged into the active call whenever possible.

## 9. Voice

### TTS v0
Use Chromium/Windows speech synthesis. Requirements: no API key, low latency, Spanish clarity. Voice realism is not a priority.

### STT v0
Use `System.Speech.Recognition.SpeechRecognitionEngine` with `es-ES` and streaming partial/final recognition.

If Windows STT is inadequate with technical vocabulary, replace only the speech provider with local Whisper/faster-whisper/whisper.cpp; the call architecture must remain unchanged.

## 10. Persistence and privacy

Do not persist:

- audio;
- full call transcript as a second permanent history;
- full Claude responses long-term.

Persist only operational metadata needed for DND/pending/snoozed/queued calls. Claude remains the canonical conversation history.

## 11. Local service

AgentCall listens only on `127.0.0.1:32147` in v0. Claude hooks POST to the local companion app. Hooks must fail open when the app is unavailable so Claude Code remains usable.

## 12. Windows v0 acceptance criteria

1. App starts and exposes `/health`.
2. Claude Code plugin validates.
3. AskUserQuestion triggers a call.
4. The incoming call shows useful session context.
5. Attention and result calls sound different.
6. Call can be answered hands-free.
7. Claude text is visible while spoken.
8. User speech appears as live partial/final text.
9. User can type a correction/fallback answer.
10. `la segunda` can answer a two-option question.
11. A clarification such as `¿por qué no la primera?` is not forced into a choice.
12. Permissions can be approved/denied by voice/text.
13. Final Stop call can continue the same Claude session when the user replies.
14. Hanging up a final result lets Claude stop.
15. Second simultaneous session is queued visibly.
16. Snooze works for the configured values.
17. 30 seconds unanswered → Pending.
18. Pending call can be opened/called back.
19. DND routes new calls silently to Pending.
20. Closing AgentCall does not make Claude Code unusable.

## 13. Later roadmap

- local Whisper STT;
- Kokoro/Piper TTS and voice selector;
- technical-term dictionary;
- global show/hide shortcut;
- repeat-last-fragment;
- autostart and signed Windows installer;
- audio device selector;
- generic `AgentAdapter` and optional Codex adapter.
