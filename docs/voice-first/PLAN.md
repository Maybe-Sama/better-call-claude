# Voice First — plan de ejecución

Spec: [SPEC.md](SPEC.md). Este plan solo fija decisiones y orden; el estado se actualiza al cerrar cada fase.

## Auditoría de partida (código en 8eb1313)

| Pieza | Hoy | Problema para una conversación real |
| --- | --- | --- |
| Captura | `src/speech/whisper_worker.py`: `sounddevice` sin AEC, VAD por energía adaptativa (inicio 3/5 tramas de 30 ms, fin 0,7 s) | El micro oye a Claude por los altavoces |
| Micro mientras Claude trabaja | `reconcileStt` pausa la escucha si `awaitingClaude` (`main.js:632`); el renderer muestra "lo que digas ahora no se le envía" | Lo que dices mientras trabaja se pierde |
| Barge-in | Solo con un parcial de ≥2 palabras que no sea eco semántico (`app.js:727`) | 1–2 s hasta callar a Claude; el VAD no se usa por miedo al eco |
| Fin de turno | 0,7 s (worker) + 1,5 / 3 / 5 s fijos (`app.js:11-17`), mínimo 1,2 s de cuenta atrás | "Sí" tarda ~2–2,5 s; temporizadores como única inteligencia |
| Correcciones | Solo antes del envío (el borrador se acumula) | Tras enviar, "no, espera" no llega a Claude hasta el siguiente hook |
| Continuidad | El siguiente Stop/pregunta de la misma sesión se funde en la llamada activa | Bien; falta escuchar entre medias |
| TTS | Edge por frases (3 en paralelo), Kokoro de respaldo, corte inmediato | Habla el mensaje final completo; no hay progreso para "sigue" / "repite" |
| Acuses | Uno de 3 frases largas al azar tras cada envío | Suena absurdo tras "espera" |
| Métricas | `window.__heard`, `window.__bargeIns` | No hay latencias medidas |

## Decisiones

1. **`VoiceConversation` vive en el proceso principal** (`src/voice/conversation.js`), puro y con reloj inyectable: recibe eventos (VAD, parciales, finales, TTS, estado de la llamada, texto tecleado) y emite órdenes (bajar/parar/reanudar voz, confirmar turno, encolar, acuse, estado para la UI). El renderer queda como pantalla y reproductor. Motivo: los eventos de STT llegan primero a main, main tiene el broker (hooks retenidos y cola) y así se prueba en Node sin DOM.
2. **Estado explícito en dos ejes**: `claude ∈ {speaking, awaitingUser, working, informing}` × `user ∈ {silent, speaking, endpointing, holding}`. La fase de la UI se deriva; los temporizadores solo son red de seguridad.
3. **Nada de lo que se dice durante una llamada se pierde**: con Claude trabajando, lo dicho va a `pendingUserSpeech` (por sesión, en el broker) con clase `queue` o `interrupt` (señales de corrección: "espera", "para", "no, no", "me he equivocado"…; si hay duda, se conserva y decide Claude).
4. **Entrega en modo hooks** (sesiones normales de terminal): en el siguiente `PostToolUse` (contexto adicional o `block` para interrupciones) y, si Claude termina antes, en el `Stop` (bloquear y continuar con lo dicho). Pendiente de confirmar empíricamente (spike B).
5. **Modo controlado** (`ConversationSessionProvider` sobre `claude -p --input-format stream-json`): solo si el spike lo valida. Los hooks siguen siendo el modo por defecto y el respaldo.
6. **AEC**: captura opcional en el renderer con `getUserMedia({echoCancellation, noiseSuppression, autoGainControl})` → PCM 16 kHz → worker (`--source stdin`). `sounddevice` queda de respaldo. A/B medido con el laboratorio de voz.
7. **Barge-in en dos pasos**: inicio de voz (VAD, con AEC) → bajar volumen al instante; si en ~300 ms sigue la voz o hay palabras → parar; si era una tos → recuperar volumen. Sin AEC, se mantiene el filtro semántico.
8. **Métricas sin contenido**: anillo en memoria + JSONL opcional (`voiceMetrics` en config) con tiempos, tipos y longitudes, nunca texto ni audio.

## Fases (orden de la spec)

1. **Instrumentar** — `src/voice/metrics.js`, marcas en worker/main/renderer, `npm run voice-lab` (fixtures sintéticas con Edge/Kokoro, WAV en tiempo real por el worker, resumen p50/p90). Línea base antes de tocar nada.
2. **VoiceConversation** — motor con TDD que reproduce el comportamiento actual, luego: micro abierto mientras Claude trabaja, cola `pendingUserSpeech`, clasificación queue/interrupt, acuses según contexto, progreso del TTS ("sigue", "repíteme lo último").
3. **Entrega en hooks** — `PostToolUse`/`Stop` entregan lo pendiente (tras el spike B).
4. **Captura con AEC + barge-in rápido** — A/B con el laboratorio (eco residual, falsos inicios, latencia hasta silenciar).
5. **Fin de turno adaptativo** — rasgos acústicos + lingüísticos; fin de silencio del worker más corto; turnos cortos rápidos y pensamientos incompletos pacientes.
6. **Modo controlado stream-json** — si el spike lo valida: proveedor, inyección a mitad de turno, interrupción real, voz en streaming desde los deltas.
7. **Estilo de voz** — reglas de sesión para hablar en llamada (frases cortas, lo importante primero, sin rutas ni markdown, sin muletillas).
8. **Estrés** — escenarios de la sección 23 de la spec y recuento de fallos de la sección 24.

## Cobertura de la spec → código y pruebas

