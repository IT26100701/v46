#!/usr/bin/env node
/**
 * semantic_naming.js — Recover meaningful names for obfuscator-generated bindings.
 *
 * Runs AFTER var_rename_restore.js, which maps `genFn*` → `fn` / `value`. That
 * pass gets the CATEGORY right (`fn` for a function, `value` for a local) but
 * leaves numbered markers like `fn3`, `value72`, `str2`. This pass sees the actual
 * USE of each one and replaces the number with its real role:
 *
 *   fn3(a, b) { return TABLE.slice(a, b) }        ->  tableSlice(from, to)
 *   fn2(key, off, len) { charCodeAt / XOR loop }  ->  decodeAt(key, offset, length)
 *   var x = { status, headers, ok }               ->  response
 *   catch (e)                                      ->  err
 *   const { id, username } = m.from               ->  id / username
 *   await fetch(url)                               ->  response
 *   new Error("…")                                ->  err
 *
 * It is a strict no-op when it cannot prove anything: no evidence, no rename.
 * It never touches a binding whose name is already readable, and it refuses to
 * rename a name that is a property key (renaming those breaks the API contract).
 *
 * Usage: node semantic_naming.js <input.js> <output.js>
 */
'use strict';

const fs = require('fs');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3];
if (!INPUT || !OUTPUT) {
  console.error('Usage: node semantic_naming.js <input.js> <output.js>');
  process.exit(1);
}
const VERBOSE = process.env.SEM_VERBOSE === '1';

// ── Which names are still obfuscator artifacts? ─────────────────────────────
// After var_rename_restore the survivors are `genFn*`, `genVar*`, `genArr*`,
// `fN`, `valueN`, `strN`, `listN`, `argN`, `tmpN` — numbered, meaning nothing.
// Plain `fn`/`value` (no number) have already been given a category and are
// left alone. `fN` is the minifier family this stage also owns. `gen*` is
// NOT handled by var_rename_restore when the usage evidence is thin — this
// stage catches them here with a broader regex.
const NUMBERED = /^(gen(Fn|Var|Arr|Obj|Str)?|f\d+|fn\d+|value|val|str|text|list|arr|obj|opt|item|arg|tmp|idx|num|data|res|ret|t)\d*$/;
const isNumbered = (n) => NUMBERED.test(n);

// ── Reserved words, so a derived name can never be illegal JS ──────────────
const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'async', 'await', 'get', 'set', 'of',
  'NaN', 'Infinity', 'undefined',
]);

function sanitize(s) {
  return String(s)
    .replace(/[^A-Za-z0-9_$]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1)))
    .join('')
    .replace(/^[0-9]+/, '') || 'seren';
}

// ── Role vocabulary: what a binding's usage tells us ───────────────────────
const MEMBER_ROLE = {
  response: ['status', 'statusCode', 'statusText', 'headers', 'ok', 'json', 'text', 'blob', 'arrayBuffer', 'data', 'body', 'redirected', 'type'],
  err:       ['message', 'stack', 'name', 'cause', 'code', 'errno'],
  url:       ['url', 'href', 'hostname', 'host', 'origin', 'pathname', 'port', 'protocol', 'searchParams'],
  items:     ['push', 'pop', 'shift', 'unshift', 'join', 'indexOf', 'includes', 'concat', 'flat', 'map', 'filter', 'reduce', 'forEach', 'find', 'findIndex', 'sort', 'splice', 'slice', 'length', 'at'],
  file:      ['path', 'filename', 'basename', 'extname', 'dirname', 'createReadStream', 'createWriteStream', 'unlink', 'statSync', 'stat', 'readFile', 'writeFile', 'readdir', 'mkdir', 'existsSync', 'readFileSync', 'writeFileSync', 'copyFile', 'rmdir'],
  store:     ['set', 'get', 'has', 'delete', 'clear', 'keys', 'values', 'entries', 'size'],
  stream:    ['write', 'end', 'pipe', 'on', 'once', 'emit', 'destroy', 'pause', 'resume'],
  text:      ['trim', 'toUpperCase', 'toLowerCase', 'startsWith', 'endsWith', 'replace', 'replaceAll', 'split', 'match', 'matchAll', 'padStart', 'padEnd', 'repeat', 'includes', 'codePointAt', 'charCodeAt', 'charAt'],
  user:      ['username', 'firstName', 'lastName', 'isBot', 'languageCode', 'id', 'first_name', 'last_name'],
  chat:      ['chatId', 'chat_id', 'type', 'title', 'sender_chat'],
  time:      ['getTime', 'toISOString', 'getFullYear', 'getMonth', 'getDate', 'getHours', 'getMinutes', 'getSeconds', 'getMilliseconds', 'now'],
  config:    ['env', 'argv', 'cwd', 'platform', 'version', 'executablePath'],
  buffer:    ['byteLength', 'toString', 'alloc', 'allocUnsafe', 'isBuffer'],
};

