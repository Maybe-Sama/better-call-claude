# BETTER CALL CLAUDE — VOICE FIRST OVERRIDE

This specification OVERRIDES the priorities of the previous Better Call Claude master specification.

The product is not a dashboard.

The product is not a notification system.

The product is not Telegram.

The product is not a pretty Windows app.

The product is:

# A PERFECT VOICE CONVERSATION WITH CLAUDE CODE

Everything else is secondary.

Do not spend meaningful implementation time on dashboards, switchboards, Telegram integration, tray UI, installer polish or visual redesign until the voice conversation reaches the acceptance criteria defined below.

The fundamental test is simple:

> If I close my eyes and talk to Claude through AgentCall for several minutes, does it feel like a real conversation rather than dictating commands into a terminal?

If the answer is no, the product is not ready.

---

# 1. PRODUCT NORTH STAR

The desired experience is similar to a natural realtime voice assistant.

Claude calls Alejandro.

Alejandro answers.

Claude explains what it needs.

Alejandro speaks naturally.

He can:

pause;

think;

hesitate;

interrupt;

correct himself;

change his mind;

add something after apparently finishing;

ask Claude a question instead of answering;

say “espera”;

say “no, no, eso no”;

say “me he explicado mal”;

say “antes de hacer eso, cambia también X”;

say “vale, sigue”;

say “repíteme lo último”;

and continue the conversation.

Claude must behave as though both people are on an actual phone call.

The call remains alive across multiple Claude turns.

ANSWERING ONE QUESTION MUST NOT MEAN THE CONVERSATION IS OVER.

The call ends when the USER hangs up or when an explicit product rule ends it.

---

# 2. CURRENT IMPLEMENTATION: PRESERVE THE GOOD PARTS

Before changing anything, inspect the actual implementation.

There are already strong pieces:

- local Whisper;
- partial transcription;
- accurate final transcription;
- contextual prompting/hotwords;
- microphone level detection;
- speech start/end detection;
- TTS sentence streaming;
- Edge neural TTS;
- Kokoro fallback;
- immediate TTS cancellation;
- barge-in;
- live transcript;
- typed correction;
- no audio persistence;
- pre-rendered acknowledgements.

Do not throw these away.

Improve them.

The current implementation already contains much of the machinery required for excellent voice UX.

---

# 3. CURRENT FUNDAMENTAL LIMITATION

The existing model is roughly:

Claude asks  
→ AgentCall rings  
→ user answers  
→ answer is submitted  
→ AgentCall waits for Claude  
→ microphone becomes effectively non-interactive  
→ next hook eventually creates another interaction.

This is not a natural conversation.

Replace this mental model with:

CALL SESSION

inside which we have:

Claude speaking  
User speaking  
Claude thinking/working  
User adds something  
User interrupts  
Claude responds  
User corrects  
Claude continues

The voice call must be a persistent conversational surface.

---

# 4. BUILD A REAL CONVERSATION ENGINE

Create a dedicated module/concept:

`VoiceConversation`

or equivalent.

Do not spread turn-taking logic randomly through renderer code.

It should own the conversation state machine.

Possible states include:

IDLE  
CLAUDE_PREPARING  
CLAUDE_SPEAKING  
USER_SPEAKING  
USER_PAUSED  
ENDPOINT_CANDIDATE  
USER_TURN_READY  
CLAUDE_WORKING  
INTERRUPTING  
RECOVERING

Use whatever exact names produce the cleanest implementation.

The important point is:

VOICE TURN STATE MUST BE EXPLICIT.

Do not infer everything from a pile of timers.

---

# 5. THE MICROPHONE MUST REMAIN AVAILABLE

Today AgentCall largely stops accepting a response while Claude is working.

That has to change.

During an active call, unless muted:

THE MICROPHONE SHOULD REMAIN AVAILABLE.

If Claude is working and Alejandro says:

“Espera.”

AgentCall should hear it.

If Alejandro says:

“Una cosa más…”

AgentCall should hear it.

If he says:

“No, me he equivocado. No hagas lo anterior.”

AgentCall should hear it and route that information appropriately.

The UI may say Claude is working, but the conversation must remain alive.

---

# 6. INVESTIGATE A CONTROLLABLE CLAUDE CODE SESSION

Hooks alone may not provide enough control for genuine realtime conversation.

Perform a focused technical spike.

Investigate driving Claude Code using its streaming CLI mode:

`claude -p`
`--input-format stream-json`
`--output-format stream-json`
`--verbose`
`--include-partial-messages`

