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
const transcriptHtml = new WeakMap(); // transcript element → the messages HTML it shows
let armedEnd = null;    // { id, until }: "Terminar" pressed once on a conversation where Claude is working
let leavingCall = null; // { id, hold }: Colgar / En espera pressed, the call is about to go (survives re-renders)
let browserUtteranceId = null;
let ringStopper = null;
let sttReady = false;
let sttListening = false;
let micLevel = 0;
let lastSpokenText = '';
// Snapshot of the conversation state from the main process (VoiceConversation.snapshot()).
let adopting = null; // pending adoptDraft() (see renderActive)
let voiceUi = { turn: 'idle', draft: '', partial: '', deadlineIn: null, holding: false, lowConfidence: false };
let callStartedAt = null;
let clockTimer = null;
let spanishVoice = null;

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function esc(value = '') { return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch])); }
function activeCall() { return state.calls.find(c => c.id === state.activeId) || null; }
function ringingCall() { return state.calls.find(c => c.status === 'ringing') || null; }
function listedCalls() { return state.calls.filter(c => ['onhold', 'parked', 'pending', 'snoozed', 'queued', 'ended'].includes(c.status)); }

function callLabel(call) {
  if (call.type === 'error') return 'ERROR';
  if (call.stream && call.interactionKind !== 'permission' && call.interactionKind !== 'ask') return call.awaitingClaude ? 'CLAUDE TRABAJANDO' : 'RESULTADO LISTO';
  if (call.type === 'completion') return 'RESULTADO LISTO';
  if (call.interactionKind === 'permission') return 'PERMISO NECESARIO';
  return 'NECESITA RESPUESTA';
}
function statusLabel(status) { return ({ ended: 'Colgada', onhold: 'En espera', parked: 'Colgada', pending: 'Pendiente', queued: 'En cola', snoozed: 'Pospuesta', ringing: 'Llamando', active: 'Activa' })[status] || status; }
function timeAgo(ts) {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return 'ahora';
  const min = Math.round(diff / 60_000);
  return min < 60 ? `hace ${min} min` : `hace ${Math.round(min / 60)} h`;
}
function formatSnooze(min) { if (min === 60) return '1 hora'; if (min === 120) return '2 horas'; return `${min} min`; }

// ── Rendering ────────────────────────────────────────────────────────────────

// The element with keyboard focus, as a selector that finds its twin after main is rebuilt.
function focusKey() {
  const el = document.activeElement;
  if (!el || !main.contains(el) || el.id === 'replyInput') return null; // the text box restores itself
  if (el.dataset.endId) return `[data-end-id="${CSS.escape(el.dataset.endId)}"]`;
  if (el.dataset.backId) return `[data-back-id="${CSS.escape(el.dataset.backId)}"]`;
  if (el.dataset.callId) return `[data-call-id="${CSS.escape(el.dataset.callId)}"]`;
  return el.id ? `#${CSS.escape(el.id)}` : null;
}

function render() {
  const focused = focusKey();
  renderView();
  if (focused && !main.contains(document.activeElement)) main.querySelector(focused)?.focus();
}

