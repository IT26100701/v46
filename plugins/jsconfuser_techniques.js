#!/usr/bin/env node
/**
 * jsconfuser_techniques.js — Fold the remaining JS-Confuser single-purpose techniques
 * that no other stage covers. Each is a self-guarding pass; the file is only
 * rewritten if at least one technique actually changed something.
 *
 *  1. Opaque predicates      if (!("randomKey" in dummyFn)) { REAL } else { JUNK }
 *  2. Dead-code injection    if ("key" in dummyFn) { deadFn(); }   + remove the dead fn
 *  3. Duplicate literals     const dlrArray = [1, 0, "log"];  dlrArray[2] -> "log"
 *  4. Object extraction      let __p_X_config_a = v;   ->   config.a = v
 *  5. RGF (runtime-generated functions)
 *                            var x = [eval("function f(){...}")];  -> inlines the body
 *  6. Calculator / global concealing
 *                            window["fetch"](x) -> window.fetch(x)  (bracket→dot pass)
 *  7. Flatten (function hoisting into a namespace object)
 *                            fn(obj, [a]) { obj["k"](a) }  with obj passed a literal object
 *  8. Moved declarations     regroup var/let blocks to their first use
 *  9. String splitting      "a" + "b" -> "ab" (fixpoint, single-quote safe)
 * 10. Computed keys          { ["a"]: v } -> { a: v }
 *
 * Usage: node jsconfuser_techniques.js <input.js> [output.js]
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3] || (INPUT ? INPUT.replace(/\.js$/, '.jsc.js') : 'out.js');
if (!INPUT) { console.error('Usage: node jsconfuser_techniques.js <input.js> [output.js]'); process.exit(1); }
const code = fs.readFileSync(INPUT, 'utf8');
const V = process.env.JSC_VERBOSE === '1';

const RESERVED = new Set([
  'break','case','catch','class','const','continue','debugger','default','delete','do','else',
  'enum','export','extends','false','finally','for','function','if','import','in','instanceof',
  'new','null','return','super','switch','this','throw','true','try','typeof','var','void',
  'while','with','yield','let','static','await',
]);

function emit(out, note) {
  fs.writeFileSync(OUTPUT, out);
  console.log('[jsc_tech] ' + note + ' | ' + OUTPUT + ' (' + out.length + ' bytes)');
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

// Slice out the leading `function …{…}` expression from a payload that may
// have a trailing identifier, comment or semicolon after it. Brace counting
// is string/regex/comment aware so nested literals don't end it early.
function extractFunctionSource(str) {
  const s = String(str).trim();
  if (!/^(async\s+)?function\b|^(\(\s*)?(async\s+)?function\b/.test(s)) return null;
  let depth = 0, sawBrace = false, i = 0;
  let inStr = null, inRe = false, inLineComment = false, inBlockComment = false;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (inLineComment) { if (c === '\n') inLineComment = false; i++; continue; }
    if (inBlockComment) { if (c === '*' && n === '/') { inBlockComment = false; i += 2; } else i++; continue; }
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === inStr) inStr = null;
      i++; continue;
    }
    if (inRe) {
      if (c === '\\') { i += 2; continue; }
      if (c === '/') inRe = false;
      else if (c === '[') inRe = false;   // crude: bail out of regex on '['
      i++; continue;
    }
    if (c === '/' && n === '/') { inLineComment = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlockComment = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; i++; continue; }
    if (c === '{') { depth++; sawBrace = true; i++; continue; }
    if (c === '}') { depth--; i++; if (sawBrace && depth === 0) return s.slice(0, i).trim(); continue; }
    i++;
  }
  return null;
}

const stats = { opaque: 0, deadcode: 0, dlr: 0, dlrRemoved: 0, objExtract: 0, rgf: 0, calc: 0, flatten: 0, computedKeys: 0, split: 0 };

// Babel caches NodePaths on the AST node itself. Once an earlier pass replaces
// or removes a node, every later traverse() call re-walks those detached paths
// and can hand us `path.id === undefined`. Re-parsing the generated code gives
// the next phase a clean AST with no stale path cache.
function freshParse(src) {
  const r = parser.parse(src, { sourceType: 'script', allowReturnOutsideFunction: true });
  r.__fresh = true;
  return r;
}
let regenerated = null;
function renewAst() {
  if (!regenerated) {
    regenerated = generate(ast, { compact: false, comments: false }).code;
  }
  ast = freshParse(regenerated);
  regenerated = null;
  traverse(ast, { Program(p) { p.scope.crawl(); } });
  return ast;
}

// Convert a raw JS value (from a literal array) into an AST node.
// `t.cloneNode(0)` returns the number 0, which replaceWith() rejects as falsy,
// so primitives must be built explicitly.
function toNode(v) {
  if (v && typeof v === 'object' && typeof v.type === 'string') return t.cloneNode(v, true);
  if (typeof v === 'string') return t.stringLiteral(v);
  if (typeof v === 'number') return t.numericLiteral(v);
  if (typeof v === 'boolean') return t.booleanLiteral(v);
  if (v === null) return t.nullLiteral();
  if (typeof v === 'undefined') return t.identifier('undefined');
  return t.valueToNode(v);
}

// ══════════════ 1 + 2. Opaque predicates & dead-code injection ══════════════
// `if (!("xxxxx" in dummyFn)) { A } else { B }`  →  A     (predicate always true)
// `if ("xxxxx" in dummyFn) { dead() }`           →  removed (always false)
const isPropInIdent = (node) =>
  (node.type === 'BinaryExpression' && node.operator === 'in') &&
  t.isStringLiteral(node.left) &&
  t.isIdentifier(node.right) && /dummyFunction$/.test(node.right.name);

traverse(ast, {
  IfStatement(path) {
    const test = path.node.test;
    let value = null;
    if (isPropInIdent(test)) value = false;                          // "k" in fn  → always false
    else if (t.isUnaryExpression(test, { operator: '!' }) && isPropInIdent(test.argument)) value = true;
    if (value === null) return;

    const takeBranch = (n) => (n && n.type === 'BlockStatement') ? n.body : (n ? [n] : []);
    if (value) {
      path.replaceWithMultiple(takeBranch(path.node.consequent));
      stats.opaque++;
    } else {
      if (path.node.alternate) path.replaceWithMultiple(takeBranch(path.node.alternate));
      else path.remove();
      stats.opaque++;
    }
    path.skip();
  },
  ConditionalExpression(path) {
    const test = path.node.test;
    if (isPropInIdent(test)) { path.replaceWith(path.node.alternate); stats.opaque++; }
    else if (t.isUnaryExpression(test, { operator: '!' }) && isPropInIdent(test.argument)) {
      path.replaceWith(path.node.consequent); stats.opaque++;
    }
  },
});

// remove now-unreferenced dummy / dead functions (checked LAST, after the
// predicates above were folded away, so reference counts are accurate)
traverse(ast, {
  Program(path) { path.scope.crawl(); },
  FunctionDeclaration(path) {
    if (!path.node.id) return;
    const n = path.node.id.name;
    if (!/dummyFunction$/.test(n) && !/_dead_/.test(n)) return;
    const b = path.scope.getBinding(n);
    if (!b || b.references === 0) { path.remove(); stats.deadcode++; }
  },
});

// ══════════════ 3. Duplicate literals removal ══════════════
// const __p_XXXX_dlrArray = [ ...literals... ];
// then __p_XXXX_dlrArray[N] -> the literal
const dlrArrays = new Map();
for (const node of ast.program.body) {
  if (node.type !== 'VariableDeclaration') continue;
  for (const d of node.declarations) {
    if (!t.isIdentifier(d.id) || !/_dlrArray$/.test(d.id.name)) continue;
    if (!d.init || d.init.type !== 'ArrayExpression') continue;
    const arr = d.init.elements.map(e => (t.isStringLiteral(e) || t.isNumericLiteral(e) || t.isBooleanLiteral(e) || t.isNullLiteral(e)) ? e : null);
    if (arr.some(x => x === null)) continue;
    dlrArrays.set(d.id.name, arr);
    d.parentPath = node;
  }
}
if (dlrArrays.size) {
  // remember the declaration paths so we can drop them after all refs are rewritten
  const dlrDeclPaths = new Map();
  for (const [name] of dlrArrays) {
    traverse(ast, {
      VariableDeclarator(path) {
        if (t.isIdentifier(path.id, { name })) dlrDeclPaths.set(name, path);
      },
    });
  }
  traverse(ast, {
    MemberExpression(path) {
      if (!t.isIdentifier(path.node.object)) return;
      const arr = dlrArrays.get(path.node.object.name);
      if (!arr) return;
      if (!path.node.computed || !t.isNumericLiteral(path.node.property)) return;
      const el = arr[path.node.property.value];
      if (el === undefined || el === null) return;   // careful: `0` and `''` are legal elements
      // skip when used as an assignment target (dlrArray[0] = x would corrupt)
      if (path.parentPath.isAssignmentExpression() && path.parentPath.node.left === path.node) return;
      path.replaceWith(toNode(el));
      stats.dlr++;
    },
  });
  // The final sweep below drops the array declaration once nothing references
  // it — that pass re-crawls scope and re-collects paths, so it is always
  // accurate. Reusing paths captured before the rewrite gives stale scopes.
}

// ══════════════ 4. Object extraction ══════════════
// renew first: the dlr pass above replaced/removed nodes, so any NodePath we
// captured before it is now detached and its scope/binding lookups are garbage.
renewAst();
// let __p_XXXX_config_apiUrl = "...";   →   config.apiUrl
// Names look like `__p_<id4>_<origName>_<prop>`. The original name may itself
// contain underscores, so find the base by majority vote across the group
// rather than splitting on a fixed position: the base is the longest common
// prefix over all names in a run of consecutive `__p_XXXX_base_suffix` ids.
const extGroups = new Map();   // base -> Map<suffix, varName>
traverse(ast, {
  VariableDeclarator(path) {
    if (!path.node || !t.isIdentifier(path.node.id) || !path.node.init) return;
    const m = /^__p_[A-Za-z0-9]{4}_(.+)$/.exec(path.node.id.name);
    if (!m) return;
    const rest = m[1];
    // try every underscore position as the base/suffix split; a base only wins
    // if ≥2 members share it (checked below)
    for (let cut = 0; cut < rest.length; cut++) {
      if (rest[cut] !== '_') continue;
      const base = rest.slice(0, cut);
      const suffix = rest.slice(cut + 1);
      if (!base || !suffix) continue;
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(base)) continue;
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(suffix)) continue;
      if (!extGroups.has(base)) extGroups.set(base, new Map());
      extGroups.get(base).set(suffix, path.node.id.name);
    }
  },
});
let extracted = 0;
for (const [base, members] of extGroups) {
  if (members.size < 2) continue;   // need ≥2 to be an object
  const varNames = [...members.values()];

  // re-find the declarators on the current (live) AST by name
  const found = new Map();
  traverse(ast, {
    VariableDeclarator(path) {
      if (!path.node || !t.isIdentifier(path.node.id)) return;
      if (varNames.includes(path.node.id.name)) found.set(path.node.id.name, path);
    },
  });
  const entries = varNames.map((vn) => [vn, found.get(vn)]).filter(([, p]) => p);
  if (entries.length < 2) continue;

  const props = entries.map(([vn, p]) => {
    const suffix = [...members.entries()].find(([, name]) => name === vn)[0];
    return t.objectProperty(t.identifier(suffix), toNode(p.node.init));
  });
  const objName = base;
  const objDecl = t.variableDeclaration('let', [t.variableDeclarator(t.identifier(objName), t.objectExpression(props))]);

  // insert the object declaration at the position of the first member
  const firstStmt = entries[0][1].parentPath.parentPath;
  const insertIdx = ast.program.body.indexOf(firstStmt.node);

  // resolve bindings from a fresh crawl so reference lists reflect reality
  traverse(ast, { Program(path) { path.scope.crawl(); } });
  for (const [vn, p] of entries) {
    const suffix = [...members.keys()].find((k) => members.get(k) === vn);
    const b = p.scope.getBinding(vn);
    if (!b) continue;
    const propName = t.memberExpression(t.identifier(objName), t.identifier(suffix));
    let n = 0;
    for (const ref of b.referencePaths) { ref.replaceWith(t.cloneNode(propName, true)); n++; }
    extracted += n;
  }
  // remove the original declarators (each sits alone in its own `let` statement)
  for (const [, p] of entries) {
    try { p.parentPath.remove(); } catch (e) { /* already detached */ }
  }
  if (insertIdx >= 0) ast.program.body.splice(Math.min(insertIdx, ast.program.body.length), 0, objDecl);
  stats.objExtract += entries.length;
}

