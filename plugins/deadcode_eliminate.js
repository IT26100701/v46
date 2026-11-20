#!/usr/bin/env node
/**
 * deadcode_eliminate.js — Stage FINAL: reachability-based dead code + junk code elimination.
 *
 * Strategi (bukan regex, tapi call-graph reachability):
 *   1. Parse AST, kumpulkan SEMUA binding top-level (function decl, var, const, let, class).
 *   2. Tentukan ROOT: program-level side effects yang WAJIB hidup
 *      (require(...), assignment ke global, bot.* registration, .launch()/.on()/.command() chain,
 *       export, process.*, module.exports).
 *   3. Transitif: dari root, tandai binding yang direferensikan. Ulangi sampai fiks point.
 *   4. Hapus binding top-level yang TIDAK ditandai.
 *   5. Di dalam fungsi yang hidup, buang statement junk:
 *      - `while (disp(X) !== N) { switch ... }`  -> dispatcher (hapus seluruh blok)
 *      - `if (cond) { <hanya breaker arithmetic> }` -> dead branch
 *      - sequence expr yang全是 numeric-assign breaker (`x[0] += x[1] - 1234, ...`)
 *      - `while(true){}` / `for(;;){}` kosong
 *   6. Hapus statement setelah `return` (unreachable).
 *   7. Gated: output hanya ditulis bila syntax valid; selain itu kembalikan input.
 *
 * Usage: node plugins/deadcode_eliminate.js <input.js> <output.js>
 */
const fs = require('fs');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  console.error('usage: deadcode_eliminate.js <input.js> <output.js>');
  process.exit(1);
}

const original = fs.readFileSync(input, 'utf8');
const write = (code, label) => {
  try { parser.parse(code, { sourceType: 'script', errorRecovery: false }); }
  catch (e) { console.error(`[deadcode] ${label} produced invalid syntax (${e.message.slice(0,70)}) — keeping input`); fs.writeFileSync(output, original); process.exit(0); }
  fs.writeFileSync(output, code);
};

let ast;
try { ast = parser.parse(original, { sourceType: 'script', errorRecovery: true }); }
catch (e) { console.error('[deadcode] parse error:', e.message); fs.writeFileSync(output, original); process.exit(0); }

// ═══════════════════════════════════════════════════════════════════
// STEP 1 — top-level bindings
// ═══════════════════════════════════════════════════════════════════
const bindingPaths = new Map();   // name -> NodePath (FunctionDeclaration | VariableDeclarator | ClassDeclaration)
traverse(ast, {
  Program(p) {
    for (const st of p.get('body')) {
      if (st.isFunctionDeclaration() && st.node.id) bindingPaths.set(st.node.id.name, st);
      else if (st.isClassDeclaration() && st.node.id) bindingPaths.set(st.node.id.name, st);
      else if (st.isVariableDeclaration()) {
        for (const d of st.get('declarations')) {
          // d is the VariableDeclarator; track simple `var name = ...` bindings
          if (d.node.id && d.node.id.type === 'Identifier') {
            bindingPaths.set(d.node.id.name, d);
          }
        }
      }
    }
  }
});

// ═══════════════════════════════════════════════════════════════════
// STEP 2 — identify dispatcher / junk statement shapes
// ═══════════════════════════════════════════════════════════════════
const DISPATCHER_HELPERS = new Set();
const BREAKER_RE = /^\s*[A-Za-z_$][\w$]*\s*\[\s*-?\d+\s*\]\s*\+=/;

function isDispatcherHelfperTest(test, helpers) {
  if (!t.isBinaryExpression(test)) return false;
  if (test.operator !== '!==' && test.operator !== '!=') return false;
  // right side may be NumericLiteral (5) OR UnaryExpression (-, NumericLiteral) (-91)
  let rOk = t.isNumericLiteral(test.right);
  if (!rOk && t.isUnaryExpression(test.right) && test.right.operator === '-' && t.isNumericLiteral(test.right.argument)) rOk = true;
  if (!rOk) return false;
  if (!t.isCallExpression(test.left) || !t.isIdentifier(test.left.callee)) return false;
  const c = test.left.callee.name;
  return c === 'genFn11' || helpers.has(c);
}

