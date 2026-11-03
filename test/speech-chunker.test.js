const test = require('node:test');
const assert = require('node:assert/strict');
const { SpeechChunker } = require('../src/voice/speech-chunker');
const { toSpeech } = require('../src/speech-text');

const norm = s => String(s).replace(/\s+/g, ' ').trim();

// Deterministic PRNG so a failing seed can be replayed.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Feeds `text` in random-sized deltas (1..maxDelta chars); returns every sentence pushed plus finish().
function stream(text, { seed = 1, maxDelta = 14, options } = {}) {
  const rand = mulberry32(seed);
  const c = new SpeechChunker(options);
  const spoken = [];
  for (let i = 0; i < text.length;) {
    const n = 1 + Math.floor(rand() * maxDelta);
    spoken.push(...c.push(text.slice(i, i + n)));
    i += n;
  }
  const rest = c.finish();
  return { sentences: spoken, rest, all: norm([...spoken, rest].join(' ')) };
}

function whole(text, options) {
  const c = new SpeechChunker(options);
  const sentences = c.push(text);
  const rest = c.finish();
  return { sentences, rest, all: norm([...sentences, rest].join(' ')) };
}

// Realistic Claude handoffs (Claude is asked to open with a spoken-style paragraph).
const CORPUS = {
  question: [
    'He arreglado el error del login: el token caducaba antes de tiempo porque `expiresIn` estaba en segundos y no en milisegundos. Ya pasan los 42 tests.',
    '',
    '¿Quieres que lo suba a la rama `main`?',
  ].join('\n'),
  list: [
    'Listo. He revisado los tres archivos que me pediste y he dejado los cambios preparados.',
    '',
    'Cambios:',
    '',
    '- `src/auth/token.js`: el cálculo de caducidad usa milisegundos.',
    '- `src/auth/session.ts`: renueva la sesión 5 minutos antes.',
    '- `test/auth.test.js`: dos casos nuevos.',
    '',
    'Los detalles están en el diff. ¿Lo reviso contigo o hago el commit directamente?',
  ].join('\n'),
  shortOpeningAndCode: [
    'Hecho.',
    '',
    'El problema estaba en la función `parseDate`, que no aceptaba fechas con zona horaria (por ejemplo 2024-05-01T10:00:00+02:00).',
    '',
    '```js',
    'function parseDate(s) {',
    '  // Nota. Esto no se lee.',
    '  return new Date(Date.parse(s));',
    '}',
    '```',
    '',
    'Pruébalo con `npm test` y dime si ves algo raro.',
  ].join('\n'),
  urlAndTable: [
    'He encontrado la causa en la documentación oficial (https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows): en Windows no se puede lanzar un `.cmd` sin shell.',
    '',
    '| Opción | Ventaja | Inconveniente |',
    '|---|---|---|',
    '| shell: true | sencillo | hay que escapar argumentos |',
    '| claude.exe | directo | depende de la instalación |',
    '',
    'Prefiero la segunda. ¿Te parece bien o prefieres la primera?',
  ].join('\n'),
  pathsBoldHeading: [
    '**Listo.** He movido la configuración a `config/settings.json` y he borrado `old.config.js`, que ya no se usaba. También he actualizado el README.',
    '',
    '## Qué falta',
    '',
    '1. Migrar los tests de integración.',
    '2. Revisar los permisos en `scripts/deploy.sh`.',
    '',
    'Avísame cuando quieras que siga con lo que falta.',
  ].join('\n'),
  oneParagraph: 'Sí, se puede. El cambio afecta a 3 módulos y tardaría unos 20 minutos... ¿Empiezo ya?',
  codeWithBlankLine: [
    'He añadido el endpoint nuevo y sus tests; todo pasa en local sin errores.',
    '',
    '```ts',
    'export async function GET(req: Request) {',
    "  const id = new URL(req.url).searchParams.get('id');",
    '',
    '  return Response.json({ id });',
    '}',
    '```',
    '',
    'Lo he probado con curl contra http://localhost:3000/api/items?id=7 y responde bien.',
    '',
    '¿Hago el deploy a staging?',
  ].join('\n'),
  quote: [
    'Revisado. El error que ves viene de una dependencia, no de tu código.',
    '',
    "> TypeError: Cannot read properties of undefined (reading 'map')",
    '',
    'He fijado la versión de `react-table` a la 7.8.0 y ya no aparece. ¿Lo dejo así?',
  ].join('\n'),
  twoShortParagraphs: [
    'Vale.',
    '',
    'Lo miro ahora mismo.',
    '',
    '- Primero el log del servidor.',
    '- Después la base de datos.',
  ].join('\n'),
  twoClosingParagraphs: [
    'He terminado la migración de la base de datos y he comprobado que los datos antiguos siguen intactos.',
    '',
    '- 1.204 usuarios migrados.',
    '- 0 errores.',
    '',
    'He dejado una copia de seguridad en `backups/2024-05-01.sql`.',
    '',
    'Si te parece bien, el siguiente paso es borrar las tablas antiguas. ¿Lo hago?',
  ].join('\n'),
  noClosing: [
    'He actualizado las dependencias y todo compila. Los tests siguen en verde.',
    '',
    '- react 18.3.1',
    '- vite 5.2.0',
  ].join('\n'),
  headingClosing: [
    'Hecho, ya funciona el login con Google y con GitHub en local y en preview.',
    '',
    '## Pruebas',
    'Todo pasa. ¿Lo subo?',
  ].join('\n'),
  linkAndItalic: [
    'He leído [la guía de migración](https://vitejs.dev/guide/migration.html) y el cambio es *pequeño*: solo hay que renombrar dos opciones.',
    '',
    '```diff',
    '- build.polyfillDynamicImport',
    '+ build.modulePreload',
    '```',
  ].join('\n'),
};
CORPUS.crlf = CORPUS.list.replace(/\n/g, '\r\n');
CORPUS.longOpening = [
  'He repasado todo el flujo de la llamada de principio a fin. Primero se abre la ventana y se pide el micrófono. Después se arranca el reconocimiento de voz, que tarda unos dos segundos en estar listo. Mientras tanto, la sesión de Claude ya está arrancada y esperando. Cuando hablas, el texto se envía en cuanto terminas la frase. Claude responde y su respuesta se lee mientras la escribe, frase a frase, sin esperar al final. Si le interrumpes, se para en menos de un segundo y te escucha. He medido cada paso varias veces y los números son estables en este equipo.',
  '',
  '¿Quieres que repita las medidas en el portátil?',
].join('\n');

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