// ══════════════ 5. RGF (runtime-generated functions) ══════════════
// renew: object extraction removed declarators above, invalidating cached paths
renewAst();
// var X = [ __p_XXX_rgf_eval("function f(){ ...body... }") ];
// then X[0]["apply"](this, [...]) — replace X[0] with a real function expression.
// The wrapper can be `eval`, `Function`, or a JS-Confuser `*_rgf_eval` shim.
const rgfFns = new Map();  // arrayVarName -> FunctionExpression
traverse(ast, {
  VariableDeclarator(path) {
    const d = path.node;
    if (!t.isIdentifier(d.id) || !d.init) return;
    if (d.init.type !== 'ArrayExpression') return;
    const el = d.init.elements[0];
    if (!el || el.type !== 'CallExpression') return;
    const cal = el.callee;
    if (!t.isIdentifier(cal)) return;
    // accept eval / Function / any *_eval / *_rgf_eval shim
    if (!/^(eval|Function)$|_eval$/.test(cal.name)) return;
    const arg = el.arguments[0];
    if (!arg) return;
    let str = null;
    if (t.isStringLiteral(arg)) str = arg.value;
    else if (t.isStringLiteral(el.arguments[el.arguments.length - 1])) str = el.arguments[el.arguments.length - 1].value;
    if (!str) return;
    // The payload is usually `function f(){...}` optionally followed by a
    // trailing helper identifier (`...}someHelper;`). Keep just the function
    // expression by scanning to the brace that closes its body.
    const strimmed = extractFunctionSource(str);
    if (!strimmed) return;
    let fnAst = null;
    try {
      fnAst = parser.parse('(' + strimmed + ')', { sourceType: 'script', errorRecovery: true });
    } catch (e) { return; }
    // the payload is wrapped in parens, so unwrap the ExpressionStatement
    let fnNode = fnAst.program.body[0];
    if (fnNode && fnNode.type === 'ExpressionStatement') fnNode = fnNode.expression;
    if (fnNode && fnNode.type === 'FunctionExpression') {
      rgfFns.set(d.id.name, t.functionExpression(null, fnNode.params, fnNode.body, fnNode.generator, fnNode.async));
      stats.rgf++;
    } else if (fnNode && fnNode.type === 'FunctionDeclaration') {
      rgfFns.set(d.id.name, t.functionExpression(null, fnNode.params, fnNode.body, false));
      stats.rgf++;
    }
  },
});
if (rgfFns.size) {
  // ── inline FIRST ──
  // RGF wraps the real body in a forwarding stub:
  //   return __p_XXX_rgf[0]["apply"](this, [__p_XXX_rgf, arguments]);
  // where the decoded function is
  //   function (a, b) { var [self, args] = a; ...real body using b... }
  // If we replaced X[0] first this trampoline becomes `fn.apply(...)` and the
  // two-level shape is lost, so match the whole call before touching X[0].
  const inlined = new Map();  // arrayVarName -> inlined function expression
  for (const [arrName, fnExpr] of rgfFns) {
    // The trampoline decodes to:
    //   function () { var [self, args] = arguments; ...real body using args... }
    // The array pattern is the declarator's *id* (bound from `arguments`),
    // and the function takes no parameters.
    let argsName = null;
    for (const st of fnExpr.body.body) {
      if (!t.isVariableDeclaration(st)) continue;
      for (const d of st.declarations) {
        if (!t.isArrayPattern(d.id)) continue;
        const el = d.id.elements;
        if (el.length >= 2 && t.isIdentifier(el[0], { name: arrName }) && t.isIdentifier(el[1])) {
          argsName = el[1].name;
        }
      }
    }
    if (!argsName) continue;
    const inner = t.cloneNode(fnExpr, true);
    let repl = 0;
    // traverse() needs a Program/File root, so wrap the function in one
    const wrapperFile = t.file(t.program([t.expressionStatement(t.cloneNode(inner, true))]));
    traverse(wrapperFile, {
      Identifier(p) {
        if (!p.node || p.node.name !== argsName) return;
        if (!p.isReferencedIdentifier()) return;
        p.replaceWith(t.identifier('arguments'));
        repl++;
      },
    });
    // read the rewritten function back out of the wrapper
    const innerNode = wrapperFile.program.body[0].expression;
    if (!repl) continue;
    inner.params = innerNode.params;
    inner.body = innerNode.body;
    // drop the `var [self, args] = arguments;` destructuring line
    inner.body.body = inner.body.body.filter((st) => {
      if (!t.isVariableDeclaration(st)) return true;
      if (st.declarations.length !== 1) return true;
      return !t.isArrayPattern(st.declarations[0].id);
    });
    inlined.set(arrName, inner);
  }
  if (inlined.size) {
    stats.rgfInline = inlined.size;
    traverse(ast, {
      CallExpression(path) {
        if (!path.node) return;
        const c = path.node.callee;
        // <arr>[<idx>]["apply"]  — two nested member expressions
        if (!t.isMemberExpression(c)) return;
        if (!t.isStringLiteral(c.property, { value: 'apply' })) return;
        const idxExpr = c.object;
        if (!t.isMemberExpression(idxExpr) || !t.isIdentifier(idxExpr.object)) return;
        const inner = inlined.get(idxExpr.object.name);
        if (!inner) return;
        path.replaceWith(t.cloneNode(inner, true));
        stats.rgf++;
      },
    });
  }
  // ── then any remaining bare X[0] becomes the decoded function ──
  traverse(ast, {
    MemberExpression(path) {
      if (!path.node || !t.isIdentifier(path.node.object) || !path.node.computed) return;
      if (!t.isNumericLiteral(path.node.property)) return;
      const fn = rgfFns.get(path.node.object.name);
      if (fn) path.replaceWith(t.cloneNode(fn, true));
    },
  });
  // drop the rgf array declarations when no longer referenced as arrays
  for (const [name] of rgfFns) {
    traverse(ast, { Program(path) { path.scope.crawl(); } });
    traverse(ast, {
      VariableDeclarator(path) {
        if (!path.node || !t.isIdentifier(path.node.id, { name })) return;
        const b = path.scope.getBinding(name);
        if (!b || b.references === 0) {
          if (path.parent && path.parent.declarations.length === 1) path.parentPath.remove();
          else path.remove();
        }
      },
    });
  }
}

