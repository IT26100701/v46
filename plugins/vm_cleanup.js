// vm_cleanup.js — Stage F3: remove VM dispatcher garbage + leftover f34 noise.
// Runs AFTER final_readable. Only applies changes if the result still passes
// node --check; otherwise returns the input unchanged (safety fallback).
//
// Usage: node vm_cleanup.js <input.js> <output.js>

const fs = require('fs');
const { execSync } = require('child_process');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3];

if (!INPUT || !OUTPUT) { console.error('usage: vm_cleanup.js <in> <out>'); process.exit(1); }
const original = fs.readFileSync(INPUT, 'utf8');

function syntaxOK(code) {
  const t = OUTPUT + '.chk.js';
  fs.writeFileSync(t, code);
  try { execSync('node --check ' + t, { stdio: 'pipe' }); return true; }
  catch { return false; }
  finally { try { fs.unlinkSync(t); } catch {} }
}

// --- 1. Collect VM dispatcher IIFEs ---------------------------------------
// Pattern: function-expression IIFE `(function (...fN) { ... })();` whose body
// contains `while (fX(...) !== N) { switch (fX(...)) { case ...: fN[idx] += ...` 
const vmBlocks = [];
let i = 0;
while (true) {
  let start = original.indexOf('(function (...', i);
  let start2 = original.indexOf('function (...', i);
  if (start < 0 && start2 < 0) break;
  const candidates = [start, start2].filter(x => x >= 0).sort((a, b) => a - b);

  let found = false;
  for (const st of candidates) {
    const snippet = original.substring(st, st + 500);
    if (!(snippet.includes('while (f') && snippet.includes('switch (f') && snippet.includes('case '))) continue;

    // find matching `})();`
    let depth = 0, end = -1, inStr = false, sChar = '';
    for (let j = st; j < original.length; j++) {
      const c = original[j], p = j > 0 ? original[j-1] : '';
      if (!inStr) {
        if (c === '"' || c === "'" || c === '`') { inStr = true; sChar = c; }
        else if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0 && original[j+1] === '(' && original[j+2] === ')') { end = j + 3; break; } }
      } else if (c === sChar && p !== '\\') inStr = false;
    }
    if (end <= st) continue;
    const block = original.substring(st, end);
    // VM signature: indexed arithmetic + break
    if (block.includes('f22[') && (block.includes('+=') || block.includes('-=')) && block.includes('break;')) {
      vmBlocks.push({ start: st, end });
      console.log('  vm_cleanup: VM block ' + st + '-' + end + ' (' + (end - st) + ' chars)');
      found = true;
      break;
    }
  }
  i = candidates[0] + 10;
}

let s = original;
if (vmBlocks.length) {
  for (let k = vmBlocks.length - 1; k >= 0; k--) {
    const vm = vmBlocks[k];
    s = s.substring(0, vm.start) + s.substring(vm.end);
  }
  console.log('  vm_cleanup: removed ' + vmBlocks.length + ' VM dispatcher block(s)');
} else {
  console.log('  vm_cleanup: no VM dispatcher found');
}

// --- 2. Leftover f34( noise from partial removal ---------------------------
s = s.replace(/^\s*f34\(\s*[;,)]/gm, '');
s = s.replace(/f34\(\s*[;,)]/g, '');
s = s.replace(/^\s*;\s*$/gm, '');

// --- 3. String concat folding ----------------------------------------------
function foldStrings(code) {
  let changed = true, iters = 0;
  while (changed && iters < 200) {
    changed = false; iters++;
    const re = /(["'])((?:\\.|(?!\1).)*)\1\s*\+\s*\1((?:\\.|(?!\1).)*)\1/g;
    const m = re.exec(code);
    if (m) {
      const folded = m[1] + m[2] + m[3] + m[1];
      code = code.substring(0, m.index) + folded + code.substring(m.index + m[0].length);
      changed = true;
    }
  }
  return code;
}
s = foldStrings(s);

// --- 4. Bracket -> dot notation for common telegraf/fs/process props --------
const repl = [
  ['f9["reply"]', 'f9.reply'], ['f9["answerCbQuery"]', 'f9.answerCbQuery'],
  ['f9["from"]', 'f9.from'], ['f9["json"]', 'f9.json'], ['f9["text"]', 'f9.text'],
  ['f9["ok"]', 'f9.ok'], ['f9["name"]', 'f9.name'], ['f9["download_url"]', 'f9.download_url'],
  ['f9["id"]', 'f9.id'], ['f13["json"]', 'f13.json'], ['f13["text"]', 'f13.text'],
  ['f23["json"]', 'f23.json'], ['f23["text"]', 'f23.text'], ['f20["download_url"]', 'f20.download_url'],
  ['f20["json"]', 'f20.json'], ['f7["json"]', 'f7.json'], ['f7["find"]', 'f7.find'],
  ['f17["json"]', 'f17.json'], ['f17["find"]', 'f17.find'], ['f32["json"]', 'f32.json'],
  ['f32["text"]', 'f32.text'], ['f6["text"]', 'f6.text'], ['f6["json"]', 'f6.json'],
  ['f25["json"]', 'f25.json'], ['f25["text"]', 'f25.text'], ['fs["writeFileSync"]', 'fs.writeFileSync'],
  ['f30("m9Zw7i8")["exit"]', 'process.exit'], ['f30("m9Zw7i8")["on"]', 'process.on'],
  ['f30("StQ5fZU")', 'setTimeout'], ['f30("Y0VqVnZTmxqn4L")', 'setTimeout'],
  ['f30("CTr4Vp2mqVpx8")', 'setTimeout'], ['f30("CTrmn42LLY8m6")', 'RegExp'],
  ['f30("m1tvrG6")', 'RegExp'], ['f30("NM7ELCw")', 'console'],
  ['f26(f30("NM7ELCw"), "error")', 'console.error'],
  ['bot["command"]', 'bot.command'], ['bot["on"]', 'bot.on'], ['bot["action"]', 'bot.action'],
  ['bot["launch"]', 'bot.launch'], ['bot["use"]', 'bot.use'], ['bot["hears"]', 'bot.hears'],
];
for (const [a, b] of repl) s = s.split(a).join(b);

// --- 5. Whitespace -----------------------------------------------------------
s = s.replace(/\n{3,}/g, '\n\n').replace(/^\s+$/gm, '');

// --- Safety: keep original unless result parses --------------------------------
if (syntaxOK(s)) {
  fs.writeFileSync(OUTPUT, s, 'utf8');
  console.log('  vm_cleanup: output ' + OUTPUT + ' (' + s.length + ' chars) SYNTAX VALID');
} else {
  fs.writeFileSync(OUTPUT, original, 'utf8');
  console.log('  vm_cleanup: cleanup broke syntax, kept original (' + original.length + ' chars)');
}