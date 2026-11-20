#!/usr/bin/env node
/**
 * semantic_unshim.js v2 — Stage setelah final_readable:
 * 1. Inline shim functions: genFn4("key"), genFn52(obj, "method"), genFn47(fn, args), genArr1[82]
 * 2. Semantic rename based on HIGH-CONFIDENCE patterns only (require + usage match)
 * 3. Fold constant computed property access where key is constant string
 *
 * Usage: node plugins/semantic_unshim.js <input.js> <output.js>
 */
const fs = require('fs');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  console.error('usage: semantic_unshim.js <input.js> <output.js>');
  process.exit(1);
}

let src = fs.readFileSync(input, 'utf8');

// ============ 0. Regex-based quick inline for shim patterns ============
const SHIM_MAP = {
  dNp6U4: 'Buffer',
  qky80kg: 'RegExp',
  QM_MNwC: 'fetch',
  Fsaarw9: 'FormData',
  vFDbydN: 'Error',
  OEs5Fu: 'JSON',
  gBWUMO: 'Array',
  z7gbOvt: 'console',
  XYz0Qg: 'Number',
  XkOxUgo: 'encodeURIComponent',
};

function inlineShimsRegex(code) {
  let count = 0;
  
  // 1. genFn47(a, b) -> b  (comma operator: evaluates a, returns b)
  // Use while loop with regex to handle all occurrences
  const re47 = /genFn47\s*\(\s*([^,]+),\s*([^)]+)\)/g;
  code = code.replace(re47, (m, a, b) => b.trim());
  if (re47.test(code)) { /* already replaced */ }
  // Count manually
  let m;
  const re47count = /genFn47\s*\(\s*([^,]+),\s*([^)]+)\)/g;
  while ((m = re47count.exec(code.replace(re47, '')))) {} // just for count estimate
  
  // 2. genArr1[82] -> null
  code = code.replace(/genArr1\[82\]/g, 'null');

  // 3. genFn4("KEY")["prop"](...) -> GLOBAL.prop(...)
  for (const [key, global] of Object.entries(SHIM_MAP)) {
    const pattern = new RegExp(`genFn4\\(["']${key}["']\\)\\[(["'])([^"']+)\\1\\]`, 'g');
    code = code.replace(pattern, `${global}.$2`);
  }
  
  // 4. new (genFn4("KEY"))(...) -> new GLOBAL(...)
  for (const [key, global] of Object.entries(SHIM_MAP)) {
    const pattern = new RegExp(`new\\s*\\(\\s*genFn4\\(["']${key}["']\\)\\s*\\)`, 'g');
    code = code.replace(pattern, `new ${global}`);
  }

  // 5. genFn52(genFn4("KEY"), "method") -> GLOBAL.method
  for (const [key, global] of Object.entries(SHIM_MAP)) {
    const pattern = new RegExp(`genFn52\\(\\s*genFn4\\(["']${key}["']\\)\\s*,\\s*["']([^"']+)["']\\s*\\)`, 'g');
    code = code.replace(pattern, `${global}.$1`);
  }
  // Also handle direct global references in genFn52
  code = code.replace(/genFn52\(\s*JSON\s*,\s*["']parse["']\s*\)/g, 'JSON.parse');
  code = code.replace(/genFn52\(\s*JSON\s*,\s*["']stringify["']\s*\)/g, 'JSON.stringify');
  code = code.replace(/genFn52\(\s*Array\s*,\s*["']from["']\s*\)/g, 'Array.from');
  code = code.replace(/genFn52\(\s*Array\s*,\s*["']isArray["']\s*\)/g, 'Array.isArray');
  code = code.replace(/genFn52\(\s*console\s*,\s*["']log["']\s*\)/g, 'console.log');
  code = code.replace(/genFn52\(\s*console\s*,\s*["']error["']\s*\)/g, 'console.error');
  code = code.replace(/genFn52\(\s*console\s*,\s*["']warn["']\s*\)/g, 'console.warn');
  code = code.replace(/genFn52\(\s*console\s*,\s*["']info["']\s*\)/g, 'console.info');
  code = code.replace(/genFn52\(\s*Buffer\s*,\s*["']from["']\s*\)/g, 'Buffer.from');
  code = code.replace(/genFn52\(\s*Number\s*\)/g, 'Number');
  code = code.replace(/genFn52\(\s*encodeURIComponent\s*\)/g, 'encodeURIComponent');
  code = code.replace(/genFn52\(\s*decodeURIComponent\s*\)/g, 'decodeURIComponent');

  // 6. genFn52(GLOBAL)(arg) -> GLOBAL(arg)
  for (const global of ['Number', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'JSON', 'Array', 'Buffer', 'console']) {
    const pattern = new RegExp(`genFn52\\(\\s*${global}\\s*\\)`, 'g');
    code = code.replace(pattern, global);
  }

  // 7. genFn4("KEY") -> GLOBAL (direct reference)
  for (const [key, global] of Object.entries(SHIM_MAP)) {
    const pattern = new RegExp(`genFn4\\(["']${key}["']\\)`, 'g');
    code = code.replace(pattern, global);
  }

  return code;
}

// Apply regex shims (skip genFn47 — handled by AST, see below)
const SKIP_47 = true;
src = (SKIP_47 ? (code => {
  // temporarily hide genFn47(...) so other regexes don't see it
  return code;
}) : inlineShimsRegex)(src);

function inlineShimsRegex2(code) {
  let count47 = 0;

  // 1. genArr1[82] -> null
  code = code.replace(/genArr1\[82\]/g, 'null');

  // 2. genFn4("KEY")["prop"](...) -> GLOBAL.prop(...)
  for (const [key, global] of Object.entries(SHIM_MAP)) {
    const pattern = new RegExp(`genFn4\\(["']${key}["']\\)\\[(["'])([^"']+)\\1\\]`, 'g');
    code = code.replace(pattern, `${global}.$2`);
  }
  
  // 3. new (genFn4("KEY"))(...) -> new GLOBAL(...)
  for (const [key, global] of Object.entries(SHIM_MAP)) {
    const pattern = new RegExp(`new\\s*\\(\\s*genFn4\\(["']${key}["']\\)\\s*\\)`, 'g');
    code = code.replace(pattern, `new ${global}`);
  }

  // 4. genFn52(genFn4("KEY"), "method") -> GLOBAL.method
  for (const [key, global] of Object.entries(SHIM_MAP)) {
    const pattern = new RegExp(`genFn52\\(\\s*genFn4\\(["']${key}["']\\)\\s*,\\s*["']([^"']+)["']\\s*\\)`, 'g');
    code = code.replace(pattern, `${global}.$1`);
  }
  // Also handle direct global references in genFn52
  code = code.replace(/genFn52\(\s*JSON\s*,\s*["']parse["']\s*\)/g, 'JSON.parse');
  code = code.replace(/genFn52\(\s*JSON\s*,\s*["']stringify["']\s*\)/g, 'JSON.stringify');
  code = code.replace(/genFn52\(\s*Array\s*,\s*["']from["']\s*\)/g, 'Array.from');
  code = code.replace(/genFn52\(\s*Array\s*,\s*["']isArray["']\s*\)/g, 'Array.isArray');
  code = code.replace(/genFn52\(\s*console\s*,\s*["']log["']\s*\)/g, 'console.log');
  code = code.replace(/genFn52\(\s*console\s*,\s*["']error["']\s*\)/g, 'console.error');
  code = code.replace(/genFn52\(\s*console\s*,\s*["']warn["']\s*\)/g, 'console.warn');
  code = code.replace(/genFn52\(\s*console\s*,\s*["']info["']\s*\)/g, 'console.info');
  code = code.replace(/genFn52\(\s*Buffer\s*,\s*["']from["']\s*\)/g, 'Buffer.from');
  code = code.replace(/genFn52\(\s*Number\s*\)/g, 'Number');
  code = code.replace(/genFn52\(\s*encodeURIComponent\s*\)/g, 'encodeURIComponent');
  code = code.replace(/genFn52\(\s*decodeURIComponent\s*\)/g, 'decodeURIComponent');

  // 5. genFn52(GLOBAL)(arg) -> GLOBAL(arg)
  for (const global of ['Number', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'JSON', 'Array', 'Buffer', 'console']) {
    const pattern = new RegExp(`genFn52\\(\\s*${global}\\s*\\)`, 'g');
    code = code.replace(pattern, global);
  }

  // 6. genFn4("KEY") -> GLOBAL (direct reference)
  for (const [key, global] of Object.entries(SHIM_MAP)) {
    const pattern = new RegExp(`genFn4\\(["']${key}["']\\)`, 'g');
    code = code.replace(pattern, global);
  }

  return code;
}
src = inlineShimsRegex2(src);

// ============ 1. Parse AST ============
let ast;
try {
  ast = parser.parse(src, { sourceType: 'script', errorRecovery: true });
} catch (e) {
  console.error('[semantic_unshim] parse error:', e.message);
  process.exit(1);
}

// ============ 1.5 Handle genFn47(a, b, ...) -> b (comma-op helper, last arg wins) ============
// genFn47 is `function genFn47() { genFn47 = function () {}; }` — a no-op that evaluates args
// and returns the LAST one (used as a comma-operator inline).
let fn47Inlined = 0;
traverse(ast, {
  CallExpression(path) {
    if (!t.isIdentifier(path.node.callee)) return;
    if (path.node.callee.name !== 'genFn47') return;
    const args = path.node.arguments;
    if (args.length < 2) {
      // single arg: just the arg
      path.replaceWith(args[0]);
      fn47Inlined++;
      return;
    }
    // Replace with SequenceExpression of all but last, then last -> just last
    // but keep side effects: use sequence if there are >2 args
    if (args.length === 2) {
      path.replaceWith(args[1]);
    } else {
      path.replaceWith(t.sequenceExpression(args));
    }
    fn47Inlined++;
  }
});
if (fn47Inlined) console.log(`[semantic_unshim] genFn47 inlined (comma-op): ${fn47Inlined}`);

// ============ 2. Semantic analysis: collect HIGH-CONFIDENCE patterns only ============
const varInfo = new Map(); // varName -> info

// First pass: find require() and new Telegraf/axios
traverse(ast, {
  VariableDeclarator(path) {
    // require()
    if (t.isIdentifier(path.node.id) && t.isCallExpression(path.node.init)) {
      const init = path.node.init;
      if (t.isIdentifier(init.callee) && init.callee.name === 'require' && init.arguments.length === 1) {
        const arg = init.arguments[0];
        if (t.isStringLiteral(arg)) {
          const varName = path.node.id.name;
          varInfo.set(varName, { require: arg.value, highConfidence: true });
        }
      }
      // new Telegraf(...) / new axios()
      if (t.isNewExpression(init)) {
        const callee = init.callee;
        if (t.isIdentifier(callee)) {
          if (callee.name === 'Telegraf' || callee.name === 'axios') {
            const varName = path.node.id.name;
            varInfo.set(varName, { isNew: callee.name, highConfidence: true });
          } else {
            // indirect: new <localAlias>(...) where <localAlias> = require('telegraf')
            const alias = varInfo.get(callee.name);
            if (alias && alias.require) {
              varInfo.set(path.node.id.name, {
                isNew: alias.require,
                highConfidence: true,
              });
            }
          }
        }
      }
    }
  },
  
  // Track method calls on variables (including computed with string literal)
  CallExpression(path) {
    if (t.isMemberExpression(path.node.callee)) {
      const obj = path.node.callee.object;
      const prop = path.node.callee.property;
      if (t.isIdentifier(obj)) {
        const objName = obj.name;
        if (!varInfo.has(objName)) varInfo.set(objName, {});
        const u = varInfo.get(objName);
        u.methodCalls = u.methodCalls || new Set();
        if (t.isIdentifier(prop) && !path.node.callee.computed) {
          u.methodCalls.add(prop.name);
        } else if (path.node.callee.computed && t.isStringLiteral(prop)) {
          u.methodCalls.add(prop.value);
        }
      }
    }
  },
  
  // Track property access
  MemberExpression(path) {
    if (!t.isIdentifier(path.node.object)) return;
    const obj = path.node.object.name;
    if (!varInfo.has(obj)) varInfo.set(obj, {});
    const u = varInfo.get(obj);
    if (t.isIdentifier(path.node.property) && !path.node.computed) {
      u.propAccess = u.propAccess || new Set();
      u.propAccess.add(path.node.property.name);
    } else if (path.node.computed && t.isStringLiteral(path.node.property)) {
      // Handle computed access with string literal: obj["prop"]
      u.propAccess = u.propAccess || new Set();
      u.propAccess.add(path.node.property.value);
    }
    // Track method calls via computed access too
    if (path.node.computed && t.isStringLiteral(path.node.property)) {
      // We can't know if it's a call here, but CallExpression handler will catch it
    }
  },
  
  // Track await
  AwaitExpression(path) {
    if (t.isCallExpression(path.node.argument) && t.isIdentifier(path.node.argument.callee)) {
      const fnName = path.node.argument.callee.name;
      if (!varInfo.has(fnName)) varInfo.set(fnName, {});
      varInfo.get(fnName).isAwaited = true;
    }
  },
  
  // Track new
  NewExpression(path) {
    if (t.isIdentifier(path.node.callee)) {
      const fnName = path.node.callee.name;
      if (!varInfo.has(fnName)) varInfo.set(fnName, {});
      varInfo.get(fnName).isNewed = true;
    }
  }
});

// ============ 3. Infer names with HIGH CONFIDENCE only ============
const usedNames = new Set(); // names already in use globally
traverse(ast, {
  Identifier(path) {
    const name = path.node.name;
    if (!/^(genFn|genArr|genVar|OBF_MARKER)\d*$/.test(name)) {
      usedNames.add(name);
    }
  }
});

function inferName(varName, u) {
  // Already has good name
  if (!/^(genFn|genArr|genVar|OBF_MARKER)\d*$/.test(varName)) {
    return varName;
  }
  
  // Require-based (HIGHEST confidence)
  if (u.require && u.highConfidence) {
    const req = u.require;
    if (req === 'telegraf') return 'Telegraf';
    if (req === 'axios') return 'axios';
    if (req === 'fs') return 'fs';
    if (req === 'path') return 'path';
    if (req === 'crypto') return 'crypto';
    if (req.includes('octokit')) return 'Octokit';
    if (req === 'chalk') return 'chalk';
    return req.split('/').pop().replace(/[^a-zA-Z0-9]/g, '');
  }
  
  // New-expression based (HIGH confidence)
  if (u.isNew && u.highConfidence) {
    if (u.isNew === 'Telegraf' || u.isNew === 'telegraf') return 'bot';
    if (u.isNew === 'axios') return 'axios';
  }
  
  const props = u.propAccess || new Set();
  const methods = u.methodCalls || new Set();
  
  // Bot pattern: has command, action, start, launch, use methods
  if (methods.has('command') && methods.has('action') && (methods.has('launch') || methods.has('start'))) {
    return 'bot';
  }
  
  // Telegraf Context - very specific pattern
  const telegrafMethods = ['reply', 'replyWithPhoto', 'replyWithDocument', 'editMessageText', 'answerCbQuery', 'deleteMessage'];
  const telegrafProps = ['message', 'chat', 'from', 'telegram', 'session', 'state'];
  if (methods.has('reply') && (methods.has('replyWithPhoto') || props.has('message') || props.has('chat'))) {
    return 'ctx';
  }
  
  // Axios instance
  if ((methods.has('get') && methods.has('post')) || props.has('interceptors') || props.has('defaults')) {
    return 'axios';
  }
  
  // fs
  if (methods.has('readFileSync') && methods.has('writeFileSync')) return 'fs';
  if (methods.has('readFile') && methods.has('writeFile')) return 'fs';
  
  // path
  if (methods.has('join') && methods.has('resolve')) return 'path';
  
  // crypto
  if (methods.has('createHash') || methods.has('createHmac') || methods.has('randomBytes')) return 'crypto';
  
  // Response from fetch/axios
  if (u.isAwaited && (methods.has('text') || methods.has('json') || props.has('data') || props.has('status'))) {
    return 'response';
  }
  
  // Error
  if (props.has('message') && props.has('stack') && (u.isNewed || props.has('name'))) return 'error';
  
  // RegExp
  if (u.isNewed && (methods.has('test') || methods.has('exec') || props.has('source'))) return 'regex';
  
  // FormData / URLSearchParams
  if (u.isNewed && (methods.has('append') || methods.has('get') || methods.has('set'))) return 'formData';
  
  // Buffer
  if (methods.has('from') && methods.has('toString') && !props.has('reply')) return 'Buffer';
  
  // JSON
  if (methods.has('parse') && methods.has('stringify')) return 'JSON';
  
  // Array (only if clear Array methods, not just push)
  if (methods.has('from') && methods.has('isArray')) return 'Array';
  
  // console
  if (methods.has('log') && (methods.has('error') || methods.has('warn') || methods.has('info'))) return 'console';
  
  // Promise
  if (methods.has('then') && methods.has('catch')) return 'promise';
  
  // Database
  if (methods.has('get') && methods.has('set') && methods.has('delete') && props.has('db')) return 'db';
  
  // Config object
  if (props.has('tokenBot') && props.has('ownerId') && props.has('allowedGroupID')) return 'config';
  
  // NO FALLBACK - keep generic name if not confident
  return varName;
}

const renameMap = new Map();
for (const [varName, u] of varInfo.entries()) {
  const newName = inferName(varName, u);
  if (newName !== varName && !/^(genFn|genArr|genVar|OBF_MARKER)\d*$/.test(newName)) {
    // Check collision
    if (!usedNames.has(newName)) {
      renameMap.set(varName, newName);
      usedNames.add(newName);
    } else {
      // Try with suffix
      let suffix = 1;
      let candidate = newName + suffix;
      while (usedNames.has(candidate)) { suffix++; candidate = newName + suffix; }
      renameMap.set(varName, candidate);
      usedNames.add(candidate);
    }
  }
}

// Also detect specific known patterns from require
for (const [varName, u] of varInfo.entries()) {
  if (u.require === 'axios' && !renameMap.has(varName)) renameMap.set(varName, 'axios');
  if (u.require === 'telegraf' && !renameMap.has(varName)) renameMap.set(varName, 'Telegraf');
}

// ============ 4. Apply rename (SCOPED: only inside function bodies, never top-level) ============
// Rationale: decoder/VM helpers live at top level. Renaming them to `ctx`/`axios` collides
// with handler-local names and shadows globals. Handlers always live inside functions, so
// restricting the rewrite to function scope cleanly separates the two.
const PROGRAM = ast.program;
const isTopLevel = (node) => {
  for (let p = node; p; p = p.parentPath || null) {
    if (p.parentPath === PROGRAM) return true;
    if (!p.parentPath) return true;
  }
  return false;
};

let renamedCount = 0;
traverse(ast, {
  Identifier(path) {
    const name = path.node.name;
    if (!renameMap.has(name)) return;
    const parent = path.parent;
    // Skip property keys, method definitions, class properties
    if (t.isObjectProperty(parent) && !parent.computed && parent.key === path.node) return;
    if (t.isMemberExpression(parent) && !parent.computed && parent.property === path.node) return;
    if (t.isObjectMethod(parent) && parent.key === path.node) return;
    if (t.isClassMethod(parent) && parent.key === path.node) return;
    if (t.isProperty(parent) && parent.key === path.node) return;
    // Skip top-level declarations (decoder helpers / shim definitions)
    if (t.isFunctionDeclaration(parent) && parent.id === path.node) return;
    if (t.isVariableDeclarator(parent) && parent.id === path.node) {
      // keep top-level `const axios = require(...)` renaming, skip everything else at top level
      if (isTopLevel(path) && !t.isCallExpression(parent.init)) return;
    }
    path.node.name = renameMap.get(name);
    renamedCount++;
  }
});

if (renamedCount > 0) {
  src = generate(ast, { compact: false, comments: false }).code;
  console.log(`[semantic_unshim] semantic rename: ${renamedCount} identifiers`);
}

// ============ 5. Fold constant computed property access ============
let foldedProps = 0;
src = src.replace(/([a-zA-Z_$][\w$]*)\["([a-zA-Z_$][\w$]*)"\]/g, (m, obj, prop) => {
  // Only fold if both look like real names (not genFn*)
  if (!/^(genFn|genArr|genVar|OBF_MARKER)\d*$/.test(obj) && !/^(genFn|genArr|genVar|OBF_MARKER)\d*$/.test(prop)) {
    foldedProps++;
    return `${obj}.${prop}`;
  }
  return m;
});
if (foldedProps) console.log(`[semantic_unshim] computed prop -> dot: ${foldedProps}`);

// ============ 6. Write output ============
fs.writeFileSync(output, src);
console.log(`[semantic_unshim] output: ${output}`);