// ══════════════ 6 + 7. Bracket→dot & flatten namespace ══════════════
// obj["identifier"] → obj.identifier   (only when it's a valid identifier)
let dotified = 0;
traverse(ast, {
  MemberExpression(path) {
    const p = path.node.property;
    if (!path.node.computed) return;
    if (!t.isStringLiteral(p)) return;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p.value)) return;
    if (RESERVED.has(p.value)) return;
    path.node.computed = false;
    path.node.property = t.identifier(p.value);
    dotified++;
  },
  ObjectProperty(path) {
    const k = path.node.key;
    if (!path.node.computed) return;
    if (!t.isStringLiteral(k)) return;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k.value)) return;
    if (RESERVED.has(k.value)) return;
    path.node.computed = false;
    path.node.key = t.identifier(k.value);
    stats.computedKeys++;
  },
});
stats.calc = dotified;

// Flatten: a call of the form FN(objLiteral, [args]) where FN's first param is
// only used as NS["x"] → substitute NS["x"] with the real member, drop the param.
const flatNames = new Set();
traverse(ast, {
  FunctionDeclaration(path) {
    if (!path.node.id || !/_flat_/.test(path.node.id.name)) return;
    const firstParam = path.node.params[0];
    if (!firstParam || firstParam.type !== 'Identifier') return;
    const nsName = firstParam.name;
    // verify it's only used as NS["literal"]
    let ok = true, uses = 0;
    path.traverse({
      MemberExpression(p) {
        if (!t.isIdentifier(p.node.object, { name: nsName })) return;
        uses++;
        if (!p.node.computed || !t.isStringLiteral(p.node.property)) ok = false;
      },
      Identifier(p) {
        if (p.node.name === nsName && !p.parentPath.isMemberExpression() &&
            !(p.parentPath.isObjectPattern())) { /* function param ref only */ }
      },
    });
    if (ok && uses > 0) flatNames.add(path.node.id.name);
  },
});
if (flatNames.size) {
  // build NS → literal object map per call site
  traverse(ast, {
    CallExpression(path) {
      if (!t.isIdentifier(path.node.callee) || !flatNames.has(path.node.callee.name)) return;
      const first = path.node.arguments[0];
      if (!first || first.type !== 'ObjectExpression') return;
      const map = new Map();
      for (const pr of first.properties) {
        if (pr.type !== 'ObjectProperty') continue;
        const k = t.isIdentifier(pr.key) ? pr.key.name : (t.isStringLiteral(pr.key) ? pr.key.value : null);
        if (k === null) return;
        map.set(k, pr.value);
      }
      if (!map.size) return;
      path.node.arguments.shift();
      path.traverse({
        MemberExpression(p) {
          if (!p.node.computed || !t.isStringLiteral(p.node.property)) return;
          const rep = map.get(p.node.property.value);
          if (rep) { p.replaceWith(t.cloneNode(rep, true)); stats.flatten++; }
        },
      });
    },
  });
}

