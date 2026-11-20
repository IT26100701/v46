#!/usr/bin/env node
/**
 * var_mask_restore.js — Restore JS-Confuser "Variable Masking" (varMask).
 *
 * Technique: local variables are consolidated into a rest-parameter array.
 *
 *   function fibonacci(...__p_8hBO_varMask) {
 *     __p_8hBO_varMask["a"] = 0;         // string keys = named locals
 *     __p_8hBO_varMask[2]   = 1;         // numeric keys = positional args
 *     var c = __p_8hGV_varMask[-172];    // negative keys = internal temporaries
 *     ...
 *     return __p_8hBO_varMask[-172];
 *   }
 *
 * Restoring it requires:
 *  1. Find masked functions (rest param whose name ends in varMask / is referenced
 *     with string + negative-numeric subscripts).
 *  2. Build the key→semantic-name map:
 *       "a"  → a real identifier        (already readable, keep)
 *       0..  → param name from the call site, or fallback fnName_paramN
 *       < -1  → local temp name         (fallback tmp_N)
 *  3. Rewrite every `MASK[key]` to a real `var`/param binding, and hoist the
 *     initial assignments out of the function into proper declarations.
 *
 * The result is ordinary JS:
 *   function fibonacci(num) { var a = 0, b = 1, c = num; ... }
 *
 * Usage: node var_mask_restore.js <input.js> [output.js]
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3] || (INPUT ? INPUT.replace(/\.js$/, '.unmasked.js') : 'out.js');
if (!INPUT) { console.error('Usage: node var_mask_restore.js <input.js> [output.js]'); process.exit(1); }
const code = fs.readFileSync(INPUT, 'utf8');
const V = process.env.VMASK_VERBOSE === '1';

function emit(out, note) {
  fs.writeFileSync(OUTPUT, out);
  console.log('[var_mask] ' + note + ' | ' + OUTPUT + ' (' + out.length + ' bytes)');
  process.exit(0);
}
function bail(msg) { emit(code, msg + ' — keep input'); }

const RESERVED = new Set([
  'break','case','catch','class','const','continue','debugger','default','delete','do',
  'else','enum','export','extends','false','finally','for','function','if','import','in',
  'instanceof','new','null','return','super','switch','this','throw','true','try','typeof',
  'var','void','while','with','yield','let','static','await','arguments','eval','undefined',
]);

let ast;
try {
  ast = parser.parse(code, {
    sourceType: 'script', errorRecovery: true, allowReturnOutsideFunction: true,
    plugins: ['classProperties', 'optionalChaining', 'nullishCoalescingOperator',
      'dynamicImport', 'topLevelAwait', 'numericSeparator', 'optionalCatchBinding'],
  });
} catch (e) { bail('parse failed: ' + e.message); }

// ── detect masked functions ──
// A masked function has a RestElement param, and the body indexes it with at
// least one string key and/or a negative number.
function findMaskedFunctions() {
  const masked = [];
  traverse(ast, {
    Function(path) {
      const rest = path.node.params.find(p => p.type === 'RestElement' && p.argument.type === 'Identifier');
      if (!rest) return;
      const maskName = rest.argument.name;
      const keys = new Set();
      let hasString = false, hasNegative = false;
      path.traverse({
        MemberExpression(p) {
          if (!t.isIdentifier(p.node.object, { name: maskName })) return;
          const prop = p.node.property;
          if (t.isStringLiteral(prop) || (t.isStringLiteral(prop))) { keys.add(prop.value); hasString = true; }
          else if (t.isUnaryExpression(prop, { operator: '-' }) && t.isNumericLiteral(prop.argument)) {
            keys.add('-' + prop.argument.value); hasNegative = true;
          } else if (t.isNumericLiteral(prop)) { keys.add(String(prop.value)); }
        },
      });
      if (keys.size === 0) return;
      // Must look like masking: string keys, or negative keys, or many numeric keys
      if (!hasString && !hasNegative && keys.size < 3) return;
      masked.push({ path, maskName, keys: [...keys] });
    },
  });
  return masked;
}

const masked = findMaskedFunctions();
if (V) console.log('[var_mask] masked functions:', masked.length);
if (!masked.length) bail('no variable-masking found');

// ── collect call-site argument names so positional keys get real names ──
// Returns Map<argIndex, paramName> from every call of fnName across the file.
function collectCallArgNames(fnName) {
  const map = new Map();
  traverse(ast, {
    CallExpression(p) {
      if (!t.isIdentifier(p.node.callee, { name: fnName })) return;
      p.node.arguments.forEach((a, i) => {
        if (t.isIdentifier(a) && !hasBinding(p, a.name) && !map.has(i)) map.set(i, a.name);
      });
    },
  });
  return map;
}
function hasBinding(path, name) {
  const b = path.scope.getBinding(name);
  return !!(b && b.path && b.path.isFunctionDeclaration());
}

// ── per function: assign names, rewrite, hoist declarations ──
let funcsFixed = 0, keysTotal = 0;

for (const m of masked) {
  const { path: fnPath, maskName, keys } = m;
  const fnName = fnPath.node.id ? fnPath.node.id.name : null;
  const callArgNames = fnName ? collectCallArgNames(fnName) : new Map();

  // Build key → binding name
  const keyToName = new Map();
  const usedNames = new Set();
  const isValidId = (n) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n) && !RESERVED.has(n);

  // 1. string keys are already names (or fall back to obj_<key>)
  for (const k of keys) {
    if (k.startsWith('-') || /^\d+$/.test(k)) continue;
    let name = k;
    if (!isValidId(name)) name = 'k_' + k.replace(/[^A-Za-z0-9_$]/g, '_');
    if (usedNames.has(name)) name = name + '_';
    usedNames.add(name);
    keyToName.set(k, name);
  }
  // 2. non-negative numeric keys = positional args
  for (const k of keys) {
    if (!/^\d+$/.test(k)) continue;
    const idx = Number(k);
    const name = callArgNames.get(idx) || ('arg' + idx);
    let finalName = name;
    if (usedNames.has(finalName)) finalName = 'arg' + idx + '_';
    if (!isValidId(finalName)) finalName = 'arg' + idx;
    usedNames.add(finalName);
    keyToName.set(k, finalName);
  }
  // 3. negative keys = internal temporaries
  let tmpN = 0;
  for (const k of keys) {
    if (!k.startsWith('-')) continue;
    let name = 'tmp' + (tmpN++);
    while (usedNames.has(name)) name = 'tmp' + (tmpN++);
    usedNames.add(name);
    keyToName.set(k, name);
  }
  keysTotal += keyToName.size;

  // 3b. positional keys become plain `var`s in the body (via hoisting below);
  //     do NOT rewrite the rest param into explicit params — a rest array indexed
  //     by number is legal JS and rewriting params risks invalid signatures.
  //     Ensure each mapped binding gets a `var` declaration so it's a real binding.
  const paramNames = fnPath.node.params
    .filter(p => p.type === 'Identifier').map(p => p.name);
  keyToName.forEach((name) => { if (!paramNames.includes(name)) paramNames.push(name); });

  // 4. rewrite every MASK[key] → identifier
  fnPath.traverse({
    MemberExpression(p) {
      if (!t.isIdentifier(p.node.object, { name: maskName })) return;
      let key = null;
      const prop = p.node.property;
      if (p.node.computed && t.isStringLiteral(prop)) key = prop.value;
      else if (p.node.computed && t.isNumericLiteral(prop)) key = String(prop.value);
      else if (p.node.computed && t.isUnaryExpression(prop, { operator: '-' }) && t.isNumericLiteral(prop.argument)) key = '-' + prop.argument.value;
      if (key === null || !keyToName.has(key)) return;
      // Don't rewrite if it's an assignment TARGET to an object key (mask["x"] = v IS the var store — rewrite it)
      p.replaceWith(t.identifier(keyToName.get(key)));
    },
  });

  // 5. declare every mapped binding so they're real bindings, not implicit globals
  const body = fnPath.node.body;
  if (body.type === 'BlockStatement') {
    // don't redeclare existing params
    const existingParams = new Set(fnPath.node.params
      .filter(p => p.type === 'Identifier').map(p => p.name));
    const alreadyDeclared = new Set();
    for (const st of body.body) {
      if (st.type === 'VariableDeclaration') {
        for (const d of st.declarations) {
          if (t.isIdentifier(d.id)) alreadyDeclared.add(d.id.name);
        }
      }
    }
    const needDecl = [...keyToName.values()].filter(n => !existingParams.has(n) && !alreadyDeclared.has(n));
    if (needDecl.length) {
      body.body.unshift(t.variableDeclaration('var',
        needDecl.map(n => t.variableDeclarator(t.identifier(n), null))));
    }
  }
  funcsFixed++;
}

if (V) console.log('[var_mask] functions fixed:', funcsFixed, 'keys:', keysTotal);

// ── drop now-unused mask param remnants & dedupe var decls ──
traverse(ast, {
  Function(path) {
    // if a var declaration declares the same name twice in one function, merge
    const seen = new Set();
    const body = path.node.body;
    if (body.type !== 'BlockStatement') return;
    const out = [];
    for (const st of body.body) {
      if (st.type === 'VariableDeclaration' && st.kind === 'var') {
        const fresh = st.declarations.filter(d => {
          if (!t.isIdentifier(d.id)) return true;
          if (seen.has(d.id.name)) return false;
          seen.add(d.id.name);
          return true;
        });
        if (!fresh.length) continue;
        out.push(fresh.length === st.declarations.length ? st : t.variableDeclaration('var', fresh));
      } else out.push(st);
    }
    body.body = out;
  },
});

let outCode;
try {
  outCode = generate(ast, { compact: false, comments: false }).code;
  new vm.Script(outCode);
} catch (e) {
  bail('output invalid: ' + e.message.slice(0, 90));
}

emit(outCode, 'functions=' + funcsFixed + ' keys=' + keysTotal);