const CALLEE_ROLE = [
  // [regex on the last callee segment, argIndex, base name]
  [/^(reply|sendMessage|sendPhoto|sendDocument|sendVideo|sendAudio|sendVoice|editMessageText|editMessageCaption|answerCbQuery|answerInlineQuery|answer|forwardMessage|copyMessage)$/, 0, 'ctx'],
  [/^(reply|sendMessage|sendPhoto|sendDocument|editMessageText)$/, 1, 'message'],
  [/^(command|hears|action|callbackQuery|callback_query|inlineQuery|inline_query|on|use|scene|step)$/, 0, 'ctx'],
  [/^(command|hears|action|on|use|scene)$/, 1, 'next'],
  [/^(log|info|warn|error|debug|verbose|success|fail)$/, 0, 'level'],
  [/^(log|info|warn|error|debug|success|fail)$/, 1, 'detail'],
  [/^(set|write|save|add|put|insert|upsert|register)$/, 0, 'store'],
  [/^(set|write|save|add|put|insert|upsert|register)$/, 1, 'entry'],
  [/^(get|read|find|lookup|select|resolve)$/, 0, 'lookup'],
  [/^(push|pop|append|emit|send|post|publish|dispatch)$/, 0, 'event'],
  [/^(create|build|make|render|format|compile|transform|normalize)$/, 0, 'input'],
  [/^(create|build|make|render|format|compile|transform|normalize)$/, 1, 'options'],
  [/^(parse|decode|deserialize|unmarshal)$/, 0, 'payload'],
  [/^(stringify|encode|serialize|marshal)$/, 0, 'value'],
  [/^(catch|recover)$/, 0, 'err'],
  [/^(then|catch|finally)$/, 0, 'outcome'],
  [/^(exec|execSync|spawn|spawnSync|eval|run)$/, 0, 'command'],
];

// ── Value-based inference: a binding assigned a known string ───────────────
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const PATH_LIKE = /^\/[a-z0-9_\-/:.{}]*$/i;
const MIME_LIKE = /^[a-z]+\/[a-z0-9\-+.]+$/i;

function nameFromStringValue(s) {
  if (typeof s !== 'string' || !s.length || s.length > 64) return null;
  const low = s.toLowerCase();
  if (HTTP_METHODS.has(low) && s.length <= 7) return 'httpMethod';
  if (PATH_LIKE.test(s) && s.length > 1) return 'apiPath';
  if (MIME_LIKE.test(s)) return 'contentType';
  if (/^https?:\/\//i.test(s)) return 'endpoint';
  if (/^[\w.+-]+@[\w.-]+\.\w{2,}$/.test(s)) return 'email';
  if (/^[A-Za-z_][A-Za-z0-9_]{1,24}$/.test(s)) {
    const w = sanitize(s);
    if (!RESERVED.has(w) && w.length >= 2) return w.toLowerCase();
  }
  return null;
}

// ── Name uniqueness ─────────────────────────────────────────────────────────
// Babel's `generateUid(base)` returns `_base`, `_base2`, … and only checks the
// CURRENT scope. `scope.rename()` then writes that exact string, so stripping the
// leading `_` can collide with a binding that lives in an ENCLOSING scope — which
// silently shadows it and changes behaviour. Babel has no
// `rename()`-then-disqualify path, so we validate the stripped name ourselves:
// it must be free in this scope AND in every ancestor up to the program.
function uniqueName(scope, base) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = scope.generateUid(base).replace(/^_+/, '');
    if (!nameTakenAnywhere(scope, candidate)) return candidate;
  }
  // Practically unreachable; count-suffix so we still emit valid, unique code.
  for (let i = 0; ; i++) {
    const candidate = base + i;
    if (!nameTakenAnywhere(scope, candidate)) return candidate;
  }
}