function renderView() {
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

  // The transcript survives re-renders (they come several times a second while Claude streams): it
  // only grows, and it follows the bottom only if the user was there. Rebuilding it jumped to the
  // top and scrolled back down on every change (live test 2026-11-02: "es mareante").
  const oldTranscript = document.getElementById('transcript');
  const keptTranscript = oldTranscript && oldTranscript.dataset.callId === call.id ? oldTranscript : null;
  const atBottom = !keptTranscript || keptTranscript.scrollHeight - keptTranscript.scrollTop - keptTranscript.clientHeight < 48;
  const readingAt = keptTranscript ? keptTranscript.scrollTop : 0; // lost when the node is moved

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
    <div class="transcript" id="transcript" role="log" aria-live="polite"></div>
    ${quickAnswersHtml(call)}
    <div class="live-caption" id="liveCaption">${liveCaptionHtml(call)}</div>
    <div class="call-controls">
      <div class="input-row">
        <button id="muteBtn" class="mic-btn ${muted ? 'muted' : ''}" title="${muted ? 'Activar micrófono' : 'Silenciar micrófono'}" aria-label="${muted ? 'Activar micrófono' : 'Silenciar micrófono'}" aria-pressed="${muted}">${muted ? '⌁' : '●'}</button>
        <input id="textInput" class="text-input" type="text" autocomplete="off" placeholder="${answering ? 'Escribe o corrige lo dictado…' : 'Añade o corrige algo para Claude…'}"/>
        <button id="sendBtn" class="send-btn">Enviar</button>
      </div>
      <div class="bottom-row">
        <div class="listen-state" id="listenState"><span class="level" aria-hidden="true"><span id="levelBar"></span></span><span id="listenText">${esc(callStatusText(call))}</span></div>
        <button id="holdBtn" class="secondary hold-btn" title="${call.stream || call.awaitingClaude ? 'Claude sigue y te llama cuando acabe o te necesite' : 'Claude espera tu respuesta; vuelves desde la lista'}" ${leavingCall?.id === call.id ? 'disabled' : ''}>${leavingCall?.id === call.id && leavingCall.hold ? 'Poniendo en espera…' : 'En espera'}</button>
        <button id="hangupBtn" class="hangup" ${leavingCall?.id === call.id ? 'disabled' : ''}>${leavingCall?.id === call.id && !leavingCall.hold ? 'Colgando…' : 'Colgar'}</button>
      </div>
    </div></section>`;

  // The caption is rewritten many times a second: one listener on it handles its ✕.
  // On press, not on release: the caption may be rewritten in between and the release land elsewhere.
  const caption = document.getElementById('liveCaption');
  caption.onpointerdown = (e) => { if (e.button === 0 && e.target.closest('[data-discard]')) { e.preventDefault(); discardHeard(); } };
  caption.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-discard]')) { e.preventDefault(); discardHeard(); } };
  let transcript = document.getElementById('transcript');
  if (keptTranscript) { transcript.replaceWith(keptTranscript); transcript = keptTranscript; }
  transcript.dataset.callId = call.id;
  // Only what changed is touched (a message marked delivered, a new one), so a screen reader hears
  // that and not the whole conversation again. One element per message.
  const parts = call.messages.map(messageHtml);
  const shown = transcriptHtml.get(transcript) || [];
  if (parts.length < shown.length || transcript.children.length !== shown.length) {
    transcript.innerHTML = parts.join('');
  } else {
    for (let i = 0; i < shown.length; i += 1) if (parts[i] !== shown[i]) transcript.children[i].outerHTML = parts[i];
    if (parts.length > shown.length) transcript.insertAdjacentHTML('beforeend', parts.slice(shown.length).join(''));
  }
  transcriptHtml.set(transcript, parts);
  transcript.scrollTop = atBottom ? transcript.scrollHeight : readingAt;
  updateClock();
  updateLevel();
  if (!clockTimer) clockTimer = setInterval(updateClock, 1000);

  bindQuickAnswers(call);
  document.getElementById('rateBtn').onclick = () => setVoiceRate(VOICE_RATES[(VOICE_RATES.indexOf(voiceRate) + 1) % VOICE_RATES.length]);
  document.getElementById('muteBtn').onclick = async () => { muted = !muted; await window.agentCall.setMuted(muted); render(); };
  const holdBtn = document.getElementById('holdBtn');
  // Main silences Claude itself (keeping what it had not said yet) and waits a moment for the end of
  // what the user was saying, so the buttons only show that the call is leaving.
  const leave = async (hold) => {
    if (leavingCall) return;
    leavingCall = { id: call.id, hold };
    render();
    try { await (hold ? window.agentCall.hold(call.id) : window.agentCall.hangup(call.id)); } finally { leavingCall = null; render(); }
  };
  if (holdBtn) holdBtn.onclick = () => leave(true);
  document.getElementById('hangupBtn').onclick = () => leave(false);

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
  // One adoption at a time, and Send waits for it, so dictated words are never sent twice or reordered.
  const adoptVoiceDraft = () => {
    if (adopting || (!voiceUi.draft && !voiceUi.partial)) return adopting;
    adopting = window.agentCall.adoptDraft().then(spoken => {
      if (!spoken) return;
      const box = document.getElementById('textInput');
      if (!box) return;
      box.value = box.value.trim() ? `${box.value.trim()} ${spoken}` : spoken;
      window.agentCall.setTyping(true);
    }).catch(() => {}).finally(() => { adopting = null; });
    return adopting;
  };
  input.onfocus = adoptVoiceDraft;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send(); return; }
    if (e.key === 'Escape') return; // Esc throws the spoken draft away (document handler), it never adopts it
    adoptVoiceDraft();
  };
  input.oninput = () => window.agentCall.setTyping(Boolean(input.value.trim()));
  // Enter with an empty box sends the spoken draft now. While Claude works, text is queued for it.
  const send = async () => {
    if (adopting) await adopting;
    const box = document.getElementById('textInput'); // a re-render may have replaced it meanwhile
    if (!box) return;
    const value = box.value.trim();
    const current = activeCall();
    if (!current || (!value && !voiceUi.draft)) return;
    box.value = '';
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

// What was heard can be thrown away before it is sent (noise taken for words, or starting over).
const DISCARD_BTN = '<button class="caption-discard" data-discard aria-label="Borrar lo escuchado" title="Borrar lo escuchado (Esc)">✕</button>';
function discardHeard() {
  if (!voiceUi.draft && !voiceUi.partial) return;
  window.agentCall.discardDraft().catch(() => {});
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !activeCall() || (!voiceUi.draft && !voiceUi.partial)) return;
  e.preventDefault();
  discardHeard();
});

function liveCaptionHtml(call = activeCall()) {
  const { draft, partial } = voiceUi;
  if (draft || partial) {
    const text = `${DISCARD_BTN}${esc(draft)}${partial ? ` <span class="partial">${esc(partial)}</span>` : ''}`;
    if (voiceUi.holding && voiceUi.deadlineIn == null) return `${text}<div class="countdown-hint">Te escucho. Sigue cuando quieras.</div>`;
    if (voiceUi.deadlineIn == null) return text;
    const where = call && !canRespond(call) ? 'Se lo diré a Claude' : 'Enviando';
    return `${text}<div class="countdown" aria-hidden="true"><span style="animation-duration:${voiceUi.deadlineIn}ms"></span></div><div class="countdown-hint">${where}… sigue hablando para añadir, pulsa Enviar, o ✕ para borrarlo.</div>`;
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
    <button class="primary call-claude" id="callClaudeBtn">Llamar a Claude</button>
    ${calls.length
      ? `<div class="list-label">Llamadas</div><div class="call-list">${calls.map(callCardHtml).join('')}</div>`
      : '<div class="empty"><div class="empty-icon" aria-hidden="true">☎</div><strong>Todo tranquilo</strong><div>No hay llamadas pendientes.</div></div>'}
  </section>`;
  document.getElementById('callClaudeBtn').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Abriendo sesión de Claude…';
    const result = await window.agentCall.startStream({}).catch(err => ({ ok: false, error: err.message }));
    if (!result?.ok && !result?.cancelled) showBanner(result?.error || 'No se pudo llamar a Claude.');
    const again = document.getElementById('callClaudeBtn');
    if (again) { again.disabled = false; again.textContent = 'Llamar a Claude'; }
  };
  main.querySelectorAll('[data-end-id]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const id = btn.dataset.endId;
      const call = state.calls.find(c => c.id === id);
      // Claude is working on it: a second press confirms (no dialog: it would block the window).
      if (call?.stream && call.awaitingClaude && !(armedEnd?.id === id && armedEnd.until > Date.now())) {
        const armed = { id, until: Date.now() + 4000 };
        armedEnd = armed;
        render();
        setTimeout(() => { if (armedEnd === armed) { armedEnd = null; render(); } }, 4100);
        return;
      }
      armedEnd = null;
      await window.agentCall.dismiss(id);
    };
  });
  const callBack = async (id) => {
    const call = state.calls.find(c => c.id === id);
    if (!call || call.status === 'snoozed' || call.sessionEnded) return;
    await window.agentCall.answer(call.id);
  };
  // The card's own button is the keyboard way; a click anywhere else on the card does the same.
  main.querySelectorAll('[data-back-id]').forEach(btn => { btn.onclick = (e) => { e.stopPropagation(); callBack(btn.dataset.backId); }; });
  main.querySelectorAll('[data-call-id]').forEach(card => { card.onclick = () => callBack(card.dataset.callId); });
}

