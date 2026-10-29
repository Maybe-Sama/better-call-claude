'use strict';

// Turns a Claude markdown message into a short text suitable for TTS. Claude is asked (SessionStart)
// to open each handoff with a spoken-style paragraph; we read that and leave the rest on screen.
// No "see the screen" tail: the full text is already in the call transcript.

function stripMarkdown(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/```[\s\S]*?(```|$)/g, '\n\n')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'un enlace')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/[\\]/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

// Headings, lists, tables, quotes and code are "detail": reading stops when one appears.
const STRUCTURAL = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|```)/;

// A closing paragraph that asks the user for something must be heard, not only read on screen.
const ASKS_USER = /[?¿]|\b(dime|dimelo|decide|decidas|elige|confirma|confirmame|permiso|autoriza|apruebas|prefieres|quieres|miralo|mirala|revisalo|revisala|pruebalo|avisame|necesito que)\b/i;
const LIST_INSIDE = /\n\s*([-*+]|\d+[.)])\s/;

function foldAccents(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function cutAt(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return sentenceEnd > max * 0.4 ? cut.slice(0, sentenceEnd + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

// Spoken version of a final message: the opening paragraph (what happened) plus the closing
// paragraphs that ask the user something (decision, permission, "míralo y dime…"). Lists, tables,
// code and other detail stay on screen only.
function toSpeech(text, max = 450, maxClosing = 450) {
  const blocks = String(text || '').replace(/\r/g, '').split(/\n\s*\n/).filter(b => /[\p{L}\p{N}]/u.test(b));
  if (!blocks.length) return '';

  let spoken = '';
  let used = 0;
  for (const block of blocks) {
    if (spoken && (STRUCTURAL.test(block) || LIST_INSIDE.test(block) || spoken.length >= 60)) break;
    const plain = stripMarkdown(block).replace(/\s*\n\s*/g, ' ').trim();
    if (plain && spoken && spoken.length + plain.length + 1 > max) break;
    used += 1;
    if (plain) spoken = spoken ? `${spoken} ${plain}` : plain;
  }
  spoken = cutAt(spoken, max);

  // Walk back from the end collecting plain (non-list) paragraphs, as long as the last one asks for something.
  const closing = [];
  for (let i = blocks.length - 1; i >= used && closing.length < 2; i -= 1) {
    if (STRUCTURAL.test(blocks[i]) || LIST_INSIDE.test(blocks[i])) break;
    const plain = stripMarkdown(blocks[i]).replace(/\s*\n\s*/g, ' ').trim();
    if (!plain) continue;
    if (!closing.length && !ASKS_USER.test(foldAccents(plain))) break;
    closing.unshift(plain);
  }
  if (closing.length) spoken = `${spoken} ${cutAt(closing.join(' '), maxClosing)}`;
  return spoken;
}

module.exports = { toSpeech, stripMarkdown };
