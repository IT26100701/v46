#!/usr/bin/env node
'use strict';
/**
 * auto_detect.js — Stage AD0: full auto-detection fingerprint
 *
 * Runs FIRST, before every expensive stage. Produces a structured report of
 * WHAT obfuscation is present so the pipeline can gate stages instead of
 * running each one blind and hoping its own regex fires.
 *
 * Detects, with counts (evidence, not guesses):
 *   families    javascript-obfuscator, js-confuser, obfuscator.io, CVC/CJK,
 *               webpack, browserify, eval/JSFuck packed, generic
 *   control flow control-flow-flatten (switch/while dispatcher), template CFF,
 *               nested dispatcher, opaque predicates, dead code
 *   VM          bytecode VM (dispatch loop over state table), proxy functions
 *   ciphers     XOR/RC4/custom string decoder, TEA (0x9e3779b9), base64, hex
 *   strings     string-array (_0x), string hiding, concat/split, escape-heavy
 *   identifiers zero-width/invisible chars, _0x hex names, single-char names
 *   structure   module loaders, proxies, getters/setters used as confusion
 *
 * Emits one console line + writes <output>.detect.json. Generic_deob uses the
 * flags to skip stages that cannot apply.
 */
const fs = require('fs');
const path = require('path');

const INPUT = process.argv[2];
const OUTPUT = process.argv[3];
if (!INPUT) { console.error('Usage: node auto_detect.js <input.js> [report.json]'); process.exit(1); }

const src = fs.readFileSync(INPUT, 'utf8');
const n = src.length;

// ── helpers ────────────────────────────────────────────────────────────────
const count = (re) => { let c = 0; const g = src.match(re); return g ? g.length : 0; };
const has = (re) => re.test(src);
const safe = (fn, d) => { try { return fn(); } catch (e) { return d; } };

// ── zero-width / invisible chars (JS-Confuser & friends) ───────────────────
const ZW = /[\u200b\u200c\u200d\u200e\u200f\u2060\ufeff\u180e\u2061-\u206f\u{e0000}-\u{e007f}]/gu;
const zwCount = safe(() => { const m = src.match(ZW); return m ? m.length : 0; }, 0);

// ── identifier shape ───────────────────────────────────────────────────────
const hex0x = count(/\b_0x[a-f0-9]{3,}\b/g);
const hex0xLen = (src.match(/\b_0x[a-f0-9]{3,}\b/g) || []).reduce((a, s) => a + s.length, 0);
// single-letter / tiny locals (minified) — sample first 400KB for speed
const head = src.slice(0, 400000);
const tinyId = (head.match(/\b[a-z]\b\s*=/g) || []).length;
// readable identifier density: how many words of length>=3 look like real names
const words = (head.match(/\b[a-z][a-zA-Z]{4,}\b/g) || []);
const dictish = words.filter((w) => /^(?:get|set|data|name|type|value|list|item|user|code|body|path|file|text|json|push|join|trim|then|catch|await|return|function|length|message|error|status|request|response|server|client|module|exports|require|window|document|format|encode|decode|string|number|object|number|index|count|total|result|target|source|origin|create|update|delete|change|handle|process|config|options|param|args|callback|promise|resolve|reject|buffer|stream|read|write|parse|stringify|concat|split|slice|splice|replace|match|test|exec|char|code|from|to|at|in|of|is|has|can|no|new|key|val|obj|arr|str|fn|res|req|err|out|inp|pos|len|max|min|sum|mul|div|add|sub|bit|and|or|xor|not)$/i.test(w)).length;

