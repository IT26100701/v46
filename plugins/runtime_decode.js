#!/usr/bin/env node
/**
 * runtime_decode.js — Runtime decoder (STAGE PERTAMA, jalan sebelum webcrack).
 *
 * Filosofi: kode obfuskasi PASTI mendekode dirinya sendiri saat runtime.
 * Daripada menebak pola secara statis, jalankan kodenya di sandbox berinstrumentasi
 * lalu rekam hasil dekode sesungguhnya.
 *
 * Tiga teknik runtime:
 *  A. eval/Function capture — rekam payload string yang dikirim ke eval/Function/
 *     vm.runInThisContext/Function constructor; pilih payload terbesar yang valid.
 *  B. Decoder-call recording — setiap panggilan fungsi decoder top-level di-rewrite
 *     jadi __REC__(id, fn(...)) → dijalankan → hasil rekaman disubstitusi jadi literal.
 *     (Covers string-table, XOR, base64, TEA, custom — apapun kodenya, runtime yang
 *      mengerjakan.)
 *  C. require hook — rekam modul yang di-require (untuk laporan).
 *
 * Sandbox aman: network diblokir, document/window dummy Proxy, timeout per-run.
 * Output: source dengan panggilan decoder sudah jadi literal string / payload eval
 * sudah diadopsi. Gate: kalau tidak ada yang terekam → keep input apa adanya.
 *
 * Usage: node runtime_decode.js <input.js> [output.js]
 * Env:   RT_VERBOSE=1 untuk log detail, RT_TIMEOUT=<ms> (default 20000)
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3] || (INPUT ? INPUT.replace(/\.js$/, '.rt.js') : 'out.js');
if (!INPUT) { console.error('Usage: node runtime_decode.js <input.js> [output.js]'); process.exit(1); }
const code = fs.readFileSync(INPUT, 'utf8');
const V = process.env.RT_VERBOSE === '1';
const RT_TIMEOUT = Number(process.env.RT_TIMEOUT || 20000);

function emit(out, note) {
  fs.writeFileSync(OUTPUT, out);
  console.log('[runtime_decode] ' + note + ' | ' + OUTPUT + ' (' + out.length + ' bytes)');
  process.exit(0);
}
function bail(msg) { emit(code, msg + ' — keep input'); }

function parseSafe(src) {
  return parser.parse(src, {
    sourceType: 'script', errorRecovery: true, allowReturnOutsideFunction: true,
    plugins: ['classProperties', 'optionalChaining', 'nullishCoalescingOperator',
      'dynamicImport', 'topLevelAwait', 'numericSeparator', 'optionalCatchBinding'],
  });
}
let ast;
try { ast = parseSafe(code); } catch (e) { bail('parse failed: ' + e.message); }

const gen = (n) => generate(n, { compact: true }).code;

// ─────────────────────────── Sandbox builder ───────────────────────────
function makeSandbox(record) {
  const fake = new Proxy(function () { return fake; }, {
    get(tg, p) {
      if (p === Symbol.toPrimitive) return () => '';
      if (p === 'toString') return () => '';
      if (p === Symbol.iterator) return function* () {};
      if (p === 'length') return 0;
      if (p === 'nodeType') return 1;
      if (p === 'then') return undefined;
      return fake;
    },
    set() { return true; },
    apply() { return fake; },
    construct() { return fake; },
    has() { return true; },
  });
  const stubModule = { exports: {} };
  const sb = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {}, table() {} },
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
    setImmediate: () => 0, clearImmediate() {},
    module: stubModule, exports: stubModule.exports,
    require: (m) => { record.required.push(String(m)); return new Proxy({}, { get: () => () => undefined }); },
    process: {
      env: {}, platform: 'linux', arch: 'x64', version: 'v20.0.0',
      argv: ['node', 'index.js'], exit() {}, cwd: () => '/',
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
      nextTick: (f) => { try { f && f(); } catch (e) {} },
    },
    Buffer,
    __dirname: '/', __filename: '/index.js',
    fetch: () => Promise.reject(new Error('network blocked')),
    XMLHttpRequest: function () { this.open = () => {}; this.send = () => {}; this.setRequestHeader = () => {}; },
    navigator: { userAgent: 'Mozilla/5.0', language: 'en', platform: 'Linux' },
    location: { href: 'https://localhost/', protocol: 'https:', hostname: 'localhost', origin: 'https://localhost' },
    document: fake, window: fake, globalThis: fake, self: fake, top: fake, parent: fake,
    localStorage: fake, sessionStorage: fake, cookies: '',
    alert() {}, prompt() {}, confirm() { return false; },
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    unescape, escape, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    // eval + Function: rekam payload, return undefined (jangan eksekusi payload 2x)
    eval: (s) => { if (typeof s === 'string') record.evals.push(s); return undefined; },
    Function: function (...a) {
      const b = String(a[a.length - 1] || '');
      if (b) record.evals.push(b);
      return function () { return undefined; };
    },
  };
  sb.globalThis = sb; sb.window = sb; sb.self = sb; sb.global = sb;
  // __REC__ : record every value produced at an instrumented call site.
  // A single site can execute many times with DIFFERENT arguments (the same
  // decoder called in a loop / recursion / per-case with a fresh key). Storing a
  // single value kept only the LAST one, so every earlier distinct result was
  // silently dropped and the call site stayed un-substituted. Keep an array, and
  // a fast single-value path for sites that only ever run once.
  sb.__REC__ = (id, v) => {
    const slot = record.values[id];
    if (slot === undefined) record.values[id] = v;
    else if (Array.isArray(slot)) { if (slot.length < 4096) slot.push(v); }
    else record.values[id] = [slot, v];
    return v;
  };
  sb.__T__ = record.values;
  return sb;
}

function runSandbox(src, record, timeout) {
  const sb = makeSandbox(record);
  const ctx = vm.createContext(sb);
  try { vm.runInContext(src, ctx, { timeout: timeout || RT_TIMEOUT, displayErrors: false }); }
  catch (e) { /* capture jalan sebelum throw — gapapa */ }
  return ctx;
}

