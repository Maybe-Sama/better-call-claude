'use strict';

const main = document.getElementById('main');
const dndBtn = document.getElementById('dndBtn');
const minBtn = document.getElementById('minBtn');
const closeBtn = document.getElementById('closeBtn');
const serviceBanner = document.getElementById('serviceBanner');

// Turn-taking lives in the main process (src/voice/conversation.js); this window shows the call and
// plays Claude's voice, reporting which sentence is playing so "sigue" / "repíteme" know where it was cut.
let state = { calls: [], activeId: null, dnd: false, snoozeOptions: [] };
let muted = false;
let ttsSpeaking = false;
let currentUtterance = null;
let browserUtteranceId = null;
let ringStopper = null;
let sttReady = false;
let sttListening = false;
let micLevel = 0;
let lastSpokenText = '';
// Snapshot of the conversation state from the main process (VoiceConversation.snapshot()).
let voiceUi = { turn: 'idle', draft: '', partial: '', deadlineIn: null, holding: false, lowConfidence: false };
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
  menu.onkeydown = (e) => {
    const items = [...menu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length].focus(); };
    if (e.key === 'Escape') { setMenu(false); snoozeBtn.focus(); }
    else if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
  };
  menu.querySelectorAll('[data-snooze]').forEach(btn => {
    btn.onclick = async () => { stopRing(); await window.agentCall.snooze(call.id, Number(btn.dataset.snooze)); };
  });
}

function canRespond(call) {
  return ['ask', 'permission', 'stop'].includes(call.interactionKind) && call.waiting && !call.awaitingClaude;
}

function callStatusText(call) {
  if (ttsSpeaking) return muted ? 'Claude hablando…' : 'Claude hablando · te escucho';
  if (muted) return 'Micrófono silenciado · puedes escribir';
  if (!sttReady) return 'Preparando reconocimiento de voz…';
  if (!sttListening) return 'Preparando micrófono…';
  if (voiceUi.holding) return 'Te escucho…';
  if (call.awaitingClaude) return 'Claude trabajando · te sigo escuchando';
  if (!canRespond(call)) return 'Te escucho · se lo diré a Claude';
  return 'Escuchando…';
}

