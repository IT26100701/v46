#!/usr/bin/env node
'use strict';
/**
 * jsobf_string_table.js — String-table + wrapper-decoder family
 *
 * Detects:
 *   1. A large string array (>=30 elements, >=70% strings)
 *   2. A wrapper decoder (arrow/function referencing that array)
 *   3. Decoder calls with numeric/string literal args
 *
 * Resolves: loads top-level declarations into a vm sandbox, evaluates each
 *           decoder call, replaces with the primitive result.
 * Cleanup:  removes table + decoder declarations if no references remain.
 *
 * Usage: node jsobf_string_table.js <input.js> [output.js]
 */
const fs = require('fs');
const vm = require('vm');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3] || INPUT;
if (!INPUT) { console.error('Usage: node jsobf_string_table.js <input.js> [output.js]'); process.exit(1); }

const code = fs.readFileSync(INPUT, 'utf8');
let ast;
try {
  ast = parser.parse(code, {
    sourceType: 'unambiguous',
    errorRecovery: true,
    plugins: ['optionalChaining', 'nullishCoalescingOperator', 'logicalAssignment', 'topLevelAwait']
  });
} catch (e) {
  console.error('jsobf_string_table: parse failed: ' + e.message);
  fs.writeFileSync(OUTPUT, code);
  process.exit(0);
}

// ── 1. Find large string tables ──────────────────────────────────────────
const tables = [];
traverse(ast, {
  VariableDeclarator(path) {
    if (!t.isIdentifier(path.node.id)) return;
    const init = path.node.init;
    if (!t.isArrayExpression(init)) return;
    const els = init.elements;
    if (els.length < 30) return;
    const strCount = els.filter(e => e && t.isStringLiteral(e)).length;
    if (strCount < els.length * 0.7) return;
    tables.push({ name: path.node.id.name, size: els.length });
  }
});

if (!tables.length) {
  console.log('jsobf_string_table: no string table found, keep original');
  fs.writeFileSync(OUTPUT, code);
  process.exit(0);
}
console.log('jsobf_string_table: tables=' + tables.map(tb => tb.name + '(' + tb.size + ')').join(','));

// ── 2. Find wrapper decoders (functions referencing a table) ─────────────
const tableNames = new Set(tables.map(tb => tb.name));
const decSet = new Set();

// Collect all top-level named functions (declaration, var-with-function-init,
// or bare `name = () => {}` assignment — obfuscators use all three shapes)
const allFuncs = [];
function pushFunc(name, node) {
  if (t.isIdentifier(name)) allFuncs.push({ name: name.name, node });
}
traverse(ast, {
  FunctionDeclaration(path) { pushFunc(path.node.id, path.node); },
  VariableDeclarator(path) {
    const init = path.node.init;
    if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) pushFunc(path.node.id, init);
  },
  AssignmentExpression(path) {
    const rhs = path.node.right;
    if ((t.isArrowFunctionExpression(rhs) || t.isFunctionExpression(rhs)) && t.isIdentifier(path.node.left)) {
      pushFunc(path.node.left, rhs);
    }
  }
});

// The decoder is usually a CHAIN: base decoder reads the table, then a thin
// wrapper with default params (CACHE, ROTATE) delegates to it, then a third
// one delegates to that. One pass only finds the base; iterate to a fixpoint
// so every layer of the chain gets included.
let grew = true;
while (grew) {
  grew = false;
  for (const fn of allFuncs) {
    if (decSet.has(fn.name)) continue;
    let src;
    try { src = generate(fn.node).code; } catch (e) { continue; }
    if ([...tableNames].some(tn => src.includes(tn)) ||
        [...decSet].some(dn => src.includes(dn))) {
      decSet.add(fn.name);
      grew = true;
    }
  }
}

if (!decSet.size) {
  console.log('jsobf_string_table: no wrapper decoder found, keep original');
  fs.writeFileSync(OUTPUT, code);
  process.exit(0);
}
console.log('jsobf_string_table: decoders=' + decSet.size + ' ' + [...decSet].slice(0, 6).join(',') +
            (decSet.size > 6 ? ',...' : ''));

