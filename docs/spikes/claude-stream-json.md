# Spike: driving Claude Code through `-p` stream-json

Date 2026-11-02 · Claude Code **2.1.289** (native `claude.exe`) · Windows 11 · subscription login (no API key).
Harness: `spikes/claude-stream/` (Node 22, no deps). Raw measurements: `spikes/claude-stream/results/*.json`.
All sessions ran in the scratch repo `E:\tmp\claude-stream-spike` with `AGENTCALL_SESSION_MODE=off`,
`--model haiku` unless stated. Every claim below was observed in those runs unless marked **(inferred)**
or **(schema)**: the npm package ships no CHANGELOG or docs, so "(schema)" means the zod schema
descriptions embedded in `claude.exe`, read with a byte search, not behavior we saw.

Spawned command:
`claude.exe -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages [--replay-user-messages] [--permission-prompt-tool stdio] [--include-hook-events]`
(`claude.cmd` cannot be spawned without a shell; the harness resolves the `claude.exe` behind the npm shim.)

## Verdicts

| Q | Verdict | Evidence (results file) |
|---|---|---|
| A1 auth | **VERIFIED** | `system/init.apiKeySource:"none"`, `ANTHROPIC_API_KEY` unset; the initialize response reports `account.subscriptionType:"Claude Ultra"`, `apiProvider:"firstParty"`. 6/6 processes answered (a1-a2-basic) |
| A2 several messages, one process | **VERIFIED** | 6 processes × 3 turns: one `session_id` across all of them, 18/18 correct answers. `system/init` is re-emitted at the start of **every** turn (a1-a2-basic) |
| A3 message while Claude works | **VERIFIED** (two behaviors) | During a tool: folded into the **current** turn at the next tool boundary (6/6, default and `priority:"next"`). During text generation: queued as the **next** turn (6/6). `priority:"now"` aborts the running turn and starts a new one (9/9: 3 during Bash, 6 during text) (a3-midturn, a3-midturn-longtext) |
| A4 interrupt | **VERIFIED**: 32/32 running turns aborted, 0 failures | text 10/10, Bash 10/10, race 9/10 aborted (in the 10th the turn had already finished, so there was nothing to abort), cold start 3/3; session usable afterwards in 33/33; the model knows it was interrupted (a4-interrupt, a4-interrupt-bash) |
| A4 child process killed? | **PARTLY** | `bash.exe` is killed (the `&& echo > marker` never ran: 0/10 markers), but the grandchild `sleep.exe` **survives as an orphan in 10/10** |
| A5 streaming | **VERIFIED** | `text_delta` about every 25 ms, about 7 characters each; block kind comes from `content_block_start` (a5-streaming-haiku) |
| A6 equivalence | **VERIFIED with caveats** | Both enabled plugins, 4/4 user MCP servers, every user skill dir, project and user CLAUDE.md all applied (Opus answered `PELICAN-42` / `codex-review`). AskUserQuestion, EnterPlanMode and ExitPlanMode are missing unless `--permission-prompt-tool stdio` is passed (a6-equivalence, a7-permissions) |
| A7 permissions | **VERIFIED** | `can_use_tool` control_request on stdout; allow 2/2, deny with message 2/2, deny+`interrupt:true` 1/1. Without a prompt tool, anything that needs approval is denied automatically (a7-permissions) |
| A8 session id / resume | **VERIFIED** | `--session-id` honored; `--resume <id of a plain -p session>` keeps the same id and context; a later `claude -p --resume` sees the streamed turns. Two live processes on one id are **not locked**: the transcript silently branches (a8-session) |
| A9 lifecycle | **VERIFIED** | Closing stdin while idle exits 0 in 0.37–0.85 s. Closing stdin mid-turn **finishes the turn**, then exits. Killing the process leaves Bash-tool orphans. Idle 315 s: no stdout traffic, about 1 % CPU, and the next turn works (a9-lifecycle) |
| B1 PostToolUse `additionalContext` | **VERIFIED** 3/3 | The secret word, given only in the hook, appeared in the final answer (b-hooks-b1-b2) |
| B2 PreToolUse deny + reason | **VERIFIED** 3/3 | Tool blocked. The model asks the user what they want, and the turn **continues one more model call, then ends normally** (b-hooks-b1-b2) |
| B3 other injection paths | **VERIFIED** for 5 outputs, **FLAKY/unsafe** for asyncRewake mid-turn | Stop `additionalContext` 2/2, Stop `decision:block` 2/2, PostToolBatch 1/1, PostToolUse `decision:block` 1/1, PreToolUse allow+`additionalContext` 1/1. asyncRewake wakes an **idle** session 2/2, but mid-turn the model distrusted it in 2/2. MessageDisplay is not a stream in `-p` (b-hooks-b3) |

## Latencies (haiku, this machine)

