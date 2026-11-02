#!/usr/bin/env node
'use strict';
// Live reading test with a real person, through the real app (microphone, echo cancellation, Whisper,
// VoiceConversation, end of turn). AgentCall must be running with --remote-debugging-port=9223.
//
//   node scripts/voice-lab/live-reading.js [--from N]
//
// "Claude" calls (held Stop hook of a test session) and shows a sentence; the person reads it aloud,
// with pauses where it says "(pausa)". When the call sends the turn, the script scores it: word error
// rate, end-of-turn latency, and whether the person was cut off (the rest then arrives as an addition,
// which is also what would reach Claude). No audio is stored; results (timings + the transcripts of
// these test sentences) go to %LOCALAPPDATA%\AgentCall\voice-lab\results\live-*.json.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const SENTENCES = [
  'Sí.',
  'La segunda, la de Supabase.',
  'Quiero que cambies la página de facturas para que primero salgan las pendientes, luego las pagadas, y que las que lleven más de treinta días se marquen en rojo.',
  'Haz el deploy del frontend en Vercel, pero no hagas merge a main todavía, que antes quiero revisar los tests de integración.',
  'Pues... (pausa) a ver... (pausa) yo creo que la primera opción es mejor, aunque no lo tengo claro del todo.',
  'Cambia el endpoint de la API de Stripe, actualiza el webhook y luego (pausa) comprueba que el login con Google sigue funcionando.',
  'Ponlo azul... no, perdona, verde. Verde oscuro, como el del logo.',
  'Pregúntale a Alejandro si el informe de Eureka Connect usa Neon o Supabase, y si el cron de las facturas sigue corriendo a las tres de la mañana.',
  'Espera. (pausa) Antes de eso, ¿has comprobado que no rompe el login de Apple?',
  'Vale, te cuento lo que quiero. La pantalla de pagos tiene que enseñar el saldo arriba del todo, con un botón grande para pagar. Debajo, el historial de los últimos seis meses, agrupado por mes. Si un pago ha fallado, que salga en rojo con el motivo, y que se pueda reintentar desde ahí mismo. Ah, y que todo funcione bien en el móvil, que la mayoría de los padres entra desde el teléfono.',
  'No, me he explicado mal. No quiero que borres la tabla de usuarios, quiero que la migres a la nueva estructura sin perder datos.',
  'Mira, haz una cosa: crea una rama nueva que se llame feature guion pagos, sube los cambios y abre una pull request, pero déjala como borrador.',
  'Sube esto a producción... (pausa) bueno, no, mejor primero a staging.',
  'Escucha, (pausa) lo que pasa es que el cliente quiere verlo mañana por la mañana, así que prioriza la pantalla de pagos.',
  'No, espera, espera. (pausa) Déjalo como estaba antes.',
  'Oye, ¿y si en vez de Postgres usamos SQLite para las pruebas locales?',
];

