#!/usr/bin/env node
'use strict';
/**
 * jsobf_tea.js — Stage NEW: TEA-blob string decoder resolver.
 *
 * Detects the "TEA blob + indexed decoder" family:
 *   var f19 = "<giant encrypted string>";         // blob
 *   var arr2 = [ ... data table ... ];
 *   function f8(x) { ... arr2-based decode ... }  // string decoder
 *   function f14(a, b) { return f8(f19.slice(a, a+b)); }  // indexed access
 *   ... f14(<off>, <len>) used inline everywhere ...
 *
 * Strategy: run the prolog (all top-level statements) inside a vm sandbox so the
 * decoder functions & blob exist with real runtime state, then replace every
 * resolvable call f14(A,B) / f35(A,B) and arr2[N] with its runtime string value.
 *
 * Extraction-only: output may be non-runnable; goal is content readability.
 */
const fs = require('fs');
const vm = require('vm');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const generate = require('@babel/generator').default;

const INPUT = process.argv[2];
const OUTPUT = process.argv[3];
const report = [];
const mark = (m) => { report.push(m); };

let src = fs.readFileSync(INPUT, 'utf8');

// ── Neutralize anti-tamper traps ──
// Obfuscator injects `while (arr2[21]) {}` (arr2[21] === true) — an infinite
// loop that hangs any runtime that executes the prolog (incl. this sandbox).
// Body is always empty; safe to neuter for both sandbox AND output (the real
// script would hang the same way, so removing the trap only helps inspection).
const ANTI_TAMPER_RE = /while\s*\(\s*(?:arr\d+|f\d+)\[\d+\]\s*\)\s*\{\s*\}/g;
const traps = (src.match(ANTI_TAMPER_RE) || []).length;
src = src.replace(ANTI_TAMPER_RE, 'while(false){}');
// anti-tamper bootstrap functions: `if (!v) { while(false){} return {}; }` —
// meant to return the real global object in native env; force the global path.
// Match any fn whose body is exactly: var X = arrN[M]; eval(...); if(!X){...return {};} const Y = eval("this"); return Y;
src = src.replace(/if\s*\(!([a-zA-Z_$][\w$]*)\)\s*\{\s*while\(false\)\{\}\s*return\s*\{\};\s*\}/g,
  'if (false) { while(false){} return {}; }');
if (traps) console.log('jsobf_tea: neutralized ' + traps + ' anti-tamper loops');

let ast;
try {
  ast = parser.parse(src, { sourceType: 'script', errorRecovery: true, allowReturnOutsideFunction: true });
} catch (e) {
  console.error('parse fail: ' + e.message);
  process.exit(1);
}

