'use strict';
/**
 * jsobf_cvc.js — deobfuscation stage for the "CVC / CJK-suffix" obfuscator family.
 *
 * Signature this stage gates on (all must hold, so old targets are untouched):
 *   1. a top-level FunctionDeclaration named 强宝高XazepysKき高高座宝 (the public getter)
 *   2. a top-level FunctionDeclaration named 我座的宝强XazepysK强座高的座 (the decoder)
 *   3. a top-level VariableDeclaration named き强的我XazepysK宝き强高宝的 holding >= 0x40 entries
 *   3b. the file contains the no-op separator 高座座XazepysK强宝座 and a 0x9e3779b9 mixer
 *
 * What it does:
 *   - slices the top-level statements that constitute the decoder prelude out of the source
 *   - runs only that prelude in a locked-down vm context (no require, no timers, no network)
 *   - evaluates every getter/decoder call site's ORIGINAL SOURCE TEXT, so argument
 *     expressions such as き强的我XazepysK宝き强高宝的[0x1f9] resolve themselves
 *   - constant-folds each successful decode into a string literal
 *   - rewrites member expressions that the decode feeds (e.g. .["length"], .length)
 *   - re-parses the rewritten source, verifies it, and reports what it did
 *
 * Runs AFTER webcrack (webcrack cannot fold this family) and BEFORE the rename/VM stages.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;

const GETTER_NAME = '强宝高XazepysKき高高座宝';
const DECODER_NAME = '我座的宝强XazepysK强座高的座';
const CONST_NAME = 'き强的我XazepysK宝き强高宝的';
const NOOP_NAME = '高座座XazepysK强宝座';

// Statements that must exist before the getter is callable: the mixer, the TEA
// decryptor, the const table, the big string blob, and the decoder itself.
const PRELUDE_NAMES = [
  '宝我きXazepysK我宝强高高我',   // xxhash-style mixer
  '我座强我XazepysK强高高',       // TEA decrypt
  '宝强座宝XazepysK座座强座我我', // sum
  '高高座XazepysK高强高き座',     // slice alias
  '我座的宝强XazepysK强座高的座', // decoder
  '强宝高XazepysKき高高座宝',     // getter
  'き强的我XazepysK宝き强高宝的',  // const table
  '座高强XazepysK宝强强き'         // string blob
];

function log(verbose, ...args) {
  if (verbose) console.log(...args);
}

function parseSource(code) {
  return parser.parse(code, {
    sourceType: 'script',
    errorRecovery: false,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true
  });
}

/** Structural fingerprint of the family — deliberately identifier-agnostic.
 *
 *  Names like 强宝高XazepysKき hoog座宝 are DIAGNOSTIC, never a gate: an
 *  obfuscator regenerates its identifier set on every run, so a name-based gate
 *  silently stops matching (it "passes through" instead of failing loudly).
 *  Measured on the reference target: 50459-char pool, 575-entry const array,
 *  78 while/switch dispatchers, ~11k indexed compound writes, xxhash constants.
 */
function cvcStructure(code) {
  const s = {
    pool: 0,
    constArray: 0,
    dispatchers: 0,
    indexedCompound: 0,
    xxhash: 0,
    charMath: 0
  };

  // Largest single-quoted / double-quoted / template string literal.
  for (const m of code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    if (m[2].length > s.pool) s.pool = m[2].length;
  }
  // Longest top-level-ish array literal, counted by top-level commas.
  for (const m of code.matchAll(/=\s*\[([^\][]{400,})\]/g)) {
    const n = m[1].split(',').length;
    if (n > s.constArray) s.constArray = n;
  }
  s.dispatchers = (code.match(/while\s*\(/g) || []).length;
  s.indexedCompound = (code.match(/\w+\s*\[[^\]]{1,60}\]\s*\+=/g) || []).length;
  // xxhash/TEA seed constants, in either hex or webcrack-normalised decimal.
  for (const c of ['0x9e3779b9', '2654435769', '1640531527', '0x243f6a88', '608135816', '0x6a09e667', '1779033703', '0x7f4a7c15', '2135587861']) {
    if (code.includes(c)) s.xxhash++;
  }
  s.charMath = (code.match(/charCodeAt/g) || []).length;
  return s;
}

/** Does the structure look like this family, with no reliance on names? */
function isCvcStructure(code) {
  const s = cvcStructure(code);
  return s.pool >= 50000 && s.constArray >= 500 && s.xxhash >= 1 && s.dispatchers >= 8;
}

