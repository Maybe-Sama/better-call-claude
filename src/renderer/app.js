'use strict';

const main = document.getElementById('main');
const dndBtn = document.getElementById('dndBtn');
const minBtn = document.getElementById('minBtn');
const closeBtn = document.getElementById('closeBtn');
const serviceBanner = document.getElementById('serviceBanner');

// Everything the user says is accumulated and sent once they have been silent this long:
// short for questions/permissions ("la segunda", "sí"), longer for free replies to a result.
const VOICE_SUBMIT_DELAY_MS = 1500;
const VOICE_SUBMIT_DELAY_FREE_MS = 3000;
// The transcribed text is always visible this long before it is sent, even if transcription was slow.
const MIN_VISIBLE_COUNTDOWN_MS = 1200;
// When the last words announce more ("y…", "pero…", "quiero añadir…"), the user is thinking, not done.
const VOICE_SUBMIT_DELAY_THINKING_MS = 5000;
const THINKING_TAIL = /(\b(y|o|e|u|pero|que|porque|entonces|adem[aá]s|tambi[eé]n|aparte|eh|em|mm|bueno|pues|a ver|o sea|es decir|como|tipo|luego|despu[eé]s|a[nñ]adir|decir|comentar|otra cosa)|\.\.\.|…|,)\s*[.,…]*\s*$/i;
// Below this, Windows recognitions are noise/echo guesses ("Orlando", 0.11) and are dropped.
const MIN_STT_CONFIDENCE = 0.3;
// How long after Claude stops speaking its voice may still echo back into the microphone.
const ECHO_TAIL_MS = 1500;

let state = { calls: [], activeId: null, dnd: false, snoozeOptions: [] };
let muted = false;
let ttsSpeaking = false;
let currentUtterance = null;
const spokenKeys = new Set();
let ringStopper = null;
let partialText = '';
let finalVoiceParts = [];
let voiceSubmitTimer = null;
let sttReady = false;
let sttListening = false;
let micLevel = 0;
let lowConfidenceHint = false;
let userSpeaking = false;
let submitDeadline = 0;
let speechEndedAt = 0;
let lastSpokenText = '';
let lastSpokenEndedAt = 0;
let callStartedAt = null;
let clockTimer = null;
let spanishVoice = null;

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function esc(value = '') { return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch])); }
function activeCall() { return state.calls.find(c => c.id === state.activeId) || null; }
function ringingCall() { return state.calls.find(c => c.status === 'ringing') || null; }
function listedCalls() { return state.calls.filter(c => ['pending', 'snoozed', 'queued'].includes(c.status)); }

function callLabel(call) {
  if (call.type === 'error') return 'ERROR';
  if (call.type === 'completion') return 'RESULTADO LISTO';
  if (call.interactionKind === 'permission') return 'PERMISO NECESARIO';
  return 'NECESITA RESPUESTA';
}
function statusLabel(status) { return ({ pending: 'Pendiente', queued: 'En cola', snoozed: 'Pospuesta', ringing: 'Llamando', active: 'Activa' })[status] || status; }
function timeAgo(ts) {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return 'ahora';
  const min = Math.round(diff / 60_000);
  return min < 60 ? `hace ${min} min` : `hace ${Math.round(min / 60)} h`;
}
function formatSnooze(min) { if (min === 60) return '1 hora'; if (min === 120) return '2 horas'; return `${min} min`; }

// ── Rendering ────────────────────────────────────────────────────────────────

function render() {
  dndBtn.classList.toggle('on', state.dnd);
  dndBtn.textContent = state.dnd ? 'DND ON' : 'DND';
  dndBtn.setAttribute('aria-pressed', String(state.dnd));
  const active = activeCall();
  const ringing = ringingCall();
  if (active) renderActive(active);
  else if (ringing) renderIncoming(ringing);
  else renderDashboard();
  syncRing(ringing && !active ? ringing : null);
  if (active) maybeSpeakLatest(active);
}

