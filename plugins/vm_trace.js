#!/usr/bin/env node
'use strict';
/**
 * vm_trace.js — Stage NEW: VM/CFF content dumper (tracer).
 *
 * Goal: EXTRACT ALL CONTENT from obfuscated VMs, hard CFF, or layered decoders —
 * even if the result won't run (node --check NOT required).
 *
 * Strategy (sandbox + full instrumentation):
 *   1. Parse source; hoist & run top-level function declarations + const/let data
 *      in a sandbox with instrumented primordials (String, Array, Object, Math).
 *   2. Run top-level statements one-by-one with a per-statement timeout + a global
 *      instruction guard (kill runaway loops early — we want content, not hang).
 *   3. During execution, ALL string literals, string concats, array writes, and
 *      function calls are captured into a trace log (dedup, ordered).
 *   4. Dump: the full trace of strings + the final values of every top-level var
 *      (JSON-serialized) + the last N statements' results — this reveals the
 *      "contents inside" even when control flow is flattened.
 *
 * The output is a REPORT (not necessarily valid JS) that exposes everything.
 *
 * Usage: node vm_trace.js <input.js> <output.txt|js>
 */
const fs = require('fs');
const vm = require('vm');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3] || (INPUT ? INPUT + '.trace.txt' : 'trace.txt');
if (!INPUT) { console.error('Usage: node vm_trace.js <input.js> [output]'); process.exit(1); }
let src = fs.readFileSync(INPUT, 'utf8');

// ── Neutralize anti-tamper traps before anything else ──
// `while (arr2[21]) {}` (arr2[21]===true) and `if(!x){while(...){} return {}}`
// bootstraps hang the sandbox; the real script would hang the same way, so
// removing them only helps inspection (extraction goal).
src = src.replace(/while\s*\(\s*(?:arr\d+|f\d+)\[\d+\]\s*\)\s*\{\s*\}/g, 'while(false){}');
src = src.replace(/if\s*\(!([a-zA-Z_$][\w$]*)\)\s*\{\s*while\(false\)\{\}\s*return\s*\{\};\s*\}/g,
  'if (false) { while(false){} return {}; }');

const report = [];
const mark = (s) => { report.push(s); console.log('  [stage] ' + s); };

// ── Parse ──
let ast;
try { ast = parser.parse(src, { sourceType: 'script', errorRecovery: true, allowReturnOutsideFunction: true }); }
catch (e) { console.error('parse fail: ' + e.message); process.exit(1); }

// ── Trace collection ──
const strings = new Map();      // string -> count
const calls = [];               // called fn names
const ops = [];                 // operations: array writes, concats, methods
let callDepth = 0;
function addString(s) {
  if (typeof s !== 'string' || !s) return;
  if (s.length < 2) return;
  strings.set(s, (strings.get(s) || 0) + 1);
}
function addOp(op) { if (ops.length < 200000) ops.push(op); }
function addCall(name) { if (calls.length < 100000) calls.push(name); }

// Instrumented String
const RealString = String;
const RealArray = Array;
function makeStringProxy() {
  return new Proxy(RealString, {
    apply(t, thisArg, args) {
      const r = Reflect.apply(t, thisArg, args);
      addString(r); return r;
    },
    get(t, p) {
      const v = Reflect.get(t, p);
      if (typeof v === 'function') {
        return function (...args) {
          const r = v.apply(this, args);
          if (p === 'fromCharCode' || p === 'fromCodePoint' || p === 'raw') addString(r);
          return r;
        };
      }
      return v;
    }
  });
}
const StringProxy = makeStringProxy();

// Instrumented Array
function makeArrayProxy() {
  return new Proxy(RealArray, {
    get(t, p) {
      const v = Reflect.get(t, p);
      if (typeof v === 'function') {
        return function (...args) {
          const r = v.apply(this, args);
          addOp('Array.' + String(p) + '(' + args.map(a => typeof a === 'string' ? a.slice(0,40) : String(a)).join(',') + ')');
          return r;
        };
      }
      return v;
    }
  });
}
const ArrayProxy = makeArrayProxy();