// What Claude is doing in a call waiting in the list: the first thing its card says, in words, an icon
// and a colour (the colour alone never carries it).
function claudeState(call) {
  if (call.sessionEnded) return { key: 'gone', icon: '■', label: 'Sesión cerrada', detail: 'Claude ya no está en esta conversación' };
  const asks = call.waiting && (call.interactionKind === 'permission' || call.interactionKind === 'ask');
  if (asks) return { key: 'needs', icon: '!', label: 'Te necesita', detail: call.interactionKind === 'permission' ? 'espera tu permiso' : 'tiene una pregunta' };
  if (call.type === 'error') return { key: 'needs', icon: '!', label: 'Se ha detenido', detail: 'por un error' };
  if (call.awaitingClaude) return { key: 'working', icon: '', label: 'Trabajando', detail: call.status === 'parked' || call.status === 'onhold' ? 'te llamará al terminar' : 'sigue con la tarea' };
  if (call.status === 'ended') return { key: 'idle', icon: '–', label: 'Colgada', detail: 'puedes volver unos minutos' };
  return { key: 'ready', icon: '✓', label: 'Listo', detail: `terminó ${timeAgo(call.updatedAt)}` };
}

function callCardHtml(call) {
  const st = claudeState(call);
  let when = timeAgo(call.createdAt);
  if (call.status === 'snoozed' && call.snoozedUntil) when = `vuelve a las ${new Date(call.snoozedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  // A conversation waiting in the list can be ended from there (Claude stops and its session closes).
  const armed = armedEnd?.id === call.id && armedEnd.until > Date.now();
  const endLabel = !call.stream ? 'Colgar' : call.sessionEnded ? 'Quitar' : armed ? '¿Detener a Claude? Pulsa otra vez' : 'Terminar';
  // A hook call on hold is hung up from its card (a result ends, a question waits in Pendientes).
  const end = (!call.stream && call.status === 'onhold') || (call.stream && (call.sessionEnded || ['onhold', 'parked', 'pending', 'ended'].includes(call.status)))
    ? `<button class="card-end ${armed ? 'armed' : ''}" data-end-id="${esc(call.id)}" title="Terminar la conversación: Claude se detiene">${endLabel}</button>` : '';
  const back = call.status === 'parked' || call.status === 'onhold';
  const action = call.status === 'snoozed' || call.sessionEnded ? ''
    : `<button class="card-action" data-back-id="${esc(call.id)}">${back ? 'Volver a la llamada' : call.status === 'ended' ? 'Volver a llamar' : 'Devolver llamada'} →</button>`;
  const icon = st.key === 'working'
    ? '<span class="state-icon" aria-hidden="true"><span class="dots"><i></i><i></i><i></i></span></span>'
    : `<span class="state-icon" aria-hidden="true">${st.icon}</span>`;
  return `<article class="call-card state-${st.key} ${esc(call.type)}" data-call-id="${esc(call.id)}">
    <div class="card-top"><div class="card-title">${esc(call.title)}</div><div class="card-status">${esc(statusLabel(call.status))}</div></div>
    <div class="claude-state">${icon}<strong>${esc(st.label)}</strong><span class="state-detail">${esc(st.detail)}</span></div>
    <div class="card-context">${esc(call.context)}</div>
    <div class="card-time">${call.detail && st.key !== 'working' ? `${esc(call.detail)} · ` : ''}${esc(when)}${action}${end}</div>
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
// The user started talking over Claude (echo-cancelled capture): lower the voice until it is clear.
const DUCK_VOLUME = 0.2;
let ducked = false;

function setDucked(on) {
  ducked = on;
  for (const el of [playback.current, ...(playback.queue || [])]) if (el) el.volume = on ? DUCK_VOLUME : 1;
  // (The Windows fallback voice cannot be turned down; the main process never ducks it: see syncEchoMode.)
}

function progress(event) { try { window.agentCall.ttsProgress(event); } catch {} }

// The main process decides what Claude says (id + text); this window plays it.
function speak(id, text) {
  stopSpeech();
  ducked = false;
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
  window.agentCall.ttsFallback(true); // outside echo cancellation: main turns the text echo filter on
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
  window.agentCall.ttsFallback(false);
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

// Streamed answer: everything sent so far has been heard and Claude is still writing (or using a tool).
// Said after a short wait, so the gap while the next sentence is being rendered does not count.
let idleTimer = null;
function scheduleIdle(id) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (playback.id === id && playback.stream && !playback.done && !playback.current && !playback.queue.length) progress({ type: 'idle', id });
  }, 400);
}