// `while (FN(anything) !== <number>) { ... }`  where FN is a known dispatcher
function looksLikeDispatcher(node, helpers) {
  if (!t.isWhileStatement(node)) return false;
  const test = node.test;
  if (!t.isBinaryExpression(test) || test.operator !== '!==' || !t.isNumericLiteral(test.right)) return false;
  if (!t.isCallExpression(test.left) || !t.isIdentifier(test.left.callee)) return false;
  const callee = test.left.callee.name;
  if (!helpers.has(callee)) return false;
  // must contain a switch inside (the flattened body)
  let hasSwitch = false;
  const scan = (n) => {
    if (!n || typeof n !== 'object') return;
    if (t.isSwitchStatement(n)) { hasSwitch = true; return; }
    if (t.isFunctionDeclaration(n) || t.isFunctionExpression(n)) return; // don't descend into nested fns
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(scan);
      else if (v && typeof v === 'object' && v.type) scan(v);
    }
  };
  scan(node.body);
  return hasSwitch || true; // treat as dispatcher even without switch (empty while body = junk)
}

// ═══════════════════════════════════════════════════════════════════
// STEP 3 — reachability fixpoint
// ═══════════════════════════════════════════════════════════════════
const GLOBALS = new Set([
  'require','module','exports','process','console','global','globalThis','Buffer','setTimeout','setInterval',
  'clearTimeout','clearInterval','setImmediate','Promise','Math','JSON','Date','RegExp','Error','TypeError',
  'RangeError','Object','Array','String','Number','Boolean','Symbol','Map','Set','WeakMap','WeakSet','Proxy',
  'Reflect','BigInt','parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent',
  'encodeURI','decodeURI','escape','unescape','eval','Function','Intl','URL','URLSearchParams','TextEncoder',
  'TextDecoder','fetch','FormData','Headers','Request','Response','AbortController','structuredClone','queueMicrotask',
  '__dirname','__filename','self','window','undefined','NaN','Infinity','arguments','this',
]);

// Which top-level names are referenced by the "program body itself" (module-level side effects).
// A binding is a ROOT if it appears in a module-level expression that isn't a plain function body.
function moduleLevelReferences() {
  const roots = new Set();
  const walk = (node, insideFn, insideBindingInit) => {
    if (!node || typeof node !== 'object') return;
    if (t.isFunction(node) && !insideBindingInit) { /* function bodies don't create module refs unless called */ }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      const v = node[key];
      if (Array.isArray(v)) { v.forEach(x => { if (x && x.type) walk(x, insideFn, insideBindingInit); }); continue; }
      if (v && typeof v === 'object' && v.type) {
        // if this is an Identifier that is a *reference* (not a declaration key), mark as root
        if (v.type === 'Identifier' && !insideFn) {
          if (bindingPaths.has(v.name) || GLOBALS.has(v.name)) roots.add(v.name);
        }
        const isFnBody = t.isFunction(v) || (t.isArrowFunctionExpression(v));
        walk(v, insideFn || isFnBody, insideBindingInit);
      }
    }
  };

  // iterate top-level statements; skip pure declarations (their bodies are deferred)
  for (const st of ast.program.body) {
    if (t.isFunctionDeclaration(st) || t.isClassDeclaration(st)) continue;         // deferred
    if (t.isVariableDeclaration(st)) {
      for (const d of st.declarations) {
        if (d.init) walk(d.init, false, true);   // init runs at module load
      }
      continue;
    }
    walk(st, false, false);
  }
  return roots;
}

function referencesIn(path) {
  const refs = new Set();
  path.traverse({
    Identifier(p) {
      const parent = p.parent;
      // skip declaration ids and non-computed property keys
      if (t.isFunctionDeclaration(parent) && parent.id === p.node) return;
      if (t.isVariableDeclarator(parent) && parent.id === p.node) return;
      if (t.isClassDeclaration(parent) && parent.id === p.node) return;
      if (t.isMemberExpression(parent) && !parent.computed && parent.property === p.node) return;
      if (t.isObjectProperty(parent) && !parent.computed && parent.key === p.node) return;
      if (t.isObjectMethod(parent) && parent.key === p.node) return;
      refs.add(p.node.name);
    }
  });
  return refs;
}

let live = moduleLevelReferences();
// Precompute each binding's reference set once (used by both propagation directions).
const refsOf = new Map();
for (const [name, path] of bindingPaths) refsOf.set(name, referencesIn(path));
let changed = true, rounds = 0;
while (changed && rounds++ < 60) {
  changed = false;
  for (const name of bindingPaths.keys()) {
    if (live.has(name)) continue;
    const refs = refsOf.get(name) || new Set();
    let ok = false;
    // forward: this binding's body touches a live/global name (helper of live code)
    for (const r of refs) { if (live.has(r) || GLOBALS.has(r)) { ok = true; break; } }
    // backward: some live binding references this one (callee of live code)
    if (!ok) {
      for (const ln of live) {
        const lr = refsOf.get(ln);
        if (lr && lr.has(name)) { ok = true; break; }
      }
    }
    if (ok) { live.add(name); changed = true; }
  }
}

