#!/usr/bin/env node
/**
 * cff_hard_unroll.js — Hard CFF unroller (execution-trace based).
 *
 * Handles every major dispatcher family:
 *
 *  A. Template-CFF (JS-Confuser):  while(SUM(states) !== N) { switch(SUM(states)) {...} }
 *     where `states` is an array threaded through the cases. Decoded by INSTRUMENTING
 *     the switch to record a states snapshot per iteration, EXECUTING the reconstruction
 *     in a sandbox, recovering the execution order, then emitting each executed case
 *     body with its live state values folded in and helper calls constant-evaluated.
 *
 *  B. Sequence-CFF (obfuscator.io): while(!![]) { switch(SEQ[idx++]) {...} }
 *     Decoded by evaluating SEQ and emitting cases in index order.
 *
 *  C. ktech-CFF:                   while(f(x) !== CONST) { switch(f(x)) {...} }
 *     Decoded by symbolic state simulation.
 *
 * Usage: node cff_hard_unroll.js <input.js> [output.js]
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3] || (INPUT ? INPUT.replace(/\.js$/, '.cff-unrolled.js') : 'out.js');
if (!INPUT) { console.error('Usage: node cff_hard_unroll.js <input.js> [output.js]'); process.exit(1); }
const code = fs.readFileSync(INPUT, 'utf8');
const V = process.env.CFF_VERBOSE === '1';

function emit(out, note) {
  fs.writeFileSync(OUTPUT, out);
  console.log('[cff_hard_unroll] ' + note + ' | ' + OUTPUT + ' (' + out.length + ' bytes)');
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

const gen = (n, o) => generate(n, Object.assign({ compact: true }, o)).code;

// ── Extract helper functions into a sandbox (must be pure, no side effects) ──
function buildSandbox() {
  const top = [];
  for (const node of ast.program.body) {
    if (node.type === 'FunctionDeclaration' && node.id) top.push(gen(node));
    else if (node.type === 'VariableDeclaration') {
      const g = gen(node);
      if (g.length < 300000) top.push(g);
    }
  }
  const sb = {
    console: { log(){}, warn(){}, error(){}, info(){}, debug(){} },
    Math, parseInt, parseFloat, String, Number, Array, Object, JSON, RegExp, Date, Boolean,
    Buffer, process: { env: {}, platform: 'linux', argv: ['node'], nextTick: (f)=>f && f() },
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    require: () => new Proxy({}, { get: () => () => undefined }),
    setTimeout: (f) => 0, clearTimeout(){}, setInterval: () => 0, clearInterval(){},
  };
  sb.globalThis = sb; sb.window = sb; sb.self = sb; sb.global = sb;
  const ctx = vm.createContext(sb);
  try { vm.runInContext(top.join('\n'), ctx, { timeout: 15000 }); }
  catch (e) { if (V) console.log('[cff] sandbox load: ' + e.message.slice(0, 90)); }
  return ctx;
}
const ctx = buildSandbox();
const evalIn = (srcStr, ms) => { try { return vm.runInContext(srcStr, ctx, { timeout: ms || 800 }); } catch (e) { return undefined; } };
const evalNode = (n) => evalIn('(' + gen(n) + ')', 800);

// ── Identify template dispatchers ──
// Find the states variable name inside a `while(SUM(states) !== N)` test.
function findStatesVar(test) {
  if (!test || test.type !== 'BinaryExpression') return null;
  for (const side of [test.left, test.right]) {
    if (side && side.type === 'CallExpression' && side.arguments[0]) {
      const a0 = side.arguments[0];
      // the traced state container can be a plain identifier (top-level CFF) or
      // a member expression (a nested dispatcher holding its own state array,
      // e.g. `scope._hrodZ9.M818Aij`). Accept both, keyed by generated text.
      if (a0.type === 'Identifier' || a0.type === 'MemberExpression') {
        return { sumFn: side.callee, statesVar: a0, statesName: (a0.type === 'Identifier' ? a0.name : null), statesText: gen(a0), sumName: side.callee.type === 'Identifier' ? side.callee.name : null };
      }
    }
  }
  return null;
}

let unrolled = 0, totalBodies = 0;

// Gather all dispatcher while-loops (anywhere, including nested)
const dispatchers = [];
traverse(ast, {
  WhileStatement(path) {
    const test = path.node.test;
    if (!test) return;
    // find switch
    let sw = null;
    const b = path.node.body;
    if (b.type === 'SwitchStatement') sw = b;
    else if (b.type === 'BlockStatement') for (const s of b.body) if (s.type === 'SwitchStatement') { sw = s; break; }
    if (!sw || sw.cases.length < 3) return;
    const sv = findStatesVar(test);
    // exit constant
    let exitConst = undefined;
    if (test.type === 'BinaryExpression' && (test.operator === '!==' || test.operator === '!=')) {
      exitConst = evalNode(test.right);
    }
    dispatchers.push({ path, sw, sv, exitConst, test });
  }
});
if (V) console.log('[cff] dispatchers found:', dispatchers.length);

// ── Template-CFF via execution trace ──
// Instrument each template dispatcher: tag its switch with a unique id and record
// a states snapshot per switch evaluation. Then run the whole program in the sandbox.
// Any dispatcher with a traceable state container qualifies. The exit
// constant may itself be an expression over the state array (nested CFF).
const traced = dispatchers.filter(d => d.sv && d.sv.statesVar);

let traceMap = null;
if (traced.length) {
  // Build instrumented copy of the program (do NOT touch the original ast yet).
  const instAst = parser.parse(code, {
    sourceType: 'script', errorRecovery: true, allowReturnOutsideFunction: true,
    plugins: ['classProperties', 'optionalChaining', 'nullishCoalescingOperator',
      'dynamicImport', 'topLevelAwait', 'numericSeparator', 'optionalCatchBinding'],
  });
  const tagIds = new Map(); // whileNode -> id  (match by order)
  let instIdx = 0;
  const instDispatchers = [];
  traverse(instAst, {
    WhileStatement(path) {
      const test = path.node.test;
      if (!test) return;
      let sw = null;
      const b = path.node.body;
      if (b.type === 'SwitchStatement') sw = b;
      else if (b.type === 'BlockStatement') for (const s of b.body) if (s.type === 'SwitchStatement') { sw = s; break; }
      if (!sw || sw.cases.length < 3) return;
      const sv = findStatesVar(test);
      if (!sv || !sv.statesVar) return;
      const id = instIdx++;
      instDispatchers.push(id);
      // instrument: switch( (TR[id].push(STATES.slice()), DISC) )
      const stVar = sv.statesText;   // generated source text of the state container
      const pushCall = t.callExpression(
        t.memberExpression(t.memberExpression(t.identifier('__CFF_TR__'), t.numericLiteral(id), true), t.identifier('push')),
        [t.callExpression(t.memberExpression(t.identifier(stVar), t.identifier('slice')), [])]
      );
      const seq = t.sequenceExpression([pushCall, sw.discriminant]);
      sw.discriminant = seq;
    }
  });
  // prepend trace container
  const tracerDecl = parser.parse('var __CFF_TR__ = [];').program.body[0];
  // initialize arrays  (declaration MUST come first, then the init loop)
  const initArr = parser.parse('for (var __i=0; __i<' + Math.max(1, instIdx) + '; __i++) __CFF_TR__[__i] = [];').program.body;
  instAst.program.body.unshift(tracerDecl, ...initArr);

  let instCode;
  try { instCode = generate(instAst, { compact: true }).code; } catch (e) { instCode = null; }

  if (instCode) {
    // Run the instrumented program: prefer running only the top-level reconstruction.
    const runCtx = vm.createContext({
      console: { log(){}, warn(){}, error(){}, info(){}, debug(){} },
      Math, parseInt, parseFloat, String, Number, Array, Object, JSON, RegExp, Date, Boolean,
      Buffer, process: { env: {}, platform: 'linux', argv: ['node'], nextTick: (f)=>f && f() },
      require: () => new Proxy({}, { get: () => () => undefined }),
      setTimeout: (f) => 0, clearTimeout(){}, setInterval: () => 0, clearInterval(){},
      fetch: () => Promise.reject(new Error('x')),
    });
    runCtx.globalThis = runCtx; runCtx.window = runCtx; runCtx.self = runCtx; runCtx.global = runCtx;
    try { vm.runInContext(instCode, runCtx, { timeout: 30000 }); } catch (e) { if (V) console.log('[cff] trace run stopped: ' + e.message.slice(0,100)); }
    traceMap = runCtx.__CFF_TR__ || [];
    if (V) console.log('[cff] trace lengths:', Array.isArray(traceMap) ? traceMap.map(a=>a.length).join(',') : 'none');
  }
}

// ── For each template dispatcher, recover execution order from its trace ──
// ── For each template dispatcher, recover execution order from its trace ──
// A nested dispatcher's case tests reference BOTH its own state container and
// the enclosing function's state array, so every container seen anywhere in the
// file gets bound (to its latest snapshot) when a case test is evaluated.
const containerSnaps = new Map();  // statesText -> snapshot array (latest seen)
function rememberSnapshots() {
  if (!Array.isArray(traceMap)) return;
  for (let i = 0; i < dispatchers.length; i++) {
    const snaps = traceMap[i];
    if (!Array.isArray(snaps) || !snaps.length) continue;
    const d = dispatchers[i];
    if (!d.sv || !d.sv.statesText) continue;
    containerSnaps.set(d.sv.statesText, snaps[snaps.length - 1]);
  }
}
function recoverOrder(disp, snapshots) {
  // snapshots: state arrays in the order each switch evaluation happened.
  // The case that ran at step k is the one whose test === sum(snapshots[k]).
  const statesVar = disp.sv.statesText;
  const sw = disp.sw;
  const order = [];
  const caseMap = new Map();
  for (const c of sw.cases) {
    if (!c.test) continue;
    const v = evalCaseTest(c.test, statesVar, snapshots[0]);
    if (v !== undefined) caseMap.set(v, c);
  }
  for (let k = 0; k < snapshots.length; k++) {
    const snap = snapshots[k];
    containerSnaps.set(statesVar, snap);
    const discv = evalCaseTest(sw.discriminant, statesVar, snap);
    if (discv === undefined) continue;
    const c = caseMap.get(discv);
    if (c) order.push({ case: c, snap });
  }
  return order;
}
function evalCaseTest(node, statesVar, snap) {
  try {
    const expr = gen(node);
    // ctx already holds the CFF helper functions. Bind every known state
    // container (nested dispatchers index into the enclosing array too).
    // NOTE 1: `var` is last-wins, so the dispatcher's own container must be
    // declared LAST or it gets clobbered by a same-named entry above.
    // NOTE 2: a nested container is a member expression (`scope.a.b`), which is
    // not a legal var declarator id. Bind those by assignment into a throwaway
    // object instead, so the expression text stays identical.
    const decls = [];
    const init = new Set();
    const bind = (name, arr) => {
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
        decls.push('var ' + name + ' = ' + JSON.stringify(arr) + ';');
        return;
      }
      // member expression like `scope.a["b"]` — split off the root identifier
      // and walk the property chain, creating intermediate objects as needed
      const m = /^([A-Za-z_$][A-Za-z0-9_$]*)(.*)$/.exec(name);
      if (!m) return;
      const root = m[1], rest = m[2];
      if (!init.has(root)) { decls.push('var ' + root + ' = (' + root + ' || {});'); init.add(root); }
      // tokenize `.name` and `["name"]` / `[expr]` steps
      const steps = [];
      const re = /\.([A-Za-z_$][A-Za-z0-9_$]*)|\[[^\]]*\]/g;
      let mm, consumed = 0;
      while ((mm = re.exec(rest)) !== null) {
        steps.push(mm[0]); consumed = mm.index + mm[0].length;
      }
      if (!steps.length) return;
      const val = JSON.stringify(arr);
      // create each intermediate level, then assign the snapshot at the leaf
      let cur = root;
      for (let i = 0; i < steps.length - 1; i++) {
        decls.push(cur + steps[i] + ' = (' + cur + steps[i] + ' || {});');
        cur = cur + steps[i];
      }
      decls.push(cur + steps[steps.length - 1] + ' = ' + val + ';');
    };
    for (const [name, arr] of containerSnaps) {
      if (name === statesVar) continue;
      bind(name, arr);
    }
    if (statesVar) bind(statesVar, snap);
    const src = decls.join('') + ' (' + expr + ')';
    return vm.runInContext(src, ctx, { timeout: 400 });
  } catch (e) { return undefined; }
}

rememberSnapshots();

// ── Emit: replace dispatcher while-loop with linearized case bodies ──
for (let i = 0; i < dispatchers.length; i++) {
  const disp = dispatchers[i];
  const snaps = traceMap && traceMap[i] ? traceMap[i] : null;
  if (!snaps || !snaps.length || !disp.sv || !disp.sv.statesVar) continue;

  const order = recoverOrder(disp, snaps);
  if (order.length < 2) continue;

  const statesVar = disp.sv.statesText;
  const stmts = [];
  for (const { case: c, snap } of order) {
    for (const st of c.consequent) {
      if (st.type === 'BreakStatement' || st.type === 'ContinueStatement') continue;
      // Skip CFF state bookkeeping: `states[i] += <const>` / comma sequences of them
      const stCode = gen(st);
      if (new RegExp('^' + statesVar + '\\s*\\[').test(stCode) &&
          /^\s*(?:\w+\s*\[\s*\d+\s*\]\s*(?:\+=[^;]*|[^;]*),?\s*)+\s*;?\s*$/.test(stCode)) continue;
      // clone, substitute states snapshot + constant-fold helper calls
      const cl = foldStatesAndHelpers(t.cloneNode(st, true), statesVar, snap);
      if (cl.type === 'EmptyStatement') continue;
      stmts.push(cl);
    }
  }
  if (stmts.length < 1) continue;
  disp.path.replaceWithMultiple(stmts);
  unrolled++; totalBodies += stmts.length;
  if (V) console.log('[cff] unrolled dispatcher #' + i + ': ' + order.length + ' cases → ' + stmts.length + ' stmts');
}

// Replace `STATES[i]` with numeric literal from snapshot; then constant-fold helper calls.
function foldStatesAndHelpers(stNode, statesVar, snap) {
  const fileNode = t.file(t.program([t.cloneNode(stNode, true)]), [], []);
  traverse(fileNode, {
    MemberExpression(p) {
      // Don't replace LHS of assignments — only RHS reads
      if (p.parentPath && p.parentPath.isAssignmentExpression() && p.parentPath.node.left === p.node) return;
      if (!t.isNumericLiteral(p.node.property)) return;
      const objText = gen(p.node.object);
      // match the dispatcher's own container, or any other container we have a
      // snapshot for (a nested body still indexes the enclosing state array)
      const known = objText === statesVar ? snap : containerSnaps.get(objText);
      if (!known) return;
      const v = known[p.node.property.value];
      if (typeof v === 'number') p.replaceWith(t.numericLiteral(v));
    }
  });
  // Constant-fold pure call expressions: f(<all-const args>) → value
  traverse(fileNode, {
    CallExpression(p) {
      if (!p.node.arguments.every(a => t.isLiteral(a) || (t.isUnaryExpression(a) && t.isLiteral(a.argument)))) return;
      const v = evalNode(p.node);
      if (v !== undefined && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
        p.replaceWith(t.valueToNode(v));
      }
    }
  });
  const out = fileNode.program.body[0];
  return out || stNode;
}
function foldCalls(node) {
  traverse(node, {
    CallExpression(p) {
      if (!p.node.arguments.every(a => t.isLiteral(a) || (t.isUnaryExpression(a) && t.isLiteral(a.argument)))) return;
      const v = evalNode(p.node);
      if (v !== undefined && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
        p.replaceWith(t.valueToNode(v));
      }
    }
  });
}

// ── Clean orphan break/continue + dead CFF helpers ──
let orphans = 0;
traverse(ast, {
  BreakStatement(p) { if (!p.findParent(x => x.isLoop() || x.isSwitchStatement())) { p.remove(); orphans++; } },
  ContinueStatement(p) { if (!p.findParent(x => x.isLoop())) { p.remove(); orphans++; } },
});
let helpers = 0;
traverse(ast, {
  FunctionDeclaration(p) {
    if (p.node.id && /__p_.*_cff_/.test(p.node.id.name)) {
      const b = p.scope.getBinding(p.node.id.name);
      if (!b || b.references <= 1) { p.remove(); helpers++; }
    }
  },
  VariableDeclarator(p) {
    if (p.node.id && p.node.id.type === 'Identifier' &&
        (/__p_.*_cff_/.test(p.node.id.name) || /__CFF_TR__/.test(p.node.id.name))) {
      const b = p.scope.getBinding(p.node.id.name);
      if (!b || b.references === 0) { p.remove(); helpers++; }
    }
  }
});

let out;
try { out = generate(ast, { compact: false, comments: true }).code; } catch (e) { bail('generate failed'); }
try { new vm.Script(out); } catch (e) { bail('output invalid: ' + e.message.slice(0,80)); }

emit(out, 'unrolled=' + unrolled + ' stmts=' + totalBodies + ' orphans=' + orphans + ' helpers=' + helpers);
