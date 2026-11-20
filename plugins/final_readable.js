#!/usr/bin/env node
/**
 * final_readable.js — Stage terakhir pipeline: bikin hasil deobfuscasi RAPI & TERBACA.
 *
 * 1. Fold semua string concat ("a"+"b" -> "ab"), termasuk \uXXXX escape.
 * 2. Rename variabel mangled -> nama bermakna (konteks require & usage).
 *    Works with both vN (generic_deob rename) and fN (jsobf_tea output) schemes.
 * 3. Hapus kode sampah: decoder helper yang sudah tidak terpakai, anti-debug,
 *    function kosong, VM dispatcher yang tidak menghasilkan output.
 * 4. Beautify + urutkan output.
 *
 * Usage: node plugins/final_readable.js <input.js> <output.js>
 */
const fs = require('fs');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const t = require('@babel/types');
const traverse = require('@babel/traverse').default;

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  console.error('usage: final_readable.js <input.js> <output.js>');
  process.exit(1);
}

let src = fs.readFileSync(input, 'utf8');

// ============ 1. FOLD STRING CONCATS (regex iterative — robust untuk \uXXXX) ============
function foldStringConcats(code) {
  let count = 0;
  const re = /"((?:[^"\\]|\\.)*)"\s*\+\s*"((?:[^"\\]|\\.)*)"/;
  let m, guard = 0;
  const unescape = (x) => x
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
    .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const reescape = (x) => x
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r')
    .replace(/[^\x20-\x7e]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  while ((m = re.exec(code)) && guard++ < 1000000) {
    const joined = unescape(m[1]) + unescape(m[2]);
    code = code.slice(0, m.index) + '"' + reescape(joined) + '"' + code.slice(m.index + m[0].length);
    count++;
  }
  return { code, count };
}

const folded = foldStringConcats(src);
console.log(`[final_readable] string concats folded: ${folded.count}`);
src = folded.code;
fs.writeFileSync(output, src); // intermediate (safe)

// ============ 2. PARSE + RENAME + DEAD-CODE + BEAUTIFY ============

// --- Generic rename pass: handles ANY mangled scheme (vN, fN, CJK, short, etc.) ---
// Runs before hardcoded maps so it catches unknown patterns
function genericRenamePass(code) {
  const parser = require('@babel/parser');
  const generate = require('@babel/generator').default;
  const traverse = require('@babel/traverse').default;
  const t = require('@babel/types');

  let ast;
  try {
    ast = parser.parse(code, { sourceType: 'script', errorRecovery: true });
  } catch (e) {
    return { code, renamed: 0 };
  }

  // Decide once whether this file looks minified. Renaming short identifiers is
  // only safe when they are minifier output, and `num` / `url` / `msg` / `res`
  // are short but perfectly meaningful. Minified files are dominated by 1–2
  // character names AND the file is large enough for that to be conclusive, so
  // require both: ≥70% short and at least 40 bindings. Hand-written code with a
  // few short locals stays untouched.
  const MINIFIED_LIKE = (() => {
    const names = new Set();
    try {
      traverse(ast, {
        Identifier(p) { if (p.node && p.isBindingIdentifier && p.isBindingIdentifier()) names.add(p.node.name); },
      });
    } catch (e) { return false; }
    if (names.size < 40) return false;
    let short = 0;
    for (const n of names) if (/^[a-zA-Z_$]{1,2}$/.test(n)) short++;
    return short / names.size >= 0.7;
  })();

  // A mixed-case identifier is a generated marker (not a real name) when it has
  // no lowercase run of 3+ characters anywhere — real camelCase words almost
  // always contain one, obfuscator output almost never does.
  const isGeneratedMarker = (n) => !/[a-z]{3,}/.test(n);

  // isJunk: identifier that looks mangled/obfuscated
  // Covers: CJK, short (1-3 chars), tail-hex, $var$const$break$, mixed-case obfuscator markers, etc.
  const isJunk = (n) => {
    if (!n || n.length > 50) return false;
    // CJK / Unicode extended
    if (/[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uF900-\uFAFF]/.test(n)) return true;
    // obfuscator.id generated suffix
    if (/\$var\$const\$break\$/.test(n)) return true;
    // tail hex 12+
    if (/[a-z0-9]{6,}[0-9a-f]{12,}/i.test(n)) return true;
    // single/double/triple letter (likely minified). Only when the file actually
    // looks minified — otherwise we would rename the author's own `num`, `url`,
    // `msg`, which are short but perfectly readable. We decide that once, below,
    // from the overall identifier-length distribution.
    if (MINIFIED_LIKE && /^[a-zA-Z_$]{1,3}$/.test(n)) return true;
    // fN / vN / arrN patterns
    if (/^[fva]rr?\d+$/.test(n)) return true;
    // Random mixed-case markers (XazepysK, MRRh3I, …) — camelCase with capitals
    // in the middle AND no dictionary-ish lowercase run. `fetchData`,
    // `getUserId` and friends are legitimate names, so require the marker to
    // look generated: a capital followed by consonants/digits rather than a
    // known word shape.
    if (/[a-z][A-Z]/.test(n) && n.length > 5 && isGeneratedMarker(n)) return true;
    return false;
  };

  // Force-rename these obfuscator markers even if they appear as properties
  const forceRename = (n) => {
    if (/\$var\$const\$break\$/.test(n)) return true;
    if (/[a-z][A-Z]/.test(n) && n.length > 5 && isGeneratedMarker(n)) return true;
    return false;
  };

  // Collect all identifiers in code segments
  const junkAll = new Set();
  const propUsed = new Set();
  const fnSet = new Set();
  const arrSet = new Set();

  traverse(ast, {
    Identifier(path) {
      const name = path.node.name;
      if (!isJunk(name)) return;
      junkAll.add(name);
    },
    MemberExpression(path) {
      if (t.isIdentifier(path.node.property) && !path.node.computed) {
        propUsed.add(path.node.property.name);
      }
    },
    FunctionDeclaration(path) {
      if (path.node.id && isJunk(path.node.id.name)) fnSet.add(path.node.id.name);
    },
    VariableDeclarator(path) {
      if (t.isIdentifier(path.node.id) && isJunk(path.node.id.name)) {
        const parent = path.parentPath;
        if (t.isVariableDeclaration(parent.node)) {
          const init = path.node.init;
          if (t.isArrayExpression(init)) arrSet.add(path.node.id.name);
        }
      }
    }
  });

  // Build rename map
  const rename = new Map();
  let fnIdx = 0, arrIdx = 0, vIdx = 0;
  for (const n of [...junkAll].sort()) {
    if (propUsed.has(n) && !forceRename(n)) continue; // skip property access
    if (fnSet.has(n))     rename.set(n, 'genFn' + (++fnIdx));
    else if (arrSet.has(n)) rename.set(n, 'genArr' + (++arrIdx));
    else                   rename.set(n, 'genVar' + (++vIdx));
  }

  // Apply rename
  let renamedCount = 0;
  traverse(ast, {
    Identifier(path) {
      const name = path.node.name;
      if (rename.has(name)) {
        const parent = path.parent;
        if (t.isObjectProperty(parent) && !parent.computed && parent.key === path.node) return;
        if (t.isMemberExpression(parent) && !parent.computed && parent.property === path.node) return;
        if (t.isObjectMethod(parent) && parent.key === path.node) return;
        path.node.name = rename.get(name);
        renamedCount++;
      }
    }
  });

  const out = generate(ast, { compact: false, comments: false }).code;
  console.log(`[final_readable] generic rename: ${renamedCount} identifiers (${rename.size} unique)`);
  return { code: out, renamed: renamedCount };
}

const genericRenamed = genericRenamePass(src);
src = genericRenamed.code;
fs.writeFileSync(output, src); // intermediate

// --- Post-pass: rename embedded mixed-case obfuscator markers (e.g., XazepysK inside CJK) ---
// Babel treats them as part of the identifier, so we need regex substitution on the code
function renameEmbeddedMarkers(code) {
  // Only target the specific obfuscator marker XazepysK (case-sensitive)
  const markerRe = /XazepysK/g;
  let count = 0;
  let out = code.replace(markerRe, (m) => {
    count++;
    return 'OBF_MARKER';
  });
  if (count) console.log(`[final_readable] embedded XazepysK markers renamed: ${count}`);
  return out;
}

src = renameEmbeddedMarkers(src);
fs.writeFileSync(output, src); // intermediate

// Now parse again for hardcoded maps + dead-code
let ast;
try {
  ast = parser.parse(src, { sourceType: 'script', errorRecovery: false });
} catch (e) {
  console.log('[final_readable] parse error (fallback: regex-only):', e.message.slice(0, 80));
  // fallback: try with errorRecovery
  try { ast = parser.parse(src, { sourceType: 'script', errorRecovery: true }); }
  catch (e2) { console.log('[final_readable] cannot parse, returning folded only'); process.exit(0); }
}

// --- Rename map: covers both vN (from generic_deob decodeAndRename) and fN (from jsobf_tea) ---
const renameMap = {};

// vN pattern: from generic_deob decodeAndRename
const vNames = {
  'v16': 'Telegraf',   // { ["Telegraf"]: v16 } = require("telegraf")
  'v36': 'fs',
  'v14': 'path',
  'v9': 'axios',
  'v40': 'chalk',
  'v31': 'Octokit',
  'v22': 'crypto',
  'v49': 'database',
  'v53': 'tokenBot',
  'v50': 'allowedGroupID',
  'v37': 'githubToken',
  'v6': 'octokit',
  'v60': 'repo',
  'v62': 'branch',
  'v20': 'catboxImageUrl',
  'v23': 'botToken',
  'v65': 'ownerId',
  'v61': 'bot',
  'v58': 'isSavingFile',
};

// fN pattern: from jsobf_tea output (based on bella_tea_READABLE.js analysis)
const fNames = {
  'f19': 'TEA_STRING_BLOB',      // giant encrypted blob (867KB)
  'f9':  'arr2',                 // string array table
  'f22': 'decoderKey',           // used in decoder functions
  'f35': 'decoderKey2',
  'f27': 'loopVar',
  'f31': 'tempObj',
  'f23': 'tempVar1',
  'f17': 'tempVar2',
  'f13': 'tempVar3',
  'f32': 'tempVar4',
  'f24': 'tempVar5',
  'f7':  'flag',
  'f20': 'catboxUrl',
  'f6':  'callbackHelper',
  'f25': 'PRNG_FUNC',            // PRNG for key generation
  'f16': 'arr2_DATA',            // data array for decoder
  'f10': 'TEA_KEY',              // TEA cipher key "@*(8c0~..."
  'f28': 'TEA_DECODE',           // TEA decode function
  'f4':  'checksumFn',           // simple checksum
  'f37': 'sliceFn',              // array slice helper
  'f8':  'DECODE_ALPHABET_C',    // alphabet C decoder
  'f14': 'DECODE_ALPHABET_C_CALL', // wrapper for f8
  'f5':  'BYTES_TO_STR',         // bytes to string
  'f34': 'COMMA_EXPR',           // comma expression wrapper (f34(a,b,c) -> a,b,c)
  'f30': 'process',              // process object (renamed from f30)
  'f3':  'EMPTY_FN',             // empty function (anti-tamper guard)
  'f2':  'EVAL_WRAPPER',         // eval wrapper
  'f36': 'CONSOLE_LOG',          // console.log alias
};

Object.assign(renameMap, vNames, fNames);

// --- Terapkan rename ---
const renamed = new Set();
traverse(ast, {
  Identifier(path) {
    const name = path.node.name;
    if (Object.prototype.hasOwnProperty.call(renameMap, name) && !renamed.has(name)) {
      // skip property keys (non-computed) & member props non-computed
      const parent = path.parent;
      if (t.isObjectProperty(parent) && !parent.computed && parent.key === path.node) return;
      if (t.isMemberExpression(parent) && !parent.computed && parent.property === path.node) return;
      if (t.isObjectMethod(parent) && parent.key === path.node) return;
      path.node.name = renameMap[name];
      renamed.add(name);
    }
  },
});

// --- Hapus fungsi yang tidak pernah dipanggil (dead code) ---
// Strategi aman: hanya hapus FunctionDeclaration yang (a) tidak dirujuk di tempat lain,
// (b) berada di top-level atau dalam blok, (c) bukan module.exports/export.
function countRefs(name) {
  let c = 0;
  traverse(ast, {
    Identifier(p) { if (p.node.name === name) c++; }
  });
  return c;
}

// mark kandidat hapus: fN/vN/gen* yang didefinisikan tapi referensi <= 1 (hanya definisi)
  // DAN yang bukan dalam renameMap (jadi decoder helpers)
  const killList = [];
  traverse(ast, {
    FunctionDeclaration(path) {
      const name = path.node.id && path.node.id.name;
      if (!name) return;
      if (!/^[fv]?\d+$/.test(name) && !/^gen(Fn|Arr|Var)\d+$/.test(name)) return;
      // Don't kill if it's in our rename map (those are meaningful)
      if (Object.prototype.hasOwnProperty.call(renameMap, name)) return;
      const refs = countRefs(name);
      if (refs <= 1) killList.push(path);
    }
  });

// Also remove VariableDeclarators that are decoder junk (f19, arr2, etc.)
const varKillList = [];
traverse(ast, {
  VariableDeclarator(path) {
    const name = path.node.id && path.node.id.name;
    if (!name) return;
    // Kill top-level vars that are decoder artifacts
    const decoderJunk = ['TEA_STRING_BLOB', 'arr2', 'PRNG_FUNC', 'arr2_DATA', 'TEA_KEY', 
                         'TEA_DECODE', 'checksumFn', 'sliceFn', 'DECODE_ALPHABET_C', 
                         'DECODE_ALPHABET_C_CALL', 'BYTES_TO_STR', 'COMMA_EXPR', 
                         'EMPTY_FN', 'EVAL_WRAPPER'];
    if (decoderJunk.includes(name)) {
      // Check if it's top-level (parent is VariableDeclaration at Program level)
      const parent = path.parent;
      if (t.isVariableDeclaration(parent)) {
        const grandParent = parent.parent;
        if (t.isProgram(grandParent)) {
          varKillList.push({ path, name });
        }
      }
    }
  }
});

// hapus dari yang paling dalam dulu (path order terbalik)
killList.sort((a, b) => b.node.start - a.node.start);
let killed = 0;
for (const p of killList) {
  try { p.remove(); killed++; } catch (e) {}
}
console.log(`[final_readable] dead functions removed: ${killed}`);

// Remove variable declarators
for (const { path, name } of varKillList) {
  try { path.remove(); console.log(`[final_readable] removed var: ${name}`); } catch (e) {}
}

// Also remove empty VariableDeclarations (after removing declarators)
traverse(ast, {
  VariableDeclaration(path) {
    if (path.node.declarations.length === 0) {
      path.remove();
    }
  }
});

// --- Beautify & output ---
const out = generate(ast, {
  compact: false,
  comments: false,
  retainLines: false,
}).code;

fs.writeFileSync(output, out);
console.log(`[final_readable] written ${output} (${out.length} chars)`);
console.log(`[final_readable] renamed vars: ${renamed.size}`);