/** Cheap family probe that never throws.
 *
 *  Accepts both the raw form (0x9e3779b9) and the webcrack-normalised decimal
 *  form (2654435769) of the mixer constant, because webcrack rewrites numeric
 *  literals before this stage ever sees the file.
 *
 *  The name check selects the decoder functions to slice and call; the
 *  structural check is what proves the FAMILY. When the structure matches but the
 *  names do not, return a distinct reason instead of a silent pass-through.
 */
function isCvcFamily(code) {
  const hasMixer = code.includes('0x9e3779b9') || code.includes('2654435769') || code.includes('1640531527');
  const byName =
    code.includes(GETTER_NAME) &&
    code.includes(DECODER_NAME) &&
    code.includes(CONST_NAME) &&
    code.includes(NOOP_NAME) &&
    hasMixer;
  if (byName) return true;
  // Structure matches but identifiers were regenerated: the decoder functions can
  // no longer be located by name. Surface it rather than pretending "no match".
  try {
    if (isCvcStructure(code)) return 'structure-without-names';
  } catch (e) { /* never throw from the gate */ }
  return false;
}

/** Find the maximal run of top-level statements that ends with the getter declaration. */
function findPreludeRange(ast) {
  const body = ast.program.body;
  const getterIdx = body.findIndex(
    (n) => n.type === 'FunctionDeclaration' && n.id && n.id.name === GETTER_NAME
  );
  if (getterIdx === -1) return null;

  const needed = new Set(PRELUDE_NAMES);
  const constIdx = body.findIndex(
    (n) => n.type === 'VariableDeclaration' && n.declarations.some((d) => d.id.type === 'Identifier' && d.id.name === CONST_NAME)
  );
  if (constIdx === -1) return null;
  needed.add(CONST_NAME);

  // Everything from 0 through getterIdx that we actually need, plus the blob node
  // (the giant ExpressionStatement that fills 座高强XazepysK宝强强き).
  const end = body[getterIdx].end;
  const start = 0;
  return { start, end, getterIdx, constIdx };
}

/** Build a minimal, side-effect-free sandbox. */
function makeSandbox(file) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {}, trace() {} },
    process: {
      env: {}, argv: [], platform: 'linux', version: 'v24.0.0',
      cwd: () => '/', nextTick() {}, exit() {}, on() {}, kill() {}, stdout: { write() {} }
    },
    process_obj_unused: null,
    Buffer,
    URL, URLSearchParams, TextEncoder, TextDecoder
  };
  delete sandbox.process_obj_unused;
  sandbox.setTimeout = () => 0;
  sandbox.clearTimeout = () => {};
  sandbox.setInterval = () => 0;
  sandbox.clearInterval = () => {};
  sandbox.setImmediate = () => 0;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__dirname = path.dirname(file) || '/';
  sandbox.__filename = file;
  return sandbox;
}

function buildPrelude(code, ast, verbose = true) {
  const body = ast.program.body;
  const range = findPreludeRange(ast);
  if (!range) return null;

  // Inclusion rule, learned the hard way on this family:
  //  - PART A: every top-level statement from the start of the file up to (but NOT
  //    including) the first NON-function statement that calls require(). That window is
  //    pure decoder state: the var list, the xxhash mixer, TEA decrypt, const table,
  //    the 302KB encrypted string blob, the decoder, the getter, and the decoder's
  //    own shims. The blob lives AFTER the getter — cutting the window at the getter
  //    leaves 座高强XazepysK宝强强き undefined and every decode throws.
  //  - PART B: small top-level FunctionDeclarations from anywhere later in the file.
  //    Declaring a function does not run its body, so it is safe, and it supplies
  //    helpers (高强座高XazepysKき宝宝, 宝きき座的XazepysK高高高座座) the decoder calls.
  //    The 1.4MB VM shim 宝座座座XazepysK强强的 is excluded by MAX_FN_BYTES: it holds
  //    three decoy decoders, costs a huge parse, and the live decoder does not need it.
  const MAX_FN_BYTES = 120000;
  const firstSideEffect = body.findIndex(
    (n) => n.type !== 'FunctionDeclaration' && /\brequire\s*\(/.test(code.slice(n.start, n.end))
  );
  const partAEnd = firstSideEffect === -1 ? body.length : firstSideEffect;

  const parts = [];
  let addedFns = 0, skippedBig = 0;
  for (let i = 0; i < body.length; i++) {
    const node = body[i];
    const text = code.slice(node.start, node.end);
    if (i < partAEnd) { parts.push(text); continue; }
    if (node.type === 'FunctionDeclaration') {
      if (node.end - node.start <= MAX_FN_BYTES) { parts.push(text); addedFns++; }
      else skippedBig++;
      continue;
    }
  }
  log(verbose, '[cvc] prelude: partA', partAEnd, 'stmt | fns added past it', addedFns, '| big fns skipped', skippedBig);
  // The separator no-op lives at the very end of the file, but the decoder calls it
  // 1.6k times. Recreate its literal no-op body here.
  parts.push('function ' + NOOP_NAME + '(){' + NOOP_NAME + '=function(){}}');
  return parts.join('\n');
}

function runPrelude(prelude, file) {
  const ctx = vm.createContext(makeSandbox(file));
  let err = null;
  try {
    vm.runInContext(prelude, ctx, { timeout: 120000, filename: 'cvc-prelude.js' });
  } catch (e) {
    err = e;
  }
  if (err) throw new Error('prelude failed: ' + String(err.message).slice(0, 300));
  for (const n of [GETTER_NAME, DECODER_NAME, CONST_NAME]) {
    if (vm.runInContext('typeof ' + n, ctx) === 'undefined') {
      throw new Error('prelude missing ' + n);
    }
  }
  return ctx;
}

function printableRatio(s) {
  if (typeof s !== 'string' || s.length === 0) return -1;
  let ok = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c > 0x2000) ok++;
  }
  return ok / [...s].length;
}