const BASE = 'http://127.0.0.1:32147';
const SESSION = `lectura-${Date.now().toString(36)}`;
const fromIndex = Math.max(1, Number(process.argv[process.argv.indexOf('--from') + 1]) || 1);
// --only 7,9,12: just those sentences (numbers as listed above).
const only = process.argv.includes('--only') ? new Set(String(process.argv[process.argv.indexOf('--only') + 1]).split(',').map(Number)) : null;

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${BASE}${pathname}`, {
      method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-AgentCall-Mode': 'on' },
    }, res => { let out = ''; res.setEncoding('utf8'); res.on('data', c => { out += c; }); res.on('end', () => resolve(out)); });
    req.on('error', reject);
    req.end(data);
  });
}

async function cdp(expression) {
  const pages = await (await fetch('http://127.0.0.1:9223/json')).json();
  const page = pages.find(p => p.type === 'page' && /index\.html/.test(p.url)) || pages[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const msg = await new Promise(r => ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id === 1) r(m); }));
  ws.close();
  return msg.result?.result?.value;
}

function words(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\(pausa\)/g, ' ').replace(/[^a-z0-9ñ ]+/g, ' ').split(/\s+/).filter(Boolean);
}
function wer(expected, heard) {
  const a = words(expected);
  const b = words(heard);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return a.length ? d[a.length][b.length] / a.length : 0;
}
const quoted = text => [...String(text).matchAll(/«([^»]*)»/g)].map(m => m[1]).join(' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Waits until the person has been silent (no voice, no pending draft) for 3 s, at most 25 s.
async function quiet() {
  const until = Date.now() + 25000;
  let since = Date.now();
  while (Date.now() < until) {
    const ui = await cdp('voiceUi').catch(() => null);
    if (!ui || ui.user !== 'silent' || ui.draft || ui.partial) since = Date.now();
    else if (Date.now() - since >= 3000) return;
    await sleep(250);
  }
}

async function metric(name) {
  const s = await cdp('window.agentCall.voiceMetrics()');
  return s?.metrics?.[name] || null;
}

async function main() {
  const health = await fetch(`${BASE}/health`).then(r => r.json()).catch(() => null);
  if (!health?.ok) throw new Error('AgentCall no está abierto');
  console.log(`\nPrueba de lectura: ${only ? only.size : SENTENCES.length - fromIndex + 1} frases. Lee cada una en voz alta desde la ventana de AgentCall.\n`);
  const rows = [];
  let first = true;
  // If the person was cut off, the rest of what they said is queued and the NEXT Stop returns at once
  // with it ("Mientras trabajabas…"): it belongs to the previous sentence.
  const leftover = (answer) => {
    if (!/Mientras trabajabas|te ha interrumpido/.test(answer) || !rows.length) return false;
    const row = rows.at(-1);
    row.heard = `${row.heard} ${quoted(answer)}`.trim();
    row.cutOff = true;
    row.wer = Number(wer(row.expected, row.heard).toFixed(3));
    console.log(`    …te cortó antes de terminar. Lo demás llegó aparte: «${quoted(answer)}» (WER ${row.wer.toFixed(2)})\n`);
    return true;
  };
  const stop = (message) => post('/hooks/stop', { session_id: SESSION, cwd: 'C:/AgentCall/prueba-de-lectura', stop_hook_active: !first, last_assistant_message: message });
  for (let i = fromIndex; i <= SENTENCES.length; i += 1) {
    if (only && !only.has(i)) continue;
    const sentence = SENTENCES[i - 1];
    const message = `Frase ${i} de ${SENTENCES.length}. Léela en voz alta${sentence.includes('(pausa)') ? ', con una pausa larga donde pone pausa' : ''}:\n\n> ${sentence}`;
    if (!first) await quiet(); // a cut-off sentence's rest must not land on the next one
    let pending = stop(message);
    if (first && process.argv.includes('--ring')) {
      first = false; // the person answers the ringing call (or calls back from Pendientes)
    } else if (first) {
      await sleep(1200);
      await cdp('(async()=>{const s=await window.agentCall.getState();const c=s.calls.find(x=>x.status==="ringing");if(c)await window.agentCall.answer(c.id);return true})()');
      first = false;
    }
    console.log(`[${i}] ${sentence}`);
    let answer = await pending;
    if (leftover(answer)) answer = await stop(message);
    if (!answer || answer === '{}') { console.log('La llamada se ha colgado.'); break; }
    const heard = quoted(answer);
    const row = { i, expected: sentence, heard, wer: Number(wer(sentence, heard).toFixed(3)), cutOff: false };
    rows.push(row);
    console.log(`    oído: «${heard}»`);
    console.log(`    WER ${row.wer.toFixed(2)}\n`);
  }
  // Last sentence: a closing Stop either returns the rest at once (cut off) or waits; hang up after 3 s.
  const closing = stop('Fin de la prueba. Gracias.');
  await sleep(3000);
  await cdp('(async()=>{const s=await window.agentCall.getState();if(s.activeId)await window.agentCall.hangup(s.activeId);return true})()');
  leftover(await closing);
  const s = await cdp('window.agentCall.voiceMetrics()');
  const avg = rows.reduce((a, r) => a + r.wer, 0) / (rows.length || 1);
  console.log(`WER medio ${avg.toFixed(3)} · cortes ${rows.filter(r => r.cutOff).length}/${rows.length}`);
  for (const [name, m] of Object.entries(s?.metrics || {})) console.log(`  ${name}: p50 ${m.p50} · p90 ${m.p90} · n ${m.count}`);
  const dir = path.join(process.env.LOCALAPPDATA || '.', 'AgentCall', 'voice-lab', 'results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ rows, metrics: s }, null, 1));
  console.log(`\nresultados: ${file}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
