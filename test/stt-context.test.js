const test = require('node:test');
const assert = require('node:assert/strict');
const { sttContextFor } = require('../src/voice/stt-context');

const call = (text, over = {}) => ({ interactionKind: 'stop', messages: [{ role: 'assistant', text }], ...over });

// Live test 2026-11-02: with Claude's sentences as the prompt Whisper copied them into the user's
// words ("Léela en voz alta: Sí.", "Frase 4: Quiero que…").
test('the context never carries Claude\'s sentences, only vocabulary', () => {
  const ctx = sttContextFor(call('Frase 4 de 12. Léela en voz alta:\n\n> Haz el deploy del frontend en Vercel.'));
  assert.equal(ctx.text, '');
  assert.doesNotMatch(ctx.hotwords, /Frase|Léela/);
  assert.match(ctx.hotwords, /Vercel/);
});

test('options of a question and yes/no of a permission are expected words', () => {
  const ask = sttContextFor(call('¿Qué base de datos prefieres?\n1. Supabase — gestionada\n2. Neon (barata)', { interactionKind: 'ask' }));
  assert.match(ask.hotwords, /Supabase/);
  assert.match(ask.hotwords, /Neon/);
  const perm = sttContextFor(call('Claude pide permiso para usar Bash.', { interactionKind: 'permission' }));
  assert.match(perm.hotwords, /sí/);
  assert.match(perm.hotwords, /no/);
});

test('technical identifiers and mid-sentence proper nouns are kept, sentence-initial words are not', () => {
  const ctx = sttContextFor(call('He terminado. Ahora el login usa NextAuth y Supabase, y el fichero app.js está listo. Mañana revisamos Stripe.'));
  for (const term of ['NextAuth', 'Supabase', 'app.js', 'Stripe']) assert.match(ctx.hotwords, new RegExp(term.replace('.', '\\.')));
  for (const word of ['He', 'Ahora', 'Mañana']) assert.doesNotMatch(ctx.hotwords, new RegExp(`(^|, )${word}(,|$)`));
});

test('no assistant message, no context', () => {
  assert.equal(sttContextFor({ messages: [] }), null);
});