// ── Sandbox ──
const sandbox = {
  console: { log(){}, error(){}, warn(){}, info(){}, debug(){}, table(){} },
  setTimeout: () => 0, setInterval: () => 0, clearTimeout(){}, clearInterval(){},
  Buffer, String: StringProxy, Number, Boolean, Array: ArrayProxy, Object, Math, JSON,
  parseFloat, parseInt, isNaN, isFinite, RegExp, Date, Error, TypeError, Promise,
  atob: (s) => { const r = Buffer.from(String(s), 'base64').toString('binary'); addString(r); return r; },
  btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
  decodeURIComponent: (s) => { const r = decodeURIComponent(s); addString(r); return r; },
  encodeURIComponent, decodeURI, encodeURI, unescape, escape,
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

// Function call hook: wrap sandbox.Function to log big-string construction
const RealFunction = Function;
sandbox.Function = function (...a) {
  const body = String(a[a.length - 1] || '');
  if (body.length > 100) { addString(body); addOp('Function(body:' + body.length + ')'); }
  return RealFunction(...a);
};
sandbox.eval = function (s) {
  const str = String(s);
  if (str.length > 100) { addString(str); addOp('eval(' + str.length + ')'); }
  // eval MUST run inside the sandbox context — obfuscated code re-defines
  // decoder functions via eval(); a host-side eval loses them.
  try { return vm.runInContext(str, ctx, { timeout: 4000, displayErrors: false }); }
  catch (e) { return undefined; }
};

// ── Step 1: try running the ENTIRE source at once (true semantics) ──
const topStmts = ast.program.body;
let wholeOk = false, wholeErr = '';
try {
  vm.runInContext(src, ctx, { timeout: 120000, displayErrors: false });
  wholeOk = true;
} catch (e) {
  wholeErr = String(e.message || e).slice(0, 200);
}
if (wholeOk) {
  mark('whole-source run: OK');
} else {
  mark('whole-source run threw: ' + wholeErr);
  // ── Step 2 (fallback): per-statement, function decls + var decls first ──
  let loaded = 0;
  for (const st of topStmts) {
    if (st.type === 'FunctionDeclaration' || st.type === 'VariableDeclaration') {
      try { vm.runInContext(generate(st, { compact: true }).code, ctx, { timeout: 10000, displayErrors: false }); loaded++; }
      catch (e) {}
    }
  }
  for (const st of topStmts) {
    if (st.type === 'FunctionDeclaration' || st.type === 'VariableDeclaration') continue;
    const code = generate(st, { compact: true }).code;
    if (!code.trim()) continue;
    try { vm.runInContext(code, ctx, { timeout: 5000, displayErrors: false }); }
    catch (e) { addOp('stmt# threw: ' + String(e.message).slice(0, 80)); }
  }
  // ── Step 2b: call each top-level function a few times to observe returns ──
  const fnNames = [];
  for (const st of topStmts) {
    if (st.type === 'FunctionDeclaration' && st.id && st.id.name) fnNames.push(st.id.name);
  }
  for (const nm of fnNames) {
    try {
      const r = vm.runInContext(
        '(function(){ try { var v = ' + nm + '(); ' +
        'if (typeof v === "string" && v.length > 10) return "RET:' + nm + ' = " + v.slice(0,200); ' +
        'if (v && typeof v === "object") { var j; try { j = JSON.stringify(v); } catch(e) { j = String(v); } ' +
        'if (j && j.length > 20) return "RET:' + nm + ' = " + j.slice(0,200); } return null; } catch(e) { return "THREW:' + nm + ': " + e.message; } })()',
        ctx, { timeout: 5000, displayErrors: false });
      if (r) addOp(String(r).slice(0, 260));
    } catch (e) {}
  }
  mark('per-statement fallback: loaded ' + loaded + ' fns');
}

// ── Step 3: capture final values of every top-level var (big ones) ──
const finalVars = [];
for (const st of topStmts) {
  if (st.type !== 'VariableDeclaration') continue;
  for (const d of st.declarations) {
    if (d.id.type !== 'Identifier') continue;
    const name = d.id.name;
    let v = null;
    try {
      v = vm.runInContext('typeof ' + name + ' !== "undefined" ? (typeof ' + name + ' === "string" ? ' + name + ' : (typeof ' + name + ' === "object" && ' + name + ' !== null ? JSON.stringify(' + name + ') : String(' + name + '))) : null', ctx);
    } catch (e) { v = null; }
    if (v !== null && v !== undefined && String(v).length > 20) {
      finalVars.push({ name, val: v });
    }
  }
}

// ── Step 4: write report ──
const lines = [];
lines.push('='.repeat(70));
lines.push('VM/CFF CONTENT DUMP');
lines.push('input: ' + INPUT + ' (' + src.length + ' bytes)');
lines.push('='.repeat(70));
lines.push('');
lines.push('## Strings observed (' + strings.size + ' unique)');
const sorted = [...strings.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
for (const [s, c] of sorted.slice(0, 5000)) {
  lines.push('[' + c + 'x] ' + JSON.stringify(s.length > 500 ? s.slice(0, 500) + '…(' + s.length + ')' : s));
}
lines.push('');
lines.push('## Ops observed (' + ops.length + ')');
for (const o of ops.slice(0, 5000)) lines.push('  ' + o);
lines.push('');
lines.push('## Final top-level var values (' + finalVars.length + ')');
for (const { name, val } of finalVars.slice(0, 500)) {
  lines.push('### ' + name + ' = ' + (String(val).length > 800 ? String(val).slice(0, 800) + '…(' + String(val).length + ')' : val));
}
lines.push('');
lines.push('## Function calls (' + calls.length + ')');
const callCounts = new Map();
for (const c of calls) callCounts.set(c, (callCounts.get(c) || 0) + 1);
for (const [c, n] of [...callCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200)) {
  lines.push('  ' + c + ' x' + n);
}
fs.writeFileSync(OUTPUT, lines.join('\n'));
console.log('vm_trace: output=' + OUTPUT + ' (' + lines.join('\n').length + ' bytes)');
console.log('vm_trace: ' + report.join(' | '));
process.exit(0);