| Measurement | median | worst | n |
|---|---|---|---|
| spawn → `initialize` control_response | 1.19 s | 1.20 s | 3 |
| spawn → `system/init` (message written at spawn) | 1.33 s | 2.28 s | 3 |
| cold first turn: write → first `text_delta` | 4.07 s | 6.52 s | 3 |
| warm turn: write → first stdout line (`system/init`) | 140 ms | 152 ms | 12 |
| warm turn: write → `message_start` | 0.81 s | 1.06 s | 12 |
| warm turn: write → first `text_delta` (haiku thinks first) | 1.12 s | 1.90 s | 12 |
| warm turn: write → `result` ("Reply with exactly: TWO") | 1.36 s | 2.18 s | 12 |
| interrupt during text: write → control_response / → `result` | 1.0 / 5.3 ms | 1.5 / 22.6 ms | 10 |
| interrupt during Bash: → control_response / → `result` | 8.3 / 19.2 ms | 38 / 56 ms | 10 |
| interrupt 0–1000 ms after a message (race): → control_response / → `result` | 15 / 122 ms | 205 / 240 ms | 9 |
| interrupt right after the first message of a fresh process: → `result` | 1.42 s (waits for startup) | 1.46 s | 3 |
| `priority:"now"` during text: write → old turn cancelled | 9 ms | 12 ms | 5 |
| mid-tool message folded in: tool_result → lifecycle `started` | 149 ms | 267 ms | 6 |
| text_delta gap (median / p90 / max per rep) | 25 / 27–29 / 44–110 ms | | 3 |
| stdin close (idle) → exit | 0.45 s | 0.85 s | 7 |
| PostToolUse command hook (node), start → response | ~90 ms | | 3 |

Other timings: the user's Stop hooks add 0.15–0.25 s between the last `assistant` event and `result`. Tool `task_started` is emitted
about 3 s after the command starts, so it is not a spawn signal (**inferred**: sleep 8 showed only 5.1 s between task_started and task_notification).

## Exact shapes that worked

stdin (one JSON object per line):
```jsonc
{"type":"user","message":{"role":"user","content":"text"},"parent_tool_use_id":null,"session_id":"","uuid":"<uuid v4, optional>"}
{"type":"user", ..., "priority":"now"}          // "now" | "next" | "later" (later not tested)
{"type":"control_request","request_id":"req_1","request":{"subtype":"initialize"}}   // optional
{"type":"control_request","request_id":"req_2","request":{"subtype":"interrupt"}}    // no initialize needed
{"type":"control_request","request_id":"req_3","request":{"subtype":"mcp_status"}}
{"type":"control_response","response":{"subtype":"success","request_id":"<CLI's id>","response":{"behavior":"allow","updatedInput":{...input}}}}
{"type":"control_response","response":{"subtype":"success","request_id":"<CLI's id>","response":{"behavior":"deny","message":"The user declined by voice."}}}
//   add "interrupt":true to a deny to also end the turn (result error_during_execution/aborted_tools)
```
stdout to consume:
```jsonc
{"type":"control_response","response":{"subtype":"success","request_id":"req_2","response":{"still_queued":[]}}}  // interrupt receipt
{"type":"system","subtype":"init","session_id","model","permissionMode","tools":[...],"capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","interrupt_send_now_v1","msg_lifecycle_v1",...]}
{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text"|"thinking"|"tool_use",...}},"parent_tool_use_id":null}
{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"..."}}}
{"type":"assistant","message":{"id":"msg_…","content":[ONE block]}}   // one event per content block, same message id
{"type":"user","message":{"content":[{"type":"tool_result",...}]},"tool_use_result":{"interrupted":bool}}
{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}  // "... for tool use" during a tool
{"type":"command_lifecycle","command_uuid":"<your uuid>","state":"queued"|"started"|"completed"|"cancelled"}
{"type":"user","message":{...},"uuid":"<your uuid>","isReplay":true}   // only with --replay-user-messages
{"type":"control_request","request_id":"<id>","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name","input",
  "description","permission_suggestions":[...],"blocked_path","tool_use_id"}}
{"type":"result","subtype":"success"|"error_during_execution","is_error","terminal_reason":"completed"|"aborted_streaming"|"aborted_tools",
  "result":"final text","num_turns","session_id","permission_denials":[...],"total_cost_usd", ...}
```
Telling deltas apart: keep `index → content_block.type` from `content_block_start`, and reset it on `message_start`.
Only `text` blocks with `parent_tool_use_id:null` are user-facing speech. Other kinds: `tool_use` blocks stream `input_json_delta`,
and `thinking` blocks stream `thinking_delta` with **empty** `thinking` text (`thinking_display:"updates"`, `estimated_tokens` only) plus `signature_delta`.
`system/thinking_tokens` events also appear while the model thinks.

