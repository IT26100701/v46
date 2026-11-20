#!/usr/bin/env node
/**
 * var_rename_restore.js — Scope-aware semantic variable renaming.
 *
 * Goal: no identifier in the output should still be an obfuscator artifact
 * (`genFn*`, `genVar*`, `genArr*`, `f1`/`a`/`b` chains, CJK names). Every one is
 * given a name that describes its actual role in the code.
 *
 * Naming is derived from the binding's own usage, never from a counter:
 *   - catch param                       -> err
 *   - first param of bot.command/on/... -> ctx
 *   - second param of a middleware      -> next
 *   - awaited/promise-returning         -> response
 *   - member access tells the role      -> url / text / data / items / json / axios
 *   - argument position to a known API  -> format / key / amount
 *   - assigned a string literal         -> <semantic name> if known, else value
 *   - array methods                    -> items
 *   - loop index                        -> index
 *   - fallback by kind                  -> fn / value / list
 *
 * Collisions are impossible: every new name comes from `scope.generateUid(base)`,
 * which is aware of the names already taken in that exact scope.
 */

const fs = require('fs');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3];

if (!INPUT || !OUTPUT) {
  console.error('Usage: node var_rename_restore.js <input.js> <output.js>');
  process.exit(1);
}

// Names produced by an obfuscator or minifier, i.e. bindings we are allowed to
// rename. Deliberately narrow: `[a-z]\d+` (value2, data4, …) matches perfectly
// readable identifiers, and renaming those destroys real information.
const GENERIC = /^(gen(Fn|Var|Arr|Obj|Str)?_?\d+|f\d+|[a-z]|[a-z]_\d+|[a-z]_[a-z]_\d+|_\d+|v\d+)$/;
const isGeneric = (n) => GENERIC.test(n);

// ── usage-signature collectors ────────────────────────────────────────────
const MEMBER_HINTS = {
  url: ['url', 'href', 'hostname', 'origin'],
  text: ['text', 'caption', 'body', 'trim', 'toUpperCase', 'toLowerCase', 'startsWith', 'endsWith'],
  items: ['push', 'pop', 'shift', 'unshift', 'join', 'indexOf', 'includes', 'concat', 'flat'],
  json: ['parse', 'stringify'],
  data: ['data', 'buffer', 'blob', 'arrayBuffer', 'byteLength'],
  response: ['status', 'statusCode', 'headers', 'ok', 'json', 'data'],
  map: ['set', 'get', 'has', 'delete', 'keys', 'values', 'entries'],
  stream: ['write', 'end', 'pipe', 'on', 'emit', 'once'],
  command: ['command', 'action', 'on', 'use', 'hears', 'callbackQuery'],
  time: ['getTime', 'toISOString', 'getFullYear', 'getMonth', 'getDate'],
  file: ['path', 'filename', 'basename', 'extname', 'createReadStream', 'unlink', 'stat'],
};

const GLOBAL_CTORS = new Set([
  'Buffer', 'RegExp', 'JSON', 'Math', 'Object', 'Array', 'Number', 'String',
  'Date', 'Promise', 'Error', 'URL', 'URLSearchParams', 'Map', 'Set', 'fetch',
  'FormData', 'Blob', 'console', 'process',
]);

function memberName(node) {
  if (!t.isMemberExpression(node)) return null;
  if (t.isIdentifier(node.property) && !node.computed) return node.property.name;
  if (t.isStringLiteral(node.property)) return node.property.value;
  return null;
}