// ── families ───────────────────────────────────────────────────────────────
const family = [];
if (has(/eval\(function\((p|a|c|k)/)) family.push('packed-dean-edwards');
if (has(/eval\s*\(\s*atob\s*\(|eval\s*\(\s*Function\s*\(/)) family.push('eval-packed');
if (has(/\beval\s*\(\s*["'`]/) || has(/new\s+Function\s*\(/)) family.push('eval-fn');
if (has(/\b_0x[a-f0-9]{3,}\b/)) family.push('string-array-0x');
if (has(/0x9e3779b9/)) family.push('TEA');
if (has(/__webpack_require__|webpackBootstrap|__webpack_modules__/)) family.push('webpack');
if (has(/require\s*=\s*function\s*\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)/)) family.push('browserify');
if (has(/\$_\$\$|\\x5f\\x24/)) family.push('JJEncode');
if (has(/\[\(!\!\[\]\]\[\(\]/) || (src.match(/\[!\[\]\]/g) || []).length > 5) family.push('JSFuck');
if (has(/jsconfuser|__p_[A-Za-z0-9]{4}_(cff|xor|sum|hash|4_states|rgf|dlr)/)) family.push('js-confuser');
if (has(/javascript-obfuscator|_0x[a-f0-9]+\s*=\s*function/)) family.push('javascript-obfuscator');
if (has(/[\u4e00-\u9fff]/) || has(/[a-z]_l[0-9]{2}_V_?/)) family.push('CVC/CJK');
if (zwCount > 0) family.push('invisible-identifier');
if (!family.length) family.push('generic');

// ── control flow ───────────────────────────────────────────────────────────
const cff = {
  switch: count(/\bswitch\s*\(/g),
  while: count(/\bwhile\s*\(/g),
  // dispatcher shape: switch on a computed discriminant, cases assign state
  cffSwitch: count(/\bswitch\s*\([^)]*(?:states|__p_|_scope|sum|hash)/g),
  cffSum: count(/__p_[A-Za-z0-9]{4}_cff_sum\s*\(/g),
  cffXor: count(/__p_[A-Za-z0-9]{4}_cff_xor\s*\(/g),
  cffHash: count(/__p_[A-Za-z0-9]{4}_cff_hash\s*\(/g),
  opaque: count(/!\s*\[\s*\]\s*(?:&&|===)|===\s*!!\s*\[|&&\s*!!\s*\[\s*\]/g),
  deadIf: count(/\bif\s*\(\s*(?:0|1|false|true)\s*\)/g),
  ternaryChain: count(/\?\s*[^:?]{1,40}:\s*[^?]{1,40}\s*\?\s*/g),
  commaSeq: count(/(?:\+=|\-=|\|=|&=|\^=)[^;]{0,60}(?:,\s*[A-Za-z_$][\w$]*\s*(?:\+=|\-=))/g),
  nestedSwitch: count(/\bswitch[\s\S]{0,2000}?\bswitch/g),
  hasCFF: false,
};
cff.hasCFF = cff.cffSum > 0 || cff.cffXor > 0 || cff.cffHash > 0 || cff.cffSwitch > 0;

// ── VM / bytecode ──────────────────────────────────────────────────────────
const vm = {
  // dispatch loop over a state table: while(true){ switch(state){...} }
  dispatchLoop: count(/\bwhile\s*\(\s*(?:!!\s*\[\s*\]|true|1)\s*\)\s*\{[\s\S]{0,400}?\bswitch/g),
  stateTable: count(/\b(?:states|stateTable|_states|state)\s*=\s*\[/g),
  opcodeMap: count(/\b(?:op|opcode|instr|bytecode)\s*[:=]\s*(?:\{|\[)/g),
  procsArray: count(/\b(?:procs|handlers|ops)\s*=\s*\[/g),
  vmFunc: count(/\bvm_\w+\s*\(/g),
  proxyFn: count(/\bfunction\s+\w+\s*\(\s*\w+\s*,\s*\w+\s*\)\s*\{\s*return\s+\w+\s*\[/g),
  hasVM: false,
};
vm.hasVM = vm.dispatchLoop > 0 || (vm.stateTable > 0 && vm.opcodeMap > 0) || vm.vmFunc > 0;

// ── ciphers / decoders ─────────────────────────────────────────────────────
const cipher = {
  xor: count(/\^\s*0x[0-9a-f]{2}\b|\^\s*\d{1,3}\b/g),
  xorDecoder: count(/\bxor\w*\s*\(/gi),
  rc4: count(/\brc4\b|\bprga\b|\bksa\b/gi),
  tea: count(/0x9e3779b9/g),
  base64: count(/\batob\s*\(|fromCharCode\(|\\x[0-9a-f]{2}/g),
  hex: (src.match(/\\x[0-9a-fA-F]{2}/g) || []).length,
  unicode: (src.match(/\\u[0-9a-fA-F]{4}/g) || []).length,
  charCodeLoop: count(/charCodeAt|fromCharCode|codePointAt/g),
  decoderCall: count(/(?:decode|decrypt|unpack|_0x[0-9a-f]+)\s*\(/g),
  hasCipher: false,
};
cipher.hasCipher = cipher.xorDecoder > 0 || cipher.rc4 > 0 || cipher.tea > 0 || cipher.charCodeLoop > 0;

// ── strings ────────────────────────────────────────────────────────────────
const str = {
  stringArray: count(/\b_0x[a-f0-9]{3,}\b|\b(?:strings|_str|strTable|arr)\s*=\s*\[\s*["'`]/g),
  longString: Math.max(0, ...((src.match(/["'`][^"'`]{80,}["'`]/g) || []).map((s) => s.length))),
  concat: count(/\+\s*["'`]|["'`]\s*\+\s*["'`]/g),
  split: count(/\.split\s*\(\s*["'`]/g),
  fromCharCode: count(/fromCharCode/g),
  hasBigStrings: false,
};
str.hasBigStrings = str.longString > 500 || str.stringArray > 0;

// ── structure ──────────────────────────────────────────────────────────────
const struct = {
  getters: count(/\bget\s+[A-Za-z_$][\w$]*\s*\(\s*\)/g),
  setters: count(/\bset\s+[A-Za-z_$][\w$]*\s*\(/g),
  defineProp: count(/definePropert/g),
  withStmt: count(/\bwith\s*\(/g),
  proxy: count(/\bnew Proxy\s*\(/g),
  freeze: count(/Object\.(?:freeze|seal)\s*\(/g),
  objKeys: count(/Object\.(?:keys|values|entries|assign|definePropert)/g),
  iife: count(/\(\s*function\s*\([^)]*\)\s*\{[\s\S]{0,200}?\}\s*\)\s*\(/g),
  module: count(/\b(?:module|exports|require)\b/g),
};

// ── per-stage gates: which stages are worth running ────────────────────────
  //
  // WHY SOME GATES ARE ALWAYS TRUE: gates computed from the ORIGINAL input go
  // stale.  Prior stages (jsconfuser_techniques, jsobf_jsconfuser) CREATE
  // patterns (rest-param masks, numeric register tables) that only exist after
  // they run.  Gating on input-time detection silently disables those stages,
  // causing regressions.  For cff_hard_unroll, var_mask_restore, and
  // numeric_table_fold, the internal detection logic in each .js file decides
  // whether work actually exists — so we always invoke the stage and let the
  // stage's own guard decide.
  const gates = {
    runtime_decode: hex0x > 5 || struct.iife > 3 || has(/(?:decode|unpack|_0x[a-f0-9]+)\s*\(/),
    webcrack: family.includes('webpack') || family.includes('browserify') ||
              has(/\b__webpack_require__|\bmodule\.exports\s*=\s*function\b|\bruntime\b\s*:\s*\{/),
    sandbox_capture: family.includes('eval-packed') || family.includes('eval-fn') ||
                     family.includes('JSFuck') || family.includes('JJEncode') ||
                     family.includes('packed-dean-edwards'),
    jsobf_tea: cipher.tea > 0,
    jsobf_cvc: family.includes('CVC/CJK') || family.includes('invisible-identifier'),
    cff_unroll: cff.cffSum > 0 || cff.cffXor > 0 || cff.hasCFF || cff.switch > 5,
    cff_hard_unroll: true,    // always run; internal check decides
    jsconfuser: family.includes('js-confuser'),
    jsconfuser_techniques: family.includes('js-confuser'),
    var_mask: true,           // always run; internal check decides
    xor_decode: cipher.hasCipher || cipher.xor > 10,
    vm_trace: vm.hasVM,
    vm_hard_decode: vm.hasVM,
    semantic_naming: true,
    numeric_table_fold: true, // always run; internal check decides
    string_table: true,       // always run; internal check decides
    strip_invisible: zwCount > 0,
  };

const report = {
  file: path.basename(INPUT),
  bytes: n,
  family,
  identifiers: { zeroWidth: zwCount, hex0x, hex0xLen, tinyId, dictish, dictRatio: words.length ? +(dictish / words.length).toFixed(3) : 0 },
  cff,
  vm,
  cipher,
  strings: str,
  structure: struct,
  gates,
  risk: {
    // high = likely needs the heavy stages
    needsVM: vm.hasVM,
    needsCFF: cff.hasCFF,
    needsCipher: cipher.hasCipher,
    needsEval: family.some((f) => /eval|packed|JSFuck|JJEncode/.test(f)),
    minified: dictish / Math.max(1, words.length) < 0.25,
  },
};

const reportPath = OUTPUT ? OUTPUT : INPUT.replace(/\.js$/, '') + '.detect.json';
try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); } catch (e) { /* report is best-effort */ }

// one line for the orchestrator to grep
const on = Object.keys(gates).filter((k) => gates[k]);
console.log('[auto_detect] family=' + family.join('+') +
  ' | zw=' + zwCount + ' hex0x=' + hex0x +
  ' | cff=' + (cff.hasCFF ? 'Y' : 'n') + ' switch=' + cff.switch +
  ' vm=' + (vm.hasVM ? 'Y' : 'n') +
  ' cipher=' + (cipher.hasCipher ? 'Y' : 'n') +
  ' | gates: ' + on.join(','));
process.exit(0);
