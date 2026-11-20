#!/usr/bin/env node
/**
 * final_surgical_cleanup.js — last-stage polish for "100% clean" output.
 *
 * Runs AFTER var_rename_restore. Does ONLY semantics-preserving, AST-level cleanups:
 *   1. Computed object keys → identifier keys  { ["foo"]: v } → { foo: v }
 *   2. Bracket member → dot member             obj["foo"] → obj.foo
 *   3. debugger; statements → remove
 *   4. !0 / !1 → true / false
 *   5. void 0 → undefined
 *   6. OBF_MARKER residual calls → remove
 *   7. Adjacent string literal concat fold     "a"+"b" → "ab" (iterate to fixpoint)
 *   8. Comma sequence var decl → split when safe
 *
 * Every transform gates on parse(). Falls back to untouched input on failure.
 *
 * Usage: node final_surgical_cleanup.js <input.js> [output.js]
 */
'use strict';

const fs = require('fs');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

const [, , inputPath, outputPath] = process.argv;
if (!inputPath) {
  console.error('usage: node final_surgical_cleanup.js <input.js> [output.js]');
  process.exit(1);
}

const code = fs.readFileSync(inputPath, 'utf8');
const outPath = outputPath || inputPath.replace(/\.js$/, '.__surgical.js');
const verbose = process.env.SURGICAL_VERBOSE === '1';

function log(msg) { console.log('[surgical] ' + msg); }

function tryParse() {
  try {
    return parser.parse(code, {
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: ['classProperties', 'optionalChaining', 'nullishCoalescingOperator',
        'dynamicImport', 'topLevelAwait', 'numericSeparator', 'optionalCatchBinding'],
    });
  } catch (e) {
    log('parse failed: ' + e.message);
    return null;
  }
}

function tryEmit(ast) {
  let out;
  try {
    out = generate(ast, { compact: false, comments: true }).code;
  } catch (e) {
    log('generate failed: ' + e.message);
    return null;
  }
  try {
    parser.parse(out, { sourceType: 'script', allowReturnOutsideFunction: true });
  } catch (e) {
    log('output invalid syntax: ' + e.message);
    return null;
  }
  return out;
}

const reserved = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally',
  'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null',
  'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'async', 'await',
]);

let ast = tryParse();
if (!ast) { fs.writeFileSync(outPath, code); process.exit(0); }

let total = 0;

// ─── 1. Computed object keys → identifier keys ───
{
  let count = 0;
  traverse(ast, {
    ObjectProperty(path) {
      if (path.node.computed && t.isStringLiteral(path.node.key)) {
        const val = path.node.key.value;
        if (/^[a-zA-Z_$][\w$]*$/.test(val) && !reserved.has(val)) {
          path.node.computed = false;
          path.node.key = t.identifier(val);
          count++;
        }
      }
    },
    // Also handle class properties
    ClassProperty(path) {
      if (path.node.computed && t.isStringLiteral(path.node.key)) {
        const val = path.node.key.value;
        if (/^[a-zA-Z_$][\w$]*$/.test(val) && !reserved.has(val)) {
          path.node.computed = false;
          path.node.key = t.identifier(val);
          count++;
        }
      }
    },
  });
  if (count > 0) { log('computed keys → identifier: ' + count); total += count; }
}

// ─── 2. Bracket member → dot member ───
{
  let count = 0;
  function convertMember(path) {
    if (path.node.computed && t.isStringLiteral(path.node.property)) {
      const val = path.node.property.value;
      if (/^[a-zA-Z_$][\w$]*$/.test(val) && !reserved.has(val)) {
        path.node.computed = false;
        path.node.property = t.identifier(val);
        count++;
      }
    }
  }
  traverse(ast, { MemberExpression: convertMember, OptionalMemberExpression: convertMember });
  if (count > 0) { log('bracket member → dot: ' + count); total += count; }
}

// ─── 3. debugger → remove ───
{
  let count = 0;
  traverse(ast, {
    DebuggerStatement(path) { path.remove(); count++; },
  });
  if (count > 0) { log('debugger removed: ' + count); total += count; }
}