// ─────────────────────────── A. eval/Function payload capture ───────────────────────────
function looksLikeJS(s) {
  return typeof s === 'string' && s.length > 20 && /[;{}()=]/.test(s);
}
function validJS(s) {
  try { new vm.Script(s); return true; } catch (e) { return false; }
}
function capturePayload(src) {
  const record = { evals: [], values: {}, required: [] };
  runSandbox(src, record, Math.min(RT_TIMEOUT, 15000));
  const cands = record.evals.filter(looksLikeJS).sort((a, b) => b.length - a.length);
  if (!cands.length) return null;
  let best = cands[0];
  // drill down: payload mungkin masih wrapped eval(...) lagi
  for (let i = 0; i < 3; i++) {
    const inner = { evals: [], values: {}, required: [] };
    runSandbox(best, inner, 5000);
    const deeper = inner.evals.filter(looksLikeJS).sort((a, b) => b.length - a.length)[0];
    if (deeper && deeper.length > best.length) best = deeper; else break;
  }
  if (!validJS(best)) return null;
  const plausible = best.length > 1000 || best.length >= src.length * 0.005;
  return plausible ? best : null;
}

// ─────────────────────────── B. decoder-call instrumentation ───────────────────────────
// Kandidat decoder: FunctionDeclaration top-level, ≤4 params, body pure-ish.
function discoverDecoders(tree) {
  const names = new Set();
  for (const node of tree.program.body) {
    if (node.type !== 'FunctionDeclaration' || !node.id) continue;
    if (node.params.length === 0 || node.params.length > 4) continue;
    if (node.params.some(p => p.type !== 'Identifier')) continue;
    const body = gen(node);
    if (body.length > 80000) continue;
    // pure decoder heuristics: return string/number dari lookup/encode/decode
    if (/charCodeAt|fromCharCode|atob|btoa|slice|substr|charAt|parseInt|from\(|toString\(|\[[^\]]*\]/.test(body)) {
      names.add(node.id.name);
    }
  }
  return names;
}

function instrument(tree, decoders) {
  let site = 0;
  const siteMap = new Map(); // id -> original call node (for report)
  traverse(tree, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (callee.type !== 'Identifier' || !decoders.has(callee.name)) return;
      // jangan sentuh deklarasi / method call
      if (path.parentPath.isMemberExpression() && path.parentPath.node.callee === path.node) return;
      const id = site++;
      siteMap.set(id, callee.name + '(' + path.node.arguments.map(a => {
        try { return gen(a).slice(0, 40); } catch (e) { return '?'; }
      }).join(',') + ')');
      path.replaceWith(t.callExpression(t.identifier('__REC__'), [t.numericLiteral(id), path.node]));
      path.skip();
    },
  });
  return { site, siteMap };
}