function playNextChunk(id) {
  if (playback.id !== id || playback.current) return;
  const el = playback.queue.shift();
  if (!el) {
    maybeFinishPlayback();
    if (playback.id === id && playback.stream) scheduleIdle(id);
    return;
  }
  playback.current = el;
  el.playbackRate = voiceRate;
  el.volume = ducked ? DUCK_VOLUME : 1;
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

// Streamed answer: sentences arrive while Claude writes. The voice worker renders them in order and
// sends audio with this id; with the Windows fallback voice each sentence is queued as an utterance.
let browserStream = null; // { id, pending, ended, seq }

function startStream(id) {
  stopSpeech();
  ducked = false;
  lastSpokenText = '';
  setTts(true);
  if (ttsEngine === 'kokoro') playback = emptyPlayback({ id, stream: true });
  else browserStream = { id, pending: 0, ended: false, seq: 0 };
}

function appendStream(id, text) {
  lastSpokenText = `${lastSpokenText} ${text}`.trim();
  const st = browserStream;
  if (ttsEngine === 'kokoro' || !st || st.id !== id) return;
  const utterance = new SpeechSynthesisUtterance(text);
  if (!spanishVoice) pickSpanishVoice();
  if (spanishVoice) utterance.voice = spanishVoice;
  utterance.lang = spanishVoice?.lang || 'es-ES';
  utterance.rate = 1.08 * voiceRate;
  const seq = st.seq;
  st.seq += 1;
  st.pending += 1;
  utterance.onstart = () => progress({ type: 'chunk', id, seq, text });
  const done = () => {
    if (browserStream !== st) return;
    st.pending -= 1;
    if (st.ended && st.pending <= 0) { browserStream = null; speechFinished(id); }
    else if (st.pending <= 0) progress({ type: 'idle', id });
  };
  utterance.onend = done;
  utterance.onerror = done;
  currentUtterance = utterance;
  browserUtteranceId = id;
  window.agentCall.ttsFallback(true);
  speechSynthesis.speak(utterance);
}

function endStream(id) {
  const st = browserStream;
  if (!st || st.id !== id) return;
  st.ended = true;
  if (st.pending <= 0) { browserStream = null; speechFinished(id); }
}

// Short acknowledgement chosen by the main process ("Vale.", "Un momento."); the worker already plays it.
function playAck(id) {
  if (ttsEngine !== 'kokoro') { progress({ type: 'end', id }); return; }
  discardPlayback(); // never ttsStop here: the worker is already producing this acknowledgement
  currentUtterance = null;
  speechSynthesis.cancel();
  playback = emptyPlayback({ id, ack: true });
  ducked = false;
  setTts(true);
}
function stopSpeech() {
  const id = playback.id || browserUtteranceId;
  if (playback.id) {
    // Named: if this stop reaches the worker after the next answer started, it is ignored there.
    window.agentCall.ttsStop(playback.id);
    discardPlayback();
  }
  currentUtterance = null;
  browserUtteranceId = null;
  browserStream = null;
  speechSynthesis.cancel();
  window.agentCall.ttsFallback(false);
  if (id) progress({ type: 'end', id, interrupted: true });
  setTts(false);
}

window.agentCall.onTts(data => {
  if (data.type === 'ready') ttsEngine = 'kokoro'; // any worker engine (kokoro or edge) streams audio here
  else if (data.type === 'unavailable') {
    ttsEngine = 'browser';
    if (playback.id && playback.ack) { const { id } = playback; discardPlayback(); progress({ type: 'end', id }); setTts(false); }
    else if (playback.id) { const { id } = playback; const text = lastSpokenText; discardPlayback(); speakWithBrowser(id, text); }
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
  // A conversation calling back with a result rings like a result; one with a question, like a question.
  if (call) startRing(call.stream && call.interactionKind !== 'permission' && call.interactionKind !== 'ask' ? 'completion' : call.type);
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
  else if (cmd.cmd === 'stop') { stopSpeech(); ducked = false; }
  else if (cmd.cmd === 'duck' || cmd.cmd === 'unduck') setDucked(cmd.cmd === 'duck');
  else if (cmd.cmd === 'ack') playAck(cmd.id);
  else if (cmd.cmd === 'stream-start') startStream(cmd.id);
  else if (cmd.cmd === 'stream-append') appendStream(cmd.id, cmd.text);
  else if (cmd.cmd === 'stream-end') endStream(cmd.id);
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

// ── Voice latency panel (Ctrl+Shift+L): live p50/p90 of the voice metrics, for tuning ──────────
const METRIC_LABELS = {
  'bargein.duck_ms': 'Tu voz → baja Claude',
  'bargein.stop_ms': 'Tu voz → Claude calla',
  'tts.stop_ms': 'Orden de parar → silencio',
  'stt.first_partial_ms': 'Tu voz → primer texto',
  'stt.final_ms': 'Fin de tu voz → texto final',
  'turn.endpoint_ms': 'Fin de tu voz → envío',
  'tts.first_audio_ms': 'Texto de Claude → su voz',
  'turn.roundtrip_ms': 'Fin de tu voz → voz de Claude',
};
let metricsTimer = null;
async function renderMetricsPanel(panel) {
  const summary = await window.agentCall.voiceMetrics().catch(() => null);
  if (!summary) return;
  const rows = Object.entries(METRIC_LABELS).map(([key, label]) => {
    const m = summary.metrics[key];
    return `<tr><td>${esc(label)}</td><td>${m ? m.p50 : '—'}</td><td>${m ? m.p90 : '—'}</td><td>${m ? m.max : '—'}</td><td>${m ? m.count : 0}</td></tr>`;
  }).join('');
  const failures = Object.entries(summary.failures).filter(([, n]) => n).map(([k, n]) => `${esc(k)}: ${n}`).join(' · ') || 'ninguno';
  panel.innerHTML = `<div class="metrics-head">Latencias de voz (ms) <span>Ctrl+Mayús+L para cerrar</span></div>
    <table><thead><tr><th></th><th>p50</th><th>p90</th><th>máx</th><th>n</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="metrics-fail">Fallos: ${failures}</div>`;
}
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'l')) return;
  e.preventDefault();
  let panel = document.getElementById('metricsPanel');
  if (panel) { panel.remove(); clearInterval(metricsTimer); metricsTimer = null; return; }
  panel = document.createElement('div');
  panel.id = 'metricsPanel';
  panel.className = 'metrics-panel';
  document.body.appendChild(panel);
  renderMetricsPanel(panel);
  metricsTimer = setInterval(() => renderMetricsPanel(panel), 2000);
});
