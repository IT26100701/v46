#!/usr/bin/env node
'use strict';
/**
 * numeric_table_fold.js — Stage G3
 *
 * JS-Confuser and friends ship a flat table of NUMBERS used as a register file
 * for var-masking and as a `slice()` backing store:
 *
 *     const genFn2 = [ -783, -690, -857, 18, 402, ... ];   // 121 numbers
 *     function genFn9(a, b) { return genFn2.slice(a, b); }
 *     ...genFn9(0, 6), -430, -5, 170, -960, ...genFn9(10, 12)...
 *
 * Nothing ever writes to `genFn2` (0 assignments, 0 push/splice) and every
 * call passes constant arguments, so the entire indirection is dead weight that
 * also HIDES the constants from every later stage: `cff_hard_unroll` skips
 * cases whose discriminant is a table read, `case_label_fold` cannot evaluate
 * `case a - b`, and a reader has to mentally eval 123 slices.
 *
 * This stage folds:
 *   1. helper(a, b) -> table.slice(a, b)   with constant a/b  -> array literal
 *   2. table[const]                       -> the literal
 *   3. helper(a) -> table[a]               with constant a
 *
 * SAFETY — folding a read is only correct if the table is never mutated.
 * A table with any write, push, splice, sort, reverse, shift, unshift, pop or
 * a reassignment of the binding itself is left completely untouched. Same for
 * a helper that is called with a non-constant argument anywhere.
 */
const fs = require('fs');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3];
if (!INPUT || !OUTPUT) {
  console.error('Usage: node numeric_table_fold.js <input.js> <output.js>');
  process.exit(1);
}

// A binding is "pure data" only if nothing in the program can change it.
const MUTATORS = /^(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)$/;
const isPureNumber = (n) => typeof n === 'number' && Number.isFinite(n);