Determine whether, using the user's normal Claude Code authentication:

1. multiple user messages can be sent into one persistent session;
2. messages can be queued while Claude works;
3. the current turn can be interrupted reliably;
4. assistant text can be streamed as it is generated;
5. tool use remains equivalent to normal Claude Code;
6. permissions can still be handled correctly;
7. session identity/resume remains viable.

DO NOT migrate the product blindly.

Build an isolated prototype first.

Measure it.

There have been recent Claude Code bugs involving `stream-json` interrupt timing, so feature-detect behavior against the installed Claude Code version and write explicit tests.

If controllable streaming Claude Code works reliably, introduce a capability such as:

`ConversationSessionProvider`

with:

sendMessage(text)

queueMessage(text)

interrupt()

streamAssistantText()

status()

Then VoiceConversation can use it.

Existing ordinary hook-driven Claude Code sessions must continue working as a fallback.

---

# 7. CONVERSATIONAL REPAIR IS P0

Natural conversation contains corrections.

This must work extremely well.

Example:

USER:
“Pon el botón azul.”

Then immediately:

“Uy no, espera. Me he equivocado. Verde.”

Expected result:

Claude understands that GREEN supersedes BLUE.

Not:

Claude finishes blue, then later receives an unrelated message saying green.

Implement a correction model.

If the previous user turn has NOT yet been consumed:

replace/amend it.

If Claude has begun acting:

decide whether the new speech should:

- queue additional context;
- interrupt the current turn;
- or be delivered at the next safe point.

Natural phrases such as:

“espera”

“para”

“no, no”

“me he equivocado”

“corrijo”

“quería decir”

“antes de eso”

must strongly bias toward interruption/correction semantics.

Do not create a brittle list of magic voice commands.

They are conversational signals.

Use deterministic local handling only when confidence is high.

Otherwise pass the natural sentence to Claude.

---

# 8. TURN TAKING MUST STOP USING FIXED TIMERS AS THE PRIMARY INTELLIGENCE

Today there are fixed delays around 1.5 s / 3 s / 5 s plus linguistic regex heuristics.

Keep them only as fallback safety mechanisms.

Build adaptive endpointing.

Use BOTH:

ACOUSTIC INFORMATION

and

LINGUISTIC INFORMATION.

Signals should include:

speech activity;

length of silence;

utterance duration;

partial transcript stability;

punctuation/completeness;

conjunctions;

filler words;

hesitation;

whether the interaction expects a short answer;

whether the user appears to be continuing a list;

whether the user has just said something equivalent to “espera”;

whether the current phrase is syntactically incomplete.

Examples:

“Sí.”

Permission question.

Can commit extremely quickly.

“Quiero que cambies la base de datos a Supabase.”

Probably complete after normal conversational silence.

“Quiero que cambies la base de datos y…”

DO NOT COMMIT.

“Pues… a ver…”

DO NOT COMMIT.

“No, espera.”

DO NOT send as an isolated final instruction immediately.

The endpointing engine should feel forgiving.

A slightly late response is better than repeatedly cutting Alejandro off.

But do not create multi-second dead air for obvious answers.

---

# 9. TARGET LATENCIES

Instrument the voice system.

Measure actual latencies.

Do not optimize by feel alone.

Create metrics for at least:

speech-start detection;

barge-in detection;

TTS stop latency;

first partial transcript;

final transcript;

endpoint decision;

submission;

Claude first output;

TTS first audio;

complete round-trip.

Initial product targets:

USER START → TTS SILENCED

target < 150 ms

hard goal < 250 ms

USER SPEAKING → FIRST USEFUL PARTIAL

target < 500 ms

OBVIOUS END OF TURN → COMMIT

short answer:
roughly 300–600 ms

normal sentence:
roughly 600–1000 ms

hesitant/incomplete thought:
adaptive, potentially longer

CLAUDE TEXT AVAILABLE → FIRST AUDIO

target < 300–500 ms whenever technically achievable.

Do not fake metrics.

Record them locally during development.

Add a debug voice-latency panel/log if useful.

---

# 10. BARGE-IN MUST BECOME EXCELLENT

Current semantic echo detection is clever but should not be the primary solution long term.

Today:

Claude speaks through speakers.

The microphone hears Claude.

Whisper can transcribe Claude's own audio.

The app attempts to determine whether transcription is echo by comparing words.

This is fragile.

Investigate true acoustic echo cancellation.

Strong candidate:

capture microphone audio through Electron/Chromium `getUserMedia()` with:

`echoCancellation: true`

`noiseSuppression: true`

and, after testing,

`autoGainControl`.

Stream PCM from Electron to the existing local Whisper worker.

Keep the current sounddevice capture as fallback until the new pipeline is proven.

Run an A/B test.

Goal:

Claude can speak through laptop speakers while the microphone remains open.

Alejandro can say:

“Espera.”

Claude's audio stops immediately.

Whisper receives Alejandro, not Claude's own voice.

This is essential for natural full-duplex conversation.

---

# 11. BARGE-IN SEMANTICS

When user speech is confidently detected while Claude speaks:

Claude audio should duck/stop immediately.

Do NOT wait for final Whisper transcription before stopping TTS if acoustic detection is sufficiently reliable.

Then determine what happened.

Examples:

“Espera.”

Pause.

“No.”

Correction/response.

“Sí, pero…”

Continue listening.

“Una cosa.”

Continue listening.

An accidental cough should not permanently destroy the conversation.

If interruption contains no meaningful speech:

resume or offer to continue naturally when possible.

Store enough TTS state to know what portion had already been spoken.

Support:

“sigue”

“continúa”

“¿qué estabas diciendo?”

“repíteme lo último”

without restarting an enormous response from the beginning.

---

# 12. STREAM CLAUDE'S RESPONSE INTO SPEECH

If the controllable Claude Code stream allows it:

DO NOT wait for Claude's full final answer before speaking.

Consume assistant text deltas.

Create a safe incremental speech chunker.

As soon as a semantically complete sentence or phrase exists:

send it to TTS.

While the user hears sentence 1:

Claude can generate sentence 2;

TTS can synthesize sentence 2.

This should create a pipeline:

Claude generation  
→ sentence detection  
→ TTS generation  
→ playback

in parallel.

Never speak:

half code;

half URL;

unfinished Markdown;

tool JSON;

internal tool chatter;

partial technical garbage.

Speech should contain only user-facing conversational text.

---

# 13. VOICE RESPONSE STYLE

Claude Code normally writes for a terminal.

During an AgentCall voice conversation, it must also speak well.

Update AgentCall's session instructions.

During a call Claude should:

speak conversationally;

use short sentences;

lead with the important thing;

avoid reading paths and giant commands aloud;

avoid Markdown-oriented language;

avoid dumping technical detail unnecessarily;

ask one clear question at a time when possible;

answer clarification questions directly;

use natural Spanish.

BUT:

Do not make Claude artificially chatty.

Do not add fake enthusiasm.

Do not repeatedly say:

“Claro”

“Perfecto”

“Entendido”

before every sentence.

The conversation should be efficient and human.

Technical details can still remain visible in the terminal/transcript.

---

# 14. ACKNOWLEDGEMENTS

The existing pre-rendered acknowledgements are useful because they hide processing dead time.

Improve them intelligently.

Use acknowledgements only when there will actually be perceptible waiting.

Examples:

“Vale.”

“Entendido.”

“Un momento.”

“Sí.”

“Lo cambio.”

Do not play a long generic sentence after every user turn.

The acknowledgement must match what happened.

For example:

USER:
“No, espera.”

AgentCall should not say:

“Perfecto, se lo paso a Claude.”

That sounds ridiculous.

It should simply stop and listen.

USER:
“Sí, dale.”

A very short:

“Vale.”

may be appropriate.

Silence is also valid.

---

# 15. STT QUALITY

Preserve the partial + accurate-final strategy.

Benchmark:

CPU Whisper small

GPU large-v3-turbo

and current partial strategy.

Measure:

latency;

word error rate;

technical vocabulary;

Spanish conversational speech;

names;

English technical terms embedded in Spanish.

Improve dynamic context.

Whisper should know:

current repository name;

branch;

technologies;

Claude's current question;

options Claude just presented;

important identifiers;

recently mentioned technical words.

Example:

If Claude asks:

“¿Prefieres Supabase o Neon?”

Whisper should be strongly biased toward:

Supabase

Neon

not random Spanish approximations.

Do not over-bias enough to hallucinate expected answers.

---

# 16. CONFIDENCE AND REPAIR

Do not silently send dubious transcription.

When confidence is poor:

do not force an answer.

Natural recovery:

“No te he entendido bien. ¿Puedes repetir esa última parte?”

But use this sparingly.

If only one technical term is uncertain, preserve the rest of the utterance and ask about that term if necessary.

