#!/usr/bin/env node
/**
 * xor_cipher_decode.js — Hard string decoder: XOR / RC4 / Caesar / Base64 / custom cipher.
 *
 * Targets:
 *  A. JS-Confuser: __p_z3qu_cff_xor(key, start, length) + __p_ngnC_strings blob
 *  B. ktech / xcode: XOR loop over hex/charCode arrays (value = arr[i] ^ key, charCodeAt/fromCharCode)
 *  C. TEA-like:  fN(offset,len) decoder called with numeric literals — decrypt via sandbox eval
 *  D. Generic:   any pure decoder `fn(lit, …)` -> string, discovered by calling it with literal args
 *
 * Strategy: sandbox-execute the decoder functions with literal args; any call that returns a
 * non-empty string is replaced with a string literal. Repeated until fixpoint.
 *
 * Usage: node xor_cipher_decode.js <input.js> [output.js]
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3] || (INPUT ? INPUT.replace(/\.js$/, '.xor-decoded.js') : 'out.js');
if (!INPUT) { console.error('Usage: node xor_cipher_decode.js <input.js> [output.js]'); process.exit(1); }
const code = fs.readFileSync(INPUT, 'utf8');
const V = process.env.XOR_VERBOSE === '1';

function emit(out, note) {
  fs.writeFileSync(OUTPUT, out);
  console.log('[xor_cipher] ' + note + ' | ' + OUTPUT + ' (' + out.length + ' bytes)');
  process.exit(0);
}
function bail(msg) { emit(code, msg + ' — keep input'); }

let ast;
try {
  ast = parser.parse(code, {
    sourceType: 'script', errorRecovery: true, allowReturnOutsideFunction: true,
    plugins: ['classProperties', 'optionalChaining', 'nullishCoalescingOperator',
      'dynamicImport', 'topLevelAwait', 'numericSeparator', 'optionalCatchBinding'],
  });
} catch (e) { bail('parse failed: ' + e.message); }

const gen = (n) => generate(n, { compact: true }).code;

// ── Build sandbox with all pure helpers ──
function buildSandbox() {
  const top = [];
  for (const node of ast.program.body) {
    if (node.type === 'FunctionDeclaration' || node.type === 'VariableDeclaration') {
      const g = gen(node);
      if (g.length < 500000) top.push(g);
    }
  }
  const sb = {
    console: { log(){}, warn(){}, error(){} },
    Math, parseInt, parseFloat, String, Number, Array, Object, JSON, RegExp, Date, Boolean,
    Buffer, process: { env: {}, platform: 'linux', argv: ['node'] },
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    unescape, escape, encodeURIComponent, decodeURIComponent,
    require: () => new Proxy({}, { get: () => () => undefined }),
  };
  sb.globalThis = sb; sb.window = sb; sb.self = sb; sb.global = sb;
  const ctx = vm.createContext(sb);
  try { vm.runInContext(top.join('\n'), ctx, { timeout: 20000 }); } catch (e) {
    if (V) console.log('[xor] sandbox partial: ' + e.message.slice(0, 90));
  }
  return ctx;
}
const ctx = buildSandbox();

// ── Discover decoder candidates ──
// A pure string decoder is a FunctionDeclaration that, when called with literal args, returns a string.
function discoverDecoders() {
  const decoders = [];
  for (const node of ast.program.body) {
    if (node.type !== 'FunctionDeclaration' || !node.id) continue;
    const name = node.id.name;
    const params = node.params.length;
    if (params === 0 || params > 4) continue;
    // Heuristic: decoder functions use charCodeAt/fromCharCode/slice/atob/Buffer/parseInt/Math
    const fnText = gen(node);
    if (/charCodeAt|fromCharCode|fromCodePoint|charAt|slice|substr|atob|Buffer/.test(fnText)) {
      decoders.push(name); continue;
    }
    // Also detect XOR-style functions: (key, start, length) -> string, with charCodeAt
    if (params === 3 && /charCodeAt|fromCharCode|\+.*32.*95/.test(fnText)) {
      decoders.push(name);
    }
  }
  if (V) console.log('[xor] decoder candidates:', decoders.join(', '));
  return decoders;
}
const decoders = discoverDecoders();
if (!decoders.length) bail('no decoder candidates');

// ── Bind helper params that are only concrete at call time ──────────────────────
// JS-Confuser's CFF dispatcher is a RECURSIVE function: `main(states, scope, …)`
// calls itself with progressively-shrinking `states` built from spreads of
// `cff_slice(…)` over a top-level table. The table is therefore not a top-level
// var — it is a parameter, and its value only exists after the recursion bottoms
// out. We cannot resolve `states[671 + -589]` unless we actually run that recursion.
//
// So: call every zero-dependency FunctionDeclaration in the sandbox and, if it
// returns an array of primitives, expose it as a synthetic const table under its
// own name. Pure builders return fine; impure ones throw and are skipped.
function seedParamTables() {
  const seeded = [];
  for (const node of ast.program.body) {
    if (node.type !== 'FunctionDeclaration' || !node.id) continue;
    const name = node.id.name;
    // Already defined at top level? nothing to seed.
    try { if (vm.runInContext('typeof ' + name, ctx) !== 'undefined') continue; } catch (e) { continue; }
    // Only try functions whose body is pure-looking (no await/while-true on I/O).
    const src = gen(node);
    if (/\bawait\b|require\(|process\.|fs\.|readFile/i.test(src)) continue;
    const nParams = node.params.length;
    // Call with plausible primitive args; unwrap if the first result is a promise.
    for (const argset of [[], [0], [0, 0], [[]], [{}, 0], [[], {}]]) {
      if (argset.length !== nParams) continue;
      const call = name + '(' + argset.map(a => JSON.stringify(a)).join(',') + ')';
      let res;
      try { res = vm.runInContext(call, ctx, { timeout: 3000 }); } catch (e) { continue; }
      if (res && typeof res.then === 'function') {
        // Do NOT await — a pending promise means the function is not a pure builder.
        continue;
      }
      if (Array.isArray(res) && res.length && res.every(v => typeof v === 'number' || typeof v === 'string')) {
        try {
          vm.runInContext(name + ' = ' + JSON.stringify(res), ctx, { timeout: 1000 });
          seeded.push(name + '[' + res.length + ']');
        } catch (e) { /* not assignable */ }
        break;
      }
    }
  }
  if (V) console.log('[xor] seeded param tables:', seeded.join(', ') || 'none');
  return seeded;
}
seedParamTables();

