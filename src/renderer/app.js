'use strict';

const main = document.getElementById('main');
const dndBtn = document.getElementById('dndBtn');
const minBtn = document.getElementById('minBtn');
const closeBtn = document.getElementById('closeBtn');
const serviceBanner = document.getElementById('serviceBanner');

let state = { calls: [], activeId: null, dnd: false, snoozeOptions: [] };
let muted = false;
let ttsSpeaking = false;
let spokenKeys = new Set();
let ringStopper = null;
let partialText = '';
let finalVoiceParts = [];
let voiceSubmitTimer = null;
let sttReady = false;
let callStartedAt = null;
let clockTimer = null;

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function esc(value = '') { return String(value).replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[ch])); }
function activeCall() { return state.calls.find(c => c.id === state.activeId) || null; }
function ringingCall() { return state.calls.find(c => c.status === 'ringing') || null; }
function pendingCalls() { return state.calls.filter(c => ['pending', 'snoozed', 'queued'].includes(c.status)); }

function callLabel(call) {
  if (call.type === 'error') return 'ERROR';
  if (call.type === 'completion') return 'RESULTADO LISTO';
  if (call.interactionKind === 'permission') return 'PERMISO NECESARIO';
  return 'NECESITA RESPUESTA';
}
function statusLabel(status) { return ({ pending:'Pendiente', queued:'En cola', snoozed:'Pospuesta', ringing:'Llamando', active:'Activa' })[status] || status; }
function timeAgo(ts) { const diff=Math.max(0,Date.now()-ts); if(diff<60000)return'ahora'; const min=Math.round(diff/60000); if(min<60)return`hace ${min} min`; return`hace ${Math.round(min/60)} h`; }
function formatSnooze(min) { if(min===60)return'1 hora'; if(min===120)return'2 horas'; return`${min} min`; }

function render() {
  dndBtn.classList.toggle('on', state.dnd);
  dndBtn.textContent = state.dnd ? 'DND ON' : 'DND';
  const active=activeCall(); const ringing=ringingCall();
  if(active) renderActive(active); else if(ringing) renderIncoming(ringing); else renderDashboard();
  syncRing(ringing && !active ? ringing : null);
  if(active) maybeSpeakLatest(active);
}

function renderIncoming(call) {
  const completion=call.type==='completion';
  main.innerHTML=`<section class="incoming ${completion?'completion-view':''}">
    <div class="call-type ${esc(call.type)}">${esc(callLabel(call))}</div>
    <div class="phone-orbit"><div class="phone-icon">☎</div></div>
    <h1>${esc(call.title)}</h1><div class="context">${esc(call.context)}</div>
    <div class="meta">${call.status==='ringing'?'Llamada entrante':esc(statusLabel(call.status))}</div>
    <div class="incoming-actions"><button class="primary" id="answerBtn">Contestar</button>
    <div class="snooze-wrap"><button class="secondary" id="snoozeBtn">Posponer ▾</button><div class="snooze-menu hidden" id="snoozeMenu">${state.snoozeOptions.map(m=>`<button data-snooze="${m}">${formatSnooze(m)}</button>`).join('')}</div></div></div></section>`;
  document.getElementById('answerBtn').onclick=async()=>{stopRing();await window.agentCall.answer(call.id);};
  const menu=document.getElementById('snoozeMenu');
  document.getElementById('snoozeBtn').onclick=()=>menu.classList.toggle('hidden');
  menu.querySelectorAll('[data-snooze]').forEach(btn=>btn.onclick=async()=>{stopRing();await window.agentCall.snooze(call.id,Number(btn.dataset.snooze));});
}