function signVal(e) {
  if (!e) return null;
  if (e.type === 'NumericLiteral') return e.value;
  if (e.type === 'UnaryExpression' && (e.operator === '-' || e.operator === '+') && e.argument.type === 'NumericLiteral') {
    return e.operator === '-' ? -e.argument.value : e.argument.value;
  }
  return null;
}
function makeIntNode(v) {
  return v < 0 ? t.unaryExpression('-', t.numericLiteral(-v)) : t.numericLiteral(v);
}
function main() {
  const code = fs.readFileSync(INPUT, 'utf8');
  const ast = parser.parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    errorRecovery: true,
    plugins: ['optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'topLevelAwait'],
  });

  // ── 1. Collect candidate tables: identifiers bound to a flat numeric array ──
  /** @type {Map<string, {name:string, elems:number[], pure:boolean, binding:any}>} */
  const tables = new Map();
  const helperOf = new Map(); // helperName -> {table, mode, params}

  traverse(ast, {
    VariableDeclarator(path) {
      const { id, init } = path.node;
      if (!t.isIdentifier(id) || !t.isArrayExpression(init)) return;
      if (!init.elements.length) return;
      // Flat + all numbers: this is a register file, not a data structure.
      // `-783` is a UnaryExpression, not a NumericLiteral, so accept both.
      const vals = init.elements.map(signVal);
      if (!vals.every((v) => v !== null)) return;
      tables.set(id.name, { name: id.name, elems: vals, pure: true, binding: path.scope.getBinding(id.name) });
    },
    // Reassignment or mutation anywhere poisons the candidate.
    AssignmentExpression(path) {
      const l = path.node.left;
      const root = t.isMemberExpression(l) ? l.object : l;
      if (!t.isIdentifier(root)) return;
      const rec = tables.get(root.name);
      if (rec) rec.pure = false;
    },
    CallExpression(path) {
      const c = path.node.callee;
      if (!t.isMemberExpression(c) || !t.isIdentifier(c.object)) return;
      if (!MUTATORS.test(c.property.name || (c.property.value || ''))) return;
      const rec = tables.get(c.object.name);
      if (rec) rec.pure = false;
    },
    UpdateExpression(path) {
      const a = path.node.argument;
      if (!t.isIdentifier(a)) return;
      const rec = tables.get(a.name);
      if (rec) rec.pure = false;
    },
  });

  const live = new Map();
  for (const [k, v] of tables) if (v.pure && v.binding) live.set(k, v);

  // ── 2. Find slice/accessor helpers that wrap a live table ──────────────────
  // `function h(a,b){ return T.slice(a,b) }`  |  `function h(a){ return T[a] }`
  //  |  `function h(a,b){ return T.slice(a,b) }` where the return is a rest/spread
  traverse(ast, {
    FunctionDeclaration(path) {
      const { id, params, body } = path.node;
      if (!id) return;
      const ret = body.body.find((n) => t.isReturnStatement(n));
      if (!ret || !ret.argument) return;
      const callee = t.isCallExpression(ret.argument) ? ret.argument.callee : null;
      if (callee && t.isMemberExpression(callee) && t.isIdentifier(callee.object) && callee.property.name === 'slice') {
        const rec = live.get(callee.object.name);
        if (rec && params.length === 2) helperOf.set(id.name, { table: rec, mode: 'slice', params });
      }
    },
    VariableDeclarator(path) {
      const { id, init } = path.node;
      if (!t.isIdentifier(id) || !t.isFunctionExpression(init)) return;
      const { params, body } = init;
      const ret = body.body.find((n) => t.isReturnStatement(n));
      if (!ret || !ret.argument) return;
      const callee = t.isCallExpression(ret.argument) ? ret.argument.callee : null;
      if (callee && t.isMemberExpression(callee) && t.isIdentifier(callee.object) && callee.property.name === 'slice') {
        const rec = live.get(callee.object.name);
        if (rec && params.length === 2) helperOf.set(id.name, { table: rec, mode: 'slice', params });
      }
    },
  });

  // ── 3. Only trust a helper if EVERY call passes constant args ──────────────
  const safeHelpers = new Set();
  for (const [name, h] of helperOf) {
    const binding = (ast.program.scope && ast.program.scope.getBinding(name)) || null;
    const refs = binding ? binding.referencePaths : [];
    let ok = refs.length > 0;
    for (const r of refs) {
      if (!r.parentPath || !r.parentPath.isCallExpression()) { ok = false; break; }
      const args = r.parentPath.node.arguments;
      if (args.length !== h.params.length) { ok = false; break; }
      for (const a of args) {
        if (a.type !== 'NumericLiteral') { ok = false; break; }
      }
      if (!ok) break;
    }
    if (ok) safeHelpers.add(name);
  }

  // ── 4. Fold ────────────────────────────────────────────────────────────────
  let sliceFolds = 0, indexFolds = 0, inlined = 0, tablesDropped = 0;

  traverse(ast, {
    // Don't walk into a table we are about to delete.
    CallExpression: {
      enter(path) {
        if (!t.isIdentifier(path.node.callee)) return;
        const h = helperOf.get(path.node.callee.name);
        if (!h || !safeHelpers.has(path.node.callee.name)) return;
        const args = path.node.arguments;
        if (!args.every((a) => a.type === 'NumericLiteral')) return;
        const start = args[0].value, end = args[1].value;
        const sliced = h.table.elems.slice(start, end);
        if (sliced.length > 200) return; // absurd slice, probably a lie
        path.replaceWith(t.arrayExpression(sliced.map((v) => t.numericLiteral(v))));
        sliceFolds++;
        inlined++;
      },
    },
    MemberExpression: {
      enter(path) {
        const obj = path.node.object;
        if (!t.isIdentifier(obj)) return;
        const rec = live.get(obj.name);
        if (!rec) return;
        // Don't fold the binding's own init.
        if (path.parentPath.isVariableDeclarator() && path.parentPath.node.init === path.node) return;
        if (!t.isNumericLiteral(path.node.property, { value: undefined }) && path.node.computed) return;
        if (path.node.computed && path.node.property.type !== 'NumericLiteral') return;
        if (!path.node.computed && !t.isIdentifier(path.node.property)) return;
        const idx = path.node.computed ? path.node.property.value : null;
        if (idx === null) return;
        if (idx < 0 || idx >= rec.elems.length) return;
        // Reads of a whole helper function, not the table: skip.
        path.replaceWith(t.numericLiteral(rec.elems[idx]));
        indexFolds++;
        inlined++;
      },
    },
  });

  // ── 5. Drop tables + helpers that are now unreferenced ──────────────────────
  traverse(ast, {
    Program(path) {
      // First pass: count remaining references.
      let changed = true;
      let rounds = 0;
      while (changed && rounds < 6) {
        changed = false; rounds++;
        for (const name of [...live.keys(), ...safeHelpers]) {
          const binding = path.scope.getBinding(name);
          if (!binding) continue;
          if (binding.referenced) continue;
          if (binding.references === 0 && binding.constantViolations.length === 0) {
            // Remove the declaration.
            for (const p of binding.paths) {
              const parent = p.parentPath;
              if (!parent) continue;
              if (parent.isVariableDeclaration() && parent.node.declarations.length === 1) {
                parent.remove();
              } else if (parent.isVariableDeclarator()) {
                parent.remove();
              } else {
                p.remove();
              }
              changed = true;
              if (live.has(name)) tablesDropped++;
            }
          }
        }
      }
    },
  });

  const out = generate(ast, { comments: true, compact: false, concise: false }, code).code;
  fs.writeFileSync(OUTPUT, out);
  console.log('[numeric_table_fold] slice=' + sliceFolds + ' index=' + indexFolds +
    ' inlined=' + inlined + ' tables=' + tables.size + ' pure=' + live.size +
    ' helpers=' + helperOf.size + ' safe=' + safeHelpers.size + ' dropped=' + tablesDropped);
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error('numeric_table_fold error: ' + e.message);
  process.exit(1);
}