// ── Detect family: blob + arr2 + f8-style decoder + f14(off,len) ──
const hasBlob = /=\s*"((?:[^"\\]|\\.){500,})"/.test(src) || /(?:^|[;,])\s*\w+\s*=\s*"((?:[^"\\]|\\.){500,})"/.test(src);
const hasArr2 = /\barr\d+\s*=\s*\[/.test(src);
const hasF14 = /\.slice\([^)]*\)/.test(src) && /function\s+f\d+\([^)]*\)\s*\{\s*return\s+f\d+\(/.test(src);
const f14Calls = (src.match(/f\d+\(\d+/g) || []).length;
mark('tea-blob detect: blob=' + hasBlob + ' arr2=' + hasArr2 + ' f14=' + hasF14 + ' directCalls=' + f14Calls);
if (!hasBlob || f14Calls < 20) {
  console.log('jsobf_tea: pattern not matched, passing through');
  fs.writeFileSync(OUTPUT, src);
  process.exit(0);
}

// ── Sandbox — minimal hostile-free host ──
const sandbox = {
  console: { log(){}, error(){}, warn(){}, info(){}, debug(){}, table(){} },
  setTimeout: () => 0, setInterval: () => 0, clearTimeout(){}, clearInterval(){},
  Buffer, String, Number, Boolean, Array, Object, Math, JSON,
  TextDecoder, TextEncoder,
  parseFloat, parseInt, isNaN, isFinite, RegExp, Date, Error, TypeError, Promise,
  atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
  btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
  decodeURIComponent, encodeURIComponent, decodeURI, encodeURI, unescape, escape,
  require: (m) => { try { return require(m); } catch (e) { return {}; } },
  module: { exports: {} }, exports: {},
  process: { env: {}, platform: 'linux', arch: 'x64', version: 'v20.0.0', argv: ['node', 'x.js'], exit(){}, cwd: () => '/', memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }) },
  __dirname: '/', __filename: '/x.js',
};
sandbox.globalThis = sandbox; sandbox.global = sandbox; sandbox.window = sandbox; sandbox.self = sandbox;
let ctx;
try { ctx = vm.createContext(sandbox); } catch (e) { console.error('ctx fail: ' + e.message); process.exit(1); }
// eval must run INSIDE the sandbox context (the obfuscator uses eval() to
// re-define decoder functions like f17 at runtime; a host-side eval would
// land those definitions in the host scope and the sandbox would never see them).
sandbox.eval = function (s) {
  try { return vm.runInContext(String(s), ctx, { timeout: 4000, displayErrors: false }); }
  catch (e) { return undefined; }
};

const topStmts = ast.program.body;

// ── Step 1: run top-level statements (prolog) in dependency-safe order ──
// order: functions first (hoisting), then var decls, then everything else
const byType = { 'FunctionDeclaration': [], 'rest': [] };
for (const st of topStmts) {
  if (st.type === 'FunctionDeclaration') byType['FunctionDeclaration'].push(st);
  else byType['rest'].push(st);
}
let ran = 0, threw = 0;
for (const type of ['FunctionDeclaration', 'rest']) {
  for (const st of byType[type]) {
    const code = generate(st, { compact: true }).code;
    if (!code.trim()) continue;
    try {
      vm.runInContext(code, ctx, { timeout: 8000, displayErrors: false });
      ran++;
    } catch (e) {
      threw++;
    }
  }
}
mark('prolog: ran=' + ran + ' threw=' + threw);

// ── Step 2: resolve arr2[N] everywhere (data table) ──
// find arr2 variable name(s)
const arrNames = new Set();
for (const st of topStmts) {
  if (st.type === 'VariableDeclaration') {
    for (const d of st.declarations) {
      if (d.id.type === 'Identifier' && d.init && d.init.type === 'ArrayExpression') arrNames.add(d.id.name);
    }
  }
}
let arrResolved = 0;
if (arrNames.size) {
  traverse(ast, {
    MemberExpression(path) {
      const obj = path.node.object;
      const prop = path.node.property;
      if (obj.type === 'Identifier' && arrNames.has(obj.name) && prop.type === 'NumericLiteral') {
        let val;
        try { val = vm.runInContext(obj.name + '[' + prop.value + ']', ctx); } catch (e) { return; }
        if (val === undefined) return;
        if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' || val === null) {
          if (typeof val === 'string' && val.length < 60) {
            path.replaceWith(t.stringLiteral(val));
            arrResolved++;
            path.skip();
          } else if (typeof val === 'number') {
            path.replaceWith(t.numericLiteral(val));
            arrResolved++;
            path.skip();
          } else if (typeof val === 'boolean') {
            path.replaceWith(t.booleanLiteral(val));
            arrResolved++;
            path.skip();
          } else if (val === null) {
            path.replaceWith(t.nullLiteral());
            arrResolved++;
            path.skip();
          }
        }
      }
    }
  });
}
mark('arr2 resolved: ' + arrResolved);

// ── Step 3: resolve decoder calls f14(A,B) / f35(A,B) with literal args ──
// identify decoder functions: those whose body calls .slice on the blob var.
// NOTE: detect from the ORIGINAL bodies BEFORE Step 2 replaced arr2[N] with
// literals (arr2[19] == "slice" becomes ["slice"], breaking a `.slice(` regex).
const decoderNames = new Set();
const sliceBodyRe = /\.slice\(|\[["']slice["']\]\(|slice\(/;
for (const st of topStmts) {
  if (st.type === 'FunctionDeclaration' && st.id) {
    const body = generate(st, { compact: true }).code;
    if (sliceBodyRe.test(body)) decoderNames.add(st.id.name);
  }
}
let callResolved = 0;
if (decoderNames.size) {
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (callee.type !== 'Identifier' || !decoderNames.has(callee.name)) return;
      const args = path.node.arguments;
      // allow NumericLiteral / StringLiteral / arr2[N] args
      const evals = [];
      let ok = true;
      for (const a of args) {
        if (a.type === 'NumericLiteral' || a.type === 'StringLiteral') { evals.push(a.type === 'NumericLiteral' ? String(a.value) : JSON.stringify(a.value)); }
        else if (a.type === 'MemberExpression' && a.object.type === 'Identifier' && arrNames.has(a.object.name) && a.property.type === 'NumericLiteral') {
          try { const v = vm.runInContext(a.object.name + '[' + a.property.value + ']', ctx); evals.push(JSON.stringify(v)); }
          catch (e) { ok = false; break; }
        } else { ok = false; break; }
      }
      if (!ok) return;
      try {
        const v = vm.runInContext(callee.name + '(' + evals.join(',') + ')', ctx);
        if (typeof v === 'string') {
          path.replaceWith(t.stringLiteral(v));
          callResolved++;
          path.skip();
        }
      } catch (e) {}
    }
  });
}
mark('decoder calls resolved: ' + callResolved);

// ── Step 4: also resolve `f35(A,B)` style ciphers if they return strings ──
// detect any top-level fn that when called returns a printable string — try all fNs
let cipherResolved = 0;
const fnNames = [];
for (const st of topStmts) {
  if (st.type === 'FunctionDeclaration' && st.id) fnNames.push(st.id.name);
}
if (cipherResolved === 0) {
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (callee.type !== 'Identifier' || !fnNames.includes(callee.name)) return;
      if (decoderNames.has(callee.name)) return;
      const args = path.node.arguments;
      if (args.length < 1 || args.length > 3) return;
      if (!args.every(a => a.type === 'NumericLiteral' || a.type === 'StringLiteral')) return;
      // only try once per name to avoid perf blowup
      try {
        const argvals = args.map(a => a.type === 'NumericLiteral' ? a.value : a.value);
        const v = vm.runInContext(callee.name + '(' + argvals.map(x => JSON.stringify(x)).join(',') + ')', ctx, { timeout: 2000 });
        if (typeof v === 'string' && v.length > 0 && !/\[object /.test(v)) {
          path.replaceWith(t.stringLiteral(v));
          cipherResolved++;
          path.skip();
        }
      } catch (e) {}
    }
  });
}
mark('cipher calls resolved: ' + cipherResolved);

let out = generate(ast, { comments: true, compact: false }).code;
fs.writeFileSync(OUTPUT, out);
console.log('jsobf_tea: output=' + OUTPUT + ' (' + out.length + ' bytes)');
console.log('jsobf_tea: ' + report.join(' | '));
process.exit(0);