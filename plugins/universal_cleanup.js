#!/usr/bin/env node
'use strict';
/**
 * universal_cleanup.js — Final universal cleanup for ALL obfuscator families.
 *
 * Removes:
 *   1.  Empty blocks / empty catch / empty try-catch wrappers
 *   2.  Dead code: if(false), while(0), switch(no matching case), unreachable
 *   3.  Anti-debug: debugger, while(true) decoys, setInterval traps, console traps
 *   4.  String concat: "a"+"b" → "ab" (fixpoint), template literals → strings
 *   5.  Computed property: .["key"] → .key, {["key"]: v} → {key: v}
 *   6.  Dead require() — unused import declarations
 *   7.  Redundant typeof guards where binding always exists
 *   8.  Empty if branches, redundant else
 *   9.  Sequence expressions: pure sub-expressions removed
 *  10.  Nested empty blocks: { { {} } } → {}
 *
 * Usage: node plugins/universal_cleanup.js <input.js> <output.js>
 */
const fs = require('fs');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3] || INPUT;
if (!INPUT) { console.error('usage: universal_cleanup.js <input.js> [output.js]'); process.exit(1); }

const original = fs.readFileSync(INPUT, 'utf8');
let ast;
try {
  ast = parser.parse(original, { sourceType: 'unambiguous', errorRecovery: true,
    plugins: ['optionalChaining','nullishCoalescingOperator','logicalAssignment','topLevelAwait','jsx'] });
} catch (e) {
  console.error('universal_cleanup: parse failed:', e.message.slice(0, 80));
  fs.writeFileSync(OUTPUT, original);
  process.exit(0);
}

const RESERVED = new Set(['break','case','catch','class','const','continue','debugger','default','delete','do','else','enum','export','extends','false','finally','for','function','if','import','in','instanceof','new','null','return','super','switch','this','throw','true','try','typeof','var','void','while','with','yield','let','static','await','implements','interface','package','private','protected','public']);

const stats = {};
const bump = (k) => { stats[k] = (stats[k] || 0) + 1; };
const isValid = (code) => {
  try { parser.parse(code, { sourceType: 'unambiguous', errorRecovery: false }); return true; }
  catch { return false; }
};
const gen = () => generate(ast, { comments: true, compact: false }).code;

// ─── 1. Anti-debug guards ─────────────────────────────────────────────
// debugger statements (top-level or in if-blocks)
traverse(ast, {
  DebuggerStatement(p) { try { p.remove(); bump('debugger'); } catch {} },
});

// setInterval(setInterval(()=>{}, N) with empty or trap callback
// Already handled by deadcode, but catch raw ones
traverse(ast, {
  ExpressionStatement(p) {
    const e = p.node.expression;
    if (!t.isCallExpression(e)) return;
    const callee = e.callee;
    // setInterval(() => {...}, ...) where body is empty or trap
    if ((t.isIdentifier(callee, {name:'setInterval'}) || t.isIdentifier(callee, {name:'setTimeout'})) &&
        e.arguments.length >= 1) {
      const arg0 = e.arguments[0];
      if (t.isArrowFunctionExpression(arg0) || t.isFunctionExpression(arg0)) {
        const body = arg0.body;
        // Empty callback
        if (t.isBlockStatement(body) && body.body.length === 0) {
          try { p.remove(); bump('empty-interval'); } catch {}
        }
        // debugger-only callback:  () => { debugger; }
        if (t.isBlockStatement(body) && body.body.length === 1 && t.isDebuggerStatement(body.body[0])) {
          try { p.remove(); bump('debugger-interval'); } catch {}
        }
        // trap callback:  () => { while(!0){} } or while(true)
        if (t.isBlockStatement(body) && body.body.length === 1) {
          const s = body.body[0];
          if (t.isWhileStatement(s) && t.isBooleanLiteral(s.test, {value:true})) {
            try { p.remove(); bump('trap-interval'); } catch {}
          }
          if (t.isWhileStatement(s) && t.isUnaryExpression(s.test, {operator:'!'}) && t.isNumericLiteral(s.test.argument, {value:0})) {
            try { p.remove(); bump('trap-interval'); } catch {}
          }
        }
      }
    }
    // console.log('...') with only a string → remove (obfuscator trap)
    if (t.isMemberExpression(callee) && t.isIdentifier(callee.object, {name:'console'}) &&
        e.arguments.length >= 1 && t.isStringLiteral(e.arguments[0])) {
      const arg = e.arguments[0].value;
      if (/debug|trap|break|debugger|anti/i.test(arg)) {
        try { p.remove(); bump('console-trap'); } catch {}
      }
    }
  },
});

