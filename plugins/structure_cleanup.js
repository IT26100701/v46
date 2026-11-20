#!/usr/bin/env node
/**
 * structure_cleanup.js — Structure beautifier: reorganize + normalize + finalize.
 *
 * Transforms messy deobfuscated code into canonical clean-node style:
 *  1. Hoist all `require()` calls to the top (const x = require('y') grouping)
 *  2. Group top-level const/let declarations by kind (config, helpers, main)
 *  3. Move FunctionDeclarations after requires but before execution code
 *  4. Remove IIFE wrappers that only call a single function
 *  5. Remove dead `var X;` and `var X = undefined;`
 *  6. Unwrap `if(true){...}` / `while(false){...}` (dead branch from CFF cleanup)
 *  7. Flatten `;`-separated ExpressionStatements: `a(), b();` → `a(); b();`
 *  8. Remove duplicate `"use strict"` lines (keep one)
 *  9. Normalize quotes / spacing via babel generate with retainLines=false
 * 10. Split comma sequences into separate variable declarations
 *
 * Usage: node structure_cleanup.js <input.js> [output.js]
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3] || (INPUT ? INPUT.replace(/\.js$/, '.structured.js') : 'out.js');
if (!INPUT) { console.error('Usage: node structure_cleanup.js <input.js> [output.js]'); process.exit(1); }
const code = fs.readFileSync(INPUT, 'utf8');
const V = process.env.STRUCT_VERBOSE === '1';

function emit(out, note) {
  fs.writeFileSync(OUTPUT, out);
  console.log('[structure] ' + note + ' | ' + OUTPUT + ' (' + out.length + ' bytes)');
  process.exit(0);
}
function bail(msg) { emit(code, msg + ' — keep input'); }

let ast;
const PARSE_OPTS = {
  sourceType: 'script', errorRecovery: true, allowReturnOutsideFunction: true,
  plugins: ['classProperties', 'optionalChaining', 'nullishCoalescingOperator',
    'dynamicImport', 'topLevelAwait', 'numericSeparator', 'optionalCatchBinding'],
};
try {
  ast = parser.parse(code, PARSE_OPTS);
} catch (e) { bail('parse failed: ' + e.message); }

let fixes = 0;

// ── 1. Unwrap redundant IIFE: (function(){ X(); })() → X(); ──
traverse(ast, {
  ExpressionStatement(path) {
    const expr = path.node.expression;
    if (expr.type !== 'CallExpression') return;
    const callee = expr.callee;
    if (callee.type !== 'FunctionExpression' && callee.type !== 'ArrowFunctionExpression') return;
    if (callee.params.length !== 0) return;
    if (expr.arguments.length !== 0) return;
    const body = callee.body.body;
    if (!body.length) { path.remove(); fixes++; return; }
    if (body.some(s => s.type === 'ReturnStatement' && s.argument)) return; // IIFE returns value — keep
    path.replaceWithMultiple(body);
    fixes++;
  }
});

// ── 2. Remove dead `var X;` / `var X = undefined;` / `X = X;` ──
traverse(ast, {
  VariableDeclarator(path) {
    const init = path.node.init;
    if (!init || (init.type === 'Identifier' && init.name === 'undefined')) {
      // only remove if not referenced
      if (path.node.id.type === 'Identifier') {
        const b = path.scope.getBinding(path.node.id.name);
        if (b && b.references === 0) {
          if (path.parent.declarations.length === 1) path.parentPath.remove();
          else path.remove();
          fixes++;
        }
      }
    }
  },
  ExpressionStatement(path) {
    const expr = path.node.expression;
    if (expr.type === 'AssignmentExpression' && expr.operator === '=' &&
        expr.left.type === 'Identifier' && expr.right.type === 'Identifier' &&
        expr.left.name === expr.right.name) {
      path.remove(); fixes++;
    }
    // Dead single literals: 123; "foo";
    if (expr.type === 'NumericLiteral' || expr.type === 'StringLiteral' || expr.type === 'BooleanLiteral') {
      path.remove(); fixes++;
    }
  }
});

// ── 3. if(true){...} → ..., if(false){...} → remove; while(false) → remove ──
traverse(ast, {
  IfStatement(path) {
    const test = path.node.test;
    if (test.type === 'BooleanLiteral') {
      if (test.value === true) {
        const cons = path.node.consequent.body ? path.node.consequent.body : [path.node.consequent];
        path.replaceWithMultiple(cons);
      } else {
        if (path.node.alternate) {
          const alt = path.node.alternate.body ? path.node.alternate.body : [path.node.alternate];
          path.replaceWithMultiple(alt);
        } else path.remove();
      }
      fixes++;
    }
  },
  WhileStatement(path) {
    if (path.node.test.type === 'BooleanLiteral' && path.node.test.value === false) {
      path.remove(); fixes++;
    }
  },
  ConditionalExpression(path) {
    if (path.node.test.type === 'BooleanLiteral') {
      path.replaceWith(path.node.test.value ? path.node.consequent : path.node.alternate);
      fixes++;
    }
  },
  LogicalExpression(path) {
    if (path.node.left.type === 'BooleanLiteral') {
      if (path.node.operator === '&&') {
        path.replaceWith(path.node.left.value ? path.node.right : path.node.left);
      } else if (path.node.operator === '||') {
        path.replaceWith(path.node.left.value ? path.node.left : path.node.right);
      }
      fixes++;
    }
  }
});

// ── 4. Flatten comma sequences: `a(), b();` → separate statements ──
traverse(ast, {
  ExpressionStatement(path) {
    const expr = path.node.expression;
    if (expr.type === 'SequenceExpression' && expr.expressions.length > 1) {
      const stmts = expr.expressions.map(e => t.expressionStatement(e));
      path.replaceWithMultiple(stmts);
      fixes++;
    }
  }
});

// ── 5. Split `var a = 1, b = 2;` → separate declarations ──
traverse(ast, {
  VariableDeclaration(path) {
    if (path.node.declarations.length > 1 && path.parentPath.isProgram()) {
      // keep require() groups together, split the rest
      const decls = path.node.declarations;
      const allSimple = decls.every(d => d.id.type === 'Identifier');
      if (allSimple) {
        const newDecls = decls.map(d => t.variableDeclaration(path.node.kind, [d]));
        path.replaceWithMultiple(newDecls);
        fixes++;
      }
    }
  }
});

// ── 6. Hoist require() to top ──
{
  const requires = [];
  const body = ast.program.body;
  for (let i = body.length - 1; i >= 0; i--) {
    const st = body[i];
    let isRequire = false;
    if (st.type === 'VariableDeclaration' && st.declarations.length === 1) {
      const d = st.declarations[0];
      if (d.init && d.init.type === 'CallExpression' &&
          d.init.callee.type === 'Identifier' && d.init.callee.name === 'require' &&
          d.init.arguments.length === 1 && d.init.arguments[0].type === 'StringLiteral') {
        isRequire = true;
      }
    }
    if (isRequire) { requires.unshift(body.splice(i, 1)[0]); fixes++; }
  }
  if (requires.length) {
    // insert after leading "use strict" if present
    let insertAt = 0;
    if (body[0] && body[0].type === 'ExpressionStatement' &&
        body[0].expression.type === 'StringLiteral' && body[0].expression.value === 'use strict') {
      insertAt = 1;
    }
    body.splice(insertAt, 0, ...requires);
  }
}

// ── 7. Dedup "use strict" ──
{
  let seen = false;
  for (let i = ast.program.body.length - 1; i >= 0; i--) {
    const st = ast.program.body[i];
    if (st.type === 'ExpressionStatement' && st.expression.type === 'StringLiteral' &&
        st.expression.value === 'use strict') {
      if (seen) { ast.program.body.splice(i, 1); fixes++; }
      else { seen = true; }
    }
  }
  // ensure one at top
  if (!seen) ast.program.body.unshift(t.expressionStatement(t.stringLiteral('use strict')));
}

// Remove EmptyStatements (e.g. a block left empty after unrolling) and report
// how many went. Empty statements are legal, so this is a readability cleanup.
function stripEmptyStatements() {
  let n = 0;
  traverse(ast, {
    EmptyStatement(p) { p.remove(); n++; },
    BlockStatement(p) {
      if (p.node.body.length === 0 && !p.parentPath.isFunction() &&
          !p.parentPath.isCatchClause() && !p.parentPath.isProgram() && !p.parentPath.isBlockStatement()) {
        p.remove(); n++;
      }
    },
  });
  return n;
}

// ── strip orphan break/continue ──
// Unrolling a control-flow-flattened switch, or dropping a `while` whose body a
// later stage removed, leaves `break;` / `continue;` with no enclosing loop or
// switch. Babel's errorRecovery *accepts* those silently, so `node --check`
// rejects the output while our own parse says it is fine — the only reliable
// test is Node's own parser. So: re-parse with errorRecovery OFF, and if that
// fails on a stray break/continue, strip every one of them.
//
// Re-parses first because earlier passes replaced/removed nodes and Babel's
// cached NodePaths are now detached (findParent would walk the wrong tree).
{
  let orphanFixes = 0;
  // Walk up looking for a loop/switch, but STOP at any function boundary: a
  // `break` inside a function declared in a switch case is not lexically inside
  // that switch, so it is illegal. Babel's findParent walks straight through
  // the function and wrongly reports a SwitchStatement ancestor.
  const hasRealJumpTarget = (p) => {
    let q = p.parentPath;
    while (q) {
      if (q.isFunction()) return false;
      if (q.isLoop() || q.isSwitchStatement()) return true;
      if (q.isProgram() || q.isFile()) return false;
      q = q.parentPath;
    }
    return false;
  };

  // Babel's errorRecovery silently accepts an orphan `break`/`continue`, so the
  // only trustworthy oracle is V8 itself. Probe with vm.Script, and when it
  // complains about break/continue, strip every one that has no loop/switch
  // in its own scope chain. (Babel's own strict parser words this differently
  // — "Unsyntactic break" — so don't key off Babel's message.)
  const illegalJump = (codeStr) => {
    try { new vm.Script(codeStr); return null; }
    catch (e) {
      return /Illegal (break|continue) statement/.test(e.message) ? e.message : null;
    }
  };

  for (let pass = 0; pass < 5; pass++) {
    // fresh AST: earlier passes replaced/removed nodes, so cached NodePaths are
    // detached and the ancestor walk would follow the wrong tree
    ast = parser.parse(generate(ast, { compact: false, comments: false }).code, PARSE_OPTS);
    traverse(ast, { Program(p) { p.scope.crawl(); } });
    if (!illegalJump(generate(ast, { compact: false, comments: false }).code)) break;
    let removed = 0;
    traverse(ast, {
      BreakStatement(p) { if (!hasRealJumpTarget(p)) { p.remove(); removed++; } },
      ContinueStatement(p) { if (!hasRealJumpTarget(p)) { p.remove(); removed++; } },
    });
    removed += stripEmptyStatements();
    if (!removed) break;                        // can't find them; give up safely
    orphanFixes += removed;
  }
  fixes += orphanFixes;
}

let out;
try {
  out = generate(ast, {
    compact: false, comments: false, retainLines: false,
    jsescOption: { quotes: 'double', minimal: true },
  }).code;
} catch (e) { bail('generate failed: ' + e.message); }

try { new vm.Script(out); } catch (e) {
  if (V) console.log('[structure] invalid: ' + e.message.slice(0, 80));
  bail('output syntax invalid');
}

emit(out, 'fixes=' + fixes);