Archivos nuevos: `src/voice/conversation.js`, `src/voice/endpointing.js`, `src/voice/metrics.js`, `scripts/voice-lab.js`, `scripts/voice-lab/{scenarios.js,make_fixtures.py}`. Pruebas: `test/voice-conversation.test.js`, `test/voice-endpointing.test.js`, `test/voice-metrics.test.js`, `test/broker.test.js`, `test/voice-acceptance.test.js`. Laboratorio: `npm run voice-lab -- fixtures|stt|tts` (datos en `%LOCALAPPDATA%\AgentCall\voice-lab`).

| Spec | Dónde | Prueba / criterio |
| --- | --- | --- |
| §4 estado explícito | `conversation.js` (turn × speaking × user; idle al colgar) | transiciones, colgar, silenciar, cambio de llamada |
| §5, §17 micro abierto | `reconcileStt` escucha toda la llamada salvo silencio | lo dicho trabajando → `commit` `steer` |
| §7 corrección | antes de confirmar: el borrador se acumula ("azul… no, verde" es un solo turno); confirmado pero sin entregar: la cola se entrega entera y en orden; entregado: `interrupt` | `voice-conversation` + `broker` |
| §8, §15, §16 fin de turno, STT, confianza | `endpointing.js` (política adaptativa junto a la heredada), contexto dinámico en `sttContextFor` | `voice-endpointing` + `voice-lab stt` (CPU y GPU, WER, nombres, técnico, mixto) |
| §9 métricas | worker (`onset_ms`, `silence_ms`, `stt_ms`), `conversation.js` (barge-in, parcial, final, fin de turno, primer audio), main (envío, primera salida de Claude, ida y vuelta) | `voice-metrics`: percentiles y que nunca se serializa texto |
| §10, §11 AEC y barge-in | captura del renderer → PCM 16 kHz → `whisper_worker.py --source stdin`; bajar volumen al detectar voz y parar si sigue 250 ms o hay palabras | eco residual y falsos inicios medidos; respaldo automático a `sounddevice` |
| §11 "sigue" / "repíteme" | cursor de frases del TTS en `conversation.js` | continúa desde la frase cortada, no desde el principio |
| §14 acuses | `committed()`: nada tras "para"/"espera", "Un momento" ante una aclaración, "Vale" en lo demás | probado |
| §17, §18, §21 cola que nunca pierde voz | `broker.queueUserSpeech` por sesión: orden, sesiones aisladas, visible en la llamada hasta entregarse, se conserva al colgar; entrega en `PostToolUse` / `Stop` / siguiente `UserPromptSubmit` | `broker`: entrega, orden, colgar, Claude cerrado, toma de control desde la terminal |
| §6, §12, §19 sesión controlada | `src/voice/stream-session.js` (`ConversationSessionProvider`), troceador seguro de deltas | tras el spike; contrato común con el modo hooks |
| §13 estilo de voz | `CALL_RULES` en `src/broker.js` (contexto de SessionStart y de `/saul on`) | solo en sesiones con llamadas activas |
| §21 degradación | Whisper caído → texto; TTS caído → texto visible y voz de Windows; stream → hooks; AEC → filtro semántico | pruebas por fallo |
| §24 recuento de fallos | contadores en `metrics.js` | `voice-lab` los informa |
| §26 aceptación | `test/voice-acceptance.test.js`: conversación completa con reloj falso (pausa de 2 s, interrupción, añadido mientras trabaja, colgar) + prueba real con Whisper | pasa repetidamente |

## Objetivos medibles (sección 9 de la spec)

| Métrica | Objetivo |
| --- | --- |
| Inicio de voz del usuario → TTS en silencio | < 150 ms (máx. 250) |
| Inicio de voz → primer parcial útil | < 500 ms |
| Fin evidente → confirmación (respuesta corta) | 300–600 ms |
| Fin evidente → confirmación (frase normal) | 600–1000 ms |
| Texto de Claude disponible → primer audio | < 300–500 ms |

## Estado

- [x] 1 instrumentar (laboratorio, tiempos del worker, métricas) · [x] 2 VoiceConversation conectado · [x] 3 entrega en hooks (`PostToolUse` sin validar en real: spike B) · [x] 4 captura con AEC + barge-in en dos pasos (`capture: "aec"`, validado con micro falso de Chromium; falta voz real) · [~] 5 fin de turno adaptativo (por defecto) + final especulativo · [ ] 6 sesión controlada stream-json · [x] 7 estilo de voz en `CALL_RULES` · [~] 8 aceptación §26 automatizada (`test/voice-acceptance.test.js`); falta prueba real repetida
- Spike stream-json: en curso → `docs/spikes/claude-stream-json.md`
- Cola de voz: vive en memoria por sesión hasta entregarse (también tras colgar); no se escribe en disco a propósito (serían transcripciones). Se pierde solo si AgentCall se cierra antes de entregarla.

## Línea base (laboratorio, Whisper GPU, voz de prueba Edge, 14 escenarios)

| Medida | Antes (8eb1313) | Adaptativa, fin 0,7 s |
| --- | --- | --- |
| Inicio de voz detectado | 60 ms | 61 ms |
| Primer parcial | 1,5 s | 1,7 s |
| Barge-in (sin AEC: parcial con 2 palabras) | 1,5 s (p90 4,1) | igual; con AEC: 250 ms desde el inicio de voz |
| Final tras acabar de hablar | 1,75 s | 2,2 s (GPU compartida en la medición) |
| Fin de turno → envío | 3,7 s | 2,6 s |
| Turnos con envío prematuro | 0/14 | 1/14 (corregido después: no decide sin la última transcripción) |
| Turnos perdidos | 2/14 | 0/14 |
| WER | 0,24 | 0,04 (contexto de la pregunta) |
| TTS primer audio (Edge / Kokoro) | 1,8 s / 0,6 s | primer mensaje preparado mientras suena |