function renderActive(call) {
  if(!callStartedAt)callStartedAt=Date.now();
  const queued=state.calls.filter(c=>c.status==='queued').length;
  const canRespond=['ask','permission','stop'].includes(call.interactionKind)&&!call.awaitingClaude&&!ttsSpeaking;
  const status=ttsSpeaking?'Claude hablando…':call.awaitingClaude?'Claude trabajando…':muted?'Micrófono silenciado':'Escuchando…';
  const statusClass=call.awaitingClaude?'working':'';
  main.innerHTML=`<section class="active-call"><div class="call-head"><div class="avatar">C</div><div class="head-copy"><div class="head-title">${esc(call.title)}</div><div class="head-context">${esc(call.context)}</div></div><div class="status-pill ${statusClass}"><span id="callClock">00:00</span></div></div>
  ${queued?`<div class="queue-strip">☎ ${queued} ${queued===1?'llamada esperando':'llamadas esperando'} en cola</div>`:''}
  <div class="transcript" id="transcript">${call.messages.map(messageHtml).join('')}</div>
  <div class="live-caption" id="liveCaption">${liveCaptionHtml()}</div>
  <div class="call-controls"><div class="input-row"><button id="muteBtn" class="mic-btn ${muted?'muted':''}" title="${muted?'Activar micrófono':'Silenciar micrófono'}">${muted?'⌁':'●'}</button><input id="textInput" class="text-input" type="text" placeholder="Escribe si la voz falla…" ${call.awaitingClaude?'disabled':''}/><button id="sendBtn" class="send-btn" ${call.awaitingClaude?'disabled':''}>Enviar</button></div><div class="bottom-row"><div class="listen-state" id="listenState">${esc(status)}</div><button id="hangupBtn" class="hangup">Colgar</button></div></div></section>`;
  const transcript=document.getElementById('transcript'); transcript.scrollTop=transcript.scrollHeight; updateClock(); if(!clockTimer)clockTimer=setInterval(updateClock,1000);
  document.getElementById('muteBtn').onclick=async()=>{muted=!muted;await window.agentCall.setMuted(muted);render();};
  document.getElementById('hangupBtn').onclick=async()=>{stopSpeech();clearVoiceDraft();await window.agentCall.hangup(call.id);callStartedAt=null;clearInterval(clockTimer);clockTimer=null;};
  const input=document.getElementById('textInput');
  const send=async()=>{const value=input.value.trim();if(!value||call.awaitingClaude)return;input.value='';clearVoiceDraft();await window.agentCall.submitText(call.id,value);};
  document.getElementById('sendBtn').onclick=send; input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();send();}};
  if(!canRespond&&ttsSpeaking)input.placeholder='Claude está hablando…';
}

function messageHtml(msg){const role=msg.role==='user'?'user':msg.role==='system'?'system':'assistant';const sender=role==='user'?'Tú':role==='system'?'AgentCall':'Claude';return`<div class="message ${role}"><div class="sender">${sender}</div><div class="bubble">${esc(msg.text)}</div></div>`;}
function liveCaptionHtml(){const final=finalVoiceParts.join(' ').trim();if(!final&&!partialText)return muted?'Micrófono silenciado.':(sttReady?'Lo que digas aparecerá aquí en tiempo real…':'Preparando reconocimiento de voz…');return`${esc(final)}${partialText?` <span class="partial">${esc(partialText)}</span>`:''}`;}
function updateLiveCaption(){const el=document.getElementById('liveCaption');if(el)el.innerHTML=liveCaptionHtml();}

function renderDashboard(){callStartedAt=null;clearInterval(clockTimer);clockTimer=null;const calls=pendingCalls();main.innerHTML=`<section class="dashboard"><div class="dashboard-head"><div><h1>Centralita</h1><div class="dashboard-sub">Claude te llama solo cuando merece tu atención.</div></div><div class="state-chip ${state.dnd?'dnd':''}">${state.dnd?'No molestar':'Disponible'}</div></div>${calls.length?`<div class="call-list">${calls.map(callCardHtml).join('')}</div>`:`<div class="empty"><div class="empty-icon">☎</div><strong>Todo tranquilo</strong><div>No hay llamadas pendientes.</div></div>`}</section>`;main.querySelectorAll('[data-call-id]').forEach(card=>card.onclick=async()=>{const id=card.dataset.callId;const call=state.calls.find(c=>c.id===id);if(!call||call.status==='snoozed')return;await window.agentCall.answer(id);});}
function callCardHtml(call){let extra=timeAgo(call.createdAt);if(call.status==='snoozed'&&call.snoozedUntil)extra=`vuelve ${new Date(call.snoozedUntil).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;return`<article class="call-card" data-call-id="${esc(call.id)}"><div class="card-top"><div class="card-title">${esc(call.title)}</div><div class="card-status">${esc(statusLabel(call.status))}</div></div><div class="card-context">${esc(call.context)}</div><div class="card-time">${esc(callLabel(call))} · ${esc(extra)}</div></article>`;}
function updateClock(){const el=document.getElementById('callClock');if(!el||!callStartedAt)return;const sec=Math.floor((Date.now()-callStartedAt)/1000);el.textContent=`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;}

