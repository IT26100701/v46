#!/usr/bin/env node
'use strict';
// generic_deob.js — universal deobfuscator untuk SEMUA tipe obfuscation umum
// usage: node generic_deob.js <input.js> <output.js>
//
// Stages:
//   A  sandbox eval/Function capture  — packed.js, eval(atob), JSFuck, AAEncode/JJencode
//   B  webcrack                       — obfuscator.io, webpack, rollup, browserify, esbuild
//   C  decoder static inline          — string-array custom (panggilan literal -> hasil decode)
//   D  string escape decode           — "..." berisi \xNN/\uNNNN -> teks readable
//   E  identifier rename              — _0xNNNN -> v1..vN (di luar string/comment)
//   F  beautify + node --check verify
const fs = require('fs'), vm = require('vm'), path = require('path'), cp = require('child_process');

const INPUT  = process.argv[2];
const OUTPUT = process.argv[3];
if(!INPUT){ console.error('Usage: node generic_deob.js <input.js> <output.js>'); process.exit(1); }

const report = { type: [], stages: [] };
const mark = (s) => { report.stages.push(s); console.log('  [stage] ' + s); };

// ── Safety net ────────────────────────────────────────────────────────────
// A stage plugin can emit syntactically broken output (e.g. jsobf_string_table
// on a 4MB eval-fn target). Before this, the pipeline adopted that output
// blindly and the final checkSyntax failed with a bare "exit code 2".
// Now: snapshot the input, validate every adopted stage output, roll back to
// the last known-good source on failure, and report WHICH stage broke.
const ORIGINAL = fs.readFileSync(INPUT, 'utf8');
// `src` lives at module scope: adopt()/snapshot() below must read and
// write the same binding that main() transforms, not a local shadow.
let src = ORIGINAL;
let lastGood = ORIGINAL;
let lastGoodTag = 'input';
function snapshot(tag){ lastGood = src; lastGoodTag = tag; }
function adopt(next, tag){
  try { new vm.Script(next, { filename: tag + '.js' }); }
  catch(e){
    console.log('  [rollback] ' + tag + ' produced INVALID syntax (' + e.message.slice(0,120) + ') — reverting to ' + lastGoodTag);
    src = lastGood;
    return false;
  }
  src = next;
  snapshot(tag);
  return true;
}
// Same validation for F-stages that write OUTPUT directly (not via src).
// tmpR = last known-good; tag = stage name for logging.
function file_adopt(tmpR, tag){
  try { new vm.Script(fs.readFileSync(OUTPUT, 'utf8'), { filename: tag + '.js' }); }
  catch(e){
    console.log('  [rollback] ' + tag + ' produced INVALID syntax (' + e.message.slice(0,120) + ') — reverting to pre-stage');
    fs.copyFileSync(tmpR, OUTPUT);
    return false;
  }
  return true;
}

// Stage 0: buang karakter tak terlihat (ZWJ/ZWNJ/BOM/variation selector) + escape \\u200c di string
function stripInvisible(s){
  // 1. escape sequences tak terlihat di dalam string literal (guard identifier)
  s = s.replace(/\\u\{?(?:200b|200c|200d|200e|200f|2060|180e|feff|fe0[0-9a-f])\}?/gi, '');
  // 2. raw invisible chars — flag `u` wajib agar \u{} astral valid
  const re = /[\u200b-\u200f\u2060\u202a-\u202e\ufe00-\ufe0f\u180e\u{e0000}-\u{e007f}]/gu;
  const before = (s.match(re) || []).length;
  if(before) mark('invisible strip: ' + before + ' karakter dibuang');
  return s.replace(re, '');
}

