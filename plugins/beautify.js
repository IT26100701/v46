#!/usr/bin/env node
'use strict';
/**
 * beautify.js — re-indent + wrap JS source into readable multi-line form.
 * Plain re-indenter (no deps): splits on braces/brackets/parens + newlines
 * after `;` at depth 0, indents by depth. Keeps strings/comments intact.
 *
 * Usage: node beautify.js <input.js> [output.js]
 */
const fs = require('fs');
const INPUT = process.argv[2];
const OUTPUT = process.argv[3] || (INPUT ? INPUT.replace(/\.js$/, '.pretty.js') : 'out.js');
if (!INPUT) { console.error('Usage: node beautify.js <input.js> [output.js]'); process.exit(1); }
let src = fs.readFileSync(INPUT, 'utf8');

// tokenize: walk with string/comment/regex awareness
let out = '', depth = 0, i = 0, n = src.length, pend = '';
const nl = () => { out = out.replace(/[ \t]+$/,''); out += '\n' + '  '.repeat(depth); };
const emit = (c) => { out += c; };

function scanString(q) {
  let s = q; i++;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { s += src[i] + (src[i+1]||''); i += 2; continue; }
    s += c; i++;
    if (c === q) break;
  }
  return s;
}

// Preserve template literals as-is (they can span lines)
function scanTemplate() {
  let s = '`'; i++;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { s += src[i] + (src[i+1]||''); i += 2; continue; }
    s += c; i++;
    if (c === '`') break;
    if (c === '$' && src[i] === '{') {
      // nested template — scan until matching } at depth
      let d = 1; s += '{'; i++;
      while (i < n && d > 0) {
        const cc = src[i];
        if (cc === '`') { s += scanTemplate(); continue; }
        if (cc === '"' || cc === "'") { s += scanString(cc); continue; }
        if (cc === '{') d++;
        else if (cc === '}') d--;
        s += cc; i++;
      }
    }
  }
  return s;
}

let prevSig = '';
while (i < n) {
  const c = src[i], d = src[i+1];
  if (c === '/' && d === '/') { let s = '//'; i += 2; while (i < n && src[i] !== '\n') { s += src[i]; i++; } out += s; continue; }
  if (c === '/' && d === '*') { let s = '/*'; i += 2; while (i < n && !(src[i] === '*' && src[i+1] === '/')) { s += src[i]; i++; } s += '*/'; i += 2; out += s; continue; }
  if (c === '"' || c === "'") { out += scanString(c); prevSig = 'str'; i++; continue; }
  if (c === '`') { out += scanTemplate(); prevSig = 'str'; continue; }
  if (c === '/' ) {
    // regex? heuristic: previous significant char
    if (prevSig === '' || '=([{,;:!&|?+-*%^~<>'.includes(prevSig)) {
      let s = '/', cls = false; i++;
      while (i < n) {
        const cc = src[i];
        if (cc === '\\') { s += cc + (src[i+1]||''); i += 2; continue; }
        s += cc; i++;
        if (cc === '[') cls = true;
        else if (cc === ']') cls = false;
        else if (cc === '/' && !cls) break;
        else if (cc === '\n') break;
      }
      while (i < n && /[a-z]/i.test(src[i])) { s += src[i]; i++; }
      out += s; prevSig = 'str'; continue;
    }
  }
  if (c === '{') { nl(); out += '{'; depth++; nl(); prevSig = '{'; i++; continue; }
  if (c === '}') { depth = Math.max(0, depth-1); nl(); out += '}'; prevSig = '}'; i++; continue; }
  if (c === ';') { out += ';'; nl(); prevSig = ';'; i++; continue; }
  if (c === '\n' || c === '\r') { i++; continue; } // collapse
  out += c; prevSig = c; i++;
}

fs.writeFileSync(OUTPUT, out);
console.log('beautify: ' + INPUT + ' -> ' + OUTPUT + ' (' + out.length + ' bytes)');
process.exit(0);