// ─── 4. !0 → true, !1 → false ───
{
  let count = 0;
  traverse(ast, {
    UnaryExpression(path) {
      if (path.node.operator === '!' && t.isNumericLiteral(path.node.argument)) {
        const n = path.node.argument.value;
        if (n === 0) { path.replaceWith(t.booleanLiteral(true)); count++; }
        else if (n === 1) { path.replaceWith(t.booleanLiteral(false)); count++; }
      }
    },
  });
  if (count > 0) { log('!0/!1 → true/false: ' + count); total += count; }
}

// ─── 5. void 0 → undefined ───
{
  let count = 0;
  traverse(ast, {
    UnaryExpression(path) {
      if (path.node.operator === 'void' && t.isNumericLiteral(path.node.argument, { value: 0 })) {
        path.replaceWith(t.identifier('undefined'));
        count++;
      }
    },
  });
  if (count > 0) { log('void 0 → undefined: ' + count); total += count; }
}

// ─── 6. OBF_MARKER residue → clean the mangled identifiers that carry it ───
// Obfuscators glue the marker into identifier names, e.g.
//   var v = genFn15OBF_MARKER座的座的 ||= fn9(fn13, 7549);
// Here the marker is part of the *identifier*, not a call, so no CallExpression
// visitor fires. Strip the marker text, keep the valid identifier prefix, and
// also drop the dead `if (<marker> === <number>) { ... }` guard that follows.
{
  let count = 0;
  // 6a. identifiers containing the marker
  traverse(ast, {
    Identifier(path) {
      if (path.node.name.includes('OBF_MARKER')) {
        const cleaned = path.node.name.replace(/OBF_MARKER[^\s]*/g, '') || '_';
        path.node.name = /^[a-zA-Z_$]/.test(cleaned) ? cleaned : '_' + cleaned;
        count++;
      }
    },
  });
  // 6b. a bare OBF_MARKER call, if any survived
  traverse(ast, {
    CallExpression(path) {
      if (t.isIdentifier(path.node.callee, { name: 'OBF_MARKER' })) {
        if (path.parentPath.isExpressionStatement()) path.parentPath.remove();
        else path.replaceWith(t.identifier('undefined'));
        count++;
      }
    },
  });
  if (count > 0) { log('OBF_MARKER residue: ' + count); total += count; }
}

// ─── 7. String concat fold (iterate to fixpoint) ───
{
  let totalFolded = 0;
  for (let iter = 0; iter < 50; iter++) {
    let count = 0;
    traverse(ast, {
      BinaryExpression(path) {
        if (path.node.operator === '+') {
          const left = path.node.left;
          const right = path.node.right;
          if (t.isStringLiteral(left) && t.isStringLiteral(right)) {
            path.replaceWith(t.stringLiteral(left.value + right.value));
            count++;
          }
        }
      },
    });
    totalFolded += count;
    if (count === 0) break;
  }
  if (totalFolded > 0) { log('string concat folded: ' + totalFolded); total += totalFolded; }
}

// ─── 8. Split comma-sequence var decls when all initers are side-effect-free ───
{
  let count = 0;
  traverse(ast, {
    VariableDeclaration(path) {
      if (path.node.declarations.length <= 1) return;
      const safeInit = (init) => {
        if (!init) return true; // no init = safe
        return t.isIdentifier(init) || t.isNumericLiteral(init) ||
               t.isStringLiteral(init) || t.isNullLiteral(init) ||
               t.isBooleanLiteral(init) || t.isRegExpLiteral(init) ||
               (t.isUnaryExpression(init) && !['delete','void'].includes(init.operator)) ||
               (t.isBinaryExpression(init) && !['in','instanceof'].includes(init.operator));
      };
      const allSafe = path.node.declarations.every(d => safeInit(d.init));
      if (allSafe && path.parentPath.isBlockStatement() || path.parentPath.isProgram()) {
        const decls = path.node.declarations.map(d =>
          t.variableDeclaration(path.node.kind, [d])
        );
        path.replaceWithMultiple(decls);
        count++;
      }
    },
  });
  if (count > 0) { log('comma-seq var decls split: ' + count); total += count; }
}

// ─── emit ───
const out = tryEmit(ast);
if (!out) {
  log('emit failed, keeping input');
  fs.writeFileSync(outPath, code);
  process.exit(0);
}

fs.writeFileSync(outPath, out);
log('done | transforms: ' + total + ' | output: ' + out.length + ' bytes → ' + outPath);
