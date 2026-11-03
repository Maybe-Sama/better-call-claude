'use strict';
// SpeechChunker: turns Claude's streamed markdown into sentences to speak while Claude is still writing.
// Same rule as toSpeech() (src/speech-text.js), applied as the text arrives: the opening plain paragraph(s)
// are spoken sentence by sentence, lists, tables, headings, code and quotes stay on screen, and finish()
// adds a closing paragraph that asks the user something. Stricter than toSpeech on purpose: it never reads
// list items, headings, quotes or code, not even in the first paragraph (toSpeech reads the first block
// whole), it knows that a blank line inside a code fence does not end the code, and ~~~ fences are code too.
//
// push(delta) → new complete sentences (markdown stripped) · finish() → what is left to say ('' if nothing).
// One chunker per message (or turn); it never repeats what it already returned.
const { stripMarkdown } = require('../speech-text');

const MAX_SENTENCE = 220; // tts_worker.py sentences(): a longer sentence is cut at a comma near this
const OPENING_MIN = 60;   // toSpeech: the opening takes more paragraphs only while it is shorter than this

// Per-line versions of speech-text.js STRUCTURAL / LIST_INSIDE, plus "this unfinished line may still become one".
const STRUCTURAL = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|```|~~~)/;
const MAYBE_STRUCTURAL = /^\s*(#{1,6}|[-*+]|\d+[.)]?|`{1,2}|~{1,2})?$/;
// A code fence opens a block of code; a ``` line with more backticks after it is an inline span (CommonMark).
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const LIST_LINE = /^\s*([-*+]|\d+[.)])\s/;
// Kept in step with speech-text.js: a closing paragraph that asks the user for something is heard.
const ASKS_USER = /[?¿]|\b(dime|dimelo|decide|decidas|elige|confirma|confirmame|permiso|autoriza|apruebas|prefieres|quieres|miralo|mirala|revisalo|revisala|pruebalo|avisame|necesito que)\b/i;
// End of sentence: . ! ? … (plus closing quotes, brackets or emphasis) once the following space has arrived.
const SENTENCE_END = /[.!?…]+["'”’»)\]*_`]*(?=\s)/g;
const WORDS = /[\p{L}\p{N}]/u;

const foldAccents = text => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '');
// stripMarkdown, plus emphasis markers left over when a sentence ends inside *…* or __…__.
const clean = raw => stripMarkdown(raw).replace(/\s*\n\s*/g, ' ')
  .replace(/(^|\s)[*_]+(?=\S)/g, '$1').replace(/(\S)[*_]+(?=\s|$)/g, '$1').trim();

