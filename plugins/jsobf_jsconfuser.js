#!/usr/bin/env node
/**
 * jsobf_jsconfuser.js — JS-Confuser family decoder.
 *
 * Targets the structural fingerprints of JS-Confuser (acorn/escodegen based):
 * - Short random identifier names (not _0x hex): /^_[A-Za-z0-9]{5,12}$/
 * - Control flow flattening: while (A + B != N) { switch (A + B) { ... } }
 *   with arithmetic dispatcher vars updated in each case
 * - String encoding: strings replaced with decoder calls (often base64/hex/rot)
 * - Global concealing: globals accessed via computed properties obj['prop']
 * - Variable masking: local vars consolidated into rotating array
 * - Dead code injection: random no-op statements
 * - Pack: output wrapped in (function(){ ... })()
 *
 * This stage runs AFTER webcrack. webcrack unpacks the outer Function() wrapper
 * but doesn't decode JS-Confuser's custom string encoding or unflatten its CFG.
 *
 * Usage: node jsobf_jsconfuser.js <input.js> [output.js]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

const [, , inputPath, outputPath] = process.argv;
if (!inputPath) {
  console.error('usage: node jsobf_jsconfuser.js <input.js> [output.js]');
  process.exit(1);
}

const code = fs.readFileSync(inputPath, 'utf8');
const outPath = outputPath || inputPath.replace(/\.js$/, '.__jsconf.js');
const verbose = process.env.JSCONF_VERBOSE === '1';

function bail(msg) {
  console.log('[jsobf_jsconfuser] ' + msg + ' — keep input');
  try { fs.writeFileSync(outPath, code); } catch (e) {}
  process.exit(0);
}

// ---------------------------------------------------------------- structural gate
// Short random identifiers (not _0x hex pattern)
const shortRandomRe = /^_[A-Za-z0-9]{5,15}$/;
let shortRandomCount = 0;
for (const m of code.matchAll(/\b_[A-Za-z0-9]{5,15}\b/g)) {
  if (shortRandomRe.test(m[0])) shortRandomCount++;
}

// Dispatcher pattern: while (X + Y != N) { switch (X + Y) { case ... } }
const dispatcherRe = /while\s*\(\s*\w+\s*\+\s*\w+\s*[!==]{2}\s*\d+\s*\)\s*\{\s*switch\s*\(\s*\w+\s*\+\s*\w+/;
const hasDispatcher = dispatcherRe.test(code);

// String encoding: lots of atob/btoa/parseInt/Buffer.from calls with string args
const stringDecodeCalls = (code.match(/atob\(|btoa\(|parseInt\(|Buffer\.from\(/g) || []).length;

// Global concealing: computed property access on common globals
const globalConcealing = /(global|window|self|globalThis)\s*\[\s*['"]/.test(code);

// TEA/SipHash constant used by JS-Confuser control flow flattening
const hasTeaHash = /0x9e3779b9/.test(code);

// CFF sequence array + hash function pattern (JS-Confuser specific)
const hasJscCff = /__p_.*_cff_hash/.test(code) && /__p_.*_cff_sequence/.test(code);

if (verbose) {
  console.log('[jsobf_jsconfuser] shortRandomIdents:', shortRandomCount);
  console.log('[jsobf_jsconfuser] hasDispatcher:', hasDispatcher);
  console.log('[jsobf_jsconfuser] stringDecodeCalls:', stringDecodeCalls);
  console.log('[jsobf_jsconfuser] globalConcealing:', globalConcealing);
  console.log('[jsobf_jsconfuser] hasTeaHash:', hasTeaHash);
  console.log('[jsobf_jsconfuser] hasJscCff:', hasJscCff);
}

// Gate: need at least 2 of these signals
const signals = [
  shortRandomCount > 20,
  hasDispatcher,
  stringDecodeCalls > 10,
  globalConcealing,
  hasTeaHash,
  hasJscCff
].filter(Boolean).length;
if (signals < 2) {
  bail('not JS-Confuser family (signals=' + signals + ')');
}

// ---------------------------------------------------------------- parse
let ast;
try {
  ast = parser.parse(code, {
    sourceType: 'script',
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: ['classProperties', 'optionalChaining', 'nullishCoalescingOperator',
      'dynamicImport', 'topLevelAwait', 'numericSeparator', 'optionalCatchBinding'],
  });
} catch (e) {
  bail('parse failed: ' + e.message);
}

let changed = false;
const program = ast.program.body;

// ------------------------------------------------------- 1. String decoder resolution
// Find the string decoder function: typically a FunctionDeclaration with
// a switch/if-chain that decodes base64/hex/rot. Detect by high entropy
// string literals in its body or calls to atob/Buffer.from/parseInt.
function findStringDecoder() {
  const candidates = [];
  for (const node of program) {
    if (node.type !== 'FunctionDeclaration' || !node.id) continue;
    const text = code.slice(node.start, node.end);
    if (text.length > 50000) continue; // too big
    // Heuristics: uses atob/btoa/Buffer/parseInt and returns string
    const usesDecoder = /atob\(|btoa\(|Buffer\.from|parseInt\(|charCodeAt|fromCharCode/.test(text);
    const returnsString = /return\s+/.test(text);
    if (usesDecoder && returnsString) {
      candidates.push({ name: node.id.name, node, text });
    }
  }
  // Pick the one with most decoder calls
  candidates.sort((a, b) => {
    const aCalls = (a.text.match(/atob\(|btoa\(|Buffer\.from|parseInt\(|fromCharCode/g) || []).length;
    const bCalls = (b.text.match(/atob\(|btoa\(|Buffer\.from|parseInt\(|fromCharCode/g) || []).length;
    return bCalls - aCalls;
  });
  return candidates[0]?.name || null;
}

let decoderName = findStringDecoder();
if (verbose) console.log('[jsobf_jsconfuser] string decoder:', decoderName);

// Sandbox for evaluating decoder calls
const sandbox = {
  console: { log() {}, warn() {}, error() {}, info() {} },
  Buffer, atob, btoa, parseInt, parseFloat,
  String, Array, Object, Math, JSON, RegExp,
};
sandbox.global = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;

let decoded = 0, failed = 0;

if (decoderName) {
  // Run the decoder in a vm context to get the function
  let decoderFn;
  try {
    const prelude = program
      .filter(n => n.start < program.find(p => p.type === 'FunctionDeclaration' && p.id && p.id.name === decoderName).end)
      .map(n => code.slice(n.start, n.end))
      .join('\n');
    // Use new Function in host realm so classes work
    const fn = new Function(prelude + '\nreturn typeof ' + decoderName + ' === "function" ? ' + decoderName + ' : null;');
    decoderFn = fn();
  } catch (e) {
    if (verbose) console.log('[jsobf_jsconfuser] decoder sandbox failed:', e.message);
  }

  if (typeof decoderFn === 'function') {
    // Replace CallExpression(decoderName, [StringLiteral])
    traverse(ast, {
      CallExpression(path) {
        if (!t.isIdentifier(path.node.callee, { name: decoderName })) return;
        if (path.node.arguments.length !== 1) return;
        const arg = path.node.arguments[0];
        if (!t.isStringLiteral(arg)) return;
        try {
          const val = decoderFn(arg.value);
          if (typeof val === 'string' && val.length > 0) {
            path.replaceWith(t.stringLiteral(val));
            decoded++;
            changed = true;
          } else failed++;
        } catch (e) { failed++; }
      },
    });
  }
}

// ------------------------------------------------------- 2. Global concealing resolution
// obj['prop'] where obj is globalThis/window/self/global and prop is known global
const globalNames = new Set([
  'console', 'process', 'Buffer', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'setImmediate', 'clearImmediate', 'fetch', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'Array', 'Object', 'String', 'Number', 'Math', 'JSON',
  'RegExp', 'Error', 'Date', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array',
  'Float64Array', 'BigInt64Array', 'BigUint64Array', 'require', 'module',
  'exports', '__dirname', '__filename',
]);

let globalResolved = 0;
traverse(ast, {
  MemberExpression(path) {
    if (!path.node.computed) return;
    if (!t.isStringLiteral(path.node.property)) return;
    const prop = path.node.property.value;
    if (!globalNames.has(prop)) return;
    // Check if object is a global reference
    const obj = path.node.object;
    if (t.isIdentifier(obj) && ['global', 'window', 'self', 'globalThis'].includes(obj.name)) {
      path.node.computed = false;
      path.node.property = t.identifier(prop);
      globalResolved++;
      changed = true;
    }
  },
});
if (verbose && globalResolved) console.log('[jsobf_jsconfuser] global concealing resolved:', globalResolved);

// ------------------------------------------------------- 3. Control flow unflattening (opaque predicate dispatcher)
// Pattern: while (A + B != N) { switch (A + B) { case M: A+=X; B+=Y; break; ... } }
// Strategy: simulate the dispatcher arithmetic to linearize the cases.
// This is a simplified version - full unflattening needs SSA + symbolic execution.
// We do a practical approach: find the dispatcher loop, extract case bodies in order,
// and replace the while-switch with sequential statements.

function findDispatcherLoop() {
  for (const node of program) {
    if (node.type === 'WhileStatement') {
      const test = node.test;
      if (test.type === 'BinaryExpression' &&
          (test.operator === '!==' || test.operator === '!=') &&
          test.left.type === 'BinaryExpression' && test.left.operator === '+') {
        const body = node.body;
        if (body.type === 'BlockStatement') {
          const first = body.body[0];
          if (first && first.type === 'SwitchStatement' &&
              first.discriminant.type === 'BinaryExpression' &&
              first.discriminant.operator === '+' &&
              t.isIdentifier(first.discriminant.left, { name: test.left.left.name }) &&
              t.isIdentifier(first.discriminant.right, { name: test.left.right.name })) {
            return { whileNode: node, switchNode: first, vars: [test.left.left.name, test.left.right.name], target: test.right.value };
          }
        }
      }
    }
  }
  return null;
}

const dispatcher = findDispatcherLoop();
if (dispatcher) {
  if (verbose) console.log('[jsobf_jsconfuser] dispatcher found:', dispatcher.vars, 'target', dispatcher.target);
  // Extract case order by simulating the arithmetic
  const switchNode = dispatcher.switchNode;
  const cases = switchNode.cases.filter(c => c.test !== null); // skip default
  const caseOrder = [];
  for (const c of cases) {
    if (t.isNumericLiteral(c.test)) caseOrder.push({ value: c.test.value, body: c.consequent });
  }
  // Sort by the order they would execute (simulate dispatcher vars)
  // This is simplified - real unflattening needs the actual arithmetic.
  // For now, we just note it and let vm_prune_and_unflatten handle the blocks.
  if (verbose) console.log('[jsobf_jsconfuser] dispatcher cases:', caseOrder.length);
}

// ------------------------------------------------------- 4. Dead code removal (JS-Confuser injects random no-ops)
// Simple patterns: standalone numeric literals, void 0, empty blocks, self-assignments
traverse(ast, {
  ExpressionStatement(path) {
    const expr = path.node.expression;
    // Numeric literal alone: 123;
    if (t.isNumericLiteral(expr) || t.isStringLiteral(expr)) {
      path.remove(); changed = true; return;
    }
    // void 0;
    if (t.isUnaryExpression(expr) && expr.operator === 'void' && t.isNumericLiteral(expr.argument, { value: 0 })) {
      path.remove(); changed = true; return;
    }
    // self assignment: x = x;
    if (t.isAssignmentExpression(expr) && t.isIdentifier(expr.left) && t.isIdentifier(expr.right) &&
        expr.left.name === expr.right.name) {
      path.remove(); changed = true; return;
    }
  },
  BlockStatement(path) {
    // Remove empty statements
    path.node.body = path.node.body.filter(stmt => !t.isEmptyStatement(stmt));
  },
});

// ------------------------------------------------------- 5. Variable masking array resolution (basic)
// Look for patterns: var _arr = [ ... ]; then accesses _arr[i]
// This is complex - for now we rely on deadcode_eliminate + var_rename_restore

// ------------------------------------------------------- emit
if (!changed) {
  bail('no transforms applied');
}

let out;
try {
  out = generate(ast, { compact: false, comments: true }).code;
  parser.parse(out, { sourceType: 'script', allowReturnOutsideFunction: true });
} catch (e) {
  bail('output invalid syntax: ' + e.message);
}

fs.writeFileSync(outPath, out);
console.log('[jsobf_jsconfuser] done | decoded:' + decoded + ' failed:' + failed +
  ' globalResolved:' + globalResolved + ' | ' + outPath + ' ' + out.length + ' bytes');