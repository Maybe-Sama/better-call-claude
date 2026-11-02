'use strict';
// Recognition context for the active call: the words the user is likely to say (the options of a
// question, sí/no for a permission, the technical terms and names Claude just used). Only vocabulary:
// with Claude's sentences as the prompt, Whisper copied them into the user's words (live test
// 2026-11-02: "Léela en voz alta: Sí.", "Frase 4: Quiero que…").

const FILE = /^[\w-]+\.(?:js|ts|tsx|jsx|py|md|json|mp4|html|css|sql|yml|yaml|env)$/;
const IDENT = /^(?:[a-z]+[A-Z]\w*|[A-Z][a-z]+[A-Z]\w*|[A-Z]{2,}[a-z]*\w*|\w*\d\w*)$/; // NextAuth, iOS, API, OAuth2
const CAPITALISED = /^[A-ZÁÉÍÓÚÑ][\wáéíóúñ.+#-]*[A-Za-z0-9]$/;

function termsIn(text) {
  const terms = [];
  // Sentence by sentence: a capitalised word that does not start a sentence is a name ("Supabase").
  for (const sentence of String(text || '').replace(/\r/g, '').split(/(?<=[.!?:;])\s+|\n+/)) {
    const words = sentence.replace(/^[\s>*#\-\d.)]+/, '').split(/\s+/).map(w => w.replace(/^[«"'(¿¡]+|[»"'),.;:!?]+$/g, '')).filter(Boolean);
    words.forEach((w, i) => {
      if (w.length < 3) return;
      if (FILE.test(w) || IDENT.test(w) || (i > 0 && CAPITALISED.test(w))) terms.push(w);
    });
  }
  return terms;
}

function sttContextFor(call) {
  const last = [...(call?.messages || [])].reverse().find(m => m.role === 'assistant');
  if (!last) return null;
  const text = String(last.text || '');
  let expected = [];
  if (call.interactionKind === 'ask') {
    expected = text.split('\n').map(l => /^\s*\d+\.\s+(.+?)(\s+—\s+|$)/.exec(l)?.[1]).filter(Boolean)
      .map(label => label.replace(/\s*\([^)]*\)\s*/g, ' ').trim());
  } else if (call.interactionKind === 'permission') {
    expected = ['sí', 'no', 'adelante', 'vale'];
  }
  const hotwords = [...new Set([...expected, ...termsIn(text)])].slice(0, 24);
  return { text: '', hotwords: hotwords.join(', ') };
}

module.exports = { sttContextFor, termsIn };