function renderIncoming(call) {
  resetCallClock();
  const completion = call.type === 'completion';
  main.innerHTML = `<section class="incoming ${completion ? 'completion-view' : ''}">
    <div class="call-type ${esc(call.type)}">${esc(callLabel(call))}</div>
    <div class="phone-orbit"><div class="phone-icon" aria-hidden="true">☎</div></div>
    <h1>${esc(call.title)}</h1>
    <div class="context">${esc(call.context)}</div>
    <div class="meta">${call.detail ? `${esc(call.detail)} · ` : ''}Llamada entrante</div>
    <div class="incoming-actions">
      <button class="primary" id="answerBtn">Contestar</button>
      <div class="snooze-wrap">
        <button class="secondary" id="snoozeBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="snoozeMenu">Posponer ▾</button>
        <div class="snooze-menu hidden" id="snoozeMenu" role="menu">${state.snoozeOptions.map(m => `<button role="menuitem" data-snooze="${m}">${formatSnooze(m)}</button>`).join('')}</div>
      </div>
    </div></section>`;
  document.getElementById('answerBtn').onclick = async () => { stopRing(); await window.agentCall.answer(call.id); };
  const menu = document.getElementById('snoozeMenu');
  const snoozeBtn = document.getElementById('snoozeBtn');
  const setMenu = (open) => {
    menu.classList.toggle('hidden', !open);
    snoozeBtn.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('button')?.focus();
  };
  snoozeBtn.onclick = () => setMenu(menu.classList.contains('hidden'));
  menu.onkeydown = (e) => { if (e.key === 'Escape') { setMenu(false); snoozeBtn.focus(); } };
  menu.querySelectorAll('[data-snooze]').forEach(btn => {
    btn.onclick = async () => { stopRing(); await window.agentCall.snooze(call.id, Number(btn.dataset.snooze)); };
  });
}

function canRespond(call) {
  return ['ask', 'permission', 'stop'].includes(call.interactionKind) && call.waiting && !call.awaitingClaude;
}

function callStatusText(call) {
  if (ttsSpeaking) return muted || !canRespond(call) ? 'Claude hablando…' : 'Claude hablando · micrófono abierto';
  if (call.awaitingClaude) return 'Claude trabajando…';
  if (!canRespond(call)) return 'Llamada informativa · cuelga cuando quieras';
  if (muted) return 'Micrófono silenciado · puedes escribir';
  if (!sttReady) return 'Preparando reconocimiento de voz…';
  return sttListening ? 'Escuchando…' : 'Preparando micrófono…';
}

function renderActive(call) {
  if (!callStartedAt) callStartedAt = Date.now();
  // Keep whatever the user is typing across re-renders.
  const oldInput = document.getElementById('textInput');
  const draft = oldInput ? { value: oldInput.value, focused: document.activeElement === oldInput, start: oldInput.selectionStart, end: oldInput.selectionEnd } : null;

  const queued = state.calls.filter(c => c.status === 'queued').length;
  const inputDisabled = !canRespond(call);
  main.innerHTML = `<section class="active-call">
    <div class="call-head">
      <div class="avatar" aria-hidden="true">C</div>
      <div class="head-copy"><div class="head-title">${esc(call.title)}</div><div class="head-context">${esc(call.context)}</div></div>
      <div class="status-pill ${call.awaitingClaude ? 'working' : ''}"><span id="callClock">00:00</span></div>
    </div>
    ${queued ? `<div class="queue-strip">☎ ${queued} ${queued === 1 ? 'llamada esperando' : 'llamadas esperando'} en cola</div>` : ''}
    <div class="transcript" id="transcript" aria-live="polite">${call.messages.map(messageHtml).join('')}</div>
    <div class="live-caption" id="liveCaption">${liveCaptionHtml(call)}</div>
    <div class="call-controls">
      <div class="input-row">
        <button id="muteBtn" class="mic-btn ${muted ? 'muted' : ''}" title="${muted ? 'Activar micrófono' : 'Silenciar micrófono'}" aria-pressed="${muted}">${muted ? '⌁' : '●'}</button>
        <input id="textInput" class="text-input" type="text" autocomplete="off" placeholder="${inputDisabled ? 'Claude no espera respuesta ahora' : 'Escribe o corrige lo dictado…'}" ${inputDisabled ? 'disabled' : ''}/>
        <button id="sendBtn" class="send-btn" ${inputDisabled ? 'disabled' : ''}>Enviar</button>
      </div>
      <div class="bottom-row">
        <div class="listen-state" id="listenState"><span class="level" aria-hidden="true"><span id="levelBar"></span></span><span id="listenText">${esc(callStatusText(call))}</span></div>
        <button id="hangupBtn" class="hangup">Colgar</button>
      </div>
    </div></section>`;

  const transcript = document.getElementById('transcript');
  transcript.scrollTop = transcript.scrollHeight;
  updateClock();
  updateLevel();
  if (!clockTimer) clockTimer = setInterval(updateClock, 1000);

  document.getElementById('muteBtn').onclick = async () => { muted = !muted; await window.agentCall.setMuted(muted); render(); };
  document.getElementById('hangupBtn').onclick = async () => {
    stopSpeech();
    clearVoiceDraft();
    await window.agentCall.hangup(call.id);
  };

  const input = document.getElementById('textInput');
  if (draft && !inputDisabled) {
    input.value = draft.value;
    if (draft.focused) {
      input.focus();
      try { input.setSelectionRange(draft.start, draft.end); } catch {}
    }
  }
  // Starting to type takes over the voice draft so a misheard word can be corrected before sending.
  const adoptVoiceDraft = () => {
    const spoken = currentVoiceText();
    if (!spoken) return;
    cancelVoiceSubmit();
    input.value = input.value ? `${input.value} ${spoken}` : spoken;
    clearVoiceDraft();
  };
  input.onfocus = adoptVoiceDraft;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send(); return; }
    adoptVoiceDraft();
  };
  const send = async () => {
    const value = input.value.trim();
    const current = activeCall();
    if (!value && finalVoiceParts.length) return submitVoiceNow();
    if (!value || !current || !canRespond(current)) return;
    input.value = '';
    clearVoiceDraft();
    stopSpeech();
    const result = await window.agentCall.submitText(current.id, value).catch(err => ({ ok: false, error: err.message }));
    if (result?.ok && result.resolved !== false) acknowledge();
    if (!result?.ok) {
      const box = document.getElementById('textInput');
      if (box && !box.value) box.value = value;
      showBanner(result?.error || 'No se pudo enviar la respuesta.');
    }
  };
  document.getElementById('sendBtn').onclick = send;
}