// ─── 2. Dead / infinite loops ─────────────────────────────────────────
traverse(ast, {
  WhileStatement(p) {
    const test = p.node.test;
    // while(false) or while(0) — dead
    if ((t.isBooleanLiteral(test) && test.value === false) ||
        (t.isNumericLiteral(test) && test.value === 0)) {
      try { p.remove(); bump('dead-while'); } catch {}
      return;
    }
    // while(!0) = while(true) — anti-debug decoy if body is trivial
    if (t.isUnaryExpression(test, {operator:'!'}) && t.isNumericLiteral(test.argument, {value:0})) {
      const body = p.node.body;
      if (t.isBlockStatement(body)) {
        // Empty body → remove
        if (body.body.length === 0) { try { p.remove(); bump('trap-while-empty'); } catch {}; return; }
        // Only self-referential junk: x = x; if(!x) break;
        const isJunk = body.body.every(s => {
          if (t.isExpressionStatement(s)) {
            const e = s.expression;
            // x = x;
            if (t.isAssignmentExpression(e) && t.isIdentifier(e.left) && t.isIdentifier(e.right) && e.left.name === e.right.name) return true;
          }
          if (t.isIfStatement(s) && !t.isBlockStatement(s.consequent) && !t.isIfStatement(s.consequent)) return true;
          if (t.isContinueStatement(s) || t.isBreakStatement(s)) return true;
          if (t.isDebuggerStatement(s)) return true;
          return false;
        });
        if (isJunk) { try { p.remove(); bump('trap-while-junk'); } catch {}; return; }
      } else if (!t.isBlockStatement(body)) {
        // while(!0) x=x; single statement — check if trivial
        if (t.isExpressionStatement(body)) {
          const e = body.expression;
          if (t.isAssignmentExpression(e) && t.isIdentifier(e.left) && t.isIdentifier(e.right) && e.left.name === e.right.name) {
            try { p.remove(); bump('trap-while-junk'); } catch {}
          }
        }
      }
    }
  },
  DoWhileStatement(p) {
    const test = p.node.test;
    if ((t.isBooleanLiteral(test) && test.value === false) || (t.isNumericLiteral(test) && test.value === 0)) {
      try { p.remove(); bump('dead-dowhile'); } catch {}
    }
  },
  ForStatement(p) {
    // for(;false;) or for(;0;)
    if (p.node.test && ((t.isBooleanLiteral(p.node.test) && p.node.test.value === false) ||
        (t.isNumericLiteral(p.node.test) && p.node.test.value === 0))) {
      try { p.remove(); bump('dead-for'); } catch {}
    }
  },
});