// ── 3. Build sandbox — execute top-level statements, skip loops ─────────
// Loops matter: the anti-debug decoy is `while(true){x=x;if(!x)break}` and the
// self-defending guard is a `for(;;)`, both of which hang the sandbox. The
// decoder chain itself is all top-level declarations, so skipping loop
// statements is safe and keeps execution bounded.
const sandbox = {};
const ctx = vm.createContext(sandbox);

const topCode = [];
traverse(ast, {
  Program(path) {
    for (const stmt of path.node.body) {
      if (t.isWhileStatement(stmt) || t.isDoWhileStatement(stmt) || t.isForStatement(stmt) ||
          t.isForInStatement(stmt) || t.isForOfStatement(stmt)) continue;
      if (t.isExpressionStatement(stmt) && t.isCallExpression(stmt.expression)) {
        const callee = stmt.expression.callee;
        if (t.isIdentifier(callee) && decSet.has(callee.name)) continue;
      }
      topCode.push(generate(stmt).code);
    }
    path.stop();
  }
});

let sandboxOk = 0, sandboxFail = 0;
for (const line of topCode) {
  try { vm.runInContext(line, ctx, { timeout: 3000 }); sandboxOk++; }
  catch (e) { sandboxFail++; }
}
console.log('jsobf_string_table: sandbox=' + sandboxOk + ' ok, ' + sandboxFail + ' fail');

// ── ensure common global fallbacks ────────────────────────────────
// Some decoders call `seren11(...args)` where seren11 is bound via
// `eval("this")` at runtime (i.e. `String`). If the sandbox does not
// have it, bind the obvious fallback so `VH06RcqsaPo(...)` can resolve.
try {
  const prelude = [
    'var String = globalThis.String;',
    'var TextDecoder = globalThis.TextDecoder;',
    'var Uint8Array = globalThis.Uint8Array;',
    'var Buffer = globalThis.Buffer;',
    'var result = function(x){return x;};'
  ].join('\n');
  vm.runInContext(prelude, ctx, { timeout: 100 });
} catch (e) {}

// ── 4. Resolve decoder calls ─────────────────────────────────────────────
let resolved = 0, failed = 0;
const cache = new Map();

// Helper: convert comma-separated byte string "99,97,108,108" -> "call"
function bytesToString(byteStr) {
  if (typeof byteStr !== 'string') return byteStr;
  // Check if it looks like comma-separated numbers
  if (!/^\d+(,\d+)+$/.test(byteStr)) return byteStr;
  const bytes = byteStr.split(',').map(n => parseInt(n, 10));
  // Validate: all must be 0-255
  if (!bytes.every(b => b >= 0 && b <= 255)) return byteStr;
  // Convert to string
  return String.fromCharCode(...bytes);
}