function messageHtml(msg) {
  const role = msg.role === 'user' ? 'user' : msg.role === 'system' ? 'system' : 'assistant';
  const sender = role === 'user' ? 'Tú' : role === 'system' ? 'AgentCall' : 'Claude';
  return `<div class="message ${role}"><div class="sender">${sender}</div><div class="bubble">${esc(msg.text)}</div></div>`;
}

function currentVoiceText() { return [...finalVoiceParts, partialText].join(' ').replace(/\s+/g, ' ').trim(); }

function liveCaptionHtml(call = activeCall()) {
  const final = finalVoiceParts.join(' ').trim();
  if (final || partialText) {
    const text = `${esc(final)}${partialText ? ` <span class="partial">${esc(partialText)}</span>` : ''}`;
    if (!submitDeadline) return text;
    const ms = Math.max(0, submitDeadline - Date.now());
    return `${text}<div class="countdown" aria-hidden="true"><span style="animation-duration:${ms}ms"></span></div><div class="countdown-hint">Enviando… sigue hablando para añadir, o pulsa Enviar.</div>`;
  }
  if (call && call.awaitingClaude && call.messages.at(-1)?.role === 'user') return '<span class="partial">Enviado. Claude está trabajando; lo que digas ahora no se le envía.</span>';
  if (lowConfidenceHint && call && canRespond(call) && !ttsSpeaking) return 'No te he entendido bien. Repítelo o escríbelo.';
  if (!call || !canRespond(call)) return '<span class="partial">—</span>';
  if (muted) return 'Micrófono silenciado. Puedes escribir tu respuesta.';
  return sttListening ? 'Lo que digas aparecerá aquí en tiempo real…' : 'Preparando reconocimiento de voz…';
}

function updateLiveCaption() {
  const el = document.getElementById('liveCaption');
  if (el) el.innerHTML = liveCaptionHtml();
  const text = document.getElementById('listenText');
  const call = activeCall();
  if (text && call) text.textContent = callStatusText(call);
}

function updateLevel() {
  const bar = document.getElementById('levelBar');
  if (bar) bar.style.transform = `scaleX(${sttListening && !muted ? Math.min(1, micLevel / 60) : 0})`;
}

