#!/usr/bin/env node
'use strict';
// AgentCall voice lab: measure the conversation pipeline instead of tuning constants by feel.
//
//   npm run voice-lab -- fixtures [--provider edge|kokoro]   synthetic scenario audio (docs/voice-first/SPEC.md §23)
//   npm run voice-lab -- stt [--backend cpu|dml] [--policy legacy]
//        plays the scenarios through the real Whisper worker at real-time speed, then replays the
//        worker's events through an end-of-turn policy: detection, partial, final and endpoint
//        latencies, premature commits and word error rate per scenario
//   npm run voice-lab -- tts [--provider edge|kokoro]        time to first audio of Claude's voice
//
// Everything lives in %LOCALAPPDATA%\AgentCall\voice-lab. Fixtures are synthetic; nothing is recorded.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const scenarios = require('./voice-lab/scenarios');
const { LegacyEndpointer } = require('../src/voice/endpointing');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(process.env.LOCALAPPDATA || '.', 'AgentCall');
const LAB = path.join(DATA, 'voice-lab');
const FIXTURES = path.join(LAB, 'fixtures');
const PYTHON = path.join(DATA, 'whisper-venv', 'Scripts', 'python.exe');
const GPU_PYTHON = path.join(DATA, 'gpu-venv', 'Scripts', 'python.exe');
const POLICIES = { legacy: LegacyEndpointer };

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function runLines(cmd, args, onEvent, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { onEvent(JSON.parse(line), child); } catch { console.log(line); }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { if (!/warn/i.test(d)) process.stderr.write(d); });
    child.on('error', reject);
    child.on('exit', code => resolve(code));
    if (input) child.stdin.end(input);
    return child;
  });
}

// ── Text helpers ────────────────────────────────────────────────────────────

function words(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ').split(/\s+/).filter(Boolean);
}

function wer(expected, heard) {
  const a = words(expected);
  const b = words(heard);
  if (!a.length) return b.length ? 1 : 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length] / a.length;
}