// No inline code, bold or link left open: cutting here cannot leave half of one.
function balanced(text) {
  const count = re => (text.match(re) || []).length;
  return count(/`/g) % 2 === 0 && count(/\*\*/g) % 2 === 0 && count(/\[/g) <= count(/\]/g) && !/\]\([^)]*$/.test(text);
}

// A dot after these never ends a sentence ("Sr. García", "EE. UU.", "pág. 4"); after these only when the
// next word starts with a capital ("etc. Luego…" ends, "p. ej. un caso" does not). A lowercase letter
// ("p.", "a. m.") is of the first kind, a capital one ("el plan B. Luego…") of the second.
const ABBREV_ALWAYS = new Set(['sr', 'sra', 'srta', 'sres', 'dr', 'dra', 'd', 'dña', 'ud', 'uds', 'vd', 'vds', 'ee', 'uu', 'pág', 'pag', 'págs', 'núm', 'num', 'nº', 'art', 'fig', 'cap', 'av', 'avda', 'tel', 'vs', 'aprox', 'mr', 'mrs', 'ms', 'st']);
const ABBREV_MAYBE = new Set(['etc', 'ej', 'máx', 'max', 'mín', 'min', 'pp', 'ss']);

function isAbbreviation(text, m) {
  if (!m[0].startsWith('.') || m[0].startsWith('..')) return false;
  const word = /([\p{L}º]+)$/u.exec(text.slice(0, m.index))?.[1];
  if (!word) return false;
  const lower = word.toLowerCase();
  if ((word.length === 1 && word === lower) || ABBREV_ALWAYS.has(lower)) return true;
  if (word.length > 1 && !ABBREV_MAYBE.has(lower)) return false;
  const next = /\S/.exec(text.slice(m.index + m[0].length));
  return !next || next[0] === next[0].toLowerCase(); // not arrived yet: wait for it
}

// strict: no inline code, bold or link left open. A stray ` or ** would make the whole paragraph one
// endless sentence, so a long text without a balanced end is cut without that rule.
function sentenceEnd(text, strict = true) {
  for (const m of text.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].length;
    if (isAbbreviation(text, m)) continue;
    if (!strict || balanced(text.slice(0, end))) return end;
  }
  return -1;
}

// Where to cut a sentence longer than MAX_SENTENCE: after the last comma that fits (else the last space).
function longCut(text, strict = true) {
  const head = text.slice(0, MAX_SENTENCE);
  const ok = t => !strict || balanced(t);
  for (let i = head.lastIndexOf(', '); i > 40; i = head.lastIndexOf(', ', i - 1)) if (ok(text.slice(0, i + 1))) return i + 1;
  for (let i = head.lastIndexOf(' '); i > 40; i = head.lastIndexOf(' ', i - 1)) if (ok(text.slice(0, i))) return i;
  return -1;
}

// speech-text.js cutAt(), for the closing paragraphs.
function cutAt(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > max * 0.4 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

// A block is what toSpeech calls one: the lines between blank lines (blank lines inside code do not count).
// kind 'prose' or 'detail' (starts with a list, table, heading, quote or code); inner: index of the first
// structural line inside a prose block (its speakable text ends there); innerList: one of them is a list item;
// after: the last line was code, a table row, a heading or a quote; afterList: a list item (or its indented
// continuation); continues: the prose after code & co., the rest of the same toSpeech paragraph.
const newBlock = () => ({ lines: [], kind: null, inner: -1, innerList: false, opened: false, after: false, afterList: false, continues: false });
const speakableOf = b => (b.inner >= 0 ? b.lines.slice(0, b.inner) : b.lines).map(l => `${l}\n`).join('');

class SpeechChunker {
  constructor({ max = 450, maxClosing = 450 } = {}) {
    this.max = max;               // toSpeech's limits for the opening and the closing
    this.maxClosing = maxClosing;
    this.line = '';               // the line being written (its newline has not arrived)
    this.fence = null;            // closing pattern of the open code fence
    this.blocks = [];             // finished blocks
    this.block = newBlock();
    this.phase = 'first';         // 'first' (nothing spoken) | 'more' (opening under 60 chars) | 'done'
    this.streaming = false;       // the current block is the first paragraph, spoken as it arrives
    this.emitted = 0;             // characters of its speakable text already spoken
    this.spoken = '';             // everything returned so far, joined: toSpeech's length rules use it
    this.lastOpening = -1;        // index of the last block the opening spoke from
    this.cut = false;
    this.paused = false;          // the opening stopped at code inside a paragraph: its rest may follow
    this.group = null;            // a held paragraph broken by code, judged whole once it ends (toSpeech's block)
    this.groupStart = -1;
    this.out = [];
    this.finished = false;
  }

  push(delta) {
    if (this.finished) return [];
    this.line += String(delta ?? '').replace(/\r/g, '');
    let i;
    while ((i = this.line.indexOf('\n')) >= 0) {
      const line = this.line.slice(0, i);
      this.line = this.line.slice(i + 1);
      this._addLine(line);
    }
    if (this.phase === 'first' && !this.streaming && !this.block.lines.length && this._partialProse()) this._startStreaming();
    if (this.streaming) {
      // A list (table, heading…) is starting on the unfinished line: the prose before it is complete.
      if (!this.fence && this.block.inner < 0 && STRUCTURAL.test(this.line)) this._stopStreaming(true, LIST_LINE.test(this.line));
      else this._speak(false);
    }
    return this._take();
  }

  finish() {
    if (this.finished) return '';
    if (this.line) {
      const line = this.line;
      this.line = '';
      this._addLine(line);
    }
    this._endBlock();
    if (this.group) this._flushGroup();
    this.finished = true;
    // toSpeech's closing: walking back from the end, up to two plain paragraphs, the last one asking something.
    const closing = [];
    let parts = [];
    for (let i = this.blocks.length - 1; i > this.lastOpening && closing.length < 2; i -= 1) {
      const b = this.blocks[i];
      if (!WORDS.test(b.lines.join('\n'))) continue;
      if (b.kind === 'detail' || b.innerList) break;
      const plain = clean(speakableOf(b));
      if (plain) parts.unshift(plain);
      if (b.continues) continue; // the paragraph began in the block before
      const paragraph = parts.join(' ');
      parts = [];
      if (!paragraph) continue;
      if (!closing.length && !ASKS_USER.test(foldAccents(paragraph))) break;
      closing.unshift(paragraph);
    }
    const out = this._take();
    if (closing.length) out.push(cutAt(closing.join(' '), this.maxClosing));
    return out.join(' ');
  }

  // ── Lines and blocks ────────────────────────────────────────────────────

  _addLine(line) {
    const b = this.block;
    if (this.fence) { // inside code only the closing fence matters
      b.lines.push(line);
      if (this.fence.test(line)) {
        this.fence = null;
        b.after = true;
      }
      return;
    }
    if (!line.trim()) { this._endBlock(); return; }
    const structural = STRUCTURAL.test(`${line}\n`);
    if (!structural && b.kind === 'prose' && (b.after || (b.afterList && !/^\s/.test(line)))) {
      // Prose right after code, a table, a heading or a quote inside a paragraph continues it in a block of its
      // own (toSpeech strips those and reads on), so a closing question written just below code is heard.
      // After a list, an unindented line is a new paragraph (an indented one belongs to the list item).
      const continues = b.after;
      this._endBlock();
      this.block.continues = continues;
      this._addLine(line);
      return;
    }
    const fence = line.match(FENCE);
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) this.fence = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
    if (!b.lines.length) {
      b.kind = structural ? 'detail' : 'prose';
      if (b.kind === 'prose' && this.phase === 'first' && !this.streaming) this._startStreaming();
    } else if (structural && b.kind === 'prose') {
      if (LIST_LINE.test(`${line}\n`)) b.innerList = true;
      if (b.inner < 0) {
        b.inner = b.lines.length;
        if (this.streaming) this._stopStreaming(true, b.innerList);
      }
    }
    const listItem = LIST_LINE.test(`${line}\n`);
    b.after = structural && !listItem && !this.fence;
    b.afterList = structural ? listItem : b.afterList && /^\s/.test(line);
    b.lines.push(line);
  }

  _endBlock() {
    const b = this.block;
    if (this.streaming) this._stopStreaming(false);
    if (b.lines.length) {
      this.blocks.push(b);
      if (!b.opened) this._consider(b, this.blocks.length - 1);
    }
    this.block = newBlock();
  }

  // A finished block the opening did not stream: does it join the opening (toSpeech's loop)?
  _consider(b, index) {
    if (this.group) {
      if (b.continues) {
        this.group.push(b);
        if (b.inner < 0 || b.innerList) this._flushGroup(); // the paragraph is complete
        return;
      }
      this._flushGroup();
    }
    const resume = b.continues && this.paused && index === this.lastOpening + 1;
    const paused = this.paused;
    this.paused = false;
    if (resume) { // the rest of the paragraph the opening was reading, after its code, table or quote
      this.lastOpening = index;
      this.phase = 'more';
      this._sentences(speakableOf(b), true);
      this._afterParagraph(b);
      return;
    }
    // That paragraph ended right after its code: like toSpeech, a short opening takes the next one.
    if (paused && !this.cut && this.spoken.length < OPENING_MIN) this.phase = 'more';
    if (this.phase === 'done' || !WORDS.test(b.lines.join('\n'))) return;
    if (b.kind === 'detail') {
      if (this.phase === 'more') this.phase = 'done'; // nothing spoken yet: skip it and keep looking
      return;
    }
    if (b.innerList) { this.phase = 'done'; return; }
    if (b.inner >= 0) { // code inside: wait for the rest of the paragraph and judge it whole
      this.group = [b];
      this.groupStart = index;
      return;
    }
    const raw = speakableOf(b);
    const plain = clean(raw);
    if (plain && this.spoken.length + plain.length + 1 > this.max) { this.phase = 'done'; return; }
    this.lastOpening = index;
    this._sentences(raw, true);
    this._afterParagraph(b);
  }

  // A held paragraph and the blocks continuing it after its code: toSpeech's single block.
  _flushGroup() {
    const blocks = this.group;
    this.group = null;
    if (blocks.some(x => x.innerList)) { this.phase = 'done'; return; }
    const raws = blocks.map(speakableOf);
    const plain = clean(raws.join('\n'));
    if (plain && this.spoken.length + plain.length + 1 > this.max) { this.phase = 'done'; return; }
    this.lastOpening = this.groupStart + blocks.length - 1;
    for (const raw of raws) this._sentences(raw, true);
    if (!this.cut) this.phase = this.spoken.length >= OPENING_MIN ? 'done' : 'more';
  }

  // toSpeech takes another paragraph only while the opening is short; code inside one pauses it instead.
  _afterParagraph(b) {
    if (this.cut) return;
    this.paused = b.inner >= 0 && !b.innerList;
    this.phase = b.inner >= 0 || this.spoken.length >= OPENING_MIN ? 'done' : 'more';
  }

  // ── The first paragraph, as it arrives ──────────────────────────────────

  _partialProse() {
    return !this.fence && Boolean(this.line) && !STRUCTURAL.test(this.line) && !MAYBE_STRUCTURAL.test(this.line);
  }

  _startStreaming() {
    this.streaming = true;
    this.block.opened = true;
    this.emitted = 0;
  }

  _stopStreaming(structure, list = false) {
    if (this.phase !== 'done') this._speak(true);
    this.streaming = false;
    if (this.phase === 'done') return;
    if (!this.spoken) this.phase = 'first';
    else {
      this.paused = structure && !list;
      this.phase = structure || this.spoken.length >= OPENING_MIN ? 'done' : 'more';
    }
  }

  _speak(final) {
    let text = speakableOf(this.block);
    if (!final && this.block.inner < 0 && this._partialProse()) text += this.line;
    const before = this.out.length;
    this.emitted += this._sentences(text.slice(this.emitted), final);
    if (this.out.length > before) this.lastOpening = this.blocks.length; // the index this block will get
    if (this.phase === 'done') this.streaming = false;
  }

  // Emits every complete sentence of `text` (all of it when final); returns how many characters it used.
  _sentences(text, final) {
    let pos = 0;
    while (this.phase !== 'done') {
      while (pos < text.length && /\s/.test(text[pos])) pos += 1;
      const rest = text.slice(pos);
      if (!rest) break;
      let end = sentenceEnd(rest);
      // Far past any sentence length with nothing balanced: an unpaired ` or ** (cut without that rule).
      const stray = end < 0 && rest.length > 2 * MAX_SENTENCE;
      if (stray) end = sentenceEnd(rest, false);
      let cut = (end < 0 ? rest.length : end) > MAX_SENTENCE ? longCut(rest) : -1;
      if (cut < 0 && stray) cut = (end < 0 ? rest.length : end) > MAX_SENTENCE ? longCut(rest, false) : -1;
      const n = cut > 0 ? cut : end > 0 ? end : final ? rest.length : 0;
      if (!n) break;
      if (!this._emit(rest.slice(0, n))) break;
      pos += n;
    }
    return pos;
  }

  // false when the opening is full (toSpeech's 450 characters): it ends here.
  _emit(raw) {
    const s = clean(raw);
    if (!WORDS.test(s)) return true;
    if (this.spoken && this.spoken.length + s.length + 1 > this.max) {
      this.phase = 'done';
      this.cut = true; // the opening is full: nothing more of it, not even after code
      return false;
    }
    this.spoken = this.spoken ? `${this.spoken} ${s}` : s;
    this.out.push(s);
    return true;
  }

  _take() {
    const out = this.out;
    this.out = [];
    return out;
  }
}

module.exports = { SpeechChunker };