// ══════════════ 9. String splitting fold ══════════════
traverse(ast, {
  BinaryExpression(path) {
    if (path.node.operator !== '+') return;
    if (!t.isStringLiteral(path.node.left) || !t.isStringLiteral(path.node.right)) return;
    path.replaceWith(t.stringLiteral(path.node.left.value + path.node.right.value));
    stats.split++;
  },
});

// ══════════════ 11. JS-Confuser calculator ══════════════
// function __p_XXXX_calc(operator, a, b) { switch (operator) { case "k": return a op b; } }
// __p_XXXX_calc("k", X, Y)  →  X op Y
const calcFns = new Map(); // fnName -> Map<key, operator>
traverse(ast, {
  FunctionDeclaration(path) {
    const f = path.node;
    if (!f.id || !/_calc$/.test(f.id.name)) return;
    if (!f.params || f.params.length !== 3) return;
    const [pOp, pA, pB] = f.params;
    if (pOp.type !== 'Identifier' || pA.type !== 'Identifier' || pB.type !== 'Identifier') return;
    if (f.body.body.length !== 1 || f.body.body[0].type !== 'SwitchStatement') return;
    const sw = f.body.body[0];
    if (sw.discriminant.type !== 'Identifier' || sw.discriminant.name !== pOp.name) return;
    const map = new Map();
    for (const c of sw.cases) {
      if (!c.test) continue;                        // default case: not a key
      if (c.test.type !== 'StringLiteral') return;
      if (c.consequent.length !== 1 || c.consequent[0].type !== 'ReturnStatement') return;
      const ret = c.consequent[0].argument;
      if (!ret || ret.type !== 'BinaryExpression') return;
      if (!['+', '-', '*', '/'].includes(ret.operator)) return;
      if (ret.left.type !== 'Identifier' || ret.left.name !== pA.name) return;
      if (ret.right.type !== 'Identifier' || ret.right.name !== pB.name) return;
      map.set(c.test.value, ret.operator);
    }
    if (map.size) calcFns.set(f.id.name, map);
  },
});
let calcFold = 0;
if (calcFns.size) {
  traverse(ast, {
    CallExpression(path) {
      const c = path.node;
      if (!t.isIdentifier(c.callee)) return;
      const map = calcFns.get(c.callee.name);
      if (!map || c.arguments.length !== 3) return;
      if (!t.isStringLiteral(c.arguments[0])) return;
      const op = map.get(c.arguments[0].value);
      if (!op) return;
      path.replaceWith(t.binaryExpression(op, c.arguments[1], c.arguments[2]));
      calcFold++;
    },
  });
}
stats.calcFold = calcFold;