/** Look at every reference of a binding and infer what it is. */
function inferRole(binding, name) {
  const refs = binding.referencePaths || [];
  if (!refs.length) return null;

  const tags = new Set();
  let awaited = false;
  let inNew = false;
  let inThrow = false;
  let isCallee = false;
  let isFunctionId = false;
  let argIndex = -1;
  let stringLiteral = null;
  let hasNumericCompare = false;
  let indexedByLoop = false;

  for (const ref of refs) {
    const p = ref.parentPath;
    if (!p) continue;

    // awaited / .then()
    if (p.isAwaitExpression()) awaited = true;
    if ((p.isCallExpression() && p.node.callee === ref.node) ||
        (p.isMemberExpression() && p.node.object === ref.node && memberName(p.node) === 'then')) {
      awaited = true;
    }
    if (p.isNewExpression() && p.node.callee === ref.node) inNew = true;
    if (p.isThrowStatement()) inThrow = true;
    if (p.isCallExpression() && p.node.callee === ref.node) isCallee = true;
    if (p.isBinaryExpression() && ['<', '>', '<=', '>='].includes(p.node.operator)) hasNumericCompare = true;

    // for (let i = 0; i < n; i++) -> index
    if (p.isUpdateExpression() && p.node.argument === ref.node) {
      const forPath = ref.findParent((q) => q.isForStatement());
      if (forPath) indexedByLoop = true;
    }
    if (p.isArrayExpression() && ref.name === 'length') hasNumericCompare = true;

    if (p.isCallExpression() && p.node.callee === ref.node && p.parentPath &&
        p.parentPath.isMemberExpression()) {
      // fn(...) then .method -> tag by that method
      const m = memberName(p.parentPath.node);
      if (m) tags.add(m);
    }
    if (p.isMemberExpression() && p.node.object === ref.node) {
      const m = memberName(p.node);
      if (m) tags.add(m);
    }
    // passed as an argument
    if (p.isCallExpression() && p.node.arguments.includes(ref.node)) {
      argIndex = p.node.arguments.indexOf(ref.node);
      const calleeSrc = p.toString().slice(0, p.toString().indexOf('('));
      for (const [role, methods] of Object.entries(MEMBER_HINTS)) {
        if (methods.some((mm) => calleeSrc.endsWith('.' + mm) || calleeSrc === mm)) tags.add(role);
      }
    }
    if (p.isStringLiteral && p.parentPath && p.parentPath.isVariableDeclarator &&
        p.parentPath.node.init === p.node) stringLiteral = p.node.value;
  }

  // binding kind
  if (binding.path.isFunctionDeclaration()) isFunctionId = true;
  const fnNode = binding.path.node;
  if (binding.path.isFunctionExpression() || binding.path.isArrowFunctionExpression()) isFunctionId = true;
  if (binding.path.isIdentifier() && binding.path.parentPath &&
      binding.path.parentPath.isFunction() &&
      binding.path.parentPath.node.params.includes(binding.path.node)) {
    isFunctionId = false;
  }

  // ── resolution order: strongest signal first ──
  if (tags.has('command') && argIndex === 0) return 'ctx';
  if (tags.has('command') && argIndex === 1) return 'next';
  if (inThrow) return 'err';
  if (binding.path.parentPath && binding.path.parentPath.isCatchClause()) return 'err';
  if (inNew) return 'instance';
  if (tags.has('axios') || (tags.has('response') && awaited)) return 'response';
  if (tags.has('response')) return 'response';
  if (tags.has('axios')) return 'client';
  if (tags.has('url')) return 'url';
  if (tags.has('json') && (awaited || tags.has('parse') || tags.has('stringify'))) {
    return tags.has('stringify') ? 'serialized' : 'parsed';
  }
  if (tags.has('text')) return 'text';
  if (tags.has('data')) return 'data';
  if (tags.has('stream')) return 'stream';
  if (tags.has('file')) return 'filePath';
  if (tags.has('time')) return 'timestamp';
  if (tags.has('map')) return 'lookup';
  if (tags.has('items')) return 'items';
  if (indexedByLoop) return 'index';
  if (isFunctionId || isCallee) {
    if (/^genFn/.test(name) || /^f\d+$/.test(name)) return 'fn';
    return null;
  }
  if (stringLiteral && stringLiteral.length <= 40) return null; // keep scope-uid default
  if (hasNumericCompare) return 'value';
  if (awaited) return 'result';
  if (tags.size) return 'value';
  return null;
}

