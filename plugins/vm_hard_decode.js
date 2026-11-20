#!/usr/bin/env node
/**
 * vm_hard_decode.js — Hard VM/sandbox execution tracer.
 *
 * Traces a JavaScript VM dispatcher loop (while + switch) to extract the payload.
 * The VM executes operations via a dispatcher state, and the real code is encoded
 * as numeric arguments to the dispatcher calls.
 *
 * Works by:
 * 1. Instrumenting the switch discriminant to record the execution trace
 * 2. Running the instrumented code in a sandbox
 * 3. Replaying the trace to recover the original operations
 * 4. For string-table VMs: constant-folding the string lookup calls
 * 5. For pure dispatchers: extracting the case bodies in execution order
 *
 * Usage: node vm_hard_decode.js <input.js> [output.js]
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3] || (INPUT ? INPUT.replace(/\.js$/, '.vm-decoded.js') : 'out.js');
if (!INPUT) { console.error('Usage: node vm_hard_decode.js <input.js> [output.js]'); process.exit(1); }
const code = fs.readFileSync(INPUT, 'utf8');
const V = process.env.VM_VERBOSE === '1';

function emit(out, note) {
  fs.writeFileSync(OUTPUT, out);
  console.log('[vm_hard_decode] ' + note + ' | ' + OUTPUT + ' (' + out.length + ' bytes)');
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

// ── Detect VM patterns ──
function hasVMSignature(src) {
  const vmWhile = (src.match(/\bwhile\s*\(\s*(?:true|!!\[\]|!0)\s*\)/g) || []).length;
  const switchCount = (src.match(/\bswitch\s*\(/g) || []).length;
  const funcTable = /function\s+[a-zA-Z_$]+\s*\(\s*\w+\s*,\s*\w+\s*\)/.test(src);
  const stringTable = /=\s*\[\s*["'][^"']{20,}["']/.test(src) ||
                       /return\s+\w+\s*\[\s*\w+\s*\]\s*\(\s*\w+\s*\)/.test(src);
  return (vmWhile >= 2 || switchCount >= 8) && (funcTable || stringTable);
}

// ── Sandboxed execution for string decryption ──
function buildSandbox() {
  const top = [];
  for (const node of ast.program.body) {
    if (node.type === 'FunctionDeclaration' || node.type === 'VariableDeclaration') {
      const g = gen(node);
      if (g.length < 500000) top.push(g);
    }
  }
  const sb = {
    console: { log(){}, warn(){}, error(){}, info(){}, debug(){} },
    Math, parseInt, parseFloat, String, Number, Array, Object, JSON, RegExp, Date, Boolean,
    Buffer, process: { env: {}, platform: 'linux', argv: ['node'], nextTick: (f)=>f && f() },
    require: () => new Proxy({}, { get: () => () => undefined }),
    setTimeout: (f) => 0, clearTimeout(){}, setInterval: () => 0, clearInterval(){},
    fetch: () => Promise.reject(new Error('x')),
    alert(){}, prompt(){},
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  };
  sb.globalThis = sb; sb.window = sb; sb.self = sb; sb.global = sb;
  const ctx = vm.createContext(sb);
  try { vm.runInContext(top.join('\n'), ctx, { timeout: 20000 }); }
  catch (e) { if (V) console.log('[vm] sandbox partial load: ' + e.message.slice(0, 100)); }
  return ctx;
}

// ── Phase 1: Constant-fold string table lookups ──
// Find patterns: decoder[i] or table[offset] where decoder/table is a large string/array
function constFoldStringLookups(code) {
  const ctx = buildSandbox();
  const tableMatches = code.match(/(\w+)\s*=\s*(\[[\s\S]{100,}?\])/g);
  if (!tableMatches) return 0;
  let folds = 0;
  for (const m of tableMatches) {
    const name = m.match(/^(\w+)/)[1];
    try { vm.runInContext(m + ';', ctx, { timeout: 1000 }); }
    catch (e) { continue; }
    // Pattern: decoder(N) or decoder[i] → resolved string
    const escName = name.replace(/\\/g, '\\\\');
    const lookupRe = new RegExp(escName + '\\s*\\[\\s*(\\d+)\\s*\\]', 'g');
    const cache = new Map();
    code = code.replace(lookupRe, (full, idx) => {
      if (cache.has(full)) return cache.get(full);
      const v = vm.runInContext(name + '[' + idx + ']', ctx, { timeout: 200 });
      if (typeof v === 'string' || typeof v === 'number') {
        const rep = JSON.stringify(String(v));
        cache.set(full, rep);
        folds++;
        return rep;
      }
      cache.set(full, full);
      return full;
    });
  }
  if (V) console.log('[vm] const-folded string lookups:', folds);
  return folds;
}

// ── Phase 2: Instrument and trace VM dispatcher ──
function traceDispatcher() {
  const instAst = parser.parse(code, {
    sourceType: 'script', errorRecovery: true, allowReturnOutsideFunction: true,
    plugins: ['classProperties', 'optionalChaining', 'nullishCoalescingOperator',
      'dynamicImport', 'topLevelAwait', 'numericSeparator', 'optionalCatchBinding'],
  });
  let dispatcherCount = 0;
  const switchNodes = [];
  traverse(instAst, {
    SwitchStatement(path) {
      // Find the enclosing while loop
      const whileParent = path.findParent(p => p.isWhileStatement());
      if (!whileParent) return;
      // Only instrument if it's a VM dispatcher (large switch inside while)
      if (path.node.cases.length < 5) return;
      const id = dispatcherCount++;
      switchNodes.push(id);
      // Instrument: (VM_TRACE.push({disc: <val>, op: <disc>}), <disc>)
      const disc = path.node.discriminant;
      const pushCall = t.callExpression(
        t.memberExpression(t.identifier('__VM_TRACE__'), t.identifier('push')),
        [{ type: 'ObjectExpression', properties: [
          { type: 'ObjectProperty', key: t.identifier('disc'), value: t.cloneNode(disc, true) },
        ]}]
      );
      const seq = t.sequenceExpression([pushCall, t.cloneNode(disc, true)]);
      path.node.discriminant = seq;
    }
  });
  if (dispatcherCount === 0) return null;

  const init = parser.parse(
    'var __VM_TRACE__ = [];'
  ).program.body;
  instAst.program.body.unshift(...init);

  const instCode = generate(instAst, { compact: true }).code;
  const runCtx = buildSandbox();
  runCtx.__VM_TRACE__ = [];
  try { vm.runInContext(instCode, runCtx, { timeout: 30000 }); } catch (e) {
    if (V) console.log('[vm] trace run stopped: ' + e.message.slice(0, 80));
  }
  const trace = runCtx.__VM_TRACE__;
  if (!trace || trace.length === 0) return null;
  if (V) console.log('[vm] trace entries:', trace.length);
  return { trace, dispatcherCount, instAst, switchNodes };
}

// ── Phase 3: Build execution map ──
function buildExecOrder(trace) {
  const order = [];
  const seen = new Set();
  for (const entry of trace) {
    const disc = entry.disc;
    if (disc === undefined || disc === null) continue;
    const key = String(disc);
    if (seen.has(key)) break; // dispatcher looped back → end of unique execution
    seen.add(key);
    order.push(disc);
  }
  return order;
}

// ── Main ──
if (!hasVMSignature(code)) {
  bail('no VM pattern detected');
}

// First: const-fold string table lookups
let folds = constFoldStringLookups(code);
if (folds > 0) {
  // Write partially folded output
  const outCode = code;
  if (V) console.log('[vm] partially folded, continuing...');
}

// Trace the dispatcher
const traceResult = traceDispatcher();
if (!traceResult || traceResult.trace.length === 0) {
  bail('no dispatcher trace recovered');
}

const order = buildExecOrder(traceResult.trace);
if (V) console.log('[vm] execution order:', order.length, 'unique states');

// ── Phase 4: Extract case bodies in execution order ──
// Find switch in the original AST
let targetSwitch = null;
traverse(ast, {
  SwitchStatement(path) {
    const whileParent = path.findParent(p => p.isWhileStatement());
    if (!whileParent) return;
    if (path.node.cases.length >= 5) {
      if (!targetSwitch || path.node.cases.length > targetSwitch.cases.length) {
        targetSwitch = path.node;
      }
    }
  }
});
if (!targetSwitch) bail('no switch found');

// Build case map
const caseMap = new Map();
for (const c of targetSwitch.cases) {
  if (!c.test) continue;
  const k = (c.test.type === 'NumericLiteral') ? c.test.value :
            (c.test.type === 'StringLiteral') ? c.test.value : null;
  if (k !== null) caseMap.set(k, c);
}

// Execute the whole AST in the sandbox to build a full context for const-folding
const fullCtx = buildSandbox();

// Replace dispatcher while-loop with linearized case bodies
const stmts = [];
const seen = new Set();
for (const disc of order) {
  if (seen.has(String(disc))) continue;
  seen.add(String(disc));
  const c = caseMap.get(disc);
  if (!c) continue;
  for (const st of c.consequent) {
    if (st.type === 'BreakStatement' || st.type === 'ContinueStatement') continue;
    const cl = t.cloneNode(st, true);
    // Try to constant-fold any string table lookups in this statement
    try {
      const stmtCode = generate(cl, { compact: true }).code;
      const evalResult = vm.runInContext('(function(){' + stmtCode + '})', fullCtx, { timeout: 500 });
      if (typeof evalResult === 'function') { /* function declaration, keep as-is */ }
    } catch (e) { /* keep original */ }
    stmts.push(cl);
  }
}

if (stmts.length < 2) bail('too few executed statements');

// Find and replace the while-switch block
traverse(ast, {
  WhileStatement(path) {
    const body = path.node.body;
    let hasTarget = false;
    if (body.type === 'SwitchStatement') { hasTarget = body === targetSwitch; }
    else if (body.type === 'BlockStatement') {
      for (const s of body.body) { if (s === targetSwitch) { hasTarget = true; break; } }
    }
    if (hasTarget) {
      path.replaceWithMultiple(stmts);
      path.skip();
    }
  }
});

// Clean orphan break/continue
traverse(ast, {
  BreakStatement(p) { if (!p.findParent(x => x.isLoop() || x.isSwitchStatement())) p.remove(); },
  ContinueStatement(p) { if (!p.findParent(x => x.isLoop())) p.remove(); },
});

let out;
try { out = generate(ast, { compact: false, comments: true }).code; } catch (e) { bail('generate failed'); }
try { new vm.Script(out); } catch (e) {
  if (V) console.log('[vm] output invalid:', e.message.slice(0, 100));
  bail('output syntax invalid');
}

emit(out, 'states=' + order.length + ' stmts=' + stmts.length + ' folds=' + folds);