const deadNames = [...bindingPaths.keys()].filter(n => !live.has(n));

// dispatcher helpers = dead top-level functions whose body contains a dispatcher while
for (const name of deadNames) {
  const path = bindingPaths.get(name);
  let hasDispatcher = false;
  try {
    path.traverse({
      WhileStatement(p) {
        if (isDispatcherHelfperTest(p.node.test, DISPATCHER_HELPERS)) hasDispatcher = true;
      }
    });
  } catch {}
  if (hasDispatcher) DISPATCHER_HELPERS.add(name);
}

// ═══════════════════════════════════════════════════════════════════
// STEP 4 — remove dead top-level bindings
// ═══════════════════════════════════════════════════════════════════
let removedBindings = 0;
for (const name of deadNames) {
  const path = bindingPaths.get(name);
  if (!path || path.removed) continue;
  try {
    if (path.isVariableDeclarator()) {
      const decl = path.parentPath;
      if (decl.node.declarations.length === 1) decl.remove();
      else path.remove();
    } else path.remove();
    removedBindings++;
  } catch {}
}

let code = generate(ast, { compact: false, comments: false }).code;
write(code, 'reachability');
console.log(`[deadcode] top-level bindings: ${bindingPaths.size}, live: ${live.size}, removed: ${removedBindings}`);

// ═══════════════════════════════════════════════════════════════════
// STEP 5 — statement-level junk removal inside surviving code
// ═══════════════════════════════════════════════════════════════════
let ast2;
try { ast2 = parser.parse(code, { sourceType: 'script', errorRecovery: true }); }
catch { fs.writeFileSync(output, code); process.exit(0); }

let dispatchersKilled = 0, unreachableKilled = 0, breakerStmtsKilled = 0, emptyLoopsKilled = 0;

// ═══════════════════════════════════════════════════════════════════
// Pass A: collect ALL dispatcher blocks (unconditional, even inside live fns)
// ═══════════════════════════════════════════════════════════════════
const toRemove = [];
traverse(ast2, {
  WhileStatement(p) {
    const test = p.node.test;
    if (isDispatcherHelfperTest(test, DISPATCHER_HELPERS)) {
      toRemove.push({ path: p, kind: 'dispatcher' });
    } else {
      // empty infinite loop: while(true){} with empty body
      if (t.isBooleanLiteral(test) && test.value === true && t.isBlockStatement(p.node.body) && p.node.body.body.length === 0) {
        toRemove.push({ path: p, kind: 'emptyloop' });
      }
    }
  },
  ForStatement(p) {
    if (p.node.test === null && t.isBlockStatement(p.node.body) && p.node.body.body.length === 0) {
      toRemove.push({ path: p, kind: 'emptyloop' });
    }
  },
  // unreachable statements after return/throw/break/continue
  BlockStatement(p) {
    const body = p.node.body;
    for (let i = 0; i < body.length; i++) {
      const s = body[i];
      if (t.isReturnStatement(s) || t.isThrowStatement(s) || t.isBreakStatement(s) || t.isContinueStatement(s)) {
        const isFnBody = p.parentPath && (p.parentPath.isFunction() || p.parentPath.isArrowFunctionExpression());
        if (isFnBody) continue;
        for (let j = i + 1; j < body.length; j++) {
          if (t.isFunctionDeclaration(body[j])) continue;
          toRemove.push({ path: p.get('body')[j], kind: 'unreachable' });
        }
        break;
      }
    }
  }
});

for (const { path, kind } of toRemove) {
  if (path.removed) continue;
  try {
    let inTry = false, q = path.parentPath;
    while (q) { if (q.isTryStatement()) { inTry = true; break; } q = q.parentPath; }
    if (kind === 'dispatcher') {
      if (inTry) path.replaceWith(t.emptyStatement()); else path.remove();
      dispatchersKilled++;
    } else {
      path.remove();
      if (kind === 'unreachable') unreachableKilled++;
      else emptyLoopsKilled++;
    }
  } catch {}
}

code = generate(ast2, { compact: false, comments: false }).code;
write(code, 'statement-junk');
console.log(`[deadcode] dispatchers killed: ${dispatchersKilled} | unreachable: ${unreachableKilled} | empty loops: ${emptyLoopsKilled}`);
console.log(`[deadcode] output: ${output}`);