/**
 * Main entry. Returns { output, stats } or { skipped, reason }.
 */
function deobfuscate(inputPath, options = {}) {
  const verbose = options.verbose !== false;
  const code = fs.readFileSync(inputPath, 'utf8');

  if (!isCvcFamily(code)) {
    return { skipped: true, reason: 'not-cvc-family' };
  }
  // Structure matched but the decoder identifiers are not the ones we know: the
  // file IS this family, re-obfuscated with fresh names. Fail loudly rather than
  // reporting a clean "no match".
  if (isCvcFamily(code) !== true) {
    const s = cvcStructure(code);
    return {
      skipped: true,
      reason: 'cvc-structure-detected-but-identifier-names-unknown',
      signals: s,
      hint: 'this file matches the CVC fingerprint (pool=' + s.pool + ' constArray=' + s.constArray +
            ' dispatchers=' + s.dispatchers + ' xxhash=' + s.xxhash + ') but the decoder functions are ' +
            'named differently; decoder discovery currently relies on known names'
    };
  }

  let ast;
  try {
    ast = parseSource(code);
  } catch (e) {
    return { skipped: true, reason: 'parse-failed: ' + String(e.message).slice(0, 120) };
  }

  let ctx;
  try {
    const prelude = buildPrelude(code, ast, verbose);
    if (!prelude) return { skipped: true, reason: 'no-prelude' };
    ctx = runPrelude(prelude, inputPath);
  } catch (e) {
    return { skipped: true, reason: String(e.message).slice(0, 200) };
  }

  // Collect every decode call site.
  const calls = [];
  traverse(ast, {
    CallExpression(p) {
      const c = p.node.callee;
      if (c.type !== 'Identifier') return;
      if (c.name !== GETTER_NAME && c.name !== DECODER_NAME) return;
      if (p.node.arguments.length === 0) return;
      calls.push({ node: p.node, start: p.node.start, end: p.node.end, name: c.name });
    }
  });
  log(verbose, '[cvc] decode call sites:', calls.length);
  if (calls.length === 0) return { skipped: true, reason: 'no-call-sites' };

  // Evaluate each call's own source text so its arguments fold themselves.
  const replacements = [];
  let decoded = 0, skippedBad = 0, failed = 0;
  let firstErr = null;
  for (const call of calls) {
    const text = code.slice(call.start, call.end);
    if (text.length > 6000) { failed++; continue; }
    let val;
    try {
      val = vm.runInContext(text, ctx, { timeout: 10000 });
    } catch (e) { failed++; if (!firstErr) firstErr = e.message + ' ||| ' + text.slice(0, 160); continue; }
    const r = printableRatio(val);
    if (r < 0.9) { skippedBad++; continue; }
    replacements.push({ start: call.start, end: call.end, value: val });
    decoded++;
  }
  log(verbose, '[cvc] decoded', decoded, '| unprintable', skippedBad, '| errors', failed);
  if (verbose && firstErr) log(verbose, '[cvc] first eval error:', firstErr);

  if (decoded === 0) return { skipped: true, reason: 'nothing-decodable' };

  // Dump fold map (decoder text → resolved value) for downstream stages that run
  // after the decoder's identifier names are gone (renamed/pruned).
  try {
    const mapFile = path.join(path.dirname(inputPath), 'cvc-fold-map.json');
    const map = {};
    for (const r of replacements) {
      const k = code.slice(r.start, r.end);
      if (!Object.prototype.hasOwnProperty.call(map, k)) map[k] = r.value;
    }
    fs.writeFileSync(mapFile, JSON.stringify(map));
    log(verbose, '[cvc] fold map wrote ' + mapFile + ' (' + Object.keys(map).length + ' entries)');
  } catch (e) { /* best-effort only */ }

  // Apply from the end so earlier offsets stay valid. (replaced below by the
  // combined splice in pass 2, which also handles const-table folds)
  replacements.sort((a, b) => b.start - a.start);
  let out = code;

  // Pass 2 — fold the const-index table. Decoded call sites often take their
  // arguments from き强的我XazepysK宝き强高宝的[N] (e.g. "length", "map", a
  // separator string), so those indexes become plain literals too.
  //
  // IMPORTANT: a const reference that sits INSIDE an already-decoded call site is
  // already gone — the call was replaced wholesale by its decoded string. Only
  // collect const references that live OUTSIDE every accepted call range, otherwise
  // the splice drops the call folds and the output regresses to raw decoder calls.
  let constFolds = 0;
  try {
    const constValues = vm.runInContext(CONST_NAME, ctx);
    if (Array.isArray(constValues)) {
      const taken = replacements.map((r) => [r.start, r.end]).sort((a, b) => a[0] - b[0]);
      const inside = (pos) => {
        let lo = 0, hi = taken.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (taken[mid][1] <= pos) lo = mid + 1; else hi = mid; }
        return lo < taken.length && taken[lo][0] <= pos && pos < taken[lo][1];
      };
      const folds = [];
      traverse(ast, {
        MemberExpression(p) {
          const o = p.node.object;
          if (!o || o.type !== 'Identifier' || o.name !== CONST_NAME) return;
          const idx = p.node.computed ? p.node.property : null;
          if (!idx || idx.type !== 'NumericLiteral') return;
          if (inside(p.node.start)) return;
          const v = constValues[idx.value];
          if (v === undefined || typeof v === 'object' || v === null) return;
          if (typeof v === 'number' || typeof v === 'boolean') {
            folds.push({ start: p.node.start, end: p.node.end, text: String(v) });
          } else if (typeof v === 'string') {
            folds.push({ start: p.node.start, end: p.node.end, text: JSON.stringify(v) });
          }
        }
      });
      const all = replacements.concat(folds);
      all.sort((a, b) => b.start - a.start);
      out = code;
      let last = Infinity;
      for (const r of all) {
        if (r.end > last) continue; // overlapping — keep the outer/earlier one
        const text = (r.text !== undefined) ? r.text : JSON.stringify(r.value);
        out = out.slice(0, r.start) + text + out.slice(r.end);
        last = r.start;
      }
      constFolds = folds.length;
    }
  } catch (e) {
    if (verbose) log(verbose, '[cvc] const fold skipped:', String(e.message).slice(0, 120));
  }
  log(verbose, '[cvc] const-table folds:', constFolds);

  let valid = false;
  try { parseSource(out); valid = true; } catch (e) { valid = false; }
  log(verbose, '[cvc] syntax after fold:', valid);

  let pretty = out;
  if (valid) {
    try {
      const ast2 = parseSource(out);
      pretty = generate(ast2, { compact: false, concise: true, comments: true }, code).code;
      // restore leading shebang if any
      if (code.startsWith('#!')) pretty = code.slice(0, code.indexOf('\n') + 1) + pretty;
    } catch (e) { /* keep unfolded source */ }
  }

  return {
    skipped: false,
    output: pretty,
    raw: out,
    stats: {
      family: 'cvc-cjk-suffix',
      call_sites: calls.length,
      decoded: decoded,
      unprintable: skippedBad,
      errors: failed,
      const_folds: constFolds,
      valid_after: valid,
      bytes_in: code.length,
      bytes_out: pretty.length
    }
  };
}

module.exports = { deobfuscate, isCvcFamily, GETTER_NAME, DECODER_NAME, CONST_NAME, NOOP_NAME };

// CLI: node jsobf_cvc.js <file.js> [out.js]
if (require.main === module) {
  const [, , input, outPath] = process.argv;
  if (!input) { console.error('usage: node jsobf_cvc.js <file.js> [out.js]'); process.exit(2); }
  const res = deobfuscate(input, { verbose: true });
  if (res.skipped) { console.error('[cvc] skipped:', res.reason); process.exit(3); }
  const dest = outPath || input.replace(/\.js$/, '') + '-cvc.js';
  fs.writeFileSync(dest, res.output);
  console.log('[cvc] wrote', dest, JSON.stringify(res.stats));
}
