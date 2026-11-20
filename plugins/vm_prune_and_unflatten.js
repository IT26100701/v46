#!/usr/bin/env node
/**
 * vm_prune_and_unflatten.js v3 — Stage pasca-semantic_unshim:
 * Otomatis menghapus sisa sampah obfuskasi:
 *   1. VM dispatcher block: `while (genFn11(X) !== N) { switch(...) {...} }`
 *   2. Fungsi helper yang HANYA dipakai di dalam dispatcher (mati setelah block dihapus)
 *   3. CJK/unicode property residue + DEAD marker
 *   4. Repair try/catch yang kehilangan body
 *
 * Gated: hanya menulis output jika hasilnya tetap valid syntax; jika tidak, kembalikan input asli.
 *
 * Usage: node plugins/vm_prune_and_unflatten.js <input.js> <output.js>
 */
const fs = require('fs');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  console.error('usage: vm_prune_and_unflatten.js <input.js> <output.js>');
  process.exit(1);
}

const originalSrc = fs.readFileSync(input, 'utf8');

function isDispatcherTest(test) {
  // while (genFn11(<anything>) !== <number>)
  return t.isBinaryExpression(test) && test.operator === '!==' &&
    t.isCallExpression(test.left) &&
    t.isIdentifier(test.left.callee) && test.left.callee.name === 'genFn11' &&
    t.isNumericLiteral(test.right);
}
function isDispatcherWhile(node) {
  return t.isWhileStatement(node) && isDispatcherTest(node.test);
}

// returns the nearest enclosing function path (incl. the path itself's fn), or null
function enclosingFunction(path) {
  let p = path.parentPath;
  while (p) {
    if (p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression()) return p;
    p = p.parentPath;
  }
  return null;
}

function withinDispatcherBlock(path) {
  let p = path;
  while (p) {
    if (isDispatcherWhile(p.node)) return true;
    p = p.parentPath;
  }
  return false;
}

function syntaxOk(code) {
  try { parser.parse(code, { sourceType: 'script', errorRecovery: false }); return true; }
  catch { return false; }
}

let ast;
try {
  ast = parser.parse(originalSrc, { sourceType: 'script', errorRecovery: true });
} catch (e) {
  console.error('[vm_prune] parse error:', e.message);
  fs.writeFileSync(output, originalSrc);
  process.exit(0);
}

// ── Pass 1: tally identifiers used OUTSIDE any dispatcher block ──
const refsOutside = new Set();
traverse(ast, {
  Identifier(path) {
    // ignore the declaration name itself
    const parent = path.parent;
    if ((t.isFunctionDeclaration(parent) && parent.id === path.node) ||
        (t.isVariableDeclarator(parent) && parent.id === path.node)) return;
    if (!withinDispatcherBlock(path.parentPath)) {
      refsOutside.add(path.node.name);
    }
  }
});

// ── Pass 2: find functions that contain dispatcher blocks ──
const fnsWithDispatcher = new Map(); // name -> { path, isTopLevel }
traverse(ast, {
  WhileStatement(path) {
    if (!isDispatcherWhile(path.node)) return;
    const fnPath = enclosingFunction(path);
    if (!fnPath) return;
    const id = fnPath.node.id;
    const name = id && t.isIdentifier(id) ? id.name
      : (fnPath.parentPath && t.isIdentifier(fnPath.parentPath.node.id) ? fnPath.parentPath.node.id.name : null);
    if (!name) return;
    if (!fnsWithDispatcher.has(name)) {
      fnsWithDispatcher.set(name, { path: fnPath, isTopLevel: fnPath.parentPath && fnPath.parentPath.isProgram() });
    }
  }
});

let prunedFns = 0, removedBlocks = 0;

// ── Pass 3: prune dead dispatcher functions; strip blocks from the rest ──
// Collect actions first, then apply, to avoid mid-traversal AST invalidation.
const removeFns = [];
const stripBlocks = [];

for (const [name, info] of fnsWithDispatcher) {
  const usedOutside = refsOutside.has(name);
  if (!usedOutside) {
    removeFns.push({ name, path: info.path });
  } else {
    info.path.traverse({
      WhileStatement(p) {
        if (isDispatcherWhile(p.node)) stripBlocks.push(p);
      }
    });
  }
}

for (const b of stripBlocks) {
  if (b.removed) continue;
  let inTry = false;
  let p = b.parentPath;
  while (p) { if (p.isTryStatement()) { inTry = true; break; } p = p.parentPath; }
  try { inTry ? b.replaceWith(t.emptyStatement()) : b.remove(); removedBlocks++; }
  catch { /* skip */ }
}
for (const f of removeFns) {
  try {
    if (f.path.removed) continue;
    // removing a FunctionDeclaration; if it's a VariableDeclarator init, remove the declarator
    if (f.path.parentPath && f.path.parentPath.isVariableDeclarator()) {
      const decl = f.path.parentPath.parentPath;
      if (decl.node.declarations && decl.node.declarations.length === 1) decl.remove();
      else f.path.parentPath.remove();
    } else {
      f.path.remove();
    }
    prunedFns++;
  } catch { /* skip */ }
}

let code = generate(ast, { compact: false, comments: false }).code;

// ── Pass 4: textual residue cleanup (safe, regex-level) ──
// CJK / Katakana / Hiragana / fullwidth property access residue: `.寶高...`
code = code.replace(/\.[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef\u3000-\u303f]+/g, '');
// leftover DEAD / OBF_MARKER tokens
code = code.replace(/\b(?:DEAD|OBF_MARKER)[\w]*/g, '');
// dispatcher loop residue if any survived (shouldn't, but defensive)
code = code.replace(/while\s*\(\s*genFn11\s*\([^)]*\)\s*!==\s*-?\d+\s*\)\s*\{\s*\}/g, '');
// empty try bodies
code = code.replace(/try\s*\{\s*\}\s*catch/g, 'try {} catch');
// collapse whitespace runs
code = code.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
// stray `, ;` / `;,` artifacts from removals
code = code.replace(/,\s*;/g, ';').replace(/;\s*,/g, ';');

if (!syntaxOk(code)) {
  console.error('[vm_prune] result invalid syntax — keeping input unchanged');
  fs.writeFileSync(output, originalSrc);
  process.exit(0);
}

fs.writeFileSync(output, code);
console.log(`[vm_prune] dispatcher fns pruned: ${prunedFns} | blocks stripped: ${removedBlocks}`);
console.log(`[vm_prune] output: ${output}`);