## A3 in detail: how to tell injected from queued

Stamp every user message with a `uuid`. The CLI then emits `command_lifecycle` for it. No opt-in was needed. Uuid-less messages get no lifecycle events.
- **Folded into the current turn**: your uuid goes `started` while the original uuid is still running. Here `started` came 125–267 ms after the
  tool_result. Both finish under one `result` (`num_turns:2`), and the answer used the new instruction (6/6).
- **Queued**: `started` comes only after the original is `completed`. That gives a second `result`.
- **`priority:"now"`**: the original goes `cancelled` and the old turn's `result` is `subtype:"success"` with `terminal_reason:"aborted_streaming"`
  (within 5–12 ms) or `"aborted_tools"`. Then a new turn runs the message. During Bash, a command that was already running finished normally and the turn
  stopped at the boundary (2/3). A command that had not started yet was aborted (exit 145, `interrupted:true`, 1/3). The new turn
  re-did the original task.
- `--replay-user-messages` echoes each message (`isReplay:true`, your uuid, creation timestamp) when it actually enters the
  conversation, after the UserPromptSubmit hooks, not when it is received. With lifecycle events it is redundant, but a cheap confirmation.

## A4 in detail

- The interrupt ends the turn with `result.subtype:"error_during_execution"`, `is_error:true`, `terminal_reason` `aborted_streaming` or `aborted_tools`.
  No `stream_event` arrived after the interrupt write (0/20). The CLI also emits the marker message `[Request interrupted by user]`.
- Asked afterwards, the model said "YES… a numbered list of animals" and "INTERRUPTED".
- An interrupt written while idle is answered (`still_queued:[]`) and has no effect on the next turn (2/2).
- An interrupt written immediately after the first message of a new process waits for startup (about 1.2 s), then aborts that turn. The second message ran normally (3/3).
  The schema describes a "latch" for this window. We saw no stuck state.
- **Windows orphans**: an interrupt kills the Bash tool's `bash.exe` but not its child `sleep.exe` (10/10). Killing `claude.exe` itself
  (TerminateProcess) left `bash.exe` ×2 + `conhost` + `sleep.exe` alive. MCP server children died.

## A6/A7 details

- Inventory, default model (Opus 5.5): 31 built-in tools, 26 MCP tools from 9 servers (4 user + 5 claude.ai), 70 skills, 10 agents,
  109 slash commands, plugins superpowers + agentcall + 4 built-in/synced. Built-in tools are identical between stream-json and plain `-p` for the
  same model. Haiku has TaskCreate/Get/List/Update, Opus does not (model-dependent).
  `terminal_slash_commands:["doctor","color","focus","reload-plugins"]` are not available in `-p`.
  Some MCP servers are `pending` at init. A later `mcp_status` showed them connected.
- Not checked: an interactive TTY session's own inventory (no PTY available without dependencies). Equivalence is judged against the config files.
- Permission mode: with no flag, the default model got `auto` (from `permissions.defaultMode`). Haiku reports `default` even with
  `--permission-mode auto`. `--permission-mode manual` is accepted and reported as `default`.
- **Hooks of the user and the plugin fire inside driven sessions**, including AgentCall's own: SessionStart, UserPromptSubmit, PreToolUse,
  PermissionRequest, PostToolUse, Stop. `--include-hook-events` puts `hook_started` and `hook_response` into the stream.
- Permission order: PreToolUse hook → `can_use_tool` on stdout → PermissionRequest hooks start about 1.5 ms later, in parallel.
  A host deny produced the tool_result 17 ms later while the hooks were still running. With deny+interrupt the hooks were `cancelled`.
  **(inferred)** The host answer and a deciding PermissionRequest hook race, and the first one wins.
- With no permission tool (stream-json or plain `-p`, default mode), the command was auto-denied and listed in `permission_denials`.
  PermissionRequest hooks still fired, and no `can_use_tool` was emitted. The plain `-p` model still answered "DONE." **Check `permission_denials`.**

## A8 details

`--resume <id>` on stream-json kept the id. Later `claude -p --resume <id>` answered "TEAL OTTER", and OTTER existed only in a streamed
turn: auto-memory held TEAL only. A second process resumed the id while the stream process was alive. It got no error and the same id, and saw the
streamed turns, but its turn became a **sibling branch** in the same `.jsonl`: by `parentUuid`, the stream process's next turn does not descend from it.
The next resume followed the newest leaf, so that turn was orphaned. Do not drive a session that is open in a terminal.

## Gotchas

1. **Orphaned processes on Windows**: an interrupt or kill does not take down the tool's whole process tree. AgentCall must end sessions with
   stdin close, or kill the tree itself (e.g. `taskkill /T /F /PID`).