// ── Constant resolver: evaluate an AST node to a primitive, in the sandbox realm ──
// Handles literals, unary/binary arithmetic, and CONSTANT ARRAY / OBJECT member index
// lookups (e.g. `__p_l3GV_4_states[671 + -589]`, `scope.a.b[3 + 4]`). Everything is
// evaluated inside the SAME vm context as the decoders, so top-level `var` tables are
// in scope and no separate constant-propagation engine is needed.
function resolveConst(node) {
  switch (node.type) {
    case 'StringLiteral': return node.value;
    case 'NumericLiteral': return node.value;
    case 'BooleanLiteral': return node.value;
    case 'NullLiteral': return null;
    case 'Identifier':
      if (node.name === 'undefined') return undefined;
      if (node.name === 'NaN') return NaN;
      if (node.name === 'Infinity') return Infinity;
      return undefined;
    case 'UnaryExpression': {
      const v = resolveConst(node.argument);
      if (v === undefined) return undefined;
      switch (node.operator) {
        case '-': return -v; case '+': return +v; case '!': return !v;
        case '~': return ~v; case 'void': return undefined;
        case 'typeof': return typeof v;
        default: return undefined;
      }
    }
    case 'BinaryExpression': {
      const l = resolveConst(node.left); const r = resolveConst(node.right);
      if (l === undefined || r === undefined) return undefined;
      switch (node.operator) {
        case '+': return l + r; case '-': return l - r; case '*': return l * r;
        case '/': return r === 0 ? undefined : l / r; case '%': return r === 0 ? undefined : l % r;
        case '**': return l ** r;
        case '<<': return l << r; case '>>': return l >> r; case '>>>': return l >>> r;
        case '|': return l | r; case '&': return l & r; case '^': return l ^ r;
        case '==': return l == r; case '===': return l === r;
        case '!=': return l != r; case '!==': return l !== r;
        case '<': return l < r; case '>': return l > r;
        case '<=': return l <= r; case '>=': return l >= r;
        case '&&': return l && r; case '||': return l || r;
        default: return undefined;
      }
    }
    // `TABLE[idx]` / `obj.a.b[idx]` where TABLE is a top-level var we hoisted into the sandbox
    case 'MemberExpression': {
      if (node.computed) {
        const obj = resolveConst(node.object);
        const key = resolveConst(node.property);
        if (obj === undefined || key === undefined) return undefined;
        try {
          const v = obj[Object.prototype.hasOwnProperty.call(Object(obj), key) ? key : String(key)];
          return v === null || ['string', 'number', 'boolean'].includes(typeof v) ? v : undefined;
        } catch (e) { return undefined; }
      }
      const obj = resolveConst(node.object);
      const key = t.isIdentifier(node.property) ? node.property.name : resolveConst(node.property);
      if (obj === undefined || key === undefined) return undefined;
      try {
        const v = obj[key];
        return v === null || ['string', 'number', 'boolean'].includes(typeof v) ? v : undefined;
      } catch (e) { return undefined; }
    }
    default: return undefined;
  }
}