Do not throw away a 20-second explanation because one word has low confidence.

Consider word/segment stability rather than only a single average confidence value where possible.

---

# 17. USER CAN KEEP TALKING WHILE CLAUDE WORKS

This is one of the most important acceptance requirements.

Example:

USER:
“Sí, usa Supabase.”

Claude starts working.

Two seconds later:

USER:
“Ah, y no toques el login de Google.”

That sentence MUST NOT disappear.

It should either:

be delivered as steering during the current turn;

be queued as immediate additional context;

or safely interrupt and restart the relevant action.

The user should not need to wait for Claude to finish before remembering something else.

VoiceConversation owns a:

`pendingUserSpeechQueue`

or equivalent.

Nothing meaningful spoken during an active call should be silently lost.

---

# 18. INTERRUPT VS QUEUE

Not every additional sentence should interrupt Claude.

Build semantics for:

QUEUE:

“Y cuando termines haz también X.”

INTERRUPT:

“No hagas eso.”

“Para.”

“Espera.”

“Me he equivocado.”

“Antes de seguir…”

High-risk correction should interrupt.

Additional non-conflicting work can queue.

If confidence is ambiguous:

prefer preserving the message and letting Claude reason about it rather than discarding it.

---

# 19. CLAUDE SHOULD BE ABLE TO TALK BACK MULTIPLE TIMES

The call must support real multi-turn dialogue.

Example:

CLAUDE:
“Hay dos formas de hacerlo. La primera mantiene…”

USER:
“Espera. ¿Por qué no usarías SQLite?”

CLAUDE:
“Porque en este caso…”

USER:
“Vale, entonces Supabase.”

CLAUDE:
“De acuerdo. Voy con Supabase.”

Claude continues working.

Later, in THE SAME CALL:

CLAUDE:
“Ya está. Las pruebas pasan.”

USER:
“¿Has probado también el login?”

CLAUDE:
“Todavía no.”

USER:
“Pues pruébalo antes de cerrar.”

Claude does it.

That is the required mental model.

---

# 20. CONVERSATIONAL MEMORY DURING THE CALL

Keep lightweight ephemeral voice state:

what Claude just said;

what part has been spoken;

current user draft;

last committed user message;

pending correction;

queued instructions;

current task;

current question.

Do not create a second giant permanent conversation database.

Claude remains canonical history.

Voice state exists only to make interaction fluid.

---

# 21. FAILURE BEHAVIOR

Voice must degrade gracefully.

If Whisper fails:

text remains available.

If TTS fails:

text remains visible.

If streaming Claude control fails:

fall back to existing hook mode.

If echo cancellation fails:

fall back to current semantic echo handling.

If interruption cannot safely reach Claude:

queue the correction and visibly/logically ensure it will be delivered at the next safe boundary.

NEVER LOSE USER SPEECH SILENTLY.

That is more important than pretending realtime steering worked.

---

# 22. BUILD A VOICE LAB

Before adding more product features, create a development harness specifically for conversation quality.

Something like:

`npm run voice-lab`

It should make it easy to test:

microphone;

speech detection;

partial STT;

final STT;

endpointing;

echo;

barge-in;

TTS latency;

interruptions;

repeated turns.

Expose timings.

Allow replaying controlled test WAVs where useful.

Do not persist normal user recordings.

Development fixtures may use synthetic/test audio.

The purpose is to tune conversation scientifically instead of editing constants blindly.

---

# 23. TEST REAL HUMAN SPEECH

Test scenarios must include:

short answer:

“sí”

option:

“la segunda”

hesitation:

“pues… a ver… yo creo que…”

continuation:

“haz eso y…”

self correction:

“ponlo azul… no, perdón, verde”

long answer:

20–30 seconds of natural speech

interruption:

Claude speaking → “espera”

false barge-in:

speaker audio/noise without user speech

technical language:

“Cambia el endpoint de Supabase y despliega en Vercel”

mixed Spanish/English:

“Haz el deploy del frontend pero no hagas merge todavía”

follow-up while Claude works:

“Ah, y otra cosa…”

clarification:

“¿Por qué has elegido esa opción?”

correction after submission:

“No, me he explicado mal.”

These are product tests, not curiosities.

---

# 24. MEASURE CONVERSATIONAL FAILURES

During development count failures such as:

premature endpoint;

late endpoint;

false speech start;

missed barge-in;

false barge-in due to echo;

incorrect transcription;

low-confidence transcription submitted anyway;

user message lost while Claude works;