function substitute(tree, values) {
  let n = 0, skipped = 0;
  // Helper: determine if a CallExpression node is inside a loop-test / switch discriminant
  function inDispatcherTest(path) {
    // via start/end containment (robust even after re-parse)
    const inWhile = path.findParent(p => (p.isWhileStatement() || p.isIfStatement() || p.isForStatement()) &&
      p.node.test && path.node.start >= p.node.test.start && path.node.end <= p.node.test.end);
    if (inWhile) return true;
    const inSwitch = path.findParent(p => p.isSwitchStatement() && p.node.discriminant &&
      path.node.start >= p.node.discriminant.start && path.node.end <= p.node.discriminant.end);
    if (inSwitch) return true;
    return false;
  }
  // Helper: determine if the inner call touches CFF state (contains statesvar references)
  function touchesCFFState(node) {
    return /__p_.*_states|__p_.*_scope\[|_scope\[|\.M818Aij\./.test(gen(node));
  }
  // A site may execute many times. Its AST node is a SINGLE position, so it can be
  // collapsed to a literal ONLY if every execution produced the same primitive.
  // If executions disagree, substituting any one of them silently corrupts the
  // program (all call positions would collapse to the last result) — unwrap instead.
  function agreedValue(slot) {
    if (!Array.isArray(slot)) return slot;
    let first;
    for (const v of slot) {
      const p = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
      if (!p) return undefined;
      if (first === undefined) first = v;
      else if (first !== v) return undefined;
    }
    return first;
  }
  traverse(tree, {
    CallExpression(path) {
      if (!t.isIdentifier(path.node.callee, { name: '__REC__' })) return;
      const idArg = path.node.arguments[0];
      const inner = path.node.arguments[1];
      if (!t.isNumericLiteral(idArg) || !inner) return;
      // slot undefined = the site never executed at runtime → keep the original call
      const v = agreedValue(values[idArg.value]);
      if (v === undefined) { path.replaceWith(inner); skipped++; return; }
      // NEVER substitute state-touching calls — CFF dispatcher state machine
      if (touchesCFFState(inner)) {
        // unwrap only: __REC__(id, inner) → inner
        path.replaceWith(inner);
        skipped++;
        return;
      }
      // NEVER substitute into switch discriminant / while-test
      if (inDispatcherTest(path)) {
        path.replaceWith(inner);
        skipped++;
        return;
      }
      // only substitute string/number/boolean results — skip arrays/objects/functions
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        if (typeof v === 'string' && v.length > 50000) { path.replaceWith(inner); skipped++; return; }
        // skip no-op: inner already is a literal with the same value
        if (inner.type === 'NumericLiteral' && inner.value === v) { path.replaceWith(inner); skipped++; return; }
        if (inner.type === 'StringLiteral' && inner.value === v) { path.replaceWith(inner); skipped++; return; }
        if (inner.type === 'BooleanLiteral' && inner.value === v) { path.replaceWith(inner); skipped++; return; }
        path.replaceWith(t.valueToNode(v));
        n++;
      } else {
        // non-primitive: unwrap to original call, don't freeze structures
        path.replaceWith(inner);
        skipped++;
      }
    },
  });
  return { n, skipped };
}

// ─────────────────────────── Main ───────────────────────────
let src = code;
let adopted = false;
let note = [];

// A. eval/Function payload
const payload = capturePayload(src);
if (payload) {
  src = payload;
  adopted = true;
  note.push('eval-payload=' + payload.length + 'c');
}

// re-parse (payload baru atau original)
try { ast = parseSafe(src); } catch (e) { emit(src, 'adopted payload but parse failed — keep'); }

// B. instrument decoder calls → run → substitute
const decoders = discoverDecoders(ast);
let subbed = 0, skipped = 0, sites = 0;
if (decoders.size) {
  const inst = instrument(ast, decoders);
  sites = inst.site;
  if (sites > 0) {
    const instSrc = generate(ast, { compact: true }).code;
    const record = { evals: [], values: {}, required: [] };
    runSandbox(instSrc, record, Math.min(RT_TIMEOUT, 15000));
    // rebuild clean AST dari original src, substitute dengan values hasil run
    try { ast = parseSafe(src); } catch (e) { ast = null; }
    if (ast) {
      // instrument ulang dgn id sama lalu substitute
      instrument(ast, decoders);
      const r = substitute(ast, record.values);
      subbed = r.n; skipped = r.skipped;
      if (V) console.log('[runtime] decoder sites=' + sites + ' substituted=' + subbed + ' skipped=' + skipped);
    }
  }
}

if (!adopted && subbed === 0) {
  bail('nothing recorded (sites=' + sites + ' subbed=0)');
}

let out;
try {
  out = generate(ast, { compact: false, comments: false }).code;
  new vm.Script(out);
} catch (e) {
  // fallback: pakai src apa adanya kalau output rusak
  if (adopted) emit(src, 'output invalid (' + e.message.slice(0, 60) + ') — adopt payload only');
  bail('output invalid: ' + e.message.slice(0, 80));
}

emit(out, 'runtime | ' + note.concat([
  adopted ? 'payload-adopted' : null,
  'sites=' + sites, 'substituted=' + subbed,
  skipped ? 'skipped=' + skipped : null,
].filter(Boolean).join(' ')));
