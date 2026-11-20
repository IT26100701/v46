#!/usr/bin/env node
'use strict';
/**
 * cff_unroll.js — Stage NEW: hard control-flow-flattening unroller (content extraction).
 *
 * Detects the classic CFF dispatcher pattern:
 *   while (!![]) { switch (stateVar) { case N: ... stateVar = M; continue; ... } }
 * and unrolls it into plain sequential statements — WITHOUT requiring the result
 * to be valid/runnable. Goal: expose the real contents (the case bodies in order),
 * even when the flattening is nested / obfuscated.
 *
 * Output: the unrolled body (each executed case body emitted in execution order),
 * plus any strings/decoder calls left visible. If the state machine can't be
 * resolved statically, we emit the switch cases grouped by reachable order using
 * a lightweight symbolic executor (track `stateVar = <literal>` assignments).
 *
 * Usage: node cff_unroll.js <input.js> <output.js>
 */
const fs = require('fs');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3] || (INPUT ? INPUT.replace(/\.js$/, '.unrolled.js') : 'out.js');
if (!INPUT) { console.error('Usage: node cff_unroll.js <input.js> [output]'); process.exit(1); }
let src = fs.readFileSync(INPUT, 'utf8');
const report = [];
const mark = (s) => { report.push(s); console.log('  [stage] ' + s); };

let ast;
try { ast = parser.parse(src, { sourceType: 'script', errorRecovery: true, allowReturnOutsideFunction: true }); }
catch (e) { console.error('parse fail: ' + e.message); process.exit(1); }

let unrolled = 0;
traverse(ast, {
  WhileStatement(path) {
    // match: while(!![]) { ... switch(X){...} ... }  OR
    //        while(fn(x) !== <const>) { ... switch(fn(x)){...} ... }  (ktech CFF)
    const test = path.node.test;
    let discr = null;
    if (test && test.type === 'UnaryExpression' && test.operator === '!' && test.argument &&
        test.argument.type === 'UnaryExpression' && test.argument.operator === '!') {
      discr = '!![]';
    } else if (test && test.type === 'BinaryExpression' && test.operator === '!==' &&
               test.right && (test.right.type === 'NumericLiteral' || test.right.type === 'UnaryExpression')) {
      discr = 'fn-const';
    }
    if (!discr) return;
    // body: either BlockStatement containing a switch, or the switch itself
    let switchNode = null;
    const body = path.node.body;
    if (body.type === 'SwitchStatement') {
      switchNode = body;
    } else if (body.type === 'BlockStatement') {
      for (const st of body.body) {
        if (st.type === 'SwitchStatement') { switchNode = st; break; }
      }
    }
    if (!switchNode) return;
    // discriminant expr (state fn call: f74(x))
    const stateExpr = switchNode.discriminant;
    // state var name: likely a fn call (f74(x)) or identifier
    let stateName = null;
    if (stateExpr.type === 'Identifier') stateName = stateExpr.name;
    else if (stateExpr.type === 'CallExpression' && stateExpr.callee.type === 'Identifier') {
      // f74(x) — state lives in the ARG (x), transitions assign to x
      const arg = stateExpr.arguments[0];
      if (arg && arg.type === 'Identifier') stateName = arg.name;
    }
    if (!stateName) return;
    const cases = switchNode.cases;
    // map case literal -> case index
    const caseMap = new Map();
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i].test;
      if (c && (c.type === 'NumericLiteral' || c.type === 'StringLiteral')) {
        caseMap.set(String(c.value), i);
      }
    }
    // find initial state: look in statements before switch for `stateName = <lit>`
    let current = null;
    if (body.type === 'BlockStatement') {
      for (const st of body.body) {
        if (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression' &&
            st.expression.left.type === 'Identifier' && st.expression.left.name === stateName &&
            (st.expression.right.type === 'NumericLiteral' || st.expression.right.type === 'StringLiteral')) {
          current = String(st.expression.right.value);
        }
      }
    }
    // fallback: first test literal
    if (current === null && cases.length) {
      const c0 = cases[0].test;
      if (c0) current = String(c0.value);
    }
    const visited = new Set();
    const order = [];
    let guard = 0;
    while (current !== null && !visited.has(current) && guard++ < 5000) {
      visited.add(current);
      const ci = caseMap.get(current);
      if (ci === undefined) break;
      order.push(cases[ci]);
      // find next state: last assignment `stateName = <lit>` in the case (excluding break)
      let next = null;
      for (const st of cases[ci].consequent) {
        if (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression' &&
            st.expression.left.type === 'Identifier' && st.expression.left.name === stateName &&
            (st.expression.right.type === 'NumericLiteral' || st.expression.right.type === 'StringLiteral')) {
          next = String(st.expression.right.value);
        }
      }
      if (next === null) break;
      current = next;
    }
    if (!order.length) return;

    // ── Build unrolled body: each case's statements, minus state assignments,
    //    minus break/continue, in execution order. ──
    const stmts = [];
    for (const c of order) {
      for (const st of c.consequent) {
        if (st.type === 'BreakStatement' || st.type === 'ContinueStatement') continue;
        if (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression' &&
            st.expression.left.type === 'Identifier' && st.expression.left.name === stateName) continue;
        stmts.push(st);
      }
    }
    if (!stmts.length) return;
    path.replaceWithMultiple(stmts);
    unrolled++;
    path.skip();
  }
});

let out = generate(ast, { comments: true, compact: false }).code;

// ── Cleanup: hapus break/continue yang tidak lagi dalam loop/switch (hasil unroll) ──
let removedBC = 0;
traverse(ast, {
  BreakStatement(path) {
    if (!path.findParent(p => p.isLoop() || p.isSwitchStatement())) {
      path.remove(); removedBC++;
    }
  },
  ContinueStatement(path) {
    if (!path.findParent(p => p.isLoop())) {
      path.remove(); removedBC++;
    }
  }
});
if (removedBC) mark('removed ' + removedBC + ' orphan break/continue');
out = generate(ast, { comments: true, compact: false }).code;

fs.writeFileSync(OUTPUT, out);
mark('unrolled ' + unrolled + ' CFF dispatcher(s)');
console.log('cff_unroll: output=' + OUTPUT + ' (' + out.length + ' bytes)');
console.log('cff_unroll: ' + report.join(' | '));
process.exit(0);