function renderActive(call) {
  if (!callStartedAt) callStartedAt = Date.now();
  // Keep whatever the user is typing across re-renders.
  const oldInput = document.getElementById('textInput');
  const draft = oldInput ? { value: oldInput.value, focused: document.activeElement === oldInput, start: oldInput.selectionStart, end: oldInput.selectionEnd } : null;

  const queued = state.calls.filter(c => c.status === 'queued').length;
  const answering = canRespond(call);
  main.innerHTML = `<section class="active-call">
    <div class="call-head">
      <div class="avatar" aria-hidden="true">C</div>
      <div class="head-copy"><div class="head-title">${esc(call.title)}</div><div class="head-context">${esc(call.context)}</div></div>
      <button id="rateBtn" class="rate-btn" title="Velocidad de la voz de Claude (clic para cambiar)" aria-label="Velocidad de la voz">${formatRate(voiceRate)}</button>
      <div class="status-pill ${call.awaitingClaude ? 'working' : ''}"><span id="callClock">00:00</span></div>
    </div>
    ${queued ? `<div class="queue-strip">☎ ${queued} ${queued === 1 ? 'llamada esperando' : 'llamadas esperando'} en cola</div>` : ''}
    <div class="transcript" id="transcript" aria-live="polite">${call.messages.map(messageHtml).join('')}</div>
    ${quickAnswersHtml(call)}
    <div class="live-caption" id="liveCaption">${liveCaptionHtml(call)}</div>
    <div class="call-controls">
      <div class="input-row">
        <button id="muteBtn" class="mic-btn ${muted ? 'muted' : ''}" title="${muted ? 'Activar micrófono' : 'Silenciar micrófono'}" aria-pressed="${muted}">${muted ? '⌁' : '●'}</button>
        <input id="textInput" class="text-input" type="text" autocomplete="off" placeholder="${answering ? 'Escribe o corrige lo dictado…' : 'Añade o corrige algo para Claude…'}"/>
        <button id="sendBtn" class="send-btn">Enviar</button>
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

  bindQuickAnswers(call);
  document.getElementById('rateBtn').onclick = () => setVoiceRate(VOICE_RATES[(VOICE_RATES.indexOf(voiceRate) + 1) % VOICE_RATES.length]);
  document.getElementById('muteBtn').onclick = async () => { muted = !muted; await window.agentCall.setMuted(muted); render(); };
  document.getElementById('hangupBtn').onclick = async () => {
    stopSpeech();
    await window.agentCall.hangup(call.id);
  };

  const input = document.getElementById('textInput');
  if (draft) {
    input.value = draft.value;
    if (draft.focused) {
      input.focus();
      try { input.setSelectionRange(draft.start, draft.end); } catch {}
    }
  }
  // Starting to type takes over the voice draft so a misheard word can be corrected before sending;
  // while the box has text, what the user says is appended to it.
  const adoptVoiceDraft = async () => {
    if (!voiceUi.draft && !voiceUi.partial) return;
    const spoken = await window.agentCall.adoptDraft();
    if (!spoken) return;
    input.value = input.value.trim() ? `${input.value.trim()} ${spoken}` : spoken;
    window.agentCall.setTyping(true);
  };
  input.onfocus = adoptVoiceDraft;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send(); return; }
    adoptVoiceDraft();
  };
  input.oninput = () => window.agentCall.setTyping(Boolean(input.value.trim()));
  // Enter with an empty box sends the spoken draft now. While Claude works, text is queued for it.
  const send = async () => {
    const value = input.value.trim();
    const current = activeCall();
    if (!current || (!value && !voiceUi.draft)) return;
    input.value = '';
    window.agentCall.setTyping(false);
    stopSpeech();
    const result = await window.agentCall.submitText(current.id, value).catch(err => ({ ok: false, error: err.message }));
    if (!result?.ok) {
      const box = document.getElementById('textInput');
      if (box && !box.value && value) box.value = value;
      showBanner(result?.error || 'No se pudo enviar la respuesta.');
    }
  };  document.getElementById('sendBtn').onclick = send;
}

function messageHtml(msg) {
  const role = msg.role === 'user' ? 'user' : msg.role === 'system' ? 'system' : 'assistant';
  const sender = role === 'user' ? 'Tú' : role === 'system' ? 'AgentCall' : 'Claude';
  const note = msg.kind === 'queued'
    ? `<div class="queued-note">${msg.delivered ? 'Entregado a Claude' : 'Se lo diré a Claude en cuanto pueda'}</div>`
    : '';
  return `<div class="message ${role}"><div class="sender">${sender}</div><div class="bubble">${esc(msg.text)}</div>${note}</div>`;
}

function liveCaptionHtml(call = activeCall()) {
  const { draft, partial } = voiceUi;
  if (draft || partial) {
    const text = `${esc(draft)}${partial ? ` <span class="partial">${esc(partial)}</span>` : ''}`;
    if (voiceUi.holding && voiceUi.deadlineIn == null) return `${text}<div class="countdown-hint">Te escucho. Sigue cuando quieras.</div>`;
    if (voiceUi.deadlineIn == null) return text;
    const where = call && !canRespond(call) ? 'Se lo diré a Claude' : 'Enviando';
    return `${text}<div class="countdown" aria-hidden="true"><span style="animation-duration:${voiceUi.deadlineIn}ms"></span></div><div class="countdown-hint">${where}… sigue hablando para añadir, o pulsa Enviar.</div>`;
  }
  if (voiceUi.lowConfidence && !ttsSpeaking) return 'No te he entendido bien. Repítelo o escríbelo.';
  if (!call) return '<span class="partial">—</span>';
  if (muted) return 'Micrófono silenciado. Puedes escribir.';
  if (call.awaitingClaude) return '<span class="partial">Claude está trabajando. Si quieres añadir o corregir algo, dilo.</span>';
  if (!canRespond(call)) return '<span class="partial">Si quieres decirle algo a Claude, dilo o escríbelo.</span>';
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
let playback = { id: null, queue: [], current: null, done: false };

function progress(event) { try { window.agentCall.ttsProgress(event); } catch {} }

// The main process decides what Claude says (id + text); this window plays it.
function speak(id, text) {
  stopSpeech();
  const spoken = String(text || '').replace(/\s+/g, ' ').trim();
  if (!spoken) { progress({ type: 'end', id }); return; }
  setTts(true);
  lastSpokenText = spoken;
  if (ttsEngine === 'kokoro') {
    playback = emptyPlayback({ id });
    const fallback = () => { if (playback.id === id) { playback = emptyPlayback(); speakWithBrowser(id, spoken); } };
    window.agentCall.ttsSpeak(id, spoken).then(ok => { if (!ok) { ttsEngine = 'browser'; fallback(); } }).catch(fallback);
    return;
  }
  speakWithBrowser(id, spoken);
}

function speakWithBrowser(id, spoken) {
  setTts(true);
  browserUtteranceId = id;
  progress({ type: 'chunk', id, seq: 0, text: spoken });
  const utterance = new SpeechSynthesisUtterance(spoken);
  if (!spanishVoice) pickSpanishVoice();
  if (spanishVoice) utterance.voice = spanishVoice;
  utterance.lang = spanishVoice?.lang || 'es-ES';
  utterance.rate = 1.08 * voiceRate;
  const finish = () => {
    if (currentUtterance !== utterance) return;
    currentUtterance = null;
    browserUtteranceId = null;
    speechFinished(id);
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  currentUtterance = utterance; // keep a reference: Chromium may GC it and never fire onend
  speechSynthesis.speak(utterance);
}

function speechFinished(id) {
  progress({ type: 'end', id, interrupted: false });
  setTts(false);
  render();
}

// Sentences arrive as MP3 (Edge) or raw PCM (Kokoro) and are played one after another with <audio>
// elements: unlike WebAudio buffers, they can change speed instantly while keeping the voice's pitch.
const VOICE_RATES = [1, 1.2, 1.4, 1.6, 0.9];
let voiceRate = (() => { try { const r = Number(localStorage.getItem('agentcall.voiceRate')); return VOICE_RATES.includes(r) ? r : 1; } catch { return 1; } })();

function setVoiceRate(rate) {
  voiceRate = rate;
  try { localStorage.setItem('agentcall.voiceRate', String(rate)); } catch {}
  for (const el of [playback.current, ...(playback.queue || [])]) if (el) el.playbackRate = rate;
  const btn = document.getElementById('rateBtn');
  if (btn) btn.textContent = formatRate(rate);
  if (currentUtterance) { const text = lastSpokenText; const id = browserUtteranceId; speechSynthesis.cancel(); currentUtterance = null; speakWithBrowser(id, text); }
}

function formatRate(rate) { return `${String(rate).replace('.', ',')}×`; }

function wavBlob(pcmBytes, rate) {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const text = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); v.setUint32(4, 36 + pcmBytes.length, true); text(8, 'WAVE');
  text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, 'data'); v.setUint32(40, pcmBytes.length, true);
  return new Blob([header, pcmBytes], { type: 'audio/wav' });
}

function playAudioChunk(data) {
  if (data.id !== playback.id) return;
  let el;
  try {
    const bytes = Uint8Array.from(atob(data.format === 'mp3' ? data.data : data.pcm), c => c.charCodeAt(0));
    const blob = data.format === 'mp3' ? new Blob([bytes], { type: 'audio/mpeg' }) : wavBlob(bytes, data.rate);
    el = new Audio(URL.createObjectURL(blob));
  } catch (err) {
    console.error('AgentCall: audio chunk skipped', err);
    maybeFinishPlayback();
    return;
  }
  el.preservesPitch = true;
  el.playbackRate = voiceRate;
  el.agentSeq = data.seq;
  el.agentText = data.text || '';
  playback.queue.push(el);
  if (!playback.current) playNextChunk(playback.id);
}

function playNextChunk(id) {
  if (playback.id !== id || playback.current) return;
  const el = playback.queue.shift();
  if (!el) { maybeFinishPlayback(); return; }
  playback.current = el;
  el.playbackRate = voiceRate;
  progress({ type: 'chunk', id, seq: el.agentSeq, text: el.agentText });
  const next = () => {
    URL.revokeObjectURL(el.src);
    if (playback.id !== id || playback.current !== el) return;
    playback.current = null;
    setTimeout(() => playNextChunk(id), 60); // short breath between sentences
  };
  el.onended = next;
  el.onerror = next;
  el.play().catch(next);
}

function maybeFinishPlayback() {
  if (!playback.id || !playback.done || playback.current || playback.queue.length) return;
  const { id, ack } = playback;
  playback = emptyPlayback();
  if (ack) { progress({ type: 'end', id, interrupted: false }); setTts(false); return; }
  speechFinished(id);
}

// Stop and release every <audio> element of the current utterance.
function discardPlayback() {
  for (const el of [playback.current, ...(playback.queue || [])]) {
    if (el) { try { el.pause(); URL.revokeObjectURL(el.src); } catch {} }
  }
  playback = emptyPlayback();
}

function emptyPlayback(extra = {}) { return { id: null, queue: [], current: null, done: false, ...extra }; }

// Short acknowledgement chosen by the main process ("Vale.", "Un momento."); the worker already plays it.
function playAck(id) {
  if (ttsEngine !== 'kokoro') { progress({ type: 'end', id }); return; }
  discardPlayback(); // never ttsStop here: the worker is already producing this acknowledgement
  currentUtterance = null;
  speechSynthesis.cancel();
  playback = emptyPlayback({ id, ack: true });
  setTts(true);
}
function stopSpeech() {
  const id = playback.id || browserUtteranceId;
  if (playback.id) {
    window.agentCall.ttsStop();
    discardPlayback();
  }
  currentUtterance = null;
  browserUtteranceId = null;
  speechSynthesis.cancel();
  if (id) progress({ type: 'end', id, interrupted: true });
  setTts(false);
}

window.agentCall.onTts(data => {
  if (data.type === 'ready') ttsEngine = 'kokoro'; // any worker engine (kokoro or edge) streams audio here
  else if (data.type === 'unavailable') {
    ttsEngine = 'browser';
    if (playback.id && !playback.ack) { const { id } = playback; const text = lastSpokenText; discardPlayback(); speakWithBrowser(id, text); }
  } else if (data.type === 'audio') playAudioChunk(data);
  else if (data.type === 'done' && data.id === playback.id) {
    if (!data.chunks && !data.interrupted && !playback.ack) {
      // The voice engine produced nothing (network/model error): say it with the Windows voice instead.
      const { id } = playback;
      playback = emptyPlayback();
      speakWithBrowser(id, lastSpokenText);
      return;
    }
    playback.done = true;
    maybeFinishPlayback();
  }
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

// ── Quick answers: tap an option (or Sí/No) instead of saying it ─────────────

let multiPick = { key: '', labels: new Set() };

function quickAnswersHtml(call) {
  if (!canRespond(call)) return '';
  if (call.interactionKind === 'permission') {
    return `<div class="quick-answers" role="group" aria-label="Respuesta rápida">
      <button class="quick-btn yes" data-choice="allow">Sí, permitir</button>
      <button class="quick-btn no" data-choice="deny">No</button>
    </div>`;
  }
  const q = call.currentQuestion;
  if (call.interactionKind !== 'ask' || !q || !q.options?.length) return '';
  const key = `${call.id}:${call.questionIndex}`;
  if (multiPick.key !== key) multiPick = { key, labels: new Set() };
  const buttons = q.options.map((o, i) => {
    const picked = multiPick.labels.has(o.label);
    return `<button class="quick-btn option ${picked ? 'picked' : ''}" data-option="${i}" ${q.multiSelect ? `aria-pressed="${picked}"` : ''} title="${esc(o.description)}">
      <span class="quick-letter">${'ABCDE'[i] || i + 1}</span><span class="quick-text"><span class="quick-label">${esc(o.label)}</span>${o.description ? `<span class="quick-desc">${esc(o.description)}</span>` : ''}</span>
    </button>`;
  }).join('');
  const send = q.multiSelect
    ? `<button class="quick-btn send" data-send-multi ${multiPick.labels.size ? '' : 'disabled'}>Enviar selección</button>`
    : '';
  return `<div class="quick-answers ${q.multiSelect ? 'multi' : ''}" role="group" aria-label="${q.multiSelect ? 'Elige una o varias' : 'Elige una opción'}">${buttons}${send}</div>`;
}

function bindQuickAnswers(call) {
  const box = main.querySelector('.quick-answers');
  if (!box) return;
  const submit = async (choice) => {
    stopSpeech();
    const result = await window.agentCall.submitChoice(call.id, choice).catch(err => ({ ok: false, error: err.message }));
    if (!result?.ok) showBanner(result?.error || 'No se pudo enviar la respuesta.');
  };
  box.querySelectorAll('[data-choice]').forEach(btn => { btn.onclick = () => submit(btn.dataset.choice); });
  const q = call.currentQuestion;
  box.querySelectorAll('[data-option]').forEach(btn => {
    btn.onclick = () => {
      const label = q.options[Number(btn.dataset.option)].label;
      if (!q.multiSelect) return submit(label);
      if (multiPick.labels.has(label)) multiPick.labels.delete(label); else multiPick.labels.add(label);
      btn.classList.toggle('picked', multiPick.labels.has(label));
      btn.setAttribute('aria-pressed', String(multiPick.labels.has(label)));
      const send = box.querySelector('[data-send-multi]');
      if (send) send.disabled = !multiPick.labels.size;
    };
  });
  const send = box.querySelector('[data-send-multi]');
  if (send) send.onclick = () => submit(q.options.map(o => o.label).filter(l => multiPick.labels.has(l)));
}

// ── Voice commands from the main process ─────────────────────────────────────

window.agentCall.onVoice(cmd => {
  if (cmd.cmd === 'speak') speak(cmd.id, cmd.text);
  else if (cmd.cmd === 'stop') stopSpeech();
  else if (cmd.cmd === 'ack') playAck(cmd.id);
  else if (cmd.cmd === 'error') showBanner(cmd.message);
  else if (cmd.cmd === 'append') {
    const input = document.getElementById('textInput');
    if (input) input.value = input.value.trim() ? `${input.value.trim()} ${cmd.text}` : cmd.text;
  }
});

window.agentCall.onVoiceUi(snapshot => {
  voiceUi = snapshot || voiceUi;
  updateLiveCaption();
});
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

    case 'engine':
      if (data.note) showBanner(data.note);
      break;
    case 'listening':
      sttListening = true;
      break;
    case 'paused':
      sttListening = false;
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
    resetCallClock();
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