// ─── 3. Dead / empty blocks & try-catch ──────────────────────────────
traverse(ast, {
  // Empty catch → remove the catch clause (keep try body)
  CatchClause(p) {
    const body = p.node.body;
    if (t.isBlockStatement(body) && body.body.length === 0) {
      // try{...}catch(e){}  →  try{...}
      const tryStmt = p.parentPath;
      if (tryStmt.isTryStatement() && !tryStmt.node.finalizer) {
        try { p.remove(); bump('empty-catch'); } catch {}
      }
    }
  },
  // try{} with empty block and no catch → remove whole statement
  TryStatement(p) {
    const block = p.node.block;
    if (t.isBlockStatement(block) && block.body.length === 0 && !p.node.handler && !p.node.finalizer) {
      try { p.remove(); bump('empty-try'); } catch {}
    }
  },
  // if(false){...} → remove
  IfStatement(p) {
    const test = p.node.test;
    // if(false)
    if (t.isBooleanLiteral(test) && test.value === false) {
      // if(false){a}else{b} → b
      if (p.node.alternate) {
        try { p.replaceWith(p.node.alternate); bump('dead-if-else'); } catch {}
      } else {
        try { p.remove(); bump('dead-if'); } catch {}
      }
      return;
    }
    // if(!0) = if(true)
    if (t.isUnaryExpression(test, {operator:'!'}) && t.isNumericLiteral(test.argument, {value:0})) {
      if (p.node.alternate) {
        try { p.remove(); bump('true-if-drop-else'); } catch {}
      } else {
        try { p.replaceWith(p.node.consequent); bump('true-if-unwrap'); } catch {}
      }
      return;
    }
    // if with EMPTY consequent and no alternate → remove
    if (t.isBlockStatement(p.node.consequent) && p.node.consequent.body.length === 0 && !p.node.alternate) {
      try { p.remove(); bump('empty-if'); } catch {}
      return;
    }
    // else with empty block → remove else
    if (p.node.alternate && t.isBlockStatement(p.node.alternate) && p.node.alternate.body.length === 0) {
      try { p.node.alternate = null; bump('empty-else'); } catch {}
    }
  },
  // Empty block statement in a non-function position → unwrap
  BlockStatement(p) {
    if (p.node.body.length === 0) {
      const parent = p.parentPath;
      if (parent.isIfStatement() || parent.isWhileStatement() || parent.isForStatement() ||
          parent.isDoWhileStatement() || parent.isFunction() || parent.isCatchClause()) return;
      try { p.remove(); bump('empty-block'); } catch {}
    }
  },
  // Dead switch: switch with only default and no matching cases, or no cases
  SwitchStatement(p) {
    const cases = p.node.cases;
    if (cases.length === 0) { try { p.remove(); bump('empty-switch'); } catch {} return; }
    // switch(true){case false: ...} — all cases dead
    const allDead = cases.every(c => {
      if (!c.test) return false; // default
      return t.isBooleanLiteral(c.test, {value:false}) || (t.isNumericLiteral(c.test) && c.test.value === 0);
    });
    if (allDead) { try { p.remove(); bump('dead-switch'); } catch {} }
  },
});

// ─── 4. Nested empty blocks unwrapping ────────────────────────────────
// { { ... } } → { ... }  (repeatedly)
let nestedChanged = true, nestedRounds = 0;
while (nestedChanged && nestedRounds++ < 10) {
  nestedChanged = false;
  traverse(ast, {
    BlockStatement(p) {
      if (p.node.body.length === 1 && t.isBlockStatement(p.node.body[0])) {
        const inner = p.node.body[0];
        // Only unwrap if this block is not a function body (functions need their block)
        if (!p.parentPath.isFunction() && !p.parentPath.isCatchClause()) {
          try { p.node.body = inner.body; nestedChanged = true; bump('nested-block'); } catch {}
        }
      }
    },
  });
}