traverse(ast, {
  CallExpression(path) {
    const callee = path.node.callee;
    // Normal decoder call: callee is Identifier in decSet
    // .apply/.call: callee is MemberExpression (obj.apply/call) where obj in decSet
    let baseName = null;
    let isApply = false, isCall = false;
    if (t.isIdentifier(callee)) {
      if (!decSet.has(callee.name)) return;
      baseName = callee.name;
    } else if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) &&
               t.isIdentifier(callee.property) &&
               (callee.property.name === 'apply' || callee.property.name === 'call')) {
      if (!decSet.has(callee.object.name)) return;
      baseName = callee.object.name;
      if (callee.property.name === 'apply') isApply = true;
      else isCall = true;
    } else return;
    const args = path.node.arguments;
    if (args.length < 1) return;

    // Determine the first argument value (literal or sandbox-evaluated)
    // Support .apply(undefined, [idx]) and .call(undefined, idx) patterns
    let argVal;
    if (isApply) {
      const arr = args[1];
      if (!t.isArrayExpression(arr) || arr.elements.length !== 1) return;
      const el = arr.elements[0];
      if (t.isNumericLiteral(el)) argVal = el.value;
      else if (t.isStringLiteral(el)) argVal = el.value;
      else return;
    } else if (isCall) {
      if (args.length < 2) return;
      if (t.isNumericLiteral(args[1])) argVal = args[1].value;
      else if (t.isStringLiteral(args[1])) argVal = args[1].value;
      else return;
    } else if (t.isNumericLiteral(args[0])) argVal = args[0].value;
    else if (t.isStringLiteral(args[0])) argVal = args[0].value;
    else {
      try {
        const argSrc = generate(args[0]).code;
        const v = vm.runInContext(argSrc, ctx, { timeout: 500 });
        if (typeof v !== 'number' && typeof v !== 'string') return;
        argVal = v;
      } catch (e) { return; }
    }

    // Skip if callee is not actually a function in the sandbox
    if (typeof ctx[baseName] !== 'function') return;

    const key = baseName + '(' + JSON.stringify(argVal) + ')';
    if (cache.has(key)) {
      path.replaceWith(t.cloneNode(cache.get(key)));
      resolved++;
      return;
    }

    try {
      const lit = typeof argVal === 'number' ? t.numericLiteral(argVal) : t.stringLiteral(argVal);
      const src = generate(t.callExpression(t.identifier(baseName), [lit])).code;
      let result = vm.runInContext(src, ctx, { timeout: 500 });

      // Post-process: if result looks like comma-separated bytes, convert to string
      if (typeof result === 'string') {
        result = bytesToString(result);
      }

      let node;
      if (typeof result === 'string') {
        node = t.stringLiteral(result);
      } else if (typeof result === 'number') {
        node = t.numericLiteral(result);
      } else if (typeof result === 'boolean') {
        node = t.booleanLiteral(result);
      } else if (Array.isArray(result)) {
        const s = String.fromCharCode(...result.filter(b => b >= 0 && b <= 255));
        node = t.stringLiteral(s);
      } else { failed++; }

      if (node) {
        // .apply(undefined, [idx]) / .call(undefined, idx) return the value directly
        path.replaceWith(t.cloneNode(node));
        cache.set(key, node);
        resolved++;
      }
    } catch (e) { failed++; if (failed <= 3) console.log('  [debug] ' + baseName + '(' + JSON.stringify(argVal) + ') -> ' + e.message.slice(0, 90)); }
  }
});

console.log('jsobf_string_table: resolved=' + resolved + ' failed=' + failed);

if (resolved === 0) {
  console.log('jsobf_string_table: no calls resolved, keep original');
  fs.writeFileSync(OUTPUT, code);
  process.exit(0);
}

// ── 5. Remove unused tables and decoders ─────────────────────────────────
try {
  const freshSrc = generate(ast, { comments: true, compact: false }).code;
  const freshAst = parser.parse(freshSrc, { sourceType: 'unambiguous', errorRecovery: true });

  const refCounts = {};
  traverse(freshAst, {
    Identifier(path) {
      const name = path.node.name;
      if (!decSet.has(name) && !tableNames.has(name)) return;
      if (path.parentPath.isVariableDeclarator() && path.parentPath.node.id === path.node) return;
      if (path.parentPath.isFunctionDeclaration() && path.parentPath.node.id === path.node) return;
      refCounts[name] = (Object.prototype.hasOwnProperty.call(refCounts, name) ? refCounts[name] : 0) + 1;
    }
  });

  const toRemove = [];
  traverse(freshAst, {
    VariableDeclarator(path) {
      const name = path.node.id && path.node.id.name;
      if (name && (decSet.has(name) || tableNames.has(name)) && !Object.prototype.hasOwnProperty.call(refCounts, name)) toRemove.push(path.parentPath);
    },
    FunctionDeclaration(path) {
      const name = path.node.id && path.node.id.name;
      if (name && decSet.has(name) && !Object.prototype.hasOwnProperty.call(refCounts, name)) toRemove.push(path);
    }
  });
  for (const p of toRemove) { try { p.remove(); } catch (e) {} }

  const output = generate(freshAst, { comments: true, compact: false }).code;
  fs.writeFileSync(OUTPUT, output);
  console.log('jsobf_string_table: removed=' + toRemove.length + ' unused decls, output=' + output.length + ' chars');
} catch (e) {
  const output = generate(ast, { comments: true, compact: false }).code;
  fs.writeFileSync(OUTPUT, output);
  console.log('jsobf_string_table: cleanup skipped (' + e.message + '), output=' + output.length + ' chars');
}