// ── detect family ──
function detect(src){
  const t = [];
  if(/eval\(function\((p|a|c|k)/.test(src))          t.push('packed (Dean Edwards)');
  if(/eval\(.*atob\(|eval\(.*Function\(/.test(src))  t.push('javascript-obfuscator eval');
  if(/\beval\(\s*atob\(/.test(src))                   t.push('base64-eval');
  if(/\b_0x[a-f0-9]{3,}\b/.test(src))                 t.push('string-array (_0x)');
  if(/[\u200c\u200d]/.test(src))                       t.push('invisible-identifier (JS-obfuscator)');
  if(/0x9e3779b9|\bdebugger\b/.test(src))             t.push('jsobfuscator (eval/debugger/siphash)');
  if(/\[\(!\[\]/.test(src))                           t.push('JSFuck');
  if(/__webpack_require__|webpackBootstrap/.test(src))t.push('webpack');
  if(/require\s*=\s*function\(\w+,\w+,\w+\)\{/.test(src)) t.push('browserify');
  if((src.match(/\\x[0-9a-fA-F]{2}/g)||[]).length>100) t.push('hex-heavy');
  if(/\$_\$\$|\\x5f\\x24/.test(src))                  t.push('JJEncode?');
  return t.length ? t : ['generic'];
}

// ── Stage A: sandbox capture of eval/Function payloads ──
function sandboxCapture(code){
  const captured = [];
  const fake = new Proxy(function(){ return fake; }, {
    get(t, p){
      if(p === Symbol.toPrimitive) return () => '';
      if(p === 'toString') return () => '';
      if(p === Symbol.iterator) return function*(){};
      if(p === 'length') return 0;
      return fake;
    },
    set(){ return true; },
    apply(){ return fake; },
    construct(){ return fake; },
    has(){ return true; },
  });
  const stubModule = { exports: {} };
  const sandbox = {
    console: { log(){}, info(){}, warn(){}, error(){}, debug(){}, table(){} },
    setTimeout: () => 0, setInterval: () => 0,
    clearTimeout(){}, clearInterval(){},
    module: stubModule, exports: stubModule.exports,
    require: () => new Proxy({}, { get: () => () => undefined }),
    process: { env: { HOME: '/home/container' }, platform: 'linux', arch: 'x64',
               version: 'v20.0.0', argv: ['node', 'index.js'], exit(){}, cwd: () => '/',
               memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }) },
    Buffer,
    __dirname: '/', __filename: '/index.js',
    fetch: () => Promise.reject(new Error('blocked')),
    XMLHttpRequest: function(){ this.open=()=>{}; this.send=()=>{}; this.setRequestHeader=()=>{}; },
    navigator: { userAgent: 'Mozilla/5.0', language: 'en', platform: 'Linux' },
    location: { href: 'https://localhost/', protocol: 'https:', hostname: 'localhost' },
    document: fake, window: fake, globalThis: fake, self: fake,
    localStorage: fake, sessionStorage: fake, cookies: '',
    eval: (s) => { if(typeof s === 'string') captured.push(s); return undefined; },
    Function: function(...a){ const b = String(a[a.length-1] || ''); captured.push(b); return function(){ return undefined; }; },
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    unescape,
  };
  sandbox.globalThis = sandbox; sandbox.window = sandbox; sandbox.self = sandbox;
  try{
    const ctx = vm.createContext(sandbox);
    vm.runInContext(code, ctx, { timeout: 30000, displayErrors: false });
  }catch(e){ /* capture berjalan sebelum throw, gapapa */ }
  // ambil payload kandidat terpanjang yang mirip kode JS
  const cands = captured
    .filter(s => typeof s === 'string' && s.length > 20 && /[;{}()=]/.test(s))
    .sort((a,b) => b.length - a.length);
  if(!cands.length) return null;
  let best = cands[0];
  // jika masih wrapped eval(...), jalankan lagi sampai 3x
  for(let i=0;i<3;i++){
    const inner = sandboxCaptureInner(best);
    if(inner && inner.length > best.length) best = inner; else break;
  }
  return best;
}
function sandboxCaptureInner(code){
  const captured = [];
  const sandbox = {
    console: { log(){}, error(){}, warn(){} },
    eval: (s) => { if(typeof s==='string') captured.push(s); },
    Function: function(...a){ captured.push(String(a[a.length-1]||'')); return function(){}; },
    setTimeout: () => 0, clearTimeout(){},
  };
  try{
    const ctx = vm.createContext(sandbox);
    vm.runInContext(code, ctx, { timeout: 4000, displayErrors: false });
  }catch(e){}
  const cands = captured.filter(s => s.length > 20 && /[;{}()=]/.test(s)).sort((a,b)=>b.length-a.length);
  return cands[0] || null;
}

// ── Stage B: webcrack ──
async function webcrackPass(code){
  try{
    const { webcrack } = require('webcrack');
    const r = await webcrack(code, { unpack:true, deobfuscate:true, jsx:false, mangle:false, unminify:true, unflatten:true });
    if(r && r.code && r.code !== code){ mark('webcrack: ' + code.length + ' -> ' + r.code.length); return r.code; }
  }catch(e){ console.log('  [skip] webcrack: ' + e.message.slice(0,80)); }
  return code;
}

// ── Stage C: decoder static inline ──
// Cari fungsi murni yang dipanggil dengan argumen literal semua -> evaluasi -> ganti string
const DANGEROUS = /document|window|location|navigator|require\(|process\.|global|fetch|XMLHttpRequest|localStorage|sessionStorage|cookie|alert\(|constructor\s*\[/;
// isJunk: identifier sampah varian baru (Cyrillic lookalike / tail-hex 12+)
const isJunk = (n) => n.length >= 10 && (
    /[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F]/.test(n) || // Cyrillic lookalike
    /[a-z0-9]{6,}[0-9a-f]{12,}/i.test(n)                                       // tail hex 12+
  );
function decoderInline(code){
  // findBigStrings: scan `NAME = "HUGE_STRING"` assignments (string table 200KB+)
  function findBigStrings(s){
    const out = []; let i = 0;
    while(i < s.length){
      const m = /^([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s*=\s*(["'])/.exec(s.slice(i));
      if(!m){ i++; continue; }
      const q = m[2]; let j = i + m[0].length;
      while(j < s.length && s[j] !== q){ if(s[j] === '\\') j++; j++; }
      if(j >= s.length){ i++; continue; }
      const val = s.slice(i + m[0].length, j);
      if(val.length > 500) out.push({ name: m[1], start: i, decl: s.slice(i, j+1) + ';', len: val.length });
      i = j + 1;
    }
    return out;
  }
  let stmts = [];
  for(const b of findBigStrings(code)) stmts.push({ idx: b.start, text: b.decl, name: b.name, kind: 'bigstr' });
  for(const m of code.matchAll(/(?:var\s+|let\s+|const\s+)?(\S{1,64}?)\s*=\s*\[/g)){
    let depth = 1, i = m.index + m[0].length;
    while(i < code.length && depth > 0){
      const ch = code[i];
      if(ch === "'" || ch === '"'){ const q = ch; i++; while(i < code.length && code[i] !== q){ if(code[i] === '\\') i++; i++; } }
      else if(ch === '/'){
        // skip regex literal /.../ (but avoid // comments)
        if(code[i+1]==='/'||code[i+1]==='*'){ i++; continue; }
        i++;
        while(i<code.length){ if(code[i]==='\\'){i++;}else if(code[i]==='/'){i++;break;}else if(code[i]==='['||code[i]===']'){}i++; }
      }
      else if(ch === '[') depth++;
      else if(ch === ']') depth--;
      i++;
    }
    if(depth === 0){ const decl = code.slice(m.index, i) + ';'; stmts.push({ idx: m.index, text: decl, name: m[1], kind: 'arr' }); }
  }
  for(const m of code.matchAll(/^var\s+([^\s;(){}\[\],]+)\s*;/gm)){
    stmts.push({ idx: m.index, text: 'var ' + m[1] + ';', name: m[1], kind: 'prim' });
  }
  for(const m of code.matchAll(/function\s+([^\s(:{]+)\s*\([^)]*\)\s*\{/g)){
    let depth = 1, i = m.index + m[0].length;
    while(i < code.length && depth > 0){ if(code[i] === '{') depth++; else if(code[i] === '}') depth--; i++; }
    const body = code.slice(m.index, i);
    if(DANGEROUS.test(body)) continue;
    stmts.push({ idx: m.index, text: body, name: m[1], kind: 'fn' });
  }
  if(!stmts.length) return { code, n: 0, stmts: [] };
  // DEDUP: keep ALL fn & bigstr; last-wins for prim/arr
  { const lastIdx = new Map(); stmts.forEach((st,idx)=>{ if(st.kind!=='fn'&&st.kind!=='bigstr') lastIdx.set(st.name,idx); });
    stmts = stmts.filter((st,idx)=>{ if(st.kind==='fn'||st.kind==='bigstr') return true; return lastIdx.get(st.name)===idx; }); }
  stmts.sort((a,b)=>a.idx-b.idx);

  // LOAD bigstr TERAKHIR (string table override bare-var)
  { const bigs = stmts.filter(s=>s.kind==='bigstr'); stmts = stmts.filter(s=>s.kind!=='bigstr').concat(bigs); }

  // load per-statement (gagal satu tetap lanjut)
  const sandbox = { console:{log(){},error(){},warn(){}}, atob:(s)=>Buffer.from(s,'base64').toString('binary'), btoa:(s)=>Buffer.from(s,'binary').toString('base64') };
  let ctx, loaded = 0;
  try{ ctx = vm.createContext(sandbox); for(const st of stmts){ try{ vm.runInContext(st.text,ctx,{timeout:3000,displayErrors:false}); loaded++; }catch(e){} } }
  catch(e){ return { code, n: 0, stmts: [] }; }
  if(!loaded) return { code, n: 0, stmts: [] };
  console.log('  [stage] decoder ctx: '+loaded+'/'+stmts.length+' stmt (bigstr='+stmts.filter(s=>s.kind==='bigstr').length+' arr='+stmts.filter(s=>s.kind==='arr').length+' fn='+stmts.filter(s=>s.kind==='fn').length+')');

  const fnNames = [...new Set(stmts.filter(s=>s.kind==='fn').map(s=>s.name))];
  const litStr = String.raw`'(?:\\\\.|[^'\\\\])*'|"(?:\\\\.|[^"\\\\])*"`;
  const litNum = String.raw`0x[0-9a-fA-F]+|\d+(?:\.\d+)?`;
  const arrLk = String.raw`[^\s(),;{}\[\]]+\[[^\]]+\]`;  // name + [idx], unicode/nested ok
  const elem = String.raw`(?:${litNum}|${litStr}|${arrLk})`;
  const argsP = String.raw`${elem}(?:\s*,\s*${elem})*`;
  const guard = '(?<!function\\s)(?<!class\\s)(?<!new\\s)(?<![.\\w$])';

  let out = code, n = 0;
  for(const name of fnNames){
    if(out.indexOf(name+'(')===-1) continue;
    const esc = name.replace(/\$/g,'\\$');
    const re = new RegExp(guard+esc+'\\(\\s*('+argsP+')\\s*\\)','g');
    const cache = new Map();
    out = out.replace(re,(full)=>{
      if(cache.has(full))return cache.get(full);
      if(n>200000)return full;
      try{
        const v = vm.runInContext(full,ctx,{timeout:300,displayErrors:false});
        if(typeof v==='string'&&v.length>0){ n++; const rep=JSON.stringify(v); cache.set(full,rep); return rep; }
      }catch(e){}
      cache.set(full,full); return full;
    });
  }
  if(n) mark('decoder inline: '+n+' panggilan didekode');
  return { code:out, n, stmts };
}

// ── scanner: pecah source jadi segmen code / string / comment / regex ──
function scanSegments(src){
  const segs = []; let i = 0, n = src.length;
  let codeStart = 0;
  const push = (type, start, end, quote) => { if(end > start) segs.push({ type, start, end, quote }); };
  const lastSig = (from) => { let j = from - 1; while(j >= 0 && /\s/.test(src[j])) j--; return j < 0 ? '' : src[j]; };
  while(i < n){
    const c = src[i], d = src[i+1];
    if(c === '/' && d === '/'){ push('code', codeStart, i); let s = i; i += 2; while(i < n && src[i] !== '\n') i++; push('comment', s, i); codeStart = i; continue; }
    if(c === '/' && d === '*'){ push('code', codeStart, i); let s = i; i += 2; while(i < n && !(src[i] === '*' && src[i+1] === '/')) i++; i = Math.min(i+2, n); push('comment', s, i); codeStart = i; continue; }
    if(c === "'" || c === '"'){
      push('code', codeStart, i); let s = i; i++;
      while(i < n && src[i] !== c){ if(src[i] === '\\') i++; i++; }
      i = Math.min(i+1, n); push('string', s, i, c); codeStart = i; continue;
    }
    if(c === '`'){
      push('code', codeStart, i); let s = i; i++; let depth = 0;
      while(i < n){
        if(src[i] === '\\'){ i += 2; continue; }
        if(src[i] === '`' && depth === 0){ i++; break; }
        if(src[i] === '$' && src[i+1] === '{') depth++;
        else if(src[i] === '}' && depth > 0) depth--;
        i++;
      }
      push('template', s, i, '`'); codeStart = i; continue;
    }
    if(c === '/'){
      const prev = lastSig(i);
      const isRegex = prev === '' || '=([{,;:!&|?+-*%^~<>'.includes(prev) || /[)\]\w]/.test(prev) === false;
      const prevWord = (src.slice(Math.max(0, i-8), i).match(/(return|typeof|case|new|delete|void|instanceof|do|else|in|of|yield)$/ ) || [])[1];
      if(isRegex || prevWord){
        push('code', codeStart, i); let s = i; i++; let cls = false;
        while(i < n){
          if(src[i] === '\\'){ i += 2; continue; }
          if(src[i] === '[') cls = true;
          else if(src[i] === ']') cls = false;
          else if(src[i] === '/' && !cls){ i++; break; }
          else if(src[i] === '\n') break;
          i++;
        }
        while(i < n && /[a-z]/i.test(src[i])) i++; // flags
        push('regex', s, i); codeStart = i; continue;
      }
    }
    i++;
  }
  push('code', codeStart, n);
  return segs;
}

// ── Stage D + E: escape decode + rename (segment-aware) ──
function decodeAndRename(code){
  const segs = scanSegments(code);
  // kumpulkan semua _0xNNN dari segmen code untuk rename map
  const names = new Set();
  for(const s of segs) if(s.type === 'code'){
    for(const m of code.slice(s.start, s.end).matchAll(/(?<![.\w$])_0x[0-9a-fA-F]+(?![\w$])/g)) names.add(m[0]);
  }

  // ── Stage E2: kumpulkan identifier sampah varian baru (Cyrillic lookalike / tail-hex panjang) ──
  const idRe = /[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*/g;
  const isJunk = (n) => n.length >= 10 && (
      /[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F]/.test(n) || // Cyrillic lookalike
      /[a-z0-9]{6,}[0-9a-f]{12,}/i.test(n) ||                             // tail hex 12+
      /\$var\$const\$break\$[0-9a-f]{8}\$[0-9a-f]{6}/.test(n)             // obfuscator.id suffix
    );
  const propUsed = new Set();   // dipakai sebagai .prop -> jangan rename
  const strUsed  = new Set();   // muncul dalam string (raw ATAU escaped) -> jangan rename
  const junkAll  = new Set();
  const fnSet    = new Set();   // deklarasi fungsi/class
  const arrSet   = new Set();   // deklarasi array
  // pass 1: kumpulkan kandidat + property usage dari segmen code
  for(const s of segs){
    if(s.type !== 'code') continue;
    const txt = code.slice(s.start, s.end);
    for(const m of txt.matchAll(/(?<![\w$])([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)(?![\w$])/g)){
      if(isJunk(m[1])) junkAll.add(m[1]);
    }
    for(const m of txt.matchAll(/\.([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)/g)){
      propUsed.add(m[1]);
    }
    for(const m of txt.matchAll(/function\s+([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)/g)) fnSet.add(m[1]);
    for(const m of txt.matchAll(/class\s+([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)/g)) fnSet.add(m[1]);
    for(const m of txt.matchAll(/(?<![\w$])([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)\s*=\s*\[/g)) arrSet.add(m[1]);
  }
  // pass 2: cek string (termasuk bentuk \xNN/\uNNNN ter-decode — guard eval pakai escape!)
  for(const s of segs){
    if(s.type !== 'string' && s.type !== 'template') continue;
    const txt = code.slice(s.start, s.end);
    const decoded = txt
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    for(const n of junkAll){
      if(txt.includes(n) || decoded.includes(n)) strUsed.add(n);
    }
  }
  const rename = new Map();
  let fnIdx = 0, arrIdx = 0, vIdx = names.size;
  let skipProp = 0, skipStr = 0;
  const forceRename = (n) => /\$var\$const\$break\$/.test(n); // obfuscator.id generated → property juga generated, safe
  for(const n of [...junkAll].sort()){
    if(propUsed.has(n) && !forceRename(n)) { skipProp++; continue; }
    if(strUsed.has(n) && !forceRename(n))  { skipStr++; continue; }
    if(fnSet.has(n))     rename.set(n, 'f' + (++fnIdx));
    else if(arrSet.has(n)) rename.set(n, 'arr' + (++arrIdx));
    else                   rename.set(n, 'v' + (++vIdx));
  }
  console.log('  [diag] junk=' + junkAll.size + ' rename=' + rename.size + ' skipProp=' + skipProp + ' skipStr=' + skipStr + ' _0x=' + names.size);

  let out = '', prev = 0;
  for(const s of segs){
    out += code.slice(prev, s.start);
    let seg = code.slice(s.start, s.end);
    if(s.type === 'string'){
      // Stage D: decode \xNN & \uNNNN yang printable
      seg = seg.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => {
        const ch = String.fromCharCode(parseInt(h, 16));
        return /[\x20-\x7e]/.test(ch) && ch !== s.quote && ch !== '\\' ? ch : _;
      }).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => {
        const cp = parseInt(h, 16), ch = String.fromCharCode(cp);
        if(cp > 0x7e && cp < 0xa0) return _;
        return /[\x20-\x7e\u00a0-\uffff]/.test(ch) && ch !== s.quote ? ch : _;
      });
      // \n \r \t biarkan (escape tetap valid & readable)
    }
    if(s.type === 'code'){
      // Stage D2: identifier escape decode — \xNN/\uNNNN yang jadi karakter identifier
      seg = seg.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => {
        const ch = String.fromCharCode(parseInt(h, 16));
        return /[A-Za-z0-9_$\u0080-\uffff]/.test(ch) && ch !== '\\' ? ch : _;
      }).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => {
        const cp = parseInt(h, 16), ch = String.fromCharCode(cp);
        return /[A-Za-z0-9_$\u0080-\uffff]/.test(ch) ? ch : _;
      });
      // Stage E: rename token (_0x + identifier sampah) — bukan property .x biasa, tapi
            //          $var$const$break$ (generated) BOLEH setelah titik
            seg = seg.replace(/(?<![.\w$])([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*)(?![.\w$])/g,
              (full, name) => {
                if(rename.has(name)) return rename.get(name);
                return full;
              });
            // kedua: property .xxx yang generated (setelah titik) — rename juga
            seg = seg.replace(/\.([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*\$var\$const\$break\$[0-9a-f]{8}\$[0-9a-f]{6})/g,
              (m, name) => rename.has(name) ? '.' + rename.get(name) : m);
            // ketiga: ident generated yang diikuti . (obj.length) — rename juga
            seg = seg.replace(/(?<![.\w$])([A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*\$var\$const\$break\$[0-9a-f]{8}\$[0-9a-f]{6})\./g,
              (m, name) => rename.has(name) ? rename.get(name) + '.' : m);
    }
    out += seg;
    prev = s.end;
  }
  out += code.slice(prev);

  // concat fold: "a" + "b" -> "ab" (biar key object jadi string rapi ala ktech)
  let folded = 0, round = 0, prevOut;
  const foldRe = /("(?:[^"\\]|\\.)*")\s*\+\s*("(?:[^"\\]|\\.)*")/g;
  do{
    prevOut = out;
    out = out.replace(foldRe, (m, a, b) => {
      try{ folded++; return JSON.stringify(JSON.parse(a) + JSON.parse(b)); }catch(e){ return m; }
    });
  }while(out !== prevOut && ++round < 8);
  if(folded) mark('concat fold: ' + folded + ' gabungan string');

  return { out, renamed: rename.size, decoded: 0 };
}

// ── Stage F: beautify (spawn plugin) ──
function beautify(inp, out){
  const b = path.join(__dirname, 'beautify.js');
  try{
    cp.spawnSync('node', [b, inp, out], { timeout: 60000 });
    if(fs.existsSync(out)) return fs.readFileSync(out, 'utf8');
  }catch(e){}
  return null;
}
// Stage F2: babel-beautify — parse + regenerate with formatting (safe, lossless-ish).
function babelBeautify(inp, out){
  try{
    const parser = require('@babel/parser');
    const generate = require('@babel/generator').default;
    const src = fs.readFileSync(inp, 'utf8');
    const ast = parser.parse(src, { sourceType: 'script', errorRecovery: true, allowReturnOutsideFunction: true });
    const code = generate(ast, { compact: false, comments: true }).code;
    fs.writeFileSync(out, code);
    return code;
  }catch(e){ return null; }
}

function checkSyntax(file){
  try{
    const src = fs.readFileSync(file, 'utf8');
    new vm.Script(src, { filename: file });
    return true;
  }catch(e){
    // fallback node --check via .js temp
    try{
      const tmp = file + '.chk.js';
      fs.copyFileSync(file, tmp);
      const r = cp.spawnSync('node', ['--check', tmp], { timeout: 30000 });
      try{ fs.unlinkSync(tmp); }catch{}
      return r.status === 0;
    }catch(e2){ return false; }
  }
}

async function main(){
  if(!fs.existsSync(INPUT)){ console.error('Not found: ' + INPUT); process.exit(1); }
  src = fs.readFileSync(INPUT, 'utf8');

  // Stage AD0 — auto_detect: fingerprint obfuscation family and gate stages
  const detectReportPath = OUTPUT + '.detect.json';
  try {
    const { stdout } = cp.spawnSync('node', [path.join(__dirname, 'auto_detect.js'), INPUT, detectReportPath], { timeout: 60000, encoding: 'utf8' });
    if (stdout) console.log(stdout.toString().trim());
  } catch (e) { console.log('[auto_detect] skipped: ' + e.message.slice(0,80)); }
  let gates = { runtime_decode: false, webcrack: false, sandbox_capture: false,
    jsobf_tea: false, jsobf_cvc: false, cff_unroll: false, cff_hard_unroll: false,
    jsconfuser: false, jsconfuser_techniques: false, var_mask: false,
    xor_decode: false, vm_trace: false, vm_hard_decode: false,
    semantic_naming: true, numeric_table_fold: false, strip_invisible: false,
    string_table: true };
  try {
    const det = JSON.parse(fs.readFileSync(detectReportPath, 'utf8'));
    gates = det.gates || gates;
  } catch (e) { /* fallback to defaults */ }

  src = stripInvisible(src);   // Stage 0 — sebelum detect & stage lain
  report.type = detect(src);
  console.log('generic_deob: type = ' + report.type.join(', '));

  // Stage 0.5 — runtime_decode: run sandbox, capture eval/Function payloads + record decoder calls
  {
    try {
      const tmpRt = OUTPUT + '.__rt_in.js', tmpRtOut = OUTPUT + '.__rt_out.js';
      fs.writeFileSync(tmpRt, src);
      const rr = cp.spawnSync('node', [path.join(__dirname,'runtime_decode.js'), tmpRt, tmpRtOut], { timeout: 60000, encoding: 'utf8' });
      const rrout = (rr.stdout || '') + (rr.stderr || '');
      if(fs.existsSync(tmpRtOut) && /sites=(\d+)/.test(rrout) && /substituted=(\d+)/.test(rrout)){
        const m = rrout.match(/sites=(\d+) substituted=(\d+)/);
        const sites = m ? Number(m[1]) : 0;
        const sub = m ? Number(m[2]) : 0;
        if(sub > 0){
          if (adopt(fs.readFileSync(tmpRtOut, 'utf8'), 'runtime_decode')) mark('runtime_decode: ' + sites + ' decoder sites, ' + sub + ' substituted');
        } else mark('runtime_decode: ' + sites + ' sites, no substitutions');
      } else mark('runtime_decode: no decoder sites, keep original');
      try{ fs.unlinkSync(tmpRt); }catch{}
      try{ fs.unlinkSync(tmpRtOut); }catch{}
    } catch(e0){ console.log('  [skip] runtime_decode: ' + e0.message.slice(0,80)); }
  }

  // Stage B (MANDATORY FIRST) — webcrack: unpack webpack/rollup/browserify/esbuild/obfuscator.io
  // Run this FIRST so subsequent stages work on unpacked source
  src = await webcrackPass(src);
  if(process.env.KEEP_WC){ fs.writeFileSync('/tmp/wc_out.js', src); console.log('wc kept: /tmp/wc_out.js'); }

  // Re-detect after webcrack (may reveal new patterns)
  report.type = detect(src);
  console.log('generic_deob: type after webcrack = ' + report.type.join(', '));

  // Stage A — sandbox eval capture (packed/JSFuck/base64/AAEncode/JJEncode)
  const cap = sandboxCapture(src);
  if(cap){
    let valid = true;
    try{ new vm.Script(cap, { filename: 'cap.js' }); }catch(e){ valid = false; }
    // payload harus masuk akal: >1000 char ATAU >=0.5% dari source (tolak guard-string kecil)
    const plausible = cap.length > 1000 || cap.length >= src.length * 0.005;
    if(valid && plausible){ if (adopt(cap, 'sandbox_capture')) { mark('sandbox capture: payload ' + cap.length + ' chars (valid, plausible)'); report.type.push('eval-unpacked'); } }
    else if(valid) mark('sandbox capture: payload ' + cap.length + ' chars too small vs source, keep original');
    else mark('sandbox capture: payload invalid, keep original');
  }
  else mark('sandbox capture: no payload (skip)');
  if(process.env.KEEP_WC){ fs.writeFileSync('/tmp/wc_out.js', src); console.log('wc kept: /tmp/wc_out.js'); }

  // Stage B2 — WhatsApp double-layer (jsobf_wa): after webcrack, if there's a
  // key-gen function (returns string via Buffer/toString) + payload const, unpack
  // the REAL source. Deteksi struktural, bukan nama spesifik.
  let waRecovered = false;
  const keyGenRe = /function\s+[A-Za-z_$][\w$]*\([^)]*\)\s*\{[\s\S]{0,6000}?Buffer[\s\S]{0,200}?toString\s*\(\s*["']utf8["']\s*\)/;
  const payloadRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*\(/;
  const bigChunkRe = /"[A-Za-z0-9+/=]{60,}"/;
  if(keyGenRe.test(src) && payloadRe.test(src) && bigChunkRe.test(src) && /\.join\s*\(\s*["']{2}\s*\)/.test(src)){
    try{
      const tmpIn = OUTPUT + '.__wa_in.js', tmpOut = OUTPUT + '.__wa_out.js';
      fs.writeFileSync(tmpIn, src);
      const rw = cp.spawnSync('node', [path.join(__dirname,'jsobf_wa.js'), tmpIn, tmpOut], { timeout: 300000 });
      if(fs.existsSync(tmpOut)){
        const wout = fs.readFileSync(tmpOut, 'utf8');
        if(wout.length >= 1000 && !/_0x[0-9a-f]{4,}/.test(wout.slice(0, 2000))){
          if (adopt(wout, 'jsobf_wa')) { waRecovered = true; mark('jsobf_wa: payload recovered (' + tmpOut + ', ' + wout.length + ' chars)'); }
        }
      }
      try{ fs.unlinkSync(tmpIn); }catch{}
      try{ fs.unlinkSync(tmpOut); }catch{}
    }catch(e2){ console.log('  [skip] jsobf_wa: ' + e2.message.slice(0,80)); }
  }

  // Stage B3 — TEA-blob decoder resolver (jsobf_tea): giant encrypted blob +
  // arrN data table + fN(off,len) indexed decoder. Plugin self-guards: no match
  // => passes through unchanged. When it resolves, the payload is already
  // clean; mark recovered so C/D/E (rename, decode) don't mangle the strings.
  let teaRecovered = false;
  if (!gates.jsobf_tea) mark('jsobf_tea: gate off (no TEA constant), skip');
  else try{
    const tmpTea = OUTPUT + '.__tea_in.js', tmpTeaOut = OUTPUT + '.__tea_out.js';
    fs.writeFileSync(tmpTea, src);
    const rt = cp.spawnSync('node', [path.join(__dirname,'jsobf_tea.js'), tmpTea, tmpTeaOut], { timeout: 300000, encoding: 'utf8' });
    const tcout = (rt.stdout || '') + (rt.stderr || '');
    if(fs.existsSync(tmpTeaOut)){
      const tout = fs.readFileSync(tmpTeaOut, 'utf8');
      // adopt TEA output only if it shrank meaningfully (decoder resolved) or
      // contains recovered require()/eval payload strings; the plugin logs
      // "cipher calls resolved" / "decoder calls resolved" when it did work.
      if(/resolved: \d+/.test(tcout) && !/resolved: 0 \| cipher calls resolved: 0/.test(tcout) && tout.length >= 1000){
        if (adopt(tout, 'jsobf_tea')) { teaRecovered = true; mark('jsobf_tea: blob decoder resolved (' + tmpTeaOut + ', ' + tout.length + ' chars)'); }
      } else {
        mark('jsobf_tea: pattern not matched, keep original');
      }
    }
    try{ fs.unlinkSync(tmpTea); }catch{}
    try{ fs.unlinkSync(tmpTeaOut); }catch{}
  }catch(e2){ console.log('  [skip] jsobf_tea: ' + e2.message.slice(0,80)); }

  // Stage B4 — CVC / CJK-suffix family (jsobf_cvc). Structural gate: the stage
  // itself checks for the top-level decoder trio + the 0x9e3779b9 mixer and
  // returns {skipped} when they are absent, so older targets pass through
  // untouched. webcrack does NOT fold this family, so it must run after webcrack
  // and before the rename/readability stages. On match it constant-folds the
  // decoder calls into plain string literals (Telegraf, addprem, Asia/Jakarta, ...).
  let cvcRecovered = false;
  let cvcMatched = false;
  function runCvcStage(tag) {
    const tmpCvc = OUTPUT + '.__cvc_in_' + tag + '.js';
    const tmpCvcOut = OUTPUT + '.__cvc_out_' + tag + '.js';
    fs.writeFileSync(tmpCvc, src);
    const rc = cp.spawnSync('node', [path.join(__dirname,'jsobf_cvc.js'), tmpCvc, tmpCvcOut], { timeout: 600000, encoding: 'utf8' });
    const ccout = (rc.stdout || '') + (rc.stderr || '');
    let ok = false;
    if(fs.existsSync(tmpCvcOut)){
      const cout = fs.readFileSync(tmpCvcOut, 'utf8');
      const decMatch = ccout.match(/"decoded":(\d+)/);
      const decoded = decMatch ? Number(decMatch[1]) : 0;
      if(decoded > 0 && cout.length >= 1000){
        if (adopt(cout, 'jsobf_cvc_' + tag)) { ok = true;
        mark('jsobf_cvc[' + tag + ']: decoder folded ' + decoded + ' strings (' + tmpCvcOut + ', ' + cout.length + ' chars)'); }
        if(/not-cvc-family/.test(ccout)) mark('jsobf_cvc[' + tag + ']: not this family, keep original');
      } else {
        const why = (ccout.match(/skipped:\s*([^\n]+)/) || [, 'no reason given'])[1];
        mark('jsobf_cvc[' + tag + ']: pattern not matched (' + why.trim() + '), keep original');
      }
    }
    try{ fs.unlinkSync(tmpCvc); }catch{}
    try{ fs.unlinkSync(tmpCvcOut); }catch{}
    return ok;
  }

  // First pass: before cff_unroll. If it matches, set cvcRecovered=true.
  if (!gates.jsobf_cvc) mark('jsobf_cvc[pre]: gate off (no CVC/CJK + invisible pattern), skip');
  else if (runCvcStage('pre')) { cvcRecovered = true; cvcMatched = true; }

  // Stage C0 — jsobfuscator stage (string table 50K+ -> run sandbox init, inline decoder)
    if(!waRecovered && !teaRecovered && !cvcRecovered){
      if(/[@;/\t\s][A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*\s*=\s*["'][^"']{50000,}/.test(src) || (fs.statSync && !0)){
        try{
          const tmpIn = OUTPUT + '.__jsobf_in.js', tmpOut = OUTPUT + '.__jsobf_out.js';
          fs.writeFileSync(tmpIn, src);
          const r2 = cp.spawnSync('node', [path.join(__dirname,'jsobf_stage.js'), tmpIn, tmpOut], { timeout: 300000 });
          if(fs.existsSync(tmpOut)){
            const jout = fs.readFileSync(tmpOut, 'utf8');
            if(jout.length >= 1000){ if (adopt(jout, 'jsobf_stage')) mark('jsobf stage: string table inline (' + tmpOut + ')'); }
          }
          try{ fs.unlinkSync(tmpIn); }catch{}
          try{ fs.unlinkSync(tmpOut); }catch{}
        }catch(e2){ console.log('  [skip] jsobf stage: ' + e2.message.slice(0,80)); }
      }
    } else { mark('skip jsobf stage: payload already clean from recover stage'); }

  // Stage C — decoder static inline
  // (skipped if jsobf_wa / jsobf_tea already recovered a clean payload — later stages would break it)
  // CVC still needs rename/decode because its output has obfuscated identifiers
  if(!waRecovered && !teaRecovered){
    const r = decoderInline(src); adopt(r.code, 'decoderInline');

    // Stage D+E — escape decode + rename
    const dr = decodeAndRename(src);
    if(dr.renamed) mark('rename: ' + dr.renamed + ' identifier -> vN');
    adopt(dr.out, 'decodeAndRename');
  } else {
    mark('skip C/D/E: payload already clean from recover stage');
  }

  // Stage G — hard CFF unroll (content extraction; result need not be runnable)
    const HAS_CFF = /while\s*\([^)]*(switch|!!\[\])/.test(src) || (src.match(/\bswitch\s*\(/g) || []).length >= 8;
    if(!gates.cff_unroll) mark('cff_unroll: gate off (no CFF pattern), skip');
    else if(HAS_CFF){
      try{
        const tmpCff = OUTPUT + '.__cff_in.js', tmpCffOut = OUTPUT + '.__cff_out.js';
        fs.writeFileSync(tmpCff, src);
        const rc = cp.spawnSync('node', [path.join(__dirname,'cff_unroll.js'), tmpCff, tmpCffOut], { timeout: 180000, encoding: 'utf8' });
        const rcout = (rc.stdout || '') + (rc.stderr || '');
        if(fs.existsSync(tmpCffOut) && !/unrolled 0 CFF/.test(rcout)){
          const cout = fs.readFileSync(tmpCffOut, 'utf8');
          if(cout.length >= 100) { if (adopt(cout, 'cff_unroll')) mark('cff_unroll: flattened->sequential'); }
        }
        else mark('cff_unroll: no dispatcher found, keep original');
        try{ fs.unlinkSync(tmpCff); }catch{}
        try{ fs.unlinkSync(tmpCffOut); }catch{}
      } catch(e3){ console.log('  [skip] cff_unroll: ' + e3.message.slice(0,80)); }
          } else mark('cff_unroll: no CFF pattern, skip');

          // Second CVC pass: after cff_unroll, to fold decoder calls that were inside flattened blocks.
          // Only run if the family was detected on the first pass.
          if (cvcMatched && !cvcRecovered) {
            if (runCvcStage('post')) { cvcRecovered = true; }
          }

  // Stage G2 — cff_hard_unroll: execution-trace CFF unroller (JS-Confuser template-CFF family)
  if (!gates.cff_hard_unroll) mark('cff_hard_unroll: gate off (no CFF dispatchers), skip');
  else {
    try {
      const tmpCfH = OUTPUT + '.__cfh_in.js', tmpCfHOut = OUTPUT + '.__cfh_out.js';
      fs.writeFileSync(tmpCfH, src);
      const rcH = cp.spawnSync('node', [path.join(__dirname,'cff_hard_unroll.js'), tmpCfH, tmpCfHOut], { timeout: 300000, encoding: 'utf8' });
      const rcHout = (rcH.stdout || '') + (rcH.stderr || '');
      if(fs.existsSync(tmpCfHOut) && /unrolled=([1-9]\d*)/.test(rcHout)){
        if (adopt(fs.readFileSync(tmpCfHOut, 'utf8'), 'cff_hard_unroll')) mark('cff_hard_unroll: ' + rcHout.match(/unrolled=\d+ stmts=\d+/)[0]);
      } else mark('cff_hard_unroll: no template dispatcher, keep original');
      try{ fs.unlinkSync(tmpCfH); }catch{}
      try{ fs.unlinkSync(tmpCfHOut); }catch{}
    } catch(e8){ console.log('  [skip] cff_hard_unroll: ' + e8.message.slice(0,80)); }
  }

  // Stage I — JS-Confuser family: string decoder + global concealing + opaque predicates
  // Runs here (post CFF unroll, pre VM) so that decoded strings don't break downstream stages.
  {
    try {
      const tmpJscIn = OUTPUT + '.__jsc_in.js', tmpJscOut = OUTPUT + '.__jsc_out.js';
      fs.writeFileSync(tmpJscIn, src);
      const rj = cp.spawnSync('node', [path.join(__dirname,'jsobf_jsconfuser.js'), tmpJscIn, tmpJscOut],
        { timeout: 120000, encoding: 'utf8' });
      if(fs.existsSync(tmpJscOut) && fs.statSync(tmpJscOut).size > 100){
        const jcout = fs.readFileSync(tmpJscOut, 'utf8');
        const jscLines = jcout.split('\n').length;
        if (adopt(jcout, 'jsobf_jsconfuser')) mark('jsobf_jsconfuser: string decoder + global concealing (' + jscLines + ' lines, ' + tmpJscOut + ')');
      } else { mark('jsobf_jsconfuser: not JS-Confuser family, keep original'); }
      try{ fs.unlinkSync(tmpJscIn); }catch{}
      try{ fs.unlinkSync(tmpJscOut); }catch{}
    } catch(e7){ console.log('  [skip] jsobf_jsconfuser: ' + e7.message.slice(0,80)); }
  }

  // Stage I2 — jsconfuser_techniques: the single-purpose JS-Confuser transforms
  // (opaque predicates, duplicate literals, object extraction, RGF, var masking,
  // string splitting, calculator, flatten, computed keys). Runs after the string
  // decoder so the literals it folds are already readable.
  {
    try {
      const tmpJtIn = OUTPUT + '.__jt_in.js', tmpJtOut = OUTPUT + '.__jt_out.js';
      fs.writeFileSync(tmpJtIn, src);
      const rj = cp.spawnSync('node', [path.join(__dirname,'jsconfuser_techniques.js'), tmpJtIn, tmpJtOut],
        { timeout: 180000, encoding: 'utf8' });
      if(fs.existsSync(tmpJtOut) && fs.statSync(tmpJtOut).size > 50){
        const jt = fs.readFileSync(tmpJtOut, 'utf8');
        if(jt.length < src.length){
          const jl = (rj.stdout || '').trim().split('\n').pop();
          if (adopt(jt, 'jsconfuser_techniques')) mark('jsconfuser_techniques: ' + (jl || 'applied').replace('[jsc_tech] ', ''));
        } else mark('jsconfuser_techniques: no gain, keep original');
      } else mark('jsconfuser_techniques: not JS-Confuser technique, keep original');
      try{ fs.unlinkSync(tmpJtIn); }catch{}
      try{ fs.unlinkSync(tmpJtOut); }catch{}
    } catch(e9){ console.log('  [skip] jsconfuser_techniques: ' + e9.message.slice(0,80)); }
  }

  // Stage I3 — var_mask_restore: JS-Confuser "variable masking" (rest-param array)
  if (!gates.var_mask) mark('var_mask_restore: gate off (no rest-param masks), skip');
  else {
    try {
      const tmpVmIn = OUTPUT + '.__vmask_in.js', tmpVmOut = OUTPUT + '.__vmask_out.js';
      fs.writeFileSync(tmpVmIn, src);
      cp.spawnSync('node', [path.join(__dirname,'var_mask_restore.js'), tmpVmIn, tmpVmOut],
        { timeout: 120000, encoding: 'utf8' });
      if(fs.existsSync(tmpVmOut) && fs.statSync(tmpVmOut).size > 50){
        if (adopt(fs.readFileSync(tmpVmOut, 'utf8'), 'var_mask_restore')) mark('var_mask_restore: rest-parameter mask -> named bindings');
      }
      try{ fs.unlinkSync(tmpVmIn); }catch{}
      try{ fs.unlinkSync(tmpVmOut); }catch{}
    } catch(e10){ console.log('  [skip] var_mask_restore: ' + e10.message.slice(0,80)); }
  }

  // Stage I4 — numeric_table_fold: constant-fold pure numeric register tables
  // (`f(a,b) => T.slice(a,b)`, `T[const]`) so later stages can read the real
  // constants. Tables that are ever written to are left alone by design.
  if (!gates.numeric_table_fold) mark('numeric_table_fold: gate off (no numeric table pattern), skip');
  else {
    try {
      const tmpNtIn = OUTPUT + '.__nt_in.js', tmpNtOut = OUTPUT + '.__nt_out.js';
      fs.writeFileSync(tmpNtIn, src);
      const rnt = cp.spawnSync('node', [path.join(__dirname,'numeric_table_fold.js'), tmpNtIn, tmpNtOut], { timeout: 240000, encoding: 'utf8' });
      const rntout = (rnt.stdout || '') + (rnt.stderr || '');
      if(fs.existsSync(tmpNtOut) && fs.statSync(tmpNtOut).size > 50 && /inlined=[1-9]/.test(rntout)){
        if (adopt(fs.readFileSync(tmpNtOut, 'utf8'), 'numeric_table_fold')) mark('numeric_table_fold: ' + (rntout.match(/slice=\d+ index=\d+ inlined=\d+[^|]*/) || ['applied'])[0].trim());
      } else mark('numeric_table_fold: no pure table, keep original');
      try{ fs.unlinkSync(tmpNtIn); }catch{}
      try{ fs.unlinkSync(tmpNtOut); }catch{}
    } catch(e10n){ console.log('  [skip] numeric_table_fold: ' + e10n.message.slice(0,80)); }
  }

  // Stage J — xor_cipher_decode: XOR/RC4/custom-cipher string decoder (post CFF, literal args now foldable)
  if (!gates.xor_decode) mark('xor_cipher_decode: gate off (no cipher evidence), skip');
  else {
    try {
      const tmpXor = OUTPUT + '.__xor_in.js', tmpXorOut = OUTPUT + '.__xor_out.js';
      fs.writeFileSync(tmpXor, src);
      const rx = cp.spawnSync('node', [path.join(__dirname,'xor_cipher_decode.js'), tmpXor, tmpXorOut], { timeout: 300000, encoding: 'utf8' });
      const rxout = (rx.stdout || '') + (rx.stderr || '');
      if(fs.existsSync(tmpXorOut) && /decoded=([1-9]\d*)/.test(rxout)){
        if (adopt(fs.readFileSync(tmpXorOut, 'utf8'), 'xor_cipher_decode')) mark('xor_cipher_decode: ' + (rxout.match(/decoded=\d+ rounds=\d+ decoders=\d+/) || ['decoded'])[0]);
      } else mark('xor_cipher_decode: no decoder calls resolved, keep original');
      try{ fs.unlinkSync(tmpXor); }catch{}
      try{ fs.unlinkSync(tmpXorOut); }catch{}
    } catch(e9){ console.log('  [skip] xor_cipher_decode: ' + e9.message.slice(0,80)); }
  }

    // Stage H — VM content dump (report file next to output; extraction, not run)
  const HAS_VM = /function\s+[A-Za-z_$][\w$]*\([^)]*\)\s*\{\s*while\s*\(/.test(src) || (src.match(/\bwhile\s*\(/g) || []).length >= 25 || /_vm[0-9a-f]+/.test(src);
  if (!gates.vm_trace && !gates.vm_hard_decode) mark('vm_trace/vm_hard_decode: gate off (no VM evidence), skip');
  else if(HAS_VM || gates.vm_trace || gates.vm_hard_decode){
    try{
      const tmpVm = OUTPUT + '.__vm_in.js', tmpVmOut = OUTPUT + '.vm-dump.txt';
      fs.writeFileSync(tmpVm, src);
      const rv = cp.spawnSync('node', [path.join(__dirname,'vm_trace.js'), tmpVm, tmpVmOut], { timeout: 240000 });
      if(fs.existsSync(tmpVmOut)) mark('vm_trace: dump written (' + tmpVmOut + ')');
      try{ fs.unlinkSync(tmpVm); }catch{}
    }catch(e4){ console.log('  [skip] vm_trace: ' + e4.message.slice(0,80)); }
  } else mark('vm_trace: no VM pattern, skip');

  // Stage K — vm_hard_decode: execution-trace VM dispatcher decoder (bytecode VM → real ops)
  if (!gates.vm_hard_decode) mark('vm_hard_decode: gate off (no VM evidence), skip');
  else {
    try {
      const tmpVh = OUTPUT + '.__vh_in.js', tmpVhOut = OUTPUT + '.__vh_out.js';
      fs.writeFileSync(tmpVh, src);
      const rv2 = cp.spawnSync('node', [path.join(__dirname,'vm_hard_decode.js'), tmpVh, tmpVhOut], { timeout: 300000, encoding: 'utf8' });
      const rv2out = (rv2.stdout || '') + (rv2.stderr || '');
      if(fs.existsSync(tmpVhOut) && /states=(\d+)/.test(rv2out) && /states=[1-9]/.test(rv2out)){
        if (adopt(fs.readFileSync(tmpVhOut, 'utf8'), 'vm_hard_decode')) mark('vm_hard_decode: ' + (rv2out.match(/states=\d+ stmts=\d+ folds=\d+/) || ['decoded'])[0]);
      } else mark('vm_hard_decode: no VM trace recovered, keep original');
      try{ fs.unlinkSync(tmpVh); }catch{}
      try{ fs.unlinkSync(tmpVhOut); }catch{}
    } catch(e10){ console.log('  [skip] vm_hard_decode: ' + e10.message.slice(0,80)); }
  }

  // simpan intermediate
  const tmp = OUTPUT + '.__inter.js';
  fs.writeFileSync(tmp, src);

  // Stage F — beautify (prefer babel; fallback to custom plugin, then copy)
  let pretty = babelBeautify(tmp, OUTPUT);
  if(pretty === null) pretty = beautify(tmp, OUTPUT);
  if(pretty === null) fs.copyFileSync(tmp, OUTPUT);
  // Beautifiers can also emit broken output on huge minified sources; keep the
  // pre-beautify intermediate if they did, so F-stages start from valid code.
  if (!file_adopt(tmp, 'beautify')) console.log('  [rollback] kept pre-beautify intermediate');
  if(process.env.KEEP_INTER) console.log('inter kept: ' + tmp);
  else try{ fs.unlinkSync(tmp); }catch{}

  // Stage F2 — final_readable: fold string concat + rename mangled vars + dead-code + beautify
  try {
    const tmpR = OUTPUT + '.__readable_in.js';
    fs.writeFileSync(tmpR, fs.readFileSync(OUTPUT));
    const r = cp.spawnSync('node', [path.join(__dirname, 'final_readable.js'), tmpR, OUTPUT], { timeout: 240000 });
    if (r.status === 0 && fs.existsSync(OUTPUT)) {
      if (file_adopt(tmpR, 'final_readable')) mark('final_readable: concat-fold + var-rename + dead-code');
    } else {
      console.log('  [skip] final_readable: ' + (r.stderr ? r.stderr.toString().slice(0,100) : 'status ' + r.status));
      fs.copyFileSync(tmpR, OUTPUT);
    }
    if(process.env.KEEP_INTER) console.log('F2 input kept: ' + tmpR);
    else try{ fs.unlinkSync(tmpR); }catch{}
  } catch(e5){ console.log('  [skip] final_readable: ' + e5.message.slice(0,80)); }

  // Stage F3 — semantic_unshim: inline shims + semantic rename (bot, ctx, axios, etc.)
  try {
    const tmpS = OUTPUT + '.__semantic_in.js';
    fs.writeFileSync(tmpS, fs.readFileSync(OUTPUT));
    const r2 = cp.spawnSync('node', [path.join(__dirname, 'semantic_unshim.js'), tmpS, OUTPUT], { timeout: 240000 });
    if (r2.status === 0 && fs.existsSync(OUTPUT)) {
      if (file_adopt(tmpS, 'semantic_unshim')) mark('semantic_unshim: shims inlined + semantic rename');
    } else {
      console.log('  [skip] semantic_unshim: ' + (r2.stderr ? r2.stderr.toString().slice(0,100) : 'status ' + r2.status));
    }
    try{ fs.unlinkSync(tmpS); }catch{}
  } catch(e5){ console.log('  [skip] semantic_unshim: ' + e5.message.slice(0,80)); }

  // Stage F5 — vm_prune_and_unflatten: remove dispatcher blocks + dead helpers
    try {
      const tmpP = OUTPUT + '.__prune_in.js';
      fs.writeFileSync(tmpP, fs.readFileSync(OUTPUT));
      const r3 = cp.spawnSync('node', [path.join(__dirname, 'vm_prune_and_unflatten.js'), tmpP, OUTPUT], { timeout: 240000 });
      if (r3.status === 0 && fs.existsSync(OUTPUT)) {
        if (file_adopt(tmpP, 'vm_prune_and_unflatten')) mark('vm_prune_and_unflatten: dispatcher blocks pruned + dead helpers removed');
      } else {
        console.log('  [skip] vm_prune_and_unflatten: ' + (r3.stderr ? r3.stderr.toString().slice(0,100) : 'status ' + r3.status));
      }
      try{ fs.unlinkSync(tmpP); }catch{}
    } catch(e6){ console.log('  [skip] vm_prune_and_unflatten: ' + e6.message.slice(0,80)); }

    // Stage F6 — deadcode_eliminate: full reachability-based dead code + junk removal
    try {
      const tmpD = OUTPUT + '.__dead_in.js';
      fs.writeFileSync(tmpD, fs.readFileSync(OUTPUT));
      const r4 = cp.spawnSync('node', [path.join(__dirname, 'deadcode_eliminate.js'), tmpD, OUTPUT], { timeout: 240000 });
      if (r4.status === 0 && fs.existsSync(OUTPUT)) {
        if (file_adopt(tmpD, 'deadcode_eliminate')) mark('deadcode_eliminate: dead bindings + dispatcher blocks + unreachable removed');
      } else {
        console.log('  [skip] deadcode_eliminate: ' + (r4.stderr ? r4.stderr.toString().slice(0,100) : 'status ' + r4.status));
      }
      try{ fs.unlinkSync(tmpD); }catch{}
    } catch(e7){ console.log('  [skip] deadcode_eliminate: ' + e7.message.slice(0,80)); }

    // Stage F7 — vm_cleanup: remove VM dispatcher garbage + leftover f34 noise.
  try {
    const tmpV = OUTPUT + '.__vmclean_in.js';
    fs.writeFileSync(tmpV, fs.readFileSync(OUTPUT));
    const r = cp.spawnSync('node', [path.join(__dirname, 'vm_cleanup.js'), tmpV, OUTPUT], { timeout: 240000 });
    if (r.status === 0 && fs.existsSync(OUTPUT)) {
      if (file_adopt(tmpV, 'vm_cleanup')) mark('vm_cleanup: VM dispatcher removal + bracket->dot + concat fold');
    } else {
      console.log('  [skip] vm_cleanup: ' + (r.stderr ? r.stderr.toString().slice(0,100) : 'status ' + r.status));
      fs.copyFileSync(tmpV, OUTPUT);
    }
    try{ fs.unlinkSync(tmpV); }catch{}
  } catch(e6){ console.log('  [skip] vm_cleanup: ' + e6.message.slice(0,80)); }

  // Stage F8 — var_rename_restore: scope-aware semantic renaming (eliminates ALL generic gen* names)
  try {
    const tmpV = OUTPUT + '.__var_rename_in.js';
    fs.writeFileSync(tmpV, fs.readFileSync(OUTPUT));
    const r = cp.spawnSync('node', [path.join(__dirname, 'var_rename_restore.js'), tmpV, OUTPUT], { timeout: 240000 });
    if (r.status === 0 && fs.existsSync(OUTPUT)) {
      if (file_adopt(tmpV, 'var_rename_restore')) mark('var_rename_restore: scope-aware semantic rename (gen* eliminated)');
    } else {
      console.log('  [skip] var_rename_restore: ' + (r.stderr ? r.stderr.toString().slice(0,100) : 'status ' + r.status));
      fs.copyFileSync(tmpV, OUTPUT);
    }
    try{ fs.unlinkSync(tmpV); }catch{}
  } catch(e8){ console.log('  [skip] var_rename_restore: ' + e8.message.slice(0,80)); }

  // Stage F9 — final_surgical_cleanup: last polish (computed keys, bracket→dot, debugger, boolean, OBF_MARKER, string concat)
  try {
    const tmpS = OUTPUT + '.__surgical_in.js';
    fs.writeFileSync(tmpS, fs.readFileSync(OUTPUT));
    const r = cp.spawnSync('node', [path.join(__dirname, 'final_surgical_cleanup.js'), tmpS, OUTPUT], { timeout: 240000 });
    if (r.status === 0 && fs.existsSync(OUTPUT)) {
      if (file_adopt(tmpS, 'final_surgical_cleanup')) mark('final_surgical_cleanup: computed keys → identifier + bracket→dot + debugger + boolean + OBF_MARKER + string concat');
    } else {
      console.log('  [skip] final_surgical_cleanup: ' + (r.stderr ? r.stderr.toString().slice(0,100) : 'status ' + r.status));
      fs.copyFileSync(tmpS, OUTPUT);
    }
    try{ fs.unlinkSync(tmpS); }catch{}
  } catch(e9){ console.log('  [skip] final_surgical_cleanup: ' + e9.message.slice(0,80)); }

  // Stage F9b — semantic_naming: replace numbered markers (fn3, value72, …) with
  // the binding's real role. Runs last, once the code is structurally final, so
  // the evidence it reads (assignment RHS, call sites, member access) is the real
  // program and not an intermediate representation.
  try {
    const tmpN = OUTPUT + '.__sem_in.js';
    fs.writeFileSync(tmpN, fs.readFileSync(OUTPUT));
    const r = cp.spawnSync('node', [path.join(__dirname, 'semantic_naming.js'), tmpN, OUTPUT], { timeout: 300000 });
    const rout = (r.stdout || '') + (r.stderr || '');
    const m = rout.match(/renamed (\d+)/);
    const left = (rout.match(/numbered left (\d+)/) || [])[1];
    if (r.status === 0 && fs.existsSync(OUTPUT)) {
      if (file_adopt(tmpN, 'semantic_naming')) mark('semantic_naming: ' + (m ? m[1] : '0') + ' bindings named (numbered left ' + (left || '?') + ')');
    } else {
      console.log('  [skip] semantic_naming: ' + (r.stderr ? r.stderr.toString().slice(0,100) : 'status ' + r.status));
      fs.copyFileSync(tmpN, OUTPUT);
    }
    try{ fs.unlinkSync(tmpN); }catch{}
  } catch(e9b){ console.log('  [skip] semantic_naming: ' + e9b.message.slice(0,80)); }

  // Stage F9c — jsobf_string_table: resolve large string-table
  // wrapper decoders (e.g. `zu59Wo9(idx)` → bytes from const table).
  // Runs LAST (after semantic_naming) so the final decoder names are stable
  // and the sandbox can evaluate the full chain with resolved identifiers.
  if (gates.string_table) {
    try {
      const tmpStIn = OUTPUT + '.__st_in.js', tmpStOut = OUTPUT + '.__st_out.js';
      // Read OUTPUT, not `src` — the F-stages (F2..F9b) write to OUTPUT
      // directly, so `src` is stale here and the decoder chain would be
      // evaluated against pre-rename bindings.
      fs.writeFileSync(tmpStIn, fs.readFileSync(OUTPUT));
      const rs = cp.spawnSync('node', [path.join(__dirname,'jsobf_string_table.js'), tmpStIn, tmpStOut], { timeout: 300000, encoding: 'utf8' });
      const rsout = (rs.stdout || '') + (rs.stderr || '');
      const resolvedMatch = rsout.match(/resolved=(\d+)/);
      if(fs.existsSync(tmpStOut) && fs.statSync(tmpStOut).size > 50){
        const stOut = fs.readFileSync(tmpStOut, 'utf8');
        if (adopt(stOut, 'string_table')) fs.writeFileSync(OUTPUT, src);
        if (resolvedMatch) {
          mark('string_table: resolved=' + resolvedMatch[1]);
        } else if (rsout.includes('no string table')) {
          // no-op: no table family → no mark needed
        } else if (rsout.trim()) {
          mark('string_table: ' + rsout.trim().split('\n').slice(-1)[0].slice(0,60));
        }
      } else {
        if (rsout.trim()) mark('string_table: ' + rsout.trim().split('\n').slice(-1)[0].slice(0,60));
      }
      try{ fs.unlinkSync(tmpStIn); }catch{}
      try{ fs.unlinkSync(tmpStOut); }catch{}
    } catch(e0s){ console.log('  [skip] jsobf_string_table: ' + e0s.message.slice(0,80)); }
  }

  // Stage F10 — structure_cleanup: final structure beautification
  try {
    const tmpSt = OUTPUT + '.__struct_in.js';
    fs.writeFileSync(tmpSt, fs.readFileSync(OUTPUT));
    const rs = cp.spawnSync('node', [path.join(__dirname, 'structure_cleanup.js'), tmpSt, OUTPUT], { timeout: 240000 });
    const rsout = (rs.stdout || '') + (rs.stderr || '');
    if (rs.status === 0 && fs.existsSync(OUTPUT)) {
      if (file_adopt(tmpSt, 'structure_cleanup')) mark('structure_cleanup: ' + (rsout.match(/fixes=\d+/) || ['fixes applied'])[0]);
    } else {
      console.log('  [skip] structure_cleanup: ' + (rs.stderr ? rs.stderr.toString().slice(0,100) : 'status ' + rs.status));
      fs.copyFileSync(tmpSt, OUTPUT);
    }
    try{ fs.unlinkSync(tmpSt); }catch{}
  } catch(e11){ console.log('  [skip] structure_cleanup: ' + e11.message.slice(0,80)); }

  const ok = checkSyntax(OUTPUT);
  console.log('generic_deob: output = ' + OUTPUT + ' (' + fs.statSync(OUTPUT).size + ' bytes) syntax=' + (ok ? 'VALID' : 'INVALID'));
  console.log('generic_deob: stages = ' + report.stages.join(' | '));
  process.exit(ok ? 0 : 2);
}

main().catch(e => { console.error('generic_deob FAIL: ' + e.message); process.exit(1); });