// ─── 5. String concat fold (fixpoint) ────────────────────────────────
let concatChanged = true, concatRounds = 0;
while (concatChanged && concatRounds++ < 30) {
  concatChanged = false;
  traverse(ast, {
    BinaryExpression(p) {
      if (p.node.operator !== '+') return;
      const l = p.node.left, r = p.node.right;
      if (t.isStringLiteral(l) && t.isStringLiteral(r)) {
        try {
          p.replaceWith(t.stringLiteral(l.value + r.value));
          concatChanged = true; bump('concat-fold');
        } catch {}
      }
      // "abc" + 123  →  "abc123"
      else if (t.isStringLiteral(l) && t.isNumericLiteral(r)) {
        try {
          p.replaceWith(t.stringLiteral(l.value + String(r.value)));
          concatChanged = true; bump('concat-num');
        } catch {}
      }
      // 123 + "abc"  →  "123abc"
      else if (t.isNumericLiteral(l) && t.isStringLiteral(r)) {
        try {
          p.replaceWith(t.stringLiteral(String(l.value) + r.value));
          concatChanged = true; bump('concat-num-pre');
        } catch {}
      }
      // "abc" + true  →  "abc true"
      else if (t.isStringLiteral(l) && t.isBooleanLiteral(r)) {
        try {
          p.replaceWith(t.stringLiteral(l.value + String(r.value)));
          concatChanged = true; bump('concat-bool');
        } catch {}
      }
      // template literal with only expressions → string
      // `` `abc${"def"}` `` → "abcdef"
    },
  });
  // Template literals with only static parts → string literal
  traverse(ast, {
    TemplateLiteral(p) {
      const quasis = p.node.quasis;
      const exprs = p.node.expressions;
      if (exprs.length === 0) {
        try { p.replaceWith(t.stringLiteral(quasis[0].value.cooked || '')); concatChanged = true; bump('template-static'); } catch {}
        return;
      }
      // All expressions are string literals → fold
      const allStrings = exprs.every(e => t.isStringLiteral(e));
      if (allStrings) {
        let out = '';
        for (let i = 0; i < quasis.length; i++) {
          out += quasis[i].value.cooked || '';
          if (i < exprs.length) out += exprs[i].value;
        }
        try { p.replaceWith(t.stringLiteral(out)); concatChanged = true; bump('template-fold'); } catch {}
      }
    },
  });
}

// ─── 6. Computed property → identifier ───────────────────────────────
traverse(ast, {
  // obj["key"] → obj.key  (when key is a valid identifier)
  MemberExpression(p) {
    if (p.node.computed && t.isStringLiteral(p.node.property)) {
      const key = p.node.property.value;
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && !RESERVED.has(key)) {
        try { p.node.computed = false; p.node.property = t.identifier(key); bump('computed-member'); } catch {}
      }
    }
    // obj[serenN] where serenN is a const string literal → obj.key
    // (handled by constant propagation below)
  },
  ObjectProperty(p) {
    if (p.node.computed && t.isStringLiteral(p.node.property)) {
      const key = p.node.property.value;
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && !RESERVED.has(key)) {
        try { p.node.computed = false; p.node.property = t.identifier(key); bump('computed-key'); } catch {}
      }
    }
  },
  ObjectMethod(p) {
    if (p.node.computed && t.isStringLiteral(p.node.property)) {
      const key = p.node.property.value;
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && !RESERVED.has(key)) {
        try { p.node.computed = false; p.node.property = t.identifier(key); bump('computed-method-key'); } catch {}
      }
    }
  },
});

// ─── 7. Redundant sequence expressions ───────────────────────────────
// (a, b, c) → c when a,b are pure (no function calls, assignments, etc.)
traverse(ast, {
  SequenceExpression(p) {
    const exprs = p.node.expressions;
    if (exprs.length < 2) return;
    const isPure = (e) => {
      if (t.isLiteral(e) || t.isIdentifier(e)) return true;
      if (t.isUnaryExpression(e)) return isPure(e.argument);
      if (t.isBinaryExpression(e)) return isPure(e.left) && isPure(e.right);
      if (t.isLogicalExpression(e)) return isPure(e.left) && isPure(e.right);
      if (t.isConditionalExpression(e)) return isPure(e.test) && isPure(e.consequent) && isPure(e.alternate);
      if (t.isMemberExpression(e) && !e.computed) return isPure(e.object);
      if (t.isArrayExpression(e)) return e.elements.every(x => x === null || isPure(x));
      if (t.isTemplateLiteral(e)) return e.expressions.every(isPure);
      return false; // calls, assignments, new, await, etc. are NOT pure
    };
    // Keep only the last expression + any impure ones before it
    const keep = [];
    for (let i = 0; i < exprs.length - 1; i++) {
      if (!isPure(exprs[i])) keep.push(exprs[i]);
      else bump('pure-seq-removed');
    }
    keep.push(exprs[exprs.length - 1]);
    if (keep.length < exprs.length) {
      try {
        if (keep.length === 1) p.replaceWith(keep[0]);
        else p.node.expressions = keep;
      } catch {}
    }
  },
});