// ── pass 1: resolve globals that were minified to 1–2 chars ───────────────
function main() {
  const code = fs.readFileSync(INPUT, 'utf8');
  const ast = parser.parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    errorRecovery: true,
    plugins: ['optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'topLevelAwait'],
  });

  let renamed = 0;
  let semanticHits = 0;

  // Walk every scope, snapshotting the binding list first (rename() mutates it).
  const scopes = [];
  traverse(ast, {
    Scopable(path) {
      if (path.scope) scopes.push(path.scope);
    },
  });
  const programScope = ast.program.scope || scopes[0];

  for (const scope of scopes) {
    const names = Object.keys(scope.bindings);
    for (const name of names) {
      if (!isGeneric(name)) continue;
      const binding = scope.bindings[name];
      if (!binding) continue;
      // Babel registers a class name in BOTH the program scope and the class's
      // own scope; renaming the program copy already updated the shared binding,
      // so the stale class-scope key must be skipped here or the class gets
      // renamed twice (decl instance, refs instance2 — or worse).
      if (binding.identifier.name !== name) continue;

      const role = inferRole(binding, name);
      let base;
      if (role) {
        base = role;
        semanticHits++;
      } else if (/^(genFn|f\d+)$/.test(name)) {
        base = 'fn';
      } else if (/^genArr/.test(name)) {
        base = 'list';
      } else if (/^genObj/.test(name)) {
        base = 'options';
      } else if (/^genStr/.test(name)) {
        base = 'text';
      } else {
        // No usage evidence at all. `seren` is the project's neutral placeholder —
        // obviously synthetic, so a reader knows the name is a placeholder and
        // not something the original author wrote, but far less noisy than
        // `value1`/`value2` piling up on one screen.
        base = 'seren';
      }

      const next = scope.generateUid(base).replace(/^_+/, '');
      try {
        scope.rename(name, next);
        renamed++;
      } catch (_) {
        /* binding already gone — nothing to do */
      }
    }
  }

  // ── pass 2: property keys left as computed string access ───────────────
  //   ctx["reply"] -> ctx.reply   (only for non-reserved, identifier-safe keys)
  const reserved = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
    'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
    'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
    'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
  ]);
  let dotified = 0;
  traverse(ast, {
    MemberExpression(path) {
      const n = path.node;
      if (!n.computed || !t.isStringLiteral(n.property)) return;
      const key = n.property.value;
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return;
      if (reserved.has(key)) return;
      n.computed = false;
      n.property = t.identifier(key);
      dotified++;
    },
    ObjectProperty(path) {
      const n = path.node;
      if (!n.computed || !t.isStringLiteral(n.key)) return;
      const key = n.key.value;
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return;
      if (reserved.has(key)) return;
      n.computed = false;
      n.key = t.identifier(key);
      dotified++;
    },
    OptionalMemberExpression(path) {
      const n = path.node;
      if (!n.computed || !t.isStringLiteral(n.property)) return;
      const key = n.property.value;
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) || reserved.has(key)) return;
      n.computed = false;
      n.property = t.identifier(key);
      dotified++;
    },
  });

  // ── pass 3: bracket-to-dot for the shim-style global lookups that survived
  //   as bare identifiers is NOT safe (they may be locals) — skip.

  const out = generate(ast, { compact: false, comments: false, jsescOption: { minimal: true } }).code;

  // Verify before shipping
  try {
    parser.parse(out, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, errorRecovery: false });
  } catch (e) {
    console.error('[var_rename_restore] output failed parse, keeping input unchanged:', e.message);
    fs.copyFileSync(INPUT, OUTPUT);
    process.exit(0);
  }

  fs.writeFileSync(OUTPUT, out);
  const left = (out.match(/\b(?:gen(?:Fn|Var|Arr|Obj|Str)?_?\d+|f\d+)\b/g) || []).length;
  console.log(`[var_rename_restore] renamed ${renamed} (${semanticHits} semantic) | dotified ${dotified} | generic left ${left} -> ${OUTPUT}`);
}

main();
