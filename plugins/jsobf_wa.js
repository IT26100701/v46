#!/usr/bin/env node
'use strict';
/**
 * jsobf_wa.js — Stage NEW: WhatsApp-bot-style double-layer deobfuscation.
 *
 * Detects + deobfuscates the pattern:
 *   - Outer: javascript-obfuscator 2.x (string array + RC4/base64 + hex names)
 *   - Inner: payload encrypted as base64 chunks, XOR'd with a derived key,
 *     decoded by `_vmXXXXXX(buf)` -> returns the REAL source code string.
 *
 * Pipeline (self-contained):
 *   1. webcrack pass        — resolves decoder machinery + string array, leaves
 *                             XOR key (_z07fed27349) + base64 chunk array.
 *   2. prolog sandbox run   — execute up to first business IIFE; the key-gen
 *                             function `_vm...` runs & returns the plaintext payload.
 *   3. capture payload      — read `_src4395afc352`-style const (real source).
 *   4. write payload as output + beautify.
 *
 * Usage: node jsobf_wa.js <input.js> <output.js>
 */
const fs = require('fs');
const vm = require('vm');
const cp = require('child_process');
const path = require('path');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3];
if (!INPUT || !OUTPUT) { console.error('Usage: node jsobf_wa.js <input.js> <output.js>'); process.exit(1); }
const report = [];
const mark = (s) => { report.push(s); console.log('  [stage] ' + s); };

let src = fs.readFileSync(INPUT, 'utf8');