correction delivered too late;

TTS begins too slowly;

Claude response unnecessarily verbose.

The goal is not “it technically works”.

The goal is:

failure rate low enough that the user stops thinking about the system.

---

# 25. DON'T CHASE VOICE REALISM FIRST

Edge Álvaro is currently acceptable.

Do not spend the main effort replacing the TTS model because another voice sounds 8% nicer.

Conversation quality is primarily:

latency;

turn-taking;

barge-in;

understanding;

repair;

continuity.

A merely good voice with excellent timing feels far more human than an incredible voice with terrible turn-taking.

After those are excellent, benchmark better voices if useful.

---

# 26. ACCEPTANCE TEST

The Voice First milestone is complete only when this works naturally:

Claude calls.

Alejandro answers.

CLAUDE:
“He terminado el cambio de autenticación, pero antes de seguir necesito decidir cómo vamos a guardar…”

ALEJANDRO, interrupting:
“Espera, espera. Antes de eso, ¿has comprobado que no rompe Google?”

Claude stops speaking almost instantly.

Claude processes the question.

CLAUDE:
“No. He probado email y contraseña, pero todavía no Google.”

ALEJANDRO:
“Vale pues prueba Google y… un momento…”

2 second thinking pause.

The system DOES NOT cut him off.

ALEJANDRO:
“y si falla no lo arregles todavía, dime primero qué ha roto.”

CLAUDE:
“Vale.”

Claude starts working.

Three seconds later:

ALEJANDRO:
“Ah, y me he equivocado antes: prueba también Apple.”

The message is preserved and delivered correctly.

Claude works.

CLAUDE:
“Google funciona. Apple falla porque…”

ALEJANDRO, interrupting:
“No, no hace falta que me expliques todo. ¿Es nuestro código o la configuración?”

CLAUDE:
“La configuración.”

ALEJANDRO:
“Pues arréglala.”

Claude continues.

Later:

CLAUDE:
“Ya funciona Google y Apple. Las pruebas pasan.”

ALEJANDRO:
“Perfecto, pues listo.”

Hang up.

If that conversation works repeatedly without Alejandro adapting his way of speaking to the software, the Voice First milestone passes.

---

# 27. EXECUTION ORDER

From this point forward:

FIRST:
audit and instrument the current voice pipeline.

SECOND:
build VoiceConversation state management.

THIRD:
improve microphone capture / echo cancellation / barge-in.

FOURTH:
adaptive endpointing.

FIFTH:
prototype controllable Claude Code streaming/steering.

SIXTH:
persistent multi-turn voice sessions and mid-work steering.

SEVENTH:
stream Claude responses into TTS.

EIGHTH:
stress-test and tune natural conversation.

ONLY THEN:

Telegram voice transport.

50-session switchboard.

dashboard.

settings polish.

tray.

installer aesthetics.

The only UI work allowed before then is UI needed to test or improve voice.

---

# 28. DEVELOPMENT BEHAVIOR

Do not write another giant design document and stop.

Inspect.

Instrument.

Implement.

Test.

Listen.

Measure.

Fix.

Repeat.

Create benchmarks before and after changes.

Keep existing tests passing.

Add voice-specific tests.

Do not sacrifice the current stable hook mode while investigating the more powerful streaming session mode.

Do not ask Alejandro routine engineering questions.

Make the decisions.

The objective is not to consume tokens.

The objective is to use the available engineering capacity to make the actual conversation dramatically better.

---

# 29. PRODUCT MANTRA

Every implementation decision should answer this question:

“Does this make talking to Claude feel more like talking to a person on the phone?”

If not, it is probably not the priority right now.

Build the conversation first.

Everything else can wait.

---

## Nota del usuario (mismo mensaje)

Hay además una decisión técnica que yo le marcaría como investigación número uno: conseguir que AgentCall controle opcionalmente la sesión de Claude mediante el modo streaming de la propia CLI, en vez de depender exclusivamente de hooks.

Eso nos abriría tres cosas brutales: escuchar la respuesta de Claude mientras la genera, meter nuevas frases mientras está trabajando e interrumpirlo de verdad. El Agent SDK ofrece formalmente precisamente streaming e interrupt(), y las sesiones gestionadas de Anthropic también admiten redirección durante la ejecución. Claude Platform Para nuestro caso intentaría primero hacerlo sobre claude -p/`stream-json`, porque queremos seguir viviendo dentro del flujo de Claude Code y no convertir Better Call Claude en otra aplicación API distinta.