// Also allow these node types as call arguments.
function isConstArg(a) {
  if (t.isStringLiteral(a) || t.isNumericLiteral(a) || t.isBooleanLiteral(a) || t.isNullLiteral(a)) return true;
  if (t.isUnaryExpression(a) || t.isBinaryExpression(a) || t.isMemberExpression(a)) return true;
  return false;
}

function tryDecode(fnName, args) {
  // First try the pure AST evaluator. When it cannot resolve everything (an
  // identifier bound to a sandbox-hoisted const table, for instance), fall back
  // to evaluating the ORIGINAL expression text inside the sandbox, where those
  // tables are in scope. Only accept a string result — a non-string means the
  // expression is not a constant and the call is not safe to substitute.
  const pure = args.map(resolveConst);
  let vals = pure;
  if (pure.some(v => v === undefined)) {
    const texts = args.map(a => { try { return gen(a); } catch (e) { return null; } });
    if (texts.some(x => x === null)) return undefined;
    const src = fnName + '(' + texts.join(',') + ')';
    let res;
    try { res = vm.runInContext(src, ctx, { timeout: 400 }); } catch (e) { return undefined; }
    if (typeof res === 'string' && res.length > 0) return res;
    if (typeof res === 'number' || typeof res === 'boolean') return undefined;
    return undefined;
  }
  const expr = fnName + '(' + vals.map(v => JSON.stringify(v)).join(',') + ')';
  try {
    const res = vm.runInContext(expr, ctx, { timeout: 400 });
    if (typeof res === 'string' && res.length > 0) return res;
  } catch (e) { /* not a pure call */ }
  return undefined;
}

// ── Fixpoint loop: scan CallExpressions, replace with string literals ──
let totalDecoded = 0;
let rounds = 0;
const MAX_ROUNDS = 6;

for (; rounds < MAX_ROUNDS; rounds++) {
  let round = 0;
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (callee.type !== 'Identifier') return;
      if (!decoders.includes(callee.name)) return;
      const args = path.node.arguments;
      if (!args.every(isConstArg)) return;
      const s = tryDecode(callee.name, args);
      if (s === undefined) return;
      // Don't substitute huge blobs into tiny files — guard size
      if (s.length > 20000) return;
      path.replaceWith(t.stringLiteral(s));
      round++;
    }
  });
  if (round === 0) break;
  totalDecoded += round;
  if (V) console.log('[xor] round ' + (rounds + 1) + ': decoded ' + round);
}

if (totalDecoded === 0) bail('no strings decoded (0 calls resolved)');

// Rebuild and fold simple escapes
let out;
try {
  out = generate(ast, { compact: false, comments: true }).code;
  // Decode \xNN / \uNNNN that decoded strings may have produced
  out = out.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => {
    const ch = String.fromCharCode(parseInt(h, 16));
    return /[\x20-\x7e]/.test(ch) && ch !== '"' && ch !== "'" && ch !== '\\' ? ch : _;
  });
  out = out.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => {
    const ch = String.fromCharCode(parseInt(h, 16));
    return /[\x20-\x7e]/.test(ch) && ch !== '"' && ch !== "'" && ch !== '\\' ? ch : _;
  });
  // Fix stray placeholder: re-parse escapes inside string segments only
  const segs = []; let i = 0; const n = out.length;
  let last = 0; const FIX = '_';
} catch (e) { bail('generate failed: ' + e.message); }

try { new vm.Script(out); } catch (e) {
  if (V) console.log('[xor] output invalid: ' + e.message.slice(0, 80));
  bail('output syntax invalid');
}

emit(out, 'decoded=' + totalDecoded + ' rounds=' + (rounds) + ' decoders=' + decoders.length);