function maybeSpeakLatest(call){const latest=[...(call.messages||[])].reverse().find(m=>m.role==='assistant');if(!latest)return;const key=`${call.id}:${latest.at}:${latest.text}`;if(spokenKeys.has(key))return;spokenKeys.add(key);speak(latest.text);}
function spokenVersion(text){const normalized=String(text).replace(/\s+/g,' ').trim();const max=1400;if(normalized.length<=max)return normalized;let cut=normalized.slice(0,max);const lastSentence=Math.max(cut.lastIndexOf('. '),cut.lastIndexOf('? '),cut.lastIndexOf('! '));if(lastSentence>650)cut=cut.slice(0,lastSentence+1);return`${cut} El resto está en pantalla.`;}
async function speak(text){stopSpeech();if(!text)return;const utterance=new SpeechSynthesisUtterance(spokenVersion(text));const voices=speechSynthesis.getVoices();utterance.voice=voices.find(v=>/^es(-|_)/i.test(v.lang))||voices.find(v=>/spanish/i.test(v.name))||voices[0]||null;utterance.lang=utterance.voice?.lang||'es-ES';utterance.rate=1.05;utterance.pitch=1;utterance.onstart=async()=>{ttsSpeaking=true;await window.agentCall.setTts(true);render();};utterance.onend=async()=>{ttsSpeaking=false;await window.agentCall.setTts(false);render();};utterance.onerror=async()=>{ttsSpeaking=false;await window.agentCall.setTts(false);render();};speechSynthesis.speak(utterance);}
function stopSpeech(){speechSynthesis.cancel();if(ttsSpeaking){ttsSpeaking=false;window.agentCall.setTts(false);}}

function startRing(type){stopRing();let stopped=false;const completion=type==='completion';const cycle=()=>{if(stopped)return;if(audioCtx.state==='suspended')audioCtx.resume().catch(()=>{});const now=audioCtx.currentTime;if(completion){tone(now,660,.13,.08);tone(now+.2,880,.16,.07);}else{tone(now,520,.22,.10);tone(now+.32,620,.22,.10);tone(now+.72,520,.22,.08);}const timer=setTimeout(cycle,completion?2300:1800);ringStopper=()=>{stopped=true;clearTimeout(timer);};};cycle();}
function tone(at,frequency,duration,gainValue){const osc=audioCtx.createOscillator();const gain=audioCtx.createGain();osc.type='sine';osc.frequency.value=frequency;gain.gain.setValueAtTime(.0001,at);gain.gain.exponentialRampToValueAtTime(gainValue,at+.015);gain.gain.exponentialRampToValueAtTime(.0001,at+duration);osc.connect(gain);gain.connect(audioCtx.destination);osc.start(at);osc.stop(at+duration+.03);}
function stopRing(){if(ringStopper)ringStopper();ringStopper=null;}
function syncRing(call){const id=call?.id||null;if(syncRing.current===id)return;stopRing();syncRing.current=id;if(call)startRing(call.type);} syncRing.current=null;
function clearVoiceDraft(){partialText='';finalVoiceParts=[];if(voiceSubmitTimer)clearTimeout(voiceSubmitTimer);voiceSubmitTimer=null;updateLiveCaption();}
function scheduleVoiceSubmit(){if(voiceSubmitTimer)clearTimeout(voiceSubmitTimer);voiceSubmitTimer=setTimeout(async()=>{const call=activeCall();const text=finalVoiceParts.join(' ').trim();if(!call||!text||call.awaitingClaude||ttsSpeaking||muted)return;clearVoiceDraft();await window.agentCall.submitText(call.id,text);},1250);}

window.agentCall.onStt(data=>{if(data.type==='ready'){sttReady=true;updateLiveCaption();return;}if(data.type==='error'){sttReady=false;serviceBanner.classList.remove('hidden');serviceBanner.textContent=`${data.message||'No se pudo iniciar el reconocimiento de voz.'} ${data.hint||''}`;updateLiveCaption();return;}if(data.type==='partial'){partialText=data.text||'';updateLiveCaption();return;}if(data.type==='final'){partialText='';if(data.text)finalVoiceParts.push(data.text);updateLiveCaption();scheduleVoiceSubmit();}});
window.agentCall.onState(next=>{const previousActive=state.activeId;state=next;if(previousActive!==state.activeId)clearVoiceDraft();render();});
window.agentCall.onServiceError(message=>{serviceBanner.classList.remove('hidden');serviceBanner.textContent=message;});
dndBtn.onclick=async()=>window.agentCall.setDnd(!state.dnd);minBtn.onclick=()=>window.agentCall.minimize();closeBtn.onclick=()=>window.agentCall.hide();
window.addEventListener('beforeunload',()=>{stopRing();stopSpeech();});
window.agentCall.getState().then(initial=>{state=initial;render();});