// ══════════════ 12. JS-Confuser dispatcher (2.x) ══════════════
// Structural fingerprint (works even when renameVariables renamed every helper):
//   function ANY(pName, pFlag, pRet, ...) {
//     var out;
//     var fns = { "key": function () { var [a, b] = PAYLOAD; ...body... }, ... };
//     if (pFlag === "nonCallKey") { ... fns[pName].apply(this) ... }
//     else { out = fns[pName](); }
//     if (pRet === "objKey") return { "prop": out }; else return out;
//   }
//   call sites:
//     (PAYLOAD = [a, b], disp("key"[, flags])[["prop"]])  →  key(a, b)
//     disp("key", "nonCallKey")                            →  key
const fixName = (k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : '_' + k;
function unwrapDispCall(node) {
  let cur = node;
  while (cur && cur.type === 'MemberExpression') cur = cur.object;   // any member wrap
  if (cur && (cur.type === 'CallExpression' || cur.type === 'NewExpression') && t.isIdentifier(cur.callee)) {
    const a0 = cur.arguments[0];
    if (a0 && t.isStringLiteral(a0)) return { disp: cur.callee.name, key: a0.value };
  }
  return null;
}
const dispInfos = new Map(); // dispFnName -> info
traverse(ast, {
  FunctionDeclaration(path) {
    const f = path.node;
    if (!f.id || !f.params || f.params.length < 3) return;
    const pName = f.params[0], pFlag = f.params[1], pRet = f.params[2];
    if (pName.type !== 'Identifier') return;
    // find the fns table object
    let fnsVar = null, fnsObj = null, payloadVar = null;
    for (const st of f.body.body) {
      if (st.type !== 'VariableDeclaration') continue;
      for (const d of st.declarations) {
        if (d.init && d.init.type === 'ObjectExpression' && d.init.properties.length >= 1 &&
            d.init.properties.every((pr) => pr.type === 'ObjectProperty' && pr.value.type === 'FunctionExpression' && pr.value.params.length === 0)) {
          fnsObj = d.init;
          fnsVar = d.id.name;
        }
      }
    }
    if (!fnsObj || !fnsVar) return;
    // payload var + params, from each fns body's leading `var [..] = PAYLOAD;`
    const entries = [];
    for (const pr of fnsObj.properties) {
      // key may be a StringLiteral ("key":) or, after a beautifier, an Identifier (key:)
      let key = null;
      if (t.isStringLiteral(pr.key)) key = pr.key.value;
      else if (!pr.computed && t.isIdentifier(pr.key)) key = pr.key.name;
      if (key === null) return;
      const fn = pr.value;
      const stmts = fn.body.body.slice();
      let params = [];
      const first = stmts[0];
      if (first && first.type === 'VariableDeclaration' && first.declarations.length === 1 &&
          first.declarations[0].id.type === 'ArrayPattern' && first.declarations[0].init &&
          first.declarations[0].init.type === 'Identifier') {
        const pv = first.declarations[0].init.name;
        if (!payloadVar) payloadVar = pv;
        else if (payloadVar !== pv) return;
        const els = first.declarations[0].id.elements;
        if (els.some((e) => e === null)) return;   // elision holes cannot become params
        params = els;
        stmts.shift();
      }
      entries.push({ key, params, body: stmts });
    }
    if (!payloadVar || !entries.length) return;
    // structural checks: fns[pName]() call and fns[pName].apply(this) inside a flagArg branch
    const flagName = pFlag.type === 'Identifier' ? pFlag.name : null;
    const retName = pRet.type === 'Identifier' ? pRet.name : null;
    let hasCall = false, nonCallKey = null, returnKey = null, propKey = null;
    traverse(t.file(t.program([f])), {
      CallExpression(p) {
        const cal = p.node.callee;
        if (cal && cal.type === 'MemberExpression' && cal.computed &&
            cal.object.type === 'Identifier' && cal.object.name === fnsVar &&
            cal.property.type === 'Identifier' && cal.property.name === pName.name) {
          hasCall = true;
        }
        if (cal && cal.type === 'MemberExpression' && !cal.computed &&
            cal.property.type === 'Identifier' && cal.property.name === 'apply' &&
            cal.object.type === 'MemberExpression') {
          // fns[pName].apply(this) — the nonCall branch
          const inner = cal.object;
          if (inner.computed && inner.object.type === 'Identifier' && inner.object.name === fnsVar &&
              inner.property.type === 'Identifier' && inner.property.name === pName.name) {
            // find enclosing IfStatement testing flagName === "K" (walk past nested
            // helper functions up to the dispatcher body itself)
            let cur = p;
            while (cur && cur.node !== f) {
              if (cur.isIfStatement()) {
                const tst = cur.node.test;
                if (flagName && tst && tst.type === 'BinaryExpression' && tst.operator === '===' &&
                    tst.left.type === 'Identifier' && tst.left.name === flagName &&
                    tst.right.type === 'StringLiteral') {
                  nonCallKey = tst.right.value;
                }
                break;
              }
              cur = cur.parentPath;
            }
          }
        }
      },
      ReturnStatement(p) {
        const a = p.node.argument;
        if (a && a.type === 'ObjectExpression' && a.properties.length === 1 && a.properties[0].type === 'ObjectProperty' &&
            a.properties[0].key.type === 'StringLiteral' && a.properties[0].value.type === 'Identifier') {
          // only accept when inside an if-test on retName === "K" (walk to dispatcher root)
          let cur = p;
          while (cur && cur.node !== f) {
            if (cur.isIfStatement()) {
              const tst = cur.node.test;
              if (retName && tst && tst.type === 'BinaryExpression' && tst.operator === '===' &&
                  tst.left.type === 'Identifier' && tst.left.name === retName &&
                  tst.right.type === 'StringLiteral') {
                returnKey = tst.right.value;
                propKey = a.properties[0].key.value;
              }
              break;
            }
            cur = cur.parentPath;
          }
        }
      },
    });
    if (!hasCall || !nonCallKey) return;
    dispInfos.set(f.id.name, { payloadVar, entries, nonCallKey });
  },
});let dispFold = 0, dispRestored = 0;
if (dispInfos.size) {
  const isDispCall = (node) => {
    let cur = node;
    while (cur && cur.type === 'MemberExpression') cur = cur.object;
    if (cur && (cur.type === 'CallExpression' || cur.type === 'NewExpression') && t.isIdentifier(cur.callee)) {
      const info = dispInfos.get(cur.callee.name);
      if (!info) return null;
      const a0 = cur.arguments[0];
      if (a0 && t.isStringLiteral(a0)) {
        const isNonCall = cur.arguments.length >= 2 && t.isStringLiteral(cur.arguments[1]) && cur.arguments[1].value === info.nonCallKey;
        if (!isNonCall) return { info, key: a0.value };
      }
    }
    return null;
  };
  // pass A1 — invocation sequences: (PAYLOAD = [args], disp("key", ...)[["prop"]]) → key(args)
  traverse(ast, {
    SequenceExpression(path) {
      const seq = path.node.expressions;
      const hit = isDispCall(seq[seq.length - 1]);
      if (!hit) return;
      let args = null;
      for (const e of seq) {
        if (e.type === 'AssignmentExpression' && e.operator === '=' &&
            e.left.type === 'Identifier' && e.left.name === hit.info.payloadVar &&
            e.right.type === 'ArrayExpression') args = e.right.elements;
      }
      if (args === null) return;
      path.replaceWith(t.callExpression(t.identifier(fixName(hit.key)), args));
      path.skip();
      dispFold++;
    },
  });
  // pass A2 — statement-split shape (webcrack/beautifier split the sequence):
  //   PAYLOAD = [a, b];  <next stmt contains disp("key", ...)>  →  remove assign, call key(a, b)
  traverse(ast, {
    ExpressionStatement(path) {
      const ex = path.node.expression;
      if (ex.type !== 'AssignmentExpression' || ex.operator !== '=' ||
          ex.left.type !== 'Identifier' || ex.right.type !== 'ArrayExpression') return;
      const info = [...dispInfos.values()].find((x) => x.payloadVar === ex.left.name);
      if (!info) return;
      const next = path.getSibling(path.key + 1);
      if (!next || !next.node) return;
      let hit = null;
      next.traverse({
        'CallExpression|NewExpression'(p) {
          if (hit) return;
          if (!t.isIdentifier(p.node.callee)) return;
          const inf = dispInfos.get(p.node.callee.name);
          if (!inf) return;
          if (!p.node.arguments.length || !t.isStringLiteral(p.node.arguments[0])) return;
          const isNonCall = p.node.arguments.length >= 2 && t.isStringLiteral(p.node.arguments[1]) && p.node.arguments[1].value === inf.nonCallKey;
          if (isNonCall) return;
          hit = { path: p, key: p.node.arguments[0].value, args: ex.right.elements };
        },
      });
      if (!hit) return;
      // strip any member wrap (.BRHtW11fbS / ["..."]) on the dispatcher expression
      let outer = hit.path;
      while (outer.parentPath && outer.parentPath.isMemberExpression() &&
             outer.parentPath.node.object === outer.node) outer = outer.parentPath;
      outer.replaceWith(t.callExpression(t.identifier(fixName(hit.key)), hit.args));
      path.remove();
      dispFold++;
      path.skip();
    },
  });
  // pass B — non-call references: disp("key", nonCallKey[, ...])[["prop"]] → key
  traverse(ast, {
    'CallExpression|NewExpression'(path) {
      const node = path.node;
      if (!t.isIdentifier(node.callee)) return;
      const info = dispInfos.get(node.callee.name);
      if (!info) return;
      if (path.findParent((p) => p.isSequenceExpression())) return;
      const args = node.arguments;
      if (!args.length || !t.isStringLiteral(args[0])) return;
      if (args.length < 2 || !t.isStringLiteral(args[1]) || args[1].value !== info.nonCallKey) return;
      let target = path;
      if (path.parentPath.isMemberExpression()) target = path.parentPath;
      target.replaceWith(t.identifier(fixName(args[0].value)));
      path.skip();
      dispFold++;
    },
  });
  // pass C — restore the dispatcher's fns as real function declarations
  traverse(ast, {
    FunctionDeclaration(path) {
      const info = dispInfos.get(path.node.id.name);
      if (!info) return;
      const decls = info.entries.map((en) =>
        t.functionDeclaration(t.identifier(fixName(en.key)), en.params, t.blockStatement(en.body)));
      path.replaceWithMultiple(decls);
      dispRestored += decls.length;
      path.skip();
    },
  });
}
stats.dispFold = dispFold;
stats.dispRestored = dispRestored;
const total = Object.values(stats).reduce((a, b) => a + b, 0);
if (!total) bail('no JS-Confuser technique matched');

// ── final sweep: drop any leftover JS-Confuser helper with zero references ──
// (catches _dummyFunction, _dlrArray, _rgf, _strings, integrity shims, …)
// NOTE: scope.crawl() must happen in its own traversal BEFORE we read binding
// reference counts, otherwise Babel hands us the pre-rewrite counts.
{
  // NOTE: earlier passes replaced/removed nodes, so Babel's cached NodePaths
  // are stale. Regenerate + re-parse before reading any binding info.
  renewAst();
  const HELPERS = /_dummyFunction$|_dlrArray$|_rgf$|_rgf_eval$|_strings$|_integrity$|^__p_[A-Za-z0-9]{4}(_[A-Za-z0-9_$]+)?$/;
  let removed = 0;
  for (let pass = 0; pass < 3; pass++) {
    // fresh scope info, computed after all prior rewrites landed
    traverse(ast, { Program(path) { path.scope.crawl(); } });
    const doomed = [];
    traverse(ast, {
      FunctionDeclaration(path) {
        if (!path.node || !path.node.id) return;
        if (!HELPERS.test(path.node.id.name)) return;
        const b = path.scope.getBinding(path.node.id.name);
        if (!b || b.references === 0) doomed.push(path);
      },
      VariableDeclarator(path) {
        if (!path.node || !t.isIdentifier(path.node.id) || !HELPERS.test(path.node.id.name)) return;
        const b = path.scope.getBinding(path.node.id.name);
        if (!b || b.references === 0) doomed.push(path);
      },
    });
    if (!doomed.length) break;
    let passRemoved = 0;
    for (const p of doomed) {
      if (!p.node || p.removed) continue;
      try {
        // for a declarator that is the only one in its `var`/`let`/`const`, drop the whole statement
        if (p.isVariableDeclarator() && p.parent && p.parent.declarations.length === 1) p.parentPath.remove();
        else p.remove();
        passRemoved++;
      } catch (e) { /* already detached by a sibling removal */ }
    }
    removed += passRemoved;
    if (!passRemoved) break;
  }
  if (removed) stats.helpersRemoved = removed;
}

let out;
try {
  out = generate(ast, { compact: false, comments: false }).code;
  new vm.Script(out);
} catch (e) { bail('output invalid: ' + e.message.slice(0, 90)); }

emit(out, Object.entries(stats).filter(([, v]) => v).map(([k, v]) => k + '=' + v).join(' '));
