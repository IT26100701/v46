'use strict';
const cp = require('child_process');
const fs = require('fs');
const samples = [
  ['dispatcher-only', 'await m.main()'],
  ['calc-only', 'm.computeTotal([10,20,30]) + "|" + m.greeting("x")'],
  ['calc-objext', 'await m.main()'],
  ['hex-rc4', 'await m.main()'],
  ['vars-mangled', 'await m.main()'],
  ['strings-only', 'm.main("bot123", 42)'],
  ['zero-width', 'await m.main()'],
];
for (const [name, expr] of samples) {
  const file = 'tests/out/' + name + '.final.js';
  if (!fs.existsSync(file)) { console.log(name, 'MISSING'); continue; }
  const script = `const m = require('./${file}');\n` +
    `(async () => { const r = await (${expr}); console.log('OK:', JSON.stringify(r).slice(0, 120)); })` +
    `(catch_placeholder => {})().catch(e => console.log('ERR:', e.message.slice(0, 100)));`;
  const clean = script.replace('(catch_placeholder => {})', '');
  const r = cp.spawnSync('node', ['-e', clean], { timeout: 20000, encoding: 'utf8' });
  const out = (r.stdout || '').trim().split('\n').pop();
  const err = (r.stderr || '').trim().split('\n').pop();
  console.log(name.padEnd(18), r.status === 0 ? out : 'CRASH: ' + (err || r.status));
}