// ── Detect: base64 chunk array + XOR key + _vm key-gen + payload const ──
function detect(s) {
  const t = [];
  if (s.includes('decodeURIComponent') && /function\s+_0x[0-9a-f]+\([^)]*\)\{[^}]*fromCharCode/.test(s)) t.push('jsobf-string-array');
  if (/const\s+_z[0-9a-f]+\s*=\s*"/.test(s) && /\(\(""\)|\.join\(""\)/.test(s)) t.push('invisible-key');
  if (/function\s+_vm[0-9a-f]+\([^)]*\)\s*\{/.test(s) && /Buffer|toString\("utf8"\)/.test(s)) t.push('vm-keygen');
  if (/(?:^|[,;])\s*"[A-Za-z0-9+/=]{60,}"/.test(s) || /\["OtapOM8|"Xdo8Ov6/.test(s)) t.push('base64-chunk-payload');
  return t;
}
const det = detect(src);
mark('detect: ' + (det.length ? det.join(', ') : 'none'));

// ── Step 1: webcrack pass (unpacks outer layer) ──
async function webcrackPass(code) {
  try {
    const { webcrack } = require('webcrack');
    const r = await webcrack(code, { unpack: true, deobfuscate: true, jsx: false, mangle: false, unminify: true, unflatten: true });
    if (r && r.code && r.code !== code) { mark('webcrack: ' + code.length + ' -> ' + r.code.length); return r.code; }
  } catch (e) { mark('webcrack skip: ' + e.message.slice(0, 60)); }
  return code;
}

async function main() {
  src = await webcrackPass(src);

  // ── Step 2: run prolog in sandbox, capture payload const ──
  const sandbox = {
    console: { log(){}, error(){}, warn(){}, info(){}, debug(){}, table(){} },
    setTimeout: () => 0, setInterval: () => 0, clearTimeout(){}, clearInterval(){},
    Buffer, String, Number, Boolean, Array, Object, Math, JSON, parseFloat, parseInt,
    isNaN, isFinite, RegExp, Date, Error, TypeError, Promise,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    decodeURIComponent, encodeURIComponent, decodeURI, encodeURI, unescape, escape,
    require: (m) => { try { return require(m); } catch (e) { return {}; } },
    module: { exports: {} }, exports: {},
    process: { env: {}, platform: 'linux', arch: 'x64', version: 'v20.0.0',
               argv: ['node', 'index.js'], exit(){}, cwd: () => '/',
               memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }) },
    __dirname: '/', __filename: '/index.js',
  };
  sandbox.globalThis = sandbox; sandbox.global = sandbox; sandbox.window = sandbox; sandbox.self = sandbox;
  let ctx;
  try { ctx = vm.createContext(sandbox); } catch (e) { console.error('ctx fail: ' + e.message); process.exit(1); }

  // Execute top-level statements one by one until the payload const is populated
  // (stops before business IIFE / infinite rotating loop).
  let ast;
  try { ast = parser.parse(src, { sourceType: 'script', errorRecovery: true, allowReturnOutsideFunction: true }); }
  catch (e) { console.error('parse fail (post-webcrack): ' + e.message); process.exit(1); }

  // Find candidate payload const: `const X = <fn>(<buf>);` where fn is a key-gen.
  const payloadNames = [];
  const topStmts = ast.program.body;
  let ranStmts = 0;
  // First: load all function declarations (decoders + helpers) so calls resolve.
  for (const st of topStmts) {
    if (st.type !== 'FunctionDeclaration') continue;
    try { vm.runInContext(generate(st, { compact: true }).code, ctx, { timeout: 8000, displayErrors: false }); ranStmts++; }
    catch (e) {}
  }
  mark('loaded ' + ranStmts + ' function decls');
  // Now run non-function top-level statements in order, capturing payload const values.
  // Payload const = any top-level const initialized with a CALL to another fn
  // whose value becomes a long string (>1000, valid JS = the real source).
  for (const st of topStmts) {
    if (st.type === 'FunctionDeclaration') continue;
    const code = generate(st, { compact: true }).code;
    try { vm.runInContext(code, ctx, { timeout: 8000, displayErrors: false }); } catch (e) {}
    for (const d of (st.type === 'VariableDeclaration' ? st.declarations : [])) {
      if (d.id.type !== 'Identifier' || !d.init || d.init.type !== 'CallExpression') continue;
      const v = vm.runInContext('typeof ' + d.id.name + ' === "string" ? ' + d.id.name + ' : null', ctx);
      if (typeof v === 'string' && v.length > 1000) {
        payloadNames.push({ name: d.id.name, val: v });
        mark('payload const ' + d.id.name + ': ' + v.length + ' chars');
      }
    }
  }

  // ── Step 3: pick best payload (longest, looks like JS) ──
  let payload = null;
  for (const p of payloadNames.sort((a, b) => b.val.length - a.val.length)) {
    try { new vm.Script(p.val); payload = p.val; mark('payload valid JS: using ' + p.name); break; }
    catch (e) { mark('payload invalid:' + p.name + ' (' + e.message.slice(0, 60) + ')'); }
  }
  if (!payload) {
    // fallback: run entire prolog before business IIFE and re-read
    const bizIdx = src.indexOf('(() => {');
    const prolog = bizIdx > 0 ? src.slice(0, bizIdx) : src;
    try { vm.runInContext(prolog, ctx, { timeout: 120000, displayErrors: false }); } catch (e) {}
    for (const k of Object.keys(sandbox)) {
      const v = sandbox[k];
      if (typeof v === 'string' && v.length > 1000) {
        try { new vm.Script(v); payload = v; mark('fallback payload: ' + k + ' ' + v.length); break; } catch (e) {}
      }
    }
  }
  if (!payload) {
    // last resort: if webcrack already produced readable code with no _0x, use it
    if (!/_0x[0-9a-f]{4,}/.test(src) && src.length > 1000) { payload = src; mark('webcrack output already clean — using as-is'); }
    else { console.error('FATAL: no payload recovered.'); process.exit(1); }
  }

  // ── Step 4: write output ──
  fs.writeFileSync(OUTPUT, payload);
  console.log('jsobf_wa: output=' + OUTPUT + ' (' + payload.length + ' bytes)');
  console.log('jsobf_wa: ' + report.join(' | '));
  process.exit(0);
}

main().catch((e) => { console.error('jsobf_wa FAIL: ' + e.message); process.exit(1); });