function pct(values, p) {
  const v = values.filter(x => Number.isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
}

const fmt = v => (v == null || !Number.isFinite(v) ? '—' : String(Math.round(v)));

// ── fixtures ────────────────────────────────────────────────────────────────

async function fixtures() {
  fs.mkdirSync(LAB, { recursive: true });
  const spec = path.join(LAB, 'scenarios.json');
  fs.writeFileSync(spec, JSON.stringify(scenarios, null, 1));
  const code = await runLines(PYTHON, ['-u', path.join(__dirname, 'voice-lab', 'make_fixtures.py'), spec, FIXTURES, '--provider', arg('provider', 'edge')],
    ev => console.log(`fixtures: ${ev.scenarios} escenarios, ${ev.seconds} s, voz ${ev.provider}`));
  if (code !== 0) throw new Error(`make_fixtures.py exit ${code}`);
}

// ── stt ─────────────────────────────────────────────────────────────────────

async function stt() {
  const wav = path.join(FIXTURES, 'scenarios.wav');
  const timeline = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'timeline.json'), 'utf8'));
  const backend = arg('backend', 'cpu');
  const policyName = arg('policy', 'legacy');
  const Policy = POLICIES[policyName];
  if (!Policy) throw new Error(`unknown policy ${policyName}`);
  const python = backend === 'dml' ? GPU_PYTHON : PYTHON;
  console.log(`stt: Whisper ${backend}, ${timeline.seconds} s de audio en tiempo real…`);

  const events = [];
  let wavStart = null;
  const code = await runLines(python, ['-u', path.join(ROOT, 'src', 'speech', 'whisper_worker.py'), '--wav', wav, '--realtime',
    '--backend', backend, '--language', 'es', '--models-dir', path.join(DATA, 'models')], ev => {
    if (ev.type === 'ready') console.log(`stt: ${ev.recognizer} cargado en ${ev.loadSeconds} s`);
    if (ev.type === 'wav-start') wavStart = ev.wt;
    if (wavStart == null || ev.type === 'level') return;
    events.push({ ...ev, t: Math.round((ev.wt - wavStart) * 1000) }); // ms in audio time of the WAV
  });
  if (code !== 0 || wavStart == null) throw new Error(`whisper_worker exit ${code}`);

  const rows = timeline.scenarios.map((sc, i) => analyse(sc, timeline.scenarios[i + 1], events, Policy));
  report(rows, { backend, policy: policyName, provider: timeline.provider });
  const out = path.join(LAB, 'results');
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `stt-${backend}-${policyName}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ backend, policy: policyName, rows }, null, 1));
  console.log(`\nresultados: ${file}`);
}

function analyse(sc, next, events, Policy) {
  const first = sc.parts[0];
  const last = sc.parts.at(-1);
  const from = first.start * 1000 - 400;
  const until = next ? next.parts[0].start * 1000 - 400 : Infinity;
  const own = events.filter(e => e.t >= from && e.t < until);
  const starts = own.filter(e => e.type === 'speech' && e.state === 'start');
  const finals = own.filter(e => e.type === 'final');
  const partials = own.filter(e => e.type === 'partial');

  const detect = starts.length ? starts[0].t - first.start * 1000 : null;
  const firstPartial = partials.length ? partials[0].t - first.start * 1000 : null;
  // Legacy barge-in: the first partial with >= 2 content words (no echo in the lab).
  const bargePartial = partials.find(p => words(p.text).filter(w => w.length >= 3).length >= 2);
  const bargeIn = bargePartial ? bargePartial.t - first.start * 1000 : null;
  const finalLag = finals.map(f => {
    const end = own.find(e => e.type === 'speech' && e.state === 'end' && e.utterance === f.utterance);
    return end ? f.t - (end.t - end.silence_ms) : null; // from the true end of that utterance's speech
  });

  // Replay the worker's events through the policy with a discrete-time simulator.
  const lost = sc.kind === 'working' && Policy === LegacyEndpointer; // legacy paused the mic while Claude worked
  const commits = [];
  if (!lost) {
    const policy = new Policy({ kind: sc.kind === 'working' ? 'stop' : sc.kind, options: sc.options });
    const fire = (upTo) => {
      while (policy.deadline != null && policy.deadline <= upTo) {
        const at = policy.deadline;
        commits.push({ t: at, text: policy.take() });
      }
    };
    for (const e of own) {
      fire(e.t);
      if (e.type === 'speech' && e.state === 'start') policy.speechStart(e.t);
      else if (e.type === 'speech' && e.state === 'end') policy.speechEnd(e.t);
      else if (e.type === 'partial') policy.partial(e.t, e.text);
      else if (e.type === 'final') policy.final(e.t, e.text, e.confidence);
    }
    fire(Number.isFinite(until) ? until : Infinity);
  }
  const lastEnd = last.end * 1000;
  const premature = commits.filter(c => c.t < lastEnd).length;
  const heard = commits.map(c => c.text).join(' ');
  return {
    id: sc.id,
    kind: sc.kind,
    detectMs: detect,
    firstPartialMs: firstPartial,
    bargeInMs: bargeIn,
    finalLagMs: pct(finalLag, 50),
    commits: commits.length,
    premature,
    endpointMs: commits.length ? commits.at(-1).t - lastEnd : null,
    lost,
    wer: lost ? 1 : wer(sc.expect, heard),
    heard: lost ? '(perdido: el micro estaba pausado)' : heard,
  };
}

function report(rows, meta) {
  console.log(`\nPolítica ${meta.policy} · Whisper ${meta.backend} · voz de prueba ${meta.provider}\n`);
  console.log('escenario           tipo        detect  1er parcial  barge-in  final  confirmaciones  prematuras  fin→envío   WER');
  for (const r of rows) {
    console.log(`${r.id.padEnd(19)} ${r.kind.padEnd(11)} ${fmt(r.detectMs).padStart(6)} ${fmt(r.firstPartialMs).padStart(12)} ${fmt(r.bargeInMs).padStart(9)} ${fmt(r.finalLagMs).padStart(6)} ${String(r.commits).padStart(15)} ${String(r.premature).padStart(11)} ${(r.lost ? 'PERDIDO' : fmt(r.endpointMs)).padStart(10)} ${r.wer.toFixed(2).padStart(5)}`);
  }
  const col = k => rows.map(r => r[k]);
  console.log(`\np50/p90 ms  detección ${fmt(pct(col('detectMs'), 50))}/${fmt(pct(col('detectMs'), 90))} · 1er parcial ${fmt(pct(col('firstPartialMs'), 50))}/${fmt(pct(col('firstPartialMs'), 90))} · barge-in ${fmt(pct(col('bargeInMs'), 50))}/${fmt(pct(col('bargeInMs'), 90))} · final ${fmt(pct(col('finalLagMs'), 50))}/${fmt(pct(col('finalLagMs'), 90))} · fin→envío ${fmt(pct(col('endpointMs'), 50))}/${fmt(pct(col('endpointMs'), 90))}`);
  console.log(`turnos con envío prematuro: ${rows.filter(r => r.premature).length}/${rows.length} · perdidos: ${rows.filter(r => r.lost).length} · WER medio ${(rows.reduce((s, r) => s + r.wer, 0) / rows.length).toFixed(3)}`);
  for (const r of rows) if (r.wer > 0) console.log(`  ${r.id}: «${r.heard}»`);
}

// ── tts ─────────────────────────────────────────────────────────────────────

async function tts() {
  const provider = arg('provider', 'edge');
  const texts = [
    'He terminado el cambio de autenticación. Antes de seguir necesito decidir cómo guardamos las sesiones.',
    'No. He probado email y contraseña, pero todavía no Google.',
    'Google funciona. Apple falla porque falta la clave del servicio en la configuración.',
    'Vale.',
    'Ya funcionan Google y Apple. Las pruebas pasan.',
  ];
  const firstAudio = [];
  const perChunk = [];
  let sentAt = 0;
  let index = 0;
  let firstSeen = false;
  let lastChunkAt = 0;
  console.log(`tts: ${provider}…`);
  await new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-u', path.join(ROOT, 'src', 'speech', 'tts_worker.py'), '--provider', provider],
      { cwd: ROOT, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let buf = '';
    const next = () => {
      if (index >= texts.length) { child.stdin.end(); return; }
      firstSeen = false;
      sentAt = performance.now();
      lastChunkAt = sentAt;
      child.stdin.write(`${JSON.stringify({ cmd: 'speak', id: `t${index}`, text: texts[index] })}\n`);
      index += 1;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const now = performance.now();
        if (ev.type === 'ready') { console.log(`tts: ${ev.engine} listo (voz ${ev.voice})`); next(); }
        else if (ev.type === 'audio') {
          if (!firstSeen) { firstSeen = true; firstAudio.push(now - sentAt); }
          perChunk.push(now - lastChunkAt);
          lastChunkAt = now;
        } else if (ev.type === 'done') setTimeout(next, 300);
        else if (ev.type === 'warning' || ev.type === 'error') console.log(`tts ${ev.type}: ${ev.message}`);
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('exit', resolve);
  });
  console.log(`\nprimer audio (ms): ${firstAudio.map(fmt).join(', ')} · p50 ${fmt(pct(firstAudio, 50))} · peor ${fmt(Math.max(...firstAudio))}`);
  console.log(`entre frases (ms): p50 ${fmt(pct(perChunk, 50))} · p90 ${fmt(pct(perChunk, 90))}`);
  console.log('(no incluye decodificar y empezar a sonar en el renderer)');
}

const commands = { fixtures, stt, tts };
const cmd = process.argv[2];
if (!commands[cmd]) {
  console.log('uso: npm run voice-lab -- fixtures|stt|tts [--backend cpu|dml] [--policy legacy] [--provider edge|kokoro]');
  process.exit(1);
}
commands[cmd]().catch(err => { console.error(err.message); process.exit(1); });
