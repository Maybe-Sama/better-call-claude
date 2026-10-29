'use strict';

const fs = require('node:fs');

// Claude Code writes session-title entries into the session transcript (JSONL):
//   {"type":"agent-name","agentName":"..."}   explicit name given by the user (/rename)
//   {"type":"custom-title","customTitle":"..."}
//   {"type":"ai-title","aiTitle":"..."}        automatic summary title
// We only read the newest title; nothing from the transcript is stored by AgentCall.
const TITLE_KEYS = [
  ['agent-name', 'agentName'],
  ['custom-title', 'customTitle'],
  ['ai-title', 'aiTitle'],
];
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

function readChunk(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readSessionTitle(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    const { size } = fs.statSync(transcriptPath);
    // Titles are written near the start and refreshed later; scan the head and the tail.
    const head = readChunk(transcriptPath, 0, Math.min(size, MAX_SCAN_BYTES / 2));
    const tail = size > MAX_SCAN_BYTES / 2
      ? readChunk(transcriptPath, Math.max(0, size - MAX_SCAN_BYTES / 2), Math.min(size, MAX_SCAN_BYTES / 2))
      : '';
    const found = {};
    for (const text of [head, tail]) {
      for (const line of text.split('\n')) {
        if (!line.includes('title') && !line.includes('agent-name')) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        for (const [type, key] of TITLE_KEYS) {
          if (entry?.type === type && typeof entry[key] === 'string' && entry[key].trim()) found[type] = entry[key].trim();
        }
      }
    }
    for (const [type] of TITLE_KEYS) if (found[type]) return found[type];
  } catch {
    // Missing/locked transcript: the caller falls back to the prompt.
  }
  return '';
}

module.exports = { readSessionTitle };