2. **AgentCall's own plugin hooks run inside the sessions it drives.** They need an explicit off switch (env `AGENTCALL_SESSION_MODE=off` worked),
   or AgentCall will ring itself and hold Stop and permission requests.
3. **`result.subtype` is not the outcome**: a `priority:"now"` preemption reports `success` with `terminal_reason:"aborted_*"`, and an interrupt reports
   `error_during_execution`. Key on `terminal_reason` and the lifecycle uuids.
4. **Without `--permission-prompt-tool stdio`**, prompts are auto-denied, and AskUserQuestion and plan-mode tools are absent.
5. **No session locking**: two writers branch the transcript silently.
6. **Per-session cost**: every process starts all user MCP servers (19 processes, 0.5–0.94 GB working set for the tree, `claude.exe`
   about 170–240 MB). The first Bash call in a session is slow, and the user's Stop hooks delay `result`.
7. Many fields are marked `@internal` in the schema (`priority`, `send_now`, lifecycle details). Feature-detect them through `system/init.capabilities`.
8. Hook-injected text is framed by the CLI. asyncRewake stderr reaches the model as
   `<task-notification><summary>Stop hook feedback</summary>… Stop hook blocking error from command "UserPromptSubmit": …`. Haiku called
   it prompt injection when it arrived mid-turn (2/2). An asyncRewake hook on UserPromptSubmit **re-arms on every delivery** and loops.

## B details (hook mode, for terminal sessions)

- PostToolUse runs before the `tool_result` is emitted. Its `additionalContext` is stored as a `hook_additional_context` attachment and reaches the
  next model call. This is the "say this at the next tool boundary" channel.
- A PreToolUse deny comes back as tool_result `is_error:true` with the text `"PreToolUse:Bash hook error: <reason>"`. In 2/3 runs the model
  had issued both commands, and each was denied separately. Then it asked "¿Qué te gustaría hacer?"
  The turn does **not** stop by itself. Add `continue:false` or an interrupt-like path if a hard stop is needed (**not tested**).
- Stop `additionalContext` makes the model continue in the same turn (`num_turns:1`). Stop `decision:"block"`+`reason` does the same with `num_turns:2`.
  This is an "inject at the end of the turn" channel. The hook must skip when `stop_hook_active` is true.
- asyncRewake (`"asyncRewake":true` on a command hook, exit 2, stderr = message): this is the only path we saw that **wakes an idle session**, 2/2
  in a live stream-json process. Interactive TTY behavior was not tested **(inferred: same code path)**.
- MessageDisplay fired once per assistant message in `-p` (`final:true`, the full text in `delta`). The schema says it fires per flushed line in the
  terminal (**schema**, not tested). In a terminal session, that could give AgentCall streamed text through a hook.
- Available but untested in 2.1.289 (**schema**): PreToolUse `additionalContext`, SessionStart `initialUserMessage`, PermissionRequest
  deny `interrupt`, control requests `set_permission_mode`, `set_model`, `cancel_async_message`, `stop_task`, `interrupt` with `send_now`/`cancel_queued`.

## Recommendation

**Build an optional `ConversationSessionProvider` on stream-json** for sessions that AgentCall starts itself.
All three goals worked with zero failures in this spike:
- streamed `text_delta` at about 25 ms cadence;
- mid-turn injection at tool boundaries, with `uuid` + `command_lifecycle` to know when Claude took a message;
- reliable interrupts (32/32 running turns aborted, `result` within 60 ms during text or Bash, within 250 ms in send-then-interrupt races), plus `priority:"now"` for voice barge-in.

Design rules:
- Spawn `claude.exe` with `--permission-prompt-tool stdio`, answer `can_use_tool` by voice, and handle AskUserQuestion through it.
- Feature-detect `system/init.capabilities` and refuse to run if `interrupt_receipt_v1` and `msg_lifecycle_v1` are missing.
- Disable AgentCall's own hooks for these sessions.
- One writer per session id.
- End sessions by closing stdin, with a process-tree kill as the fallback.

Keep hook mode for terminal sessions, ranked by fit:
1. PostToolUse `additionalContext` (next tool boundary).
2. Stop `additionalContext` (end of turn).
3. PreToolUse deny (soft stop).
4. asyncRewake for idle wake-up. Validate this one in a real terminal first, and word the message so it is not taken as an injection.

Re-run `spikes/claude-stream` on every Claude Code upgrade. Many fields involved are `@internal`.

Reproduce: `cd spikes/claude-stream && node exp-a1-a2-basic.js 3 && node exp-a3-midturn.js 3 && node exp-a4-interrupt.js 10 &&
node exp-a5-streaming.js 3 && node exp-a6-equivalence.js && node exp-a7-permissions.js && node exp-a8-session.js &&
node exp-a9-lifecycle.js 300 && node exp-b-hooks.js 3`. Set `SPIKE_RAW_DIR` to keep full stdout outside the repo.
