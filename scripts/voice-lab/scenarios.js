'use strict';
// Conversation scenarios from docs/voice-first/SPEC.md §23. Each scenario is ONE user turn: every
// pause inside it is a pause a person makes while still talking, so committing there is premature.
// kind: what Claude is waiting for — 'permission' | 'ask' (options) | 'stop' (free reply) | 'working'.
// expect: the words that must reach Claude (for WER); options: the choices Claude offered, if any.

module.exports = [
  { id: 'short-yes', kind: 'permission', expect: 'Sí.', parts: [{ say: 'Sí.' }] },
  { id: 'option', kind: 'ask', options: ['Supabase', 'Neon', 'SQLite'], expect: 'La segunda.', parts: [{ say: 'La segunda.' }] },
  {
    id: 'hesitation', kind: 'stop', expect: 'Pues... a ver... yo creo que la primera opción es mejor.',
    parts: [{ say: 'Pues...', pause_after: 1.2 }, { say: 'a ver...', pause_after: 1.5 }, { say: 'yo creo que la primera opción es mejor.' }],
  },
  {
    id: 'continuation', kind: 'stop', expect: 'Haz eso y luego despliega en Vercel.',
    parts: [{ say: 'Haz eso y', pause_after: 1.8 }, { say: 'luego despliega en Vercel.' }],
  },
  {
    id: 'self-correction', kind: 'stop', expect: 'Ponlo azul. No, perdón, verde.',
    parts: [{ say: 'Ponlo azul.', pause_after: 0.6 }, { say: 'No, perdón, verde.' }],
  },
  {
    id: 'long', kind: 'stop',
    expect: 'Vale, te cuento lo que quiero. La página de facturas tiene que mostrar primero las pendientes. Luego, las pagadas, ordenadas por fecha. Si una factura tiene más de treinta días, márcala en rojo. Y añade un botón para descargar todas en PDF. Ah, y que funcione bien en el móvil.',
    parts: [
      { say: 'Vale, te cuento lo que quiero.', pause_after: 0.5 },
      { say: 'La página de facturas tiene que mostrar primero las pendientes.', pause_after: 0.6 },
      { say: 'Luego, las pagadas, ordenadas por fecha.', pause_after: 0.8 },
      { say: 'Si una factura tiene más de treinta días, márcala en rojo.', pause_after: 0.7 },
      { say: 'Y añade un botón para descargar todas en PDF.', pause_after: 0.9 },
      { say: 'Ah, y que funcione bien en el móvil.' },
    ],
  },
  { id: 'names', kind: 'stop', expect: 'Pregúntale a Alejandro si el informe de Eureka Connect usa Neon o Supabase.', parts: [{ say: 'Pregúntale a Alejandro si el informe de Eureka Connect usa Neon o Supabase.' }] },
  { id: 'technical', kind: 'stop', expect: 'Cambia el endpoint de Supabase y despliega en Vercel.', parts: [{ say: 'Cambia el endpoint de Supabase y despliega en Vercel.' }] },
  { id: 'mixed', kind: 'stop', expect: 'Haz el deploy del frontend pero no hagas merge todavía.', parts: [{ say: 'Haz el deploy del frontend pero no hagas merge todavía.' }] },
  {
    id: 'follow-up', kind: 'working', expect: 'Ah, y otra cosa: no toques el login de Google.',
    parts: [{ say: 'Ah, y otra cosa:', pause_after: 1.0 }, { say: 'no toques el login de Google.' }],
  },
  { id: 'clarification', kind: 'ask', options: ['Supabase', 'Neon'], expect: '¿Por qué has elegido esa opción?', parts: [{ say: '¿Por qué has elegido esa opción?' }] },
  { id: 'correction-after', kind: 'working', expect: 'No, me he explicado mal.', parts: [{ say: 'No, me he explicado mal.' }] },
  {
    id: 'wait', kind: 'stop', expect: 'Espera. Antes de eso, ¿has comprobado que no rompe Google?',
    parts: [{ say: 'Espera.', pause_after: 2.0 }, { say: 'Antes de eso, ¿has comprobado que no rompe Google?' }],
  },
  {
    id: 'acceptance-pause', kind: 'stop', expect: 'Vale pues prueba Google y... un momento... y si falla no lo arregles todavía, dime primero qué ha roto.',
    parts: [{ say: 'Vale pues prueba Google y...', pause_after: 1.0 }, { say: 'un momento...', pause_after: 2.0 }, { say: 'y si falla no lo arregles todavía, dime primero qué ha roto.' }],
  },
];