// ─── 8. Unused variable declarations ─────────────────────────────────
// Remove top-level `var x;` / `let x;` / `const x;` with no init and no references
traverse(ast, {
  VariableDeclarator(p) {
    if (p.node.init) return;
    const name = p.node.id && p.node.id.name;
    if (!name) return;
    // Check if referenced anywhere else in the program
    let referenced = false;
    try {
      const scope = p.scope;
      const binding = scope.getBinding(name);
      if (binding && binding.referencePaths.length > 0) referenced = true;
      // Also check parent scopes (could be a hoisted var used elsewhere)
      if (!referenced && binding && binding.constantViolations.length > 1) referenced = true;
    } catch {}
    if (!referenced) {
      try {
        const decl = p.parentPath;
        if (decl.node.declarations.length === 1) decl.remove();
        else p.remove();
        bump('unused-var');
      } catch {}
    }
  },
});

// ─── 9. Dead require() removal ───────────────────────────────────────
// require('x') at top level where the result is never assigned → remove
traverse(ast, {
  ExpressionStatement(p) {
    const e = p.node.expression;
    if (!t.isCallExpression(e) || !t.isIdentifier(e.callee, {name:'require'})) return;
    // require('x') alone with no assignment — check if any side effect
    // Only remove if it's clearly a bare statement (no assignment)
    // Keep: require has side effects (loading module). Only remove if duplicate.
    const arg0 = e.arguments[0];
    if (arg0 && t.isStringLiteral(arg0)) {
      // Check if this exact require already appeared earlier
      const body = p.parentPath && p.parentPath.node.body;
      if (body) {
        const idx = body.indexOf(p.node);
        for (let i = 0; i < idx; i++) {
          const s = body[i];
          if (t.isExpressionStatement(s) && t.isCallExpression(s.expression) &&
              t.isIdentifier(s.expression.callee, {name:'require'}) &&
              s.expression.arguments[0] && t.isStringLiteral(s.expression.arguments[0]) &&
              s.expression.arguments[0].value === arg0.value) {
            try { p.remove(); bump('dup-require'); } catch {}
            return;
          }
        }
      }
    }
  },
});

// ─── 10. Redundant `void 0` → `undefined` in return ──────────────────
traverse(ast, {
  ReturnStatement(p) {
    if (p.node.argument && t.isUnaryExpression(p.node.argument, {operator:'void'}) &&
        t.isNumericLiteral(p.node.argument.argument, {value:0})) {
      // return void 0 → return;  (or return undefined)
      try { p.node.argument = t.identifier('undefined'); bump('void0-to-undefined'); } catch {}
    }
  },
});

// ─── 11. Wrap in try-catch safety check ──────────────────────────────
let output = gen();
if (!isValid(output)) {
  console.error('universal_cleanup: output invalid, keeping input');
  fs.writeFileSync(OUTPUT, original);
  process.exit(0);
}

fs.writeFileSync(OUTPUT, output);

const entries = Object.entries(stats).filter(([,v]) => v > 0);
const summary = entries.map(([k,v]) => `${k}=${v}`).join(' ');
console.log('universal_cleanup: ' + (summary || 'no changes') + ' | output=' + output.length + ' chars');