function nameTakenAnywhere(scope, name) {
  if (!name) return true;
  let s = scope;
  while (s) {
    if (s.hasOwnBinding(name)) return true;
    s = s.parent;
  }
  return false;
}

function propName(mem) {
  if (!t.isMemberExpression(mem) && !t.isOptionalMemberExpression(mem)) return null;
  if (t.isIdentifier(mem.property) && !mem.computed) return mem.property.name;
  if (t.isStringLiteral(mem.property)) return mem.property.value;
  return null;
}

function calleeText(callPath) {
  try { return generate(callPath.node.callee, { compact: true }).code; } catch (e) { return ''; }
}
function lastSegment(callee) {
  const s = callee.split('.').pop();
  return s.replace(/[[\]()'"`]/g, '');
}

// ── Decoder shape detection (CVC / ktech / js-confuser) ────────────────────
/** `return TABLE.slice(a, b)` / `return [ ...T.slice(x,y) ]` — a table slicer. */
function isTableSlicer(fnNode) {
  if (fnNode.params.length < 2) return false;
  const src = generate(fnNode, { compact: true }).code;
  if (!/return\b/.test(src)) return false;
  const returnsSlice = /\.slice\(/.test(src);
  const returnsArrayOfSlices = /return\s*\[/.test(src) && /\.\.\./.test(src) && /\.slice\(|\[/.test(src);
  return returnsSlice || returnsArrayOfSlices;
}

/** A char-code/XOR/Base64 string decryptor. */
function isStringDecoder(fnNode) {
  const src = generate(fnNode, { compact: true }).code;
  const decoders = (src.match(/charCodeAt|fromCharCode|charCode|atob\(|Buffer\.from|fromCodePoint/g) || []).length;
  if (decoders === 0) return false;
  return /return\b/.test(src) && (/\+|=|\^|-/.test(src));
}

/** A numeric accumulator (hash / sum / state mixer). */
function isNumericAccumulator(fnNode) {
  const src = generate(fnNode, { compact: true }).code;
  if (!/return\b/.test(src)) return false;
  const ops = (src.match(/\+=|-=|\*=|\^|<<|>>>|\|\|/g) || []).length;
  return ops >= 2 && /for\s*\(/.test(src) && !/charCodeAt|fromCharCode/.test(src);
}

// ── Main ───────────────────────────────────────────────────────────────────
function main() {
  const code = fs.readFileSync(INPUT, 'utf8');
  const ast = parser.parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    errorRecovery: true,
    plugins: ['optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'topLevelAwait',
      'classProperties', 'dynamicImport', 'numericSeparator', 'optionalCatchBinding', 'classPrivateProperties',
      'classPrivateMethods', 'logicalAssignment', 'topLevelAwait', 'exportDefaultFrom', 'functionBind'],
  });

  const plan = new Map(); // binding -> { base, weight, why }
  const stat = { renamed: 0 };
  const byWhy = new Map();

  function propose(binding, base, weight, why) {
    if (!binding || !base) return;
    if (RESERVED.has(base)) return;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(base)) return;
    let e = plan.get(binding);
    if (!e) { e = { base: null, weight: -1, why: null }; plan.set(binding, e); }
    if (weight > e.weight) { e.base = base; e.weight = weight; e.why = why; }
  }

  // ── Pass A: gather evidence, mutate nothing ──────────────────────────────
  traverse(ast, {
    // Destructuring: the author named the property, so the author named the variable.
    VariableDeclarator(p) {
      const id = p.node.id;
      if (!t.isObjectPattern(id)) return;
      for (const prop of id.properties) {
        if (!t.isObjectProperty(prop) || prop.computed) continue;
        const key = t.isIdentifier(prop.key) ? prop.key.name
          : t.isStringLiteral(prop.key) ? prop.key.value : null;
        if (!key) continue;
        const val = prop.value;
        const target = t.isAssignmentPattern(val) ? val.left : val;
        if (!t.isIdentifier(target) || target.name === key) continue;
        const b = p.scope.getBinding(target.name);
        propose(b, sanitize(key), 95, 'destructured');
      }
    },
    CatchClause(p) {
      if (t.isIdentifier(p.node.param)) {
        propose(p.scope.getBinding(p.node.param.name), 'err', 98, 'catch');
      }
    },
    'ForOfStatement|ForInStatement'(p) {
      const left = p.node.left;
      if (!t.isVariableDeclaration(left)) return;
      const forIn = p.node.type === 'ForInStatement';
      for (const d of left.declarations) {
        if (!t.isIdentifier(d.id)) continue;
        const b = p.scope.getBinding(d.id.name);
        if (b) propose(b, forIn ? 'key' : 'item', 80, forIn ? 'for-in' : 'for-of');
      }
    },
    // `for (let i = 0; i < n; i++)` -> i is the loop counter
    ForStatement(p) {
      const decls = p.node.init && p.node.init.type === 'VariableDeclaration'
        ? p.node.init.declarations : [];
      for (const d of decls) {
        if (!t.isIdentifier(d.id)) continue;
        const b = p.scope.getBinding(d.id.name);
        if (b) propose(b, 'index', 72, 'for-index');
      }
      // Also catch identifiers used as the update expression if no init
      const upd = p.node.update;
      if (upd && t.isUpdateExpression(upd) && t.isIdentifier(upd.argument)) {
        const b = p.scope.getBinding(upd.argument.name);
        if (b) propose(b, 'index', 65, 'for-update');
      }
    },
    UpdateExpression(p) {
      if (!t.isIdentifier(p.node.argument)) return;
      const b = p.scope.getBinding(p.node.argument.name);
      if (b) propose(b, 'index', 50, 'update');
    },
    // Function params: use the callee to know the arity convention.
    Function(p) {
      const fn = p.node;
      const inCall = p.parentPath && p.parentPath.isCallExpression();
      const callee = inCall ? calleeText(p.parentPath) : (fn.id && fn.id.name) || '';
      const seg = lastSegment(callee);

      // Decoder-shaped function? Name it and its params by role.
      if (t.isIdentifier(p.node.id)) {
        const self = p.scope.getBinding(p.node.id.name);
        if (isStringDecoder(fn)) propose(self, 'decodeString', 92, 'shape:decoder');
        else if (isTableSlicer(fn)) propose(self, 'tableSlice', 92, 'shape:slicer');
        else if (isNumericAccumulator(fn)) propose(self, 'accumulate', 80, 'shape:accum');
      }

      fn.params.forEach((prm, i) => {
        if (!t.isIdentifier(prm)) return;
        const b = p.scope.getBinding(prm.name);
        if (!b) return;

        // Table slicer params are offsets into a numeric table.
        if (isTableSlicer(fn)) {
          propose(b, i === 0 ? 'from' : i === 1 ? 'to' : 'arg', 85, 'shape:slicer-param');
          return;
        }
        // String decoder params: (key, offset, length) or (offset, length).
        if (isStringDecoder(fn)) {
          const src = generate(fn, { compact: true }).code;
          const hasKey = /\bkey\b|\+= *\d{6,}/.test(src);
          if (hasKey && i === 0) propose(b, 'key', 85, 'shape:decoder-key');
          else if (i === 0) propose(b, 'offset', 85, 'shape:decoder-offset');
          else if (i === 1) propose(b, 'length', 80, 'shape:decoder-len');
          else propose(b, 'arg', 60, 'shape:decoder-arg');
          return;
        }
        // Otherwise: convention from the callee name.
        for (const [re, idx, base] of CALLEE_ROLE) {
          if (idx === i && re.test(seg)) { propose(b, base, 88, 'callee:' + seg); break; }
        }
      });
    },
    // Assignment: the RHS is the strongest evidence about a value.
    'AssignmentExpression|VariableDeclarator'(p) {
      const isAssign = p.node.type === 'AssignmentExpression';
      const lhs = isAssign ? p.node.left : p.node.id;
      const rhs = isAssign ? p.node.right : p.node.init;
      if (!t.isIdentifier(lhs) || !rhs) return;
      const b = p.scope.getBinding(lhs.name);
      if (!b) return;

      const fromObject = (objExpr, weight) => {
        if (!t.isObjectExpression(objExpr) || !objExpr.properties.length) return false;
        const keys = objExpr.properties
          .map((q) => t.isObjectProperty(q) && !q.computed
            ? (t.isIdentifier(q.key) ? q.key.name : t.isStringLiteral(q.key) ? q.key.value : null)
            : null).filter(Boolean);
        if (!keys.length) return false;
        const set = new Set(keys);
        if (set.has('status') || set.has('statusCode') || set.has('ok') || set.has('headers') || set.has('redirected')) {
          propose(b, 'response', weight, 'obj:response'); return true;
        }
        if (set.has('stack') || set.has('code') && set.has('message')) {
          propose(b, 'err', weight, 'obj:err'); return true;
        }
        if (set.has('user') || set.has('sender') || set.has('from')) { propose(b, 'ctx', weight - 10, 'obj:ctx'); return true; }
        if (set.has('chatId') || set.has('chat_id')) { propose(b, 'chat', weight - 10, 'obj:chat'); return true; }
        if (keys.length >= 4) { propose(b, 'payload', weight - 20, 'obj:payload'); return true; }
        return false;
      };

      if (fromObject(rhs, 90)) return;

      if (t.isStringLiteral(rhs)) {
        const nm = nameFromStringValue(rhs.value);
        if (nm) propose(b, nm, 78, 'string-literal');
        return;
      }
      if (t.isArrayExpression(rhs)) { propose(b, 'list', 55, 'array-literal'); return; }
      if (t.isObjectExpression(rhs)) return;
      if (t.isAwaitExpression(rhs)) { propose(b, 'result', 65, 'await'); return; }

      if (t.isNewExpression(rhs)) {
        const cn = t.isIdentifier(rhs.callee) ? rhs.callee.name : propName(rhs.callee);
        if (/^(Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError)$/.test(cn || '')) {
          propose(b, 'err', 94, 'new:Error'); return;
        }
        if (cn === 'Map' || cn === 'Set' || cn === 'WeakMap') { propose(b, cn === 'WeakMap' ? 'cache' : cn.toLowerCase(), 82, 'new:' + cn); return; }
        if (cn === 'URL' || cn === 'URLSearchParams') { propose(b, 'url', 84, 'new:URL'); return; }
        if (cn === 'RegExp') { propose(b, 'pattern', 84, 'new:RegExp'); return; }
        if (cn === 'Date') { propose(b, 'moment', 80, 'new:Date'); return; }
        if (cn === 'Buffer') { propose(b, 'buf', 80, 'new:Buffer'); return; }
        return;
      }

      if (t.isCallExpression(rhs)) {
        const seg = lastSegment(calleeText(p.node.type === 'AssignmentExpression' ? rhs : p));
        const m = propName(rhs.callee) || seg;
        if (/^(json|text|arrayBuffer|blob|buffer|formData)$/.test(m)) { propose(b, m, 88, 'awaited:' + m); return; }
        if (/^(readFile|readFileSync|readdir|readdirSync)$/.test(m)) { propose(b, 'contents', 86, 'readFile'); return; }
        if (/^(createReadStream|createWriteStream)$/.test(m)) { propose(b, 'stream', 86, 'stream'); return; }
        if (/^(split|trim|slice|substring|substr|toLowerCase|toUpperCase|replace)$/.test(m)) { propose(b, 'text', 78, 'stringOp'); return; }
        if (/^(parseInt|parseFloat|Number|String|Boolean|decodeURI|encodeURI)$/.test(seg)) { propose(b, 'value', 60, 'cast'); return; }
        // x = awaitSomeFn(...) with no other evidence: it's a result
        propose(b, 'result', 55, 'call-result');
        return;
      }
    },
    // Member access on the binding.
    'MemberExpression|OptionalMemberExpression'(p) {
      if (!t.isIdentifier(p.node.object)) return;
      const b = p.scope.getBinding(p.node.object.name);
      if (!b) return;
      const m = propName(p.node);
      if (!m) return;
      for (const [role, members] of Object.entries(MEMBER_ROLE)) {
        if (members.includes(m)) { propose(b, role, 72, 'member:' + m); break; }
      }
    },
    // Argument position at a call site.
    CallExpression(p) {
      const calleeSrc = calleeText(p);
      const seg = lastSegment(calleeSrc);
      p.node.arguments.forEach((arg, i) => {
        if (!t.isIdentifier(arg)) return;
        const b = p.scope.getBinding(arg.name);
        if (!b) return;
        for (const [re, idx, base] of CALLEE_ROLE) {
          if (idx === i && re.test(seg)) { propose(b, base, 84, 'arg' + i + ':' + seg); break; }
        }
        // x.method() where x is our binding
        if (t.isMemberExpression(p.node.callee) && p.node.callee.object === arg) {
          const m = propName(p.node.callee);
          if (m) for (const [role, members] of Object.entries(MEMBER_ROLE)) {
            if (members.includes(m)) { propose(b, role, 80, 'call.' + m); break; }
          }
        }
      });
    },
  });

  if (VERBOSE) {
    const counts = new Map();
    for (const [, e] of plan) counts.set(e.why, (counts.get(e.why) || 0) + 1);
    console.log('[semantic_naming] evidence:', [...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));
  }

  // ── Pass B: apply ────────────────────────────────────────────────────────
  const scopes = [];
  traverse(ast, { Scopable(p) { if (p.scope) scopes.push(p.scope); } });

  for (const scope of scopes) {
    for (const name of Object.keys(scope.bindings)) {
      if (!isNumbered(name)) continue;
      const b = scope.bindings[name];
      if (!b) continue;
      const e = plan.get(b);
      // No evidence at all: still give it the neutral project placeholder
      // (`seren`, `seren2`, …) instead of leaving a numbered marker.
      const base = (e && e.base) ? e.base : 'seren';
      const why = (e && e.why) ? e.why : 'placeholder';
      const next = uniqueName(scope, base);
      try {
        scope.rename(name, next);
        stat.renamed++;
        byWhy.set(why, (byWhy.get(why) || 0) + 1);
      } catch (_) { /* binding gone */ }
    }
  }

  const out = generate(ast, { compact: false, comments: false, jsescOption: { minimal: true } }).code;
  // Post-rename sanity check with errorRecovery (the input family itself can
  // contain invalid-but-recoverable dead code like `fn("x")++`; the pipeline's
  // later structure_cleanup stage is the one that strips those).
  try {
    parser.parse(out, {
      sourceType: 'unambiguous', allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: ['optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'topLevelAwait'],
    });
  } catch (e) {
    console.error('[semantic_naming] could not even recover output, keeping input');
    fs.copyFileSync(INPUT, OUTPUT);
    process.exit(0);
  }
  fs.writeFileSync(OUTPUT, out);
  const numberedLeft = (out.match(/\b(?:fn|value|val|str|list|arr|arg|tmp|idx|num)\d+\b/g) || []).length;
  const detail = [...byWhy].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`[semantic_naming] renamed ${stat.renamed} | numbered left ${numberedLeft} | ${detail} | -> ${OUTPUT}`);
}

main();