function renderDashboard() {
  resetCallClock();
  const calls = listedCalls();
  main.innerHTML = `<section class="dashboard">
    <div class="dashboard-head">
      <div><h1>Centralita</h1><div class="dashboard-sub">Claude te llama solo cuando merece tu atención.</div></div>
      <div class="state-chip ${state.dnd ? 'dnd' : ''}">${state.dnd ? 'No molestar' : 'Disponible'}</div>
    </div>
    ${calls.length
      ? `<div class="list-label">Pendientes</div><div class="call-list">${calls.map(callCardHtml).join('')}</div>`
      : '<div class="empty"><div class="empty-icon" aria-hidden="true">☎</div><strong>Todo tranquilo</strong><div>No hay llamadas pendientes.</div></div>'}
  </section>`;
  main.querySelectorAll('[data-call-id]').forEach(card => {
    const callBack = async () => {
      const call = state.calls.find(c => c.id === card.dataset.callId);
      if (!call || call.status === 'snoozed') return;
      await window.agentCall.answer(call.id);
    };
    card.onclick = callBack;
    card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); callBack(); } };
  });
}

function callCardHtml(call) {
  let extra = timeAgo(call.createdAt);
  if (call.status === 'snoozed' && call.snoozedUntil) extra = `vuelve a las ${new Date(call.snoozedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const action = call.status === 'snoozed' ? '' : '<span class="card-action">Devolver llamada →</span>';
  const interactive = call.status !== 'snoozed' ? 'role="button" tabindex="0"' : 'aria-disabled="true"';
  return `<article class="call-card ${esc(call.type)}" data-call-id="${esc(call.id)}" ${interactive}>
    <div class="card-top"><div class="card-title">${esc(call.title)}</div><div class="card-status">${esc(statusLabel(call.status))}</div></div>
    <div class="card-context">${esc(call.context)}</div>
    <div class="card-time">${esc(callLabel(call))}${call.detail ? ` · ${esc(call.detail)}` : ''} · ${esc(extra)}${action}</div>
  </article>`;
}

function updateClock() {
  const el = document.getElementById('callClock');
  if (!el || !callStartedAt) return;
  const sec = Math.floor((Date.now() - callStartedAt) / 1000);
  el.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

function resetCallClock() {
  callStartedAt = null;
  clearInterval(clockTimer);
  clockTimer = null;
}

// ── Text to speech (Chromium → Windows voices) ───────────────────────────────

function pickSpanishVoice() {
  const voices = speechSynthesis.getVoices();
  spanishVoice = voices.find(v => /^es-ES$/i.test(v.lang))
    || voices.find(v => /^es[-_]/i.test(v.lang))
    || voices.find(v => /spanish|español/i.test(v.name))
    || null;
}
speechSynthesis.onvoiceschanged = pickSpanishVoice;
pickSpanishVoice();

function maybeSpeakLatest(call) {
  const latest = [...(call.messages || [])].reverse().find(m => m.role === 'assistant');
  if (!latest) return;
  const key = `${call.id}:${latest.at}`;
  if (spokenKeys.has(key)) return;
  spokenKeys.add(key);
  speak(latest.speech || latest.text);
}

function setTts(value) {
  if (ttsSpeaking === value) return;
  ttsSpeaking = value;
  window.agentCall.setTts(value);
  const call = activeCall();
  if (call) { updateLiveCaption(); const text = document.getElementById('listenText'); if (text) text.textContent = callStatusText(call); }
}

// Claude's voice. Kokoro (local neural TTS) streams one sentence at a time and is played here, on the
// same output as the ringtone, so it can be cut the instant the user starts talking. If Kokoro is not
// available, Chromium's Windows voices are used instead.
let ttsEngine = 'browser';
let uttCounter = 0;
let playback = { id: null, sources: [], nextTime: 0, done: false };

function speak(text) {
  stopSpeech();
  const spoken = String(text || '').replace(/\s+/g, ' ').trim();
  if (!spoken) return;
  setTts(true);
  lastSpokenText = spoken;
  if (ttsEngine === 'kokoro') {
    const id = `u${++uttCounter}`;
    playback = { id, sources: [], nextTime: 0, done: false };
    window.agentCall.ttsSpeak(id, spoken).then(ok => {
      if (!ok && playback.id === id) { playback.id = null; ttsEngine = 'browser'; speakWithBrowser(spoken); }
    });
    return;
  }
  speakWithBrowser(spoken);
}

function speakWithBrowser(spoken) {
  setTts(true);
  const utterance = new SpeechSynthesisUtterance(spoken);
  if (!spanishVoice) pickSpanishVoice();
  if (spanishVoice) utterance.voice = spanishVoice;
  utterance.lang = spanishVoice?.lang || 'es-ES';
  utterance.rate = 1.08;
  const finish = () => {
    if (currentUtterance !== utterance) return;
    currentUtterance = null;
    speechFinished();
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  currentUtterance = utterance; // keep a reference: Chromium may GC it and never fire onend
  speechSynthesis.speak(utterance);
}

function speechFinished() {
  lastSpokenEndedAt = Date.now();
  setTts(false);
  render();
  if (finalVoiceParts.length) scheduleVoiceSubmit();
}

// Sentences arrive as raw PCM (Kokoro) or MP3 (Edge). MP3 decoding is async, so sentences are chained
// to keep their order, and the utterance only "ends" once every pending decode has been scheduled.
function playAudioChunk(data) {
  if (data.id !== playback.id) return;
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  const id = playback.id;
  playback.pending = (playback.pending || 0) + 1;
  playback.chain = (playback.chain || Promise.resolve()).then(async () => {
    try {
      if (playback.id !== id) return;
      const bytes = Uint8Array.from(atob(data.format === 'mp3' ? data.data : data.pcm), c => c.charCodeAt(0));
      let buffer;
      if (data.format === 'mp3') {
        buffer = await audioCtx.decodeAudioData(bytes.buffer);
      } else {
        const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
        buffer = audioCtx.createBuffer(1, pcm.length, data.rate);
        const channel = buffer.getChannelData(0);
        for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;
      }
      if (playback.id !== id) return;
      scheduleBuffer(buffer, id);
    } catch (err) {
      console.error('AgentCall audio chunk failed', err);
    } finally {
      if (playback.id === id) { playback.pending -= 1; maybeFinishPlayback(); }
    }
  });
}

function scheduleBuffer(buffer, id) {
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  const at = Math.max(audioCtx.currentTime + 0.03, playback.nextTime);
  source.start(at);
  playback.nextTime = at + buffer.duration + 0.06; // short breath between sentences
  playback.sources.push(source);
  source.onended = () => {
    if (playback.id !== id) return;
    playback.sources = playback.sources.filter(x => x !== source);
    maybeFinishPlayback();
  };
}

function maybeFinishPlayback() {
  if (!playback.id || !playback.done || playback.sources.length || playback.pending) return;
  const wasAck = playback.ack;
  playback = { id: null, sources: [], nextTime: 0, done: false };
  if (wasAck) { lastSpokenEndedAt = Date.now(); setTts(false); return; }
  speechFinished();
}

// Instant "Vale, se lo paso a Claude." after the user's answer is sent, so the line never feels dead.
function acknowledge() {
  if (ttsEngine !== 'kokoro' || muted) return;
  stopSpeech();
  const id = `ack${++uttCounter}`;
  playback = { id, sources: [], nextTime: 0, done: false, ack: true };
  lastSpokenText = 'Vale, se lo paso a Claude. Entendido, se lo digo. Perfecto, se lo paso.';
  setTts(true);
  window.agentCall.ttsAck(id);
}

function stopSpeech() {
  const wasSpeaking = Boolean(currentUtterance || playback.id);
  if (playback.id) {
    window.agentCall.ttsStop();
    for (const source of playback.sources) { try { source.stop(); } catch {} }
    playback = { id: null, sources: [], nextTime: 0, done: false };
  }
  currentUtterance = null;
  speechSynthesis.cancel();
  if (wasSpeaking) lastSpokenEndedAt = Date.now();
  setTts(false);
}

window.agentCall.onTts(data => {
  if (data.type === 'ready') ttsEngine = 'kokoro'; // any worker engine (kokoro or edge) streams audio here
  else if (data.type === 'unavailable') {
    ttsEngine = 'browser';
    if (playback.id && !playback.ack) { const text = lastSpokenText; playback = { id: null, sources: [], nextTime: 0, done: false }; speakWithBrowser(text); }
  } else if (data.type === 'audio') playAudioChunk(data);
  else if (data.type === 'done' && data.id === playback.id) { playback.done = true; maybeFinishPlayback(); }
});
window.agentCall.getTtsEngine().then(engine => { if (engine) ttsEngine = engine; });

// ── Ringtones: attention (questions/permissions/errors) vs result ────────────

function startRing(type) {
  stopRing();
  let stopped = false;
  let timer = null;
  const completion = type === 'completion';
  const cycle = () => {
    if (stopped) return;
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const now = audioCtx.currentTime;
    if (completion) {
      tone(now, 660, 0.13, 0.08);
      tone(now + 0.2, 880, 0.16, 0.07);
      tone(now + 0.42, 1320, 0.22, 0.05);
    } else {
      tone(now, 520, 0.22, 0.10);
      tone(now + 0.32, 620, 0.22, 0.10);
      tone(now + 0.72, 520, 0.22, 0.08);
    }
    timer = setTimeout(cycle, completion ? 2600 : 1800);
  };
  ringStopper = () => { stopped = true; clearTimeout(timer); };
  cycle();
}

function tone(at, frequency, duration, gainValue) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(gainValue, at + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(at);
  osc.stop(at + duration + 0.03);
}

function stopRing() { if (ringStopper) ringStopper(); ringStopper = null; }

function syncRing(call) {
  const id = call?.id || null;
  if (syncRing.current === id) return;
  stopRing();
  syncRing.current = id;
  if (call) startRing(call.type);
}
syncRing.current = null;

// ── Voice answers ────────────────────────────────────────────────────────────

function cancelVoiceSubmit() {
  const wasCounting = Boolean(submitDeadline);
  if (voiceSubmitTimer) clearTimeout(voiceSubmitTimer);
  voiceSubmitTimer = null;
  submitDeadline = 0;
  if (wasCounting) updateLiveCaption();
}
function clearVoiceDraft() { partialText = ''; finalVoiceParts = []; lowConfidenceHint = false; userSpeaking = false; speechEndedAt = 0; cancelVoiceSubmit(); updateLiveCaption(); }

// Send once the user has been silent for VOICE_SUBMIT_DELAY_MS. Any new speech restarts the wait,
// and everything said meanwhile is joined into one answer. Never sent while Claude is still speaking.
function scheduleVoiceSubmit() {
  cancelVoiceSubmit();
  if (userSpeaking || ttsSpeaking) return; // re-armed when the user stops talking / Claude stops speaking
  const call = activeCall();
  const thinking = THINKING_TAIL.test(finalVoiceParts.at(-1) || '');
  const silenceMs = thinking ? VOICE_SUBMIT_DELAY_THINKING_MS : call?.interactionKind === 'stop' ? VOICE_SUBMIT_DELAY_FREE_MS : VOICE_SUBMIT_DELAY_MS;
  // Engines that report speech boundaries (Whisper) count the silence from when the user stopped.
  const sinceSpeech = speechEndedAt ? Date.now() - speechEndedAt : 0;
  const delay = Math.max(MIN_VISIBLE_COUNTDOWN_MS, silenceMs - sinceSpeech);
  submitDeadline = Date.now() + delay;
  voiceSubmitTimer = setTimeout(() => { voiceSubmitTimer = null; submitVoiceNow(); }, delay);
  updateLiveCaption();
}

async function submitVoiceNow() {
  cancelVoiceSubmit();
  const call = activeCall();
  const text = finalVoiceParts.join(' ').trim();
  if (!call || !text || !canRespond(call)) return;
  if (ttsSpeaking || userSpeaking) return scheduleVoiceSubmit();
  const input = document.getElementById('textInput');
  if (input && input.value.trim()) return; // the user is editing: they send with Enter
  clearVoiceDraft();
  const result = await window.agentCall.submitText(call.id, text).catch(err => ({ ok: false, error: err.message }));
  if (result?.ok && result.resolved !== false) acknowledge();
  if (!result?.ok) {
    const box = document.getElementById('textInput');
    if (box) box.value = box.value.trim() ? `${box.value.trim()} ${text}` : text;
    showBanner(result?.error || 'No se pudo enviar la respuesta.');
  }
}

const STOPWORDS = new Set(['que', 'los', 'las', 'del', 'por', 'para', 'con', 'una', 'uno', 'unos', 'unas', 'como', 'pero', 'mas', 'este', 'esta', 'eso', 'esto', 'muy', 'hay', 'sus', 'les', 'nos', 'ese', 'esa']);
function contentWords(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ').split(' ').filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

// Without headphones Claude's voice reaches the microphone. A recognition made while (or just after)
// Claude speaks whose words mostly come from what Claude is saying is its own echo, not the user.
function isEcho(text) {
  if (!ttsSpeaking && Date.now() - lastSpokenEndedAt > ECHO_TAIL_MS) return false;
  const heard = contentWords(text);
  if (!heard.length) return ttsSpeaking;
  const spoken = new Set(contentWords(lastSpokenText));
  const overlap = heard.filter(w => spoken.has(w)).length / heard.length;
  return overlap >= 0.6;
}

// The user started talking over Claude: Claude goes quiet at once and listens.
function bargeIn(heard = '') {
  if (!ttsSpeaking) return;
  (window.__bargeIns ||= []).push({ at: new Date().toLocaleTimeString(), heard, speaking: lastSpokenText.slice(0, 80) });
  stopSpeech();
  updateLiveCaption();
}

function showBanner(message) {
  serviceBanner.classList.remove('hidden');
  serviceBanner.textContent = message;
}

window.agentCall.onStt(data => {
  switch (data.type) {
    case 'ready':
      sttReady = true;
      serviceBanner.classList.add('hidden');
      break;
    case 'speech': {
      const call = activeCall();
      if (!call || !canRespond(call) || muted) return;
      userSpeaking = data.state === 'start';
      if (userSpeaking) cancelVoiceSubmit();
      else {
        speechEndedAt = Date.now();
        if (finalVoiceParts.length) scheduleVoiceSubmit();
      }
      return;
    }
    case 'engine':
      if (data.note) showBanner(data.note);
      break;
    case 'listening':
      sttListening = true;
      break;
    case 'paused':
      sttListening = false;
      userSpeaking = false;
      micLevel = 0;
      break;
    case 'level':
      micLevel = data.value || 0;
      updateLevel();
      return;
    case 'error':
      sttReady = false;
      sttListening = false;
      serviceBanner.classList.remove('hidden');
      serviceBanner.textContent = `${data.message || 'No se pudo iniciar el reconocimiento de voz.'} ${data.hint || ''}`;
      break;
    case 'partial': {
      (window.__heard ||= []).push({ at: new Date().toLocaleTimeString(), partial: data.text, tts: ttsSpeaking, echo: isEcho(data.text) });
      const call = activeCall();
      if (!call || !canRespond(call) || muted) return;
      if (ttsSpeaking) {
        if (isEcho(data.text)) return; // Claude hearing itself through the speakers
        if (contentWords(data.text).length >= 2) bargeIn(data.text);
      }
      partialText = data.text || '';
      if (voiceSubmitTimer) scheduleVoiceSubmit();
      break;
    }
    case 'final': {
      const call = activeCall();
      if (!call || !canRespond(call) || muted) return;
      partialText = '';
      if (!data.text) break;
      const confidence = typeof data.confidence === 'number' ? data.confidence : 1;
      lowConfidenceHint = confidence < MIN_STT_CONFIDENCE;
      if (lowConfidenceHint || isEcho(data.text)) {
        if (finalVoiceParts.length) scheduleVoiceSubmit();
        break;
      }
      if (ttsSpeaking) bargeIn(data.text);
      const input = document.getElementById('textInput');
      if (input && input.value.trim()) {
        // The user is correcting by keyboard: keep adding what they say to the text box.
        input.value = `${input.value.trim()} ${data.text}`;
        break;
      }
      finalVoiceParts.push(data.text);
      scheduleVoiceSubmit();
      break;
    }
    default:
      return;
  }
  updateLiveCaption();
  updateLevel();
});

window.agentCall.onState(next => {
  const previousActive = state.activeId;
  state = next;
  if (previousActive !== state.activeId) {
    clearVoiceDraft();
    if (!state.activeId) stopSpeech();
  }
  render();
});

window.agentCall.onServiceError(message => {
  serviceBanner.classList.remove('hidden');
  serviceBanner.textContent = message;
});

dndBtn.onclick = async () => window.agentCall.setDnd(!state.dnd);
minBtn.onclick = () => window.agentCall.minimize();
closeBtn.onclick = () => window.agentCall.hide();
window.addEventListener('beforeunload', () => { stopRing(); stopSpeech(); });
window.agentCall.getState().then(initial => { state = initial; render(); });