test('equivalence: random-sized deltas speak exactly what the whole text speaks, sentence by sentence', () => {
  for (const [name, text] of Object.entries(CORPUS)) {
    const expected = whole(text);
    assert.ok(expected.all, `${name}: says something`);
    // Code, tables, URLs and markup never reach the voice.
    assert.doesNotMatch(expected.all, /https?:|`|\||#|\*\*|\]\(|Nota\. Esto|return|Response|TypeError|polyfill|react 18/, name);
    const runs = [...SEEDS.map(seed => ({ seed })), { maxDelta: 1 }, { seed: 99, maxDelta: 40 }];
    for (const run of runs) {
      const got = stream(text, run);
      assert.deepEqual(got.sentences, expected.sentences, `${name}, ${JSON.stringify(run)}`);
      assert.equal(got.rest, expected.rest, `${name}, ${JSON.stringify(run)}`);
    }
  }
});

test('equivalence: the spoken content is toSpeech(text) without its length cut', () => {
  const uncut = { max: Infinity, maxClosing: Infinity };
  for (const [name, text] of Object.entries(CORPUS)) {
    const expected = norm(toSpeech(text, Infinity, Infinity));
    for (const seed of SEEDS) assert.equal(stream(text, { seed, options: uncut }).all, expected, `${name}, seed ${seed}`);
  }
});

test('equivalence: with the default limits it also matches toSpeech(text)', () => {
  for (const [name, text] of Object.entries(CORPUS)) {
    if (name === 'longOpening') continue; // toSpeech cuts at a character count, the chunker at whole sentences
    assert.equal(stream(text, { seed: 11 }).all, norm(toSpeech(text)), name);
  }
});

test('a long opening stops at the last whole sentence that fits in 450 characters', () => {
  const { sentences, rest } = stream(CORPUS.longOpening, { seed: 3 });
  const opening = norm(sentences.join(' '));
  assert.ok(opening.length <= 450, `${opening.length} chars`);
  assert.match(opening, /\.$/);
  assert.equal(opening, norm(toSpeech(CORPUS.longOpening)).replace(/ ¿Quieres.*$/, ''));
  assert.equal(rest, '¿Quieres que repita las medidas en el portátil?');
});

// ── Targeted ─────────────────────────────────────────────────────────────

test('a sentence is emitted as soon as its final punctuation and a space arrive', () => {
  const c = new SpeechChunker();
  assert.deepEqual(c.push('He arreglado el login'), []);
  assert.deepEqual(c.push('.'), [], 'could still be "login.js"');
  assert.deepEqual(c.push(' Aho'), ['He arreglado el login.']);
  assert.deepEqual(c.push('ra pasan los tests!\n'), ['Ahora pasan los tests!']);
  assert.deepEqual(c.push('¿Algo más'), []);
  assert.deepEqual(c.push('?\n'), ['¿Algo más?']);
  assert.equal(c.finish(), '');
});

test('a paragraph break or the start of a list completes a sentence without punctuation', () => {
  const a = new SpeechChunker();
  assert.deepEqual(a.push('Cambios principales\n'), []);
  assert.deepEqual(a.push('\n'), ['Cambios principales']);
  const b = new SpeechChunker();
  assert.deepEqual(b.push('He tocado tres archivos:\n'), []);
  assert.deepEqual(b.push('-'), [], 'a dash alone could still be prose');
  assert.deepEqual(b.push(' `a.js`\n- `b.js`\n'), ['He tocado tres archivos:']);
  assert.equal(b.finish(), '');
});

test('nothing is emitted while inside an unclosed code fence', () => {
  const c = new SpeechChunker();
  assert.deepEqual(c.push('Hecho.\n\n```py\n'), ['Hecho.']);
  assert.deepEqual(c.push("print('hola. adiós')\n# Nota. Esto no se lee. "), []);
  assert.deepEqual(c.push('\nmás código. Sigue.\n'), []);
  assert.equal(c.finish(), '');
  const first = new SpeechChunker();
  assert.deepEqual(first.push('```\nconst a = 1. Esto es código. '), []);
  assert.equal(first.finish(), '');
});

test('a URL split across deltas is never emitted half', () => {
  const c = new SpeechChunker();
  assert.deepEqual(c.push('Mira la guía en https://docs.exa'), []);
  assert.deepEqual(c.push('mple.'), []);
  assert.deepEqual(c.push('com/a.b?c=d'), []);
  const [sentence] = c.push(' y dime. ');
  assert.equal(sentence, 'Mira la guía en un enlace y dime.');
  const d = new SpeechChunker();
  assert.deepEqual(d.push('La documentación está en https://nodejs.org/api.'), []);
  assert.deepEqual(d.push('\n\n'), ['La documentación está en un enlace']);
});

test('inline code, bold and links are never split, and their markdown is stripped', () => {
  const c = new SpeechChunker();
  const out = c.push('Ejecuta `git commit -m "fix. ok"` y luego **revisa. todo** con [la guía. nueva](https://x.dev/a) bien. Fin');
  assert.deepEqual(out, ['Ejecuta git commit -m "fix. ok" y luego revisa. todo con la guía. nueva bien.']);
  assert.equal(c.finish(), 'Fin');
});

test('after a list starts nothing more is spoken until finish() adds the closing question', () => {
  const c = new SpeechChunker();
  const spoken = [];
  const deltas = ['Te cuento lo que he hecho hoy en el proyecto, que ha sido bastante. ', '\n\n- Uno. Dos.\n', '- Tres.\n\n',
    'Texto intermedio. No se lee.\n\n', '```\nmás. código.\n```\n\n', '¿Seguimos mañana?'];
  for (const d of deltas) spoken.push(...c.push(d));
  assert.deepEqual(spoken, ['Te cuento lo que he hecho hoy en el proyecto, que ha sido bastante.']);
  assert.equal(c.finish(), '¿Seguimos mañana?');
});

test('finish() speaks the unfinished sentence of the opening once and never repeats anything', () => {
  const c = new SpeechChunker();
  assert.deepEqual(c.push('Hecho. Todo pasa'), ['Hecho.']);
  assert.equal(c.finish(), 'Todo pasa');
  assert.equal(c.finish(), '');
  assert.deepEqual(c.push('más texto. '), []);
  const q = new SpeechChunker();
  assert.deepEqual(q.push('Listo. ¿Lo subo? '), ['Listo.', '¿Lo subo?']);
  assert.equal(q.finish(), '', 'the closing question was already spoken in the opening');
});

test('very long sentences are cut at a comma near 220 characters', () => {
  const clause = 'he revisado el módulo de pagos con mucho cuidado';
  const sentence = `${Array.from({ length: 8 }, (_, i) => `${clause} ${i}`).join(', ')}.`;
  assert.ok(sentence.length > 400);
  const { sentences, rest } = stream(`${sentence}\n\nFin.`, { seed: 5 });
  assert.ok(sentences.length >= 2, JSON.stringify(sentences));
  for (const s of sentences) assert.ok(s.length <= 220, `${s.length}: ${s}`);
  assert.match(sentences[0], /,$/);
  assert.ok(sentences[0].length > 150, 'cut near the limit, not at the first comma');
  assert.equal(norm(sentences.join(' ')), sentence);
  assert.equal(rest, '');
});

test('a closing question written right after code, a quote or a table in the same paragraph is still heard', () => {
  const code = 'Ya está montado y funcionando en local.\n\nPara lanzarlo:\n```\nnpm run dev\n```\n¿Te parece bien así?';
  assert.equal(stream(code, { seed: 2 }).all, norm(toSpeech(code)));
  assert.equal(whole(code).all, 'Ya está montado y funcionando en local. Para lanzarlo: ¿Te parece bien así?');
  const quote = 'Ya está montado y funcionando en local, con la base de datos nueva.\n\nEl error era este:\n> TypeError: x\n¿Quieres que lo arregle?';
  assert.equal(stream(quote, { seed: 4 }).all, 'Ya está montado y funcionando en local, con la base de datos nueva. El error era este: ¿Quieres que lo arregle?',
    'the quote itself is not read (toSpeech reads it)');
  const table = 'He comparado las dos opciones y la diferencia de precio es pequeña.\n\nResumen:\n| A | B |\n|---|---|\n| 5 € | 7 € |\n¿Cuál prefieres?';
  assert.equal(stream(table, { seed: 6 }).all, norm(toSpeech(table)));
});

test('a paragraph interrupted by code is still one paragraph: the opening reads on after it, the closing counts it once', () => {
  const opening = 'Para lanzarlo:\n```\nnpm run dev\n```\ny luego abre el navegador en el puerto 3000.\n\n- a';
  assert.equal(stream(opening, { seed: 7 }).all, norm(toSpeech(opening)));
  assert.equal(whole(opening).all, 'Para lanzarlo: y luego abre el navegador en el puerto 3000.');
  const closing = 'Hecho, el servidor ya arranca bien en local y en staging, sin errores.\n\n- a\n\nHe dejado el servidor listo.\n\nPara lanzarlo:\n```\nnpm run dev\n```\n¿Te parece bien así?';
  assert.equal(stream(closing, { seed: 5 }).all, norm(toSpeech(closing)));
  assert.match(whole(closing).all, /He dejado el servidor listo\. Para lanzarlo: ¿Te parece bien así\?$/);
  const askFirst = 'Hecho, el servidor ya arranca bien en local y en staging, sin errores.\n\n- a\n\n¿Lo ves en tu pantalla?\n```\nlocalhost:3000\n```\nGracias.';
  assert.equal(stream(askFirst, { seed: 9 }).all, norm(toSpeech(askFirst)), 'the question may be before the code');
});

test('toSpeech parity around code: a short opening reads on after it; a held paragraph is judged whole', () => {
  const short = 'Para lanzarlo:\n```\nnpm run dev\n```\n\nLuego abre el navegador en el puerto 3000.\n\n- a';
  assert.equal(stream(short, { seed: 3 }).all, norm(toSpeech(short)));
  const long = `Hecho.\n\nPara lanzarlo:\n\`\`\`\nnpm run dev\n\`\`\`\n${'Después abre el navegador y revisa la consola con calma. '.repeat(8).trim()}\n\n- a`;
  assert.equal(stream(long, { seed: 4 }).all, norm(toSpeech(long)), 'too long as a whole: toSpeech says only "Hecho."');
});

test('a question right after a list, without a blank line, is still the closing question (list items are not)', () => {
  const text = 'He tocado tres archivos:\n- `src/a.js`\n- `src/b.js`\n¿Hago el commit?';
  assert.equal(stream(text, { seed: 2 }).all, 'He tocado tres archivos: ¿Hago el commit?');
  const wrapped = '- Cambié la configuración\n  y también el script de despliegue.\n- Otro cambio\n\n¿Vale?';
  assert.equal(stream(wrapped, { seed: 5 }).all, '¿Vale?', 'an indented continuation is part of the list item');
});

test('a one-line ```code``` span does not open a fence; ~~~ fences are code too', () => {
  const inline = 'Hecho.\n\n```npm test```\n\n¿Lo subo?';
  assert.equal(stream(inline, { seed: 1 }).all, 'Hecho. ¿Lo subo?');
  assert.equal(norm(toSpeech(inline)), 'Hecho. ¿Lo subo?');
  const tilde = 'Hecho.\n\n~~~sh\nrm -rf build. Esto no se lee.\n\n~~~\n\n¿Sigo?';
  assert.equal(stream(tilde, { seed: 3 }).all, 'Hecho. ¿Sigo?');
});

test('emphasis that spans sentences leaves no markers behind', () => {
  const c = new SpeechChunker();
  assert.deepEqual(c.push('Hecho. *Ojo. Esto es importante.* Y __ojo. también__ esto. Edita config_file.js. '),
    ['Hecho.', 'Ojo.', 'Esto es importante.', 'Y ojo.', 'también esto.', 'Edita config_file.js.']);
  assert.equal(c.finish(), '');
});

// Where the chunker is deliberately stricter than toSpeech (it never reads list items, headings or code).
test('differences from toSpeech: list items, a leading heading and code are never read', () => {
  // toSpeech reads the first block whole, list items included.
  const intoList = 'He tocado tres archivos:\n- `a.js`\n- `b.js`\n\n¿Sigo?';
  assert.equal(whole(intoList).all, 'He tocado tres archivos: ¿Sigo?');
  assert.equal(norm(toSpeech(intoList)), 'He tocado tres archivos: a.js b.js ¿Sigo?');
  // toSpeech reads a leading heading (and the list that follows it).
  const heading = '## Resumen\n\nHe arreglado el login.\n\n- a\n- b';
  assert.equal(whole(heading).all, 'He arreglado el login.');
  assert.equal(norm(toSpeech(heading)), 'Resumen He arreglado el login.');
  // toSpeech splits paragraphs inside a fence, so code after a blank line can reach the closing.
  const code = 'Hecho, ya está el cambio aplicado y probado en local.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n¿Lo subo?';
  assert.equal(whole(code).all, 'Hecho, ya está el cambio aplicado y probado en local. ¿Lo subo?');
  assert.equal(norm(toSpeech(code)), 'Hecho, ya está el cambio aplicado y probado en local. const b = 2; ¿Lo subo?');
});

// ── Full-day review (2026-11-03) ─────────────────────────────────────────────

test('abbreviations do not end a sentence (review A10)', () => {
  const c = new SpeechChunker();
  const out = [...c.push('El Sr. García vive en EE. UU. y p. ej. trabaja allí. Elige el plan B. Hay peras, etc. Luego hablamos. '), c.finish()].filter(Boolean);
  assert.deepEqual(out, ['El Sr. García vive en EE. UU. y p. ej. trabaja allí.', 'Elige el plan B.', 'Hay peras, etc.', 'Luego hablamos.']);
});

test('a stray backtick does not turn the paragraph into one endless sentence (review A10)', () => {
  const c = new SpeechChunker({ max: 5000 });
  const text = `Usa la orden \`npm para todo. ${'Sigo escribiendo una frase normal. '.repeat(20)}`;
  const out = [...c.push(text), c.finish()].filter(Boolean);
  assert.ok(out.length > 5, `cut into sentences (${out.length})`);
  assert.ok(out.every(s => s.length <= 220));
});
