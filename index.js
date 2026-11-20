#!/usr/bin/env node
/**
 * index.js — Telegram Bot untuk JS Deobfuscation
 *
 * Framework: @icanseeuanywhere/telekaf (Bot API 10.1 Rich Messages)
 * All messages use RichHTMLBuilder with tables.
 *
 * Usage:
 *   node index.js
 *   (reads settings/config.json and/or env vars TELEGRAM_BOT_TOKEN + TELEGRAM_OWNER_ID)
 */
'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const cp   = require('child_process');
const { Telegraf } = require('@icanseeuanywhere/telekaf');
const { RichMessage } = require('@icanseeuanywhere/telekaf');
const H = RichMessage.RichHTMLBuilder;
const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const richBold = (value) => '<b>' + escapeHtml(value) + '</b>';
// Telegram inline-button captions are plain text; the library cannot apply
// Telegram HTML formatting to InlineKeyboardButton.text. Keep the menu copy
// and the confirmation name consistent in the localized button label.
const SEREN_CONFIRM_TEXT  = 'ยืนยัน';
const SEREN_CANCEL_TEXT   = 'ยกเลิก';
const SEREN_CONFIRM_LABEL = '✅ - ' + SEREN_CONFIRM_TEXT;
const SEREN_CANCEL_LABEL  = '❌ - ' + SEREN_CANCEL_TEXT;
const SEREN_BACK_LABEL    = '🔙 - เมนูหลัก';

function formatFileSize(bytes){
  const n = Number(bytes);
  if(!Number.isFinite(n) || n < 0) return '-';
  if(n < 1024) return n + ' B';
  if(n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Config ──
const SCRIPT_DIR = __dirname;
const CONFIG_FILE = path.join(SCRIPT_DIR, 'settings', 'config.json');

let cfg = { bot:{}, deobfuscator:{} };
try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')); }catch{}

const TOKEN     = process.env.TELEGRAM_BOT_TOKEN || cfg.bot?.token || '';
const OWNER_IDS = String(process.env.TELEGRAM_OWNER_ID || process.env.TELEGRAM_ALLOWED_USERS || cfg.bot?.owner_id || '')
                   .split(/[,;\s]+/).filter(Boolean);
const ALLOWED   = [...new Set([...OWNER_IDS, ...((cfg.bot?.allowed_users || []).map(String))])]
                   .filter(id => id && !/YOUR_TELEGRAM/i.test(id));
const TIMEOUT   = cfg.deobfuscator?.timeout_ms || 300000;
const THUMBNAIL = process.env.TELEGRAM_THUMBNAIL || cfg.bot?.thumbnail || '';
const DEFAULT_THUMBNAIL = 'https://c.top4top.io/p_3666xqenk0.png'; // dari script Thunder contoh — ganti di settings/config.json
const WORK_DIR  = path.join(SCRIPT_DIR, cfg.deobfuscator?.work_dir || path.join('plugins','work'));
const DEOBF     = path.join(SCRIPT_DIR, 'plugins', 'generic_deob.js');

if(!TOKEN || TOKEN === 'YOUR_BOT_TOKEN_HERE'){
  console.error('FATAL: TELEGRAM_BOT_TOKEN tidak diset.');
  console.error('  Edit settings/config.json (isi bot.token) atau set env TELEGRAM_BOT_TOKEN.');
  process.exit(1);
}
if(!ALLOWED.length || ALLOWED.includes('YOUR_TELEGRAM_CHAT_ID_HERE')){
  console.error('FATAL: TELEGRAM_OWNER_ID belum diisi.');
  console.error('  Edit settings/config.json (isi bot.owner_id) atau set env TELEGRAM_OWNER_ID.');
  process.exit(1);
}

// ── State ──
let offset    = 0;
let busy      = false;
const pending = new Map(); // token -> {path, name, size}
let pendingId = 0;
let processed = 0;
let startTime = Date.now();

// ── Logging ──
function log(...args){ console.error('[' + new Date().toISOString().slice(11,19) + ']', ...args); }

// ── Owner check ──
function isAllowed(uid){
  return ALLOWED.includes(String(uid));
}

// ── User label: @username atau "Nama Belakang" ──
function userLabel(from){
  if(!from) return '-';
  if(from.username) return '@' + from.username;
  const fn = from.first_name || '', ln = from.last_name || '';
  return (fn + ' ' + ln).trim() || ('#' + from.id);
}

// ── Rich Message Helpers ──
// SEREN theme: raw `blocks` JSON (Bot API 10.1 table blocks), not RichHTMLBuilder.
// sendRich/replyRich unwrap builders OR pass raw blocks through.
function uptimeStr(){
  const s = Math.floor((Date.now() - startTime) / 1000);
  const d = Math.floor(s/86400), h = Math.floor(s%86400/3600),
        m = Math.floor(s%3600/60), sec = s%60;
  const parts = [];
  if(d) parts.push(d+'d');
  if(h) parts.push(h+'h');
  if(m) parts.push(m+'m');
  parts.push(sec+'s');
  return parts.join(' ');
}
function memStr(){
  const used = process.memoryUsage().rss;
  const total = os.totalmem();
  const f = (b)=>{ const mb=b/1024/1024; return (mb>=1024? (mb/1024).toFixed(2)+' GB' : mb.toFixed(1)+' MB'); };
  return f(used)+' / '+f(total);
}

function sendRich(ctx, builder){
  const msg = (builder && typeof builder.build === 'function') ? builder.build() : builder;
  return ctx.sendRichMessage(msg).catch(e => log('sendRich error:', e.message));
}

function replyRich(ctx, builder){
  const msg = (builder && typeof builder.build === 'function') ? builder.build() : builder;
  return ctx.replyWithRichMessageContent(msg).catch(e => log('replyRich error:', e.message));
}

function statusTable(){
  const uptime = Math.floor((Date.now() - startTime) / 60000);
  const rows = [
    ['Uptime', uptime + ' menit'],
    ['Processed', String(processed) + ' file'],
    ['Status', busy ? '⏳ Sibuk' : '✅ Siap'],
  ];
  return rows;
}

// ── SEREN Theme HTML Builder ──
// The two-line brand header, defined once so every card renders it identically.
// Split into two <tr> rows (not one cell with <br>, which Telegram renders as
// literal text) and centered via colspan + text-align.
const TITLE_STYLE = 'background: transparent; border: none; padding: 8px 12px; text-align: center;';
const titleRows = () => new H()
  .raw('<tr><td colspan="2" style="' + TITLE_STYLE + '">' + richBold('S E R E N - D E O B F U S C A T O R') + '</td></tr>')
  .build().html;

function buildSerenMenuHTML(runtimeStatus, memoryStatus){
  let b = new H();
  if(THUMBNAIL || DEFAULT_THUMBNAIL) b = b.photo(THUMBNAIL || DEFAULT_THUMBNAIL);
  const row2 = (k, v) => `<tr><td style="background: transparent; border: none; padding: 3px 12px; text-align: left; width: 38%;">${richBold(k)}</td>`
                       + `<td style="background: transparent; border: none; padding: 3px 12px; text-align: left;">${richBold(v)}</td></tr>`;
  const sect = (t) => `<tr><td colspan="2" style="background: transparent; border: none; padding: 6px 12px; text-align: left; border-bottom: 1px solid rgba(128,128,128,0.25);">${richBold(t)}</td></tr>`;
  return b
    .raw('<table style="background: transparent; border: none; width: 100%;">')
    .raw(titleRows())
    .raw(sect('Information'))
    .raw(row2('Author', 'Zephyrine'))
    .raw(row2('Version', '1.0'))
    .raw(row2('Language', 'JavaScript (Node.js)'))
    .raw(row2('Prefix', '/ (Slash)'))
    .raw(sect('System'))
    .raw(row2('Runtime', runtimeStatus))
    .raw(row2('Memory', memoryStatus))
    .raw('</table>')
    .build();
}

// ── Simple menu (section + key-value rows) ──
// SEREN look: centered title, a distinct section header row, then key-value rows.
// Rows may be "Key | Value" (two columns) or plain text (full width, centered).
function buildSerenSimpleHTML(sectionEmoji, sectionTitle, rows){
  let b = new H();
  if(THUMBNAIL || DEFAULT_THUMBNAIL) b = b.photo(THUMBNAIL || DEFAULT_THUMBNAIL);
  b = b
    .raw('<table style="background: transparent; border: none; width: 100%;">')
    .raw(titleRows())
    .raw(`<tr><td colspan="2" style="background: transparent; border: none; padding: 6px 12px; text-align: left; border-bottom: 1px solid rgba(128,128,128,0.25);">${richBold(sectionEmoji + ' - ' + sectionTitle)}</td></tr>`);
  for(const r of rows){
    const parts = r.split('|');
    if(parts.length===2){
      b = b.raw(`<tr><td style="background: transparent; border: none; padding: 3px 12px; text-align: left; width: 38%;">${richBold(parts[0].trim())}</td>`
             + `<td style="background: transparent; border: none; padding: 3px 12px; text-align: left;">${richBold(parts[1].trim())}</td></tr>`);
    } else {
      b = b.raw(`<tr><td colspan="2" style="background: transparent; border: none; padding: 3px 12px; text-align: left;">${richBold(r)}</td></tr>`);
    }
  }
  return b.raw('</table>').build();
}

// ── Centered instruction card ──
function buildSerenCenteredHTML(message){
  let b = new H();
  if(THUMBNAIL || DEFAULT_THUMBNAIL) b = b.photo(THUMBNAIL || DEFAULT_THUMBNAIL);
  return b
    .raw('<table style="background: transparent; border: none; width: 100%;">')
    .raw(titleRows())
    .raw(`<tr><td colspan="2" style="background: transparent; border: none; padding: 8px 12px; text-align: center; line-height: 1.45;">${richBold(message)}</td></tr>`)
    .raw('</table>')
    .build();
}

// ── Telegram helpers ──
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function getFileBytes(fileId){
  // Step 1: getFile -> file_path (file_id BUKAN path download!)
  const gfr = await fetch(`https://api.telegram.org/bot${TOKEN}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId })
  });
  const gj = await gfr.json();
  if(!gj.ok) throw new Error('getFile failed: ' + gj.description);
  const filePath = gj.result.file_path;
  // Step 2: download via file_path
  const url = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
  const r = await fetch(url);
  if(!r.ok) throw new Error('download failed: ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// ── Process a file sent as reply ──
async function processRepliedFile(file, ctx){
  const outPath = path.join(WORK_DIR, (file.file_name||'').replace(/\.js$/i, '') + '.deobfuscated.js');
  try{
    const bytes = await getFileBytes(file.file_id);
    if(bytes.length > 10 * 1024 * 1024){
      await replyRich(ctx, buildSerenSimpleHTML('々', 'File Too Large', [
        `Size | ${(bytes.length/1024/1024).toFixed(1)} MB`,
        'Limit 10 MB'
      ]));
      return;
    }
    const tempInput = path.join(WORK_DIR, file.file_name || 'input.js');
    fs.writeFileSync(tempInput, bytes);
    await processJS(tempInput, ctx, ctx.message?.message_id);
    try{ fs.unlinkSync(tempInput); }catch{}
  }catch(e){
    log('Reply process error:', e.message);
    await replyRich(ctx, buildSerenSimpleHTML('々', 'Error', [
      'Condition failed',
      `Detail | ${String(e.message).slice(0,200)}`
    ]));
  }
}

// ── Process a JS file through the deobfuscator ──
async function processJS(inputPath, ctx, replyToMessageId, meta){
  if(busy){
    await replyRich(ctx, buildSerenSimpleHTML('々', 'Busy', ['Condition: still processing a previous file']));
    return;
  }
  busy = true;
  const baseName = path.basename(inputPath);
  const outPath  = path.join(WORK_DIR, baseName.replace(/\.js$/i, '') + '.deobfuscated.js');
  const userName = meta?.user || '-';

  try{
    log('Processing:', baseName);

    // Progress: kirim status awal (tidak silent)
    const progressMsgId = (await api('sendRichMessage', {
      chat_id: ctx.chat.id,
      rich_message: buildSerenSimpleHTML('々', 'Processing', [
        `Requested by | ${userName}`,
        `File | ${meta?.name || baseName}`,
        `Size | ${meta?.size ? (meta.size/1024).toFixed(1) + ' KB' : '-'}`,
        `Stage | Starting deobfuscator`
      ])
    }).catch(()=>({ message_id: null })))?.message_id;
    // Typing indicator: kirim setiap stage baru supaya status "bot lagi ngetik" terus keliatan
    const sendTyping = () => api('sendChatAction', { chat_id: ctx.chat.id, action: 'typing' }).catch(()=>{});
    await sendTyping();
    const editProgress = async (stage) => {
      if(!progressMsgId) return;
      await sendTyping();
      await api('editRichMessage', {
        chat_id: ctx.chat.id,
        rich_message: buildSerenSimpleHTML('々', 'Processing', [
          `Requested by | ${userName}`,
          `File | ${meta?.name || baseName}`,
          `Size | ${meta?.size ? (meta.size/1024).toFixed(1) + ' KB' : '-'}`,
          `Stage | ${stage}`
        ]),
        message_id: progressMsgId
      }).catch(()=>{});
    };

    const result = await new Promise((resolve, reject) => {
      const proc = cp.spawn('node', [DEOBF, inputPath, outPath], {
        timeout: TIMEOUT,
        maxBuffer: 64*1024*1024,
        cwd: SCRIPT_DIR,
        env: { ...process.env, NODE_PATH: path.join(SCRIPT_DIR, 'node_modules') }
      });
      let stdout = '', stderr = '';
      let lastStage = '';
      // Not-silent: update progress setiap ada stage baru di stderr
      proc.stderr.on('data', d => {
        const s = d.toString();
        stderr += s;
        const m = s.match(/\[stage\]\s*(.+)/g);
        if(m){
          const st = m[m.length-1].replace('[stage]','').trim();
          if(st !== lastStage){ lastStage = st; editProgress(st.slice(0,90)); }
        }
      });
      proc.stdout.on('data', d => stdout += d);
      proc.on('close', code => {
        if(code === 0) resolve({ stdout, stderr });
        else {
          // The useful part of a MODULE_NOT_FOUND stack is the FIRST line
          // ("Cannot find module 'X'"), which the tail slice was cutting off.
          const head = stderr.slice(0, 600);
          const modErr = stderr.match(/Cannot find module '([^']+)'/);
          if(modErr) return reject(new Error('MODULE_NOT_FOUND: ' + modErr[1] +
                '\n(dependency belum terinstall — jalankan: npm install)'));
          // The pipeline prints its stage log to STDOUT, so a syntax-invalid
          // output (exit 2) left stderr empty and the card showed a bare
          // "exit code 2". Surface the real line from stdout instead.
          if(!head.trim() && stdout.trim()){
            const tail = stdout.trim().split('\n').slice(-6).join('\n').slice(0, 600);
            return reject(new Error(tail));
          }
          reject(new Error(head || 'exit code ' + code));
        }
      });
      proc.on('error', reject);
    });

    if(!fs.existsSync(outPath)){
      throw new Error('Deobfuscator tidak menghasilkan output.');
    }

    const outSize = fs.statSync(outPath).size;
    const outCode = fs.readFileSync(outPath, 'utf8');
    const fns  = (outCode.match(/\bfunction\b/g)||[]).length;
    const cats = (outCode.match(/\} catch/g)||[]).length;
    const ur   = (outCode.match(/UNRESOLVED/g)||[]).length;

    // Build result table (rows passed to .table([header, ...rows]))
    const rows = [
      ['File', baseName],
      ['Size', (outSize/1024).toFixed(1) + ' KB'],
      ['Functions', String(fns)],
      ['Try/Catch', String(cats)],
      ['UNRESOLVED', String(ur)],
      ['Syntax', '✅ VALID'],
    ];

    await ctx.sendRichMessage(buildSerenSimpleHTML('々', 'Deobfuscated', [
      `Requested by | ${userName}`,
      `File | ${meta?.name || baseName}`,
      `Size | ${(outSize/1024).toFixed(1)} KB`,
      `Functions | ${fns}`,
      `Try/Catch | ${cats}`,
      `UNRESOLVED | ${ur}`,
      `Syntax | ✅ VALID`,
      `Output | Clean file sent below`
    ]));
    


    // Send the file document (FormData via fetch)
    // Note: reply_to_message_id may point at a deleted message (the confirmation
    // flow deletes the "File Received" card), which Telegram rejects with 400.
    // Retry without reply params if that happens. Response is always checked.
    const sendDoc = (withReply) => {
      const formData = new FormData();
      formData.append('document', new Blob([fs.readFileSync(outPath)], {type:'application/javascript'}), baseName);
      formData.append('chat_id', String(ctx.chat.id));
      if(withReply && replyToMessageId) formData.append('reply_to_message_id', String(replyToMessageId));
      return fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, {
        method: 'POST',
        body: formData
      });
    };

    let docRes = await sendDoc(true);
    if(!docRes.ok){
      const errText = await docRes.text().catch(()=> '');
      // Match teks error Telegram apa pun yang menyangkut reply target mati
      // ("message to be replied not found", "replied message not found", dst)
      if(replyToMessageId && /replied/i.test(errText) && /not found/i.test(errText)){
        docRes = await sendDoc(false);   // pesan yang di-reply sudah dihapus -> kirim tanpa reply
      }
    }
    if(!docRes.ok){
      const errText = await docRes.text().catch(()=> '');
      log('sendDocument failed:', docRes.status, errText.slice(0,200));
      throw new Error('sendDocument failed: ' + (errText || docRes.status));
    }

    processed++;
    log('Done:', baseName, '(' + (outSize/1024).toFixed(1) + ' KB)');

  }catch(e){
    log('Error:', e.message);
    await replyRich(ctx, buildSerenSimpleHTML('々', 'Error', [
      `Requested by | ${userName}`,
      `File | ${meta?.name || baseName}`,
      `Detail | ${String(e.message).slice(0,200)}`
    ]));
  }finally{
    busy = false;
    try{ fs.unlinkSync(inputPath); }catch{}
    try{ fs.unlinkSync(outPath); }catch{}
  }
}

// ── Handle a single update ──
async function handleUpdate(upd){
  // Button press (callback_query)
  const cq = upd.callback_query;
  if(cq){
    if(!isAllowed(cq.from?.id)){
      await api('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: 'เฉพาะเจ้าของบอทเท่านั้นที่สามารถใช้เมนูนี้ได้',
        show_alert: true
      }).catch(()=>{});
      return;
    }
    if(cq.data === 'deobf'){
      await api('answerCallbackQuery', { callback_query_id: cq.id }).catch(()=>{});
      const chatId = cq.message?.chat?.id;
      const oldMsgId = cq.message?.message_id;
      try { await api('deleteMessage', { chat_id: chatId, message_id: oldMsgId }); }catch{}
      await api('sendRichMessage', {
        chat_id: chatId,
        rich_message: buildSerenCenteredHTML('Send a .js file to this chat, then press the ' + SEREN_CONFIRM_LABEL + ' button when the file information appears, wait for all processing stages to finish, and the deobfuscated file will be sent here automatically.'),
        reply_markup: { inline_keyboard: [[ { text: SEREN_BACK_LABEL, callback_data: 'menu' } ]] }
      });
    }
    if(cq.data.startsWith('proc:')){
      const token = cq.data.slice(5);
      const item = pending.get(token);
      const chatId = cq.message?.chat?.id;
      const oldMsgId = cq.message?.message_id;
      if(!item){
        await api('answerCallbackQuery', { callback_query_id: cq.id }).catch(()=>{});
        await api('sendRichMessage', { chat_id: chatId, rich_message: buildSerenSimpleHTML('々', 'Expired', ['Session expired', 'Send the file again']) }).catch(()=>{});
        return;
      }
      if(item.requesterId !== String(cq.from?.id || '')){
        await api('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: 'เฉพาะผู้ส่งไฟล์เท่านั้นที่สามารถเริ่มประมวลผลได้',
          show_alert: true
        }).catch(()=>{});
        return;
      }
      pending.delete(token);
      await api('answerCallbackQuery', { callback_query_id: cq.id }).catch(()=>{});
      // Ganti pesan info jadi "Processing..." + tampilkan user/name/size
      try { await api('deleteMessage', { chat_id: chatId, message_id: oldMsgId }); }catch{}
      const ctx2 = {
        chat: { id: chatId },
        sendRichMessage: async (m) => { await api('sendRichMessage', { chat_id: chatId, rich_message: m }); },
        replyWithRichMessageContent: async (m) => { await api('sendRichMessage', { chat_id: chatId, rich_message: m }); },
      };
      const meta = {
        user: userLabel(cq.from),
        name: item.name,
        size: item.size
      };
      // Pesan card sudah di-delete -> jangan pakai reply (Telegram 400
      // "message to be replied not found" kalau message_id sudah mati)
      await processJS(item.path, ctx2, null, meta);
      return;
    }
    if(cq.data.startsWith('cancel:')){
      const token = cq.data.slice(7);
      const item = pending.get(token);
      const chatId = cq.message?.chat?.id;
      const oldMsgId = cq.message?.message_id;
      if(!item || item.requesterId !== String(cq.from?.id || '')){
        await api('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: 'เฉพาะผู้ส่งไฟล์เท่านั้นที่สามารถยกเลิกได้',
          show_alert: true
        }).catch(()=>{});
        return;
      }
      await api('answerCallbackQuery', { callback_query_id: cq.id }).catch(()=>{});
      pending.delete(token);
      try{ fs.unlinkSync(item.path); }catch{}
      try { await api('deleteMessage', { chat_id: chatId, message_id: oldMsgId }); }catch{}
      await api('sendRichMessage', {
        chat_id: chatId,
        rich_message: buildSerenSimpleHTML('々', 'Cancelled', [
          'Requested by | ' + (item.requesterLabel || userLabel(cq.from)),
          'Name | ' + (item.name || '-'),
          'Size | ' + formatFileSize(item.size),
          'Status | Cancelled'
        ]),
        reply_markup: { inline_keyboard: [[ { text: SEREN_BACK_LABEL, callback_data: 'menu' } ]] }
      }).catch(()=>{});
      return;
    }
    if(cq.data === 'menu'){
      await api('answerCallbackQuery', { callback_query_id: cq.id }).catch(()=>{});
      const chatId = cq.message?.chat?.id;
      const oldMsgId = cq.message?.message_id;
      try { await api('deleteMessage', { chat_id: chatId, message_id: oldMsgId }); }catch{}
      await api('sendRichMessage', {
        chat_id: chatId,
        rich_message: buildSerenMenuHTML(uptimeStr(), memStr()),
        reply_markup: { inline_keyboard: [[ { text: '🔐 - ถอดรหัสไฟล์', callback_data: 'deobf' } ]] }
      });
    }
    return;
  }

  const msg = upd.message;
  if(!msg) return;

  // Owner check
  if(!isAllowed(msg.from?.id)){
    return;
  }

  const chatId  = msg.chat.id;
  const text    = msg.text || '';
  const doc     = msg.document;

  // Build ctx-like context
  const ctx = {
    chat: { id: chatId },
    from: { id: msg.from?.id },
    message_id: msg.message_id,
    sendRichMessage: async (richMsg) => {
      await api('sendRichMessage', { chat_id: chatId, rich_message: richMsg });
    },
    replyWithRichMessageContent: async (richMsg) => {
      await api('sendRichMessage', { chat_id: chatId, rich_message: richMsg, reply_parameters: { message_id: msg.message_id } });
    },
  };

  // ── Commands ──
  if(text === '/start'){
    // SEREN main menu + tombol DEOBFUSCATION
    const menu = buildSerenMenuHTML(uptimeStr(), memStr());
    await api('sendRichMessage', {
      chat_id: chatId,
      rich_message: menu,
      reply_parameters: { message_id: msg.message_id },
      reply_markup: { inline_keyboard: [[ { text: '🔐 - ถอดรหัสไฟล์', callback_data: 'deobf' } ]] }
    });
    return;
  }


  // ── Document handling: simpan file + tampilkan info + tombol proses/batal ──
  if(doc){
    const name = doc.file_name || '';
    if(!name.endsWith('.js')){
      await replyRich(ctx, buildSerenSimpleHTML('々', 'Error', [
        'Only .js files are accepted',
        'Send a .js file to continue'
      ]));
      return;
    }

    try{
      const bytes = await getFileBytes(doc.file_id);
      if(bytes.length > 10 * 1024 * 1024){
        await replyRich(ctx, buildSerenSimpleHTML('々', 'File Too Large', [
          'Size | ' + (bytes.length/1024/1024).toFixed(1) + ' MB',
          'Limit 10 MB'
        ]));
        return;
      }

      fs.mkdirSync(WORK_DIR, { recursive: true });
      const tmpPath = path.join(WORK_DIR, 'incoming_' + Date.now() + '_' + name.replace(/[^a-zA-Z0-9._-]/g,'_'));
      fs.writeFileSync(tmpPath, bytes);
      const token = String(++pendingId);
      pending.set(token, {
        path: tmpPath,
        name,
        size: bytes.length,
        requesterId: String(msg.from?.id || ''),
        requesterLabel: userLabel(msg.from),
        messageId: msg.message_id
      });
      log('File received:', name, '(' + (bytes.length/1024).toFixed(1) + ' KB) token=' + token);

      // Info file dalam tabel SEREN + tombol konfirmasi/batalkan
      await api('sendRichMessage', {
        chat_id: chatId,
        rich_message: buildSerenSimpleHTML('々', 'File Received', [
          'Requested by | ' + userLabel(msg.from),
          'Name | ' + name,
          'Size | ' + (bytes.length/1024).toFixed(1) + ' KB',
          'Type | JavaScript (.js)',
          'Status | Ready to process'
        ]),
        reply_parameters: { message_id: msg.message_id },
        reply_markup: { inline_keyboard: [
          [ { text: SEREN_CONFIRM_LABEL, callback_data: 'proc:' + token } ],
          [ { text: SEREN_CANCEL_LABEL, callback_data: 'cancel:' + token } ]
        ]}
      });
      return;
    }catch(e){
      log('Download error:', e.message);
      await replyRich(ctx, buildSerenSimpleHTML('々', 'Error', [
        'Download failed | ' + String(e.message).slice(0,200)
      ]));
    }
    return;
  }

  // Text message that isn't a command
  if(text && !text.startsWith('/')){
    await replyRich(ctx, buildSerenSimpleHTML('々', 'Unknown Command', [
      'Command not recognized',
      'Type /start for menu, or send a .js file'
    ]));
  }
}

// ── Telegram API helper ──
async function api(method, params = {}){
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  const j = await r.json();
  if(!j.ok) throw new Error('API ' + method + ': ' + (j.description || JSON.stringify(j)));
  return j.result;
}

// ── Main polling loop ──
async function main(){
  log('Bot started. Owner IDs:', ALLOWED.join(', '));
  log('Work dir:', WORK_DIR);
  log('Polling updates... (Ctrl+C to stop)');

  fs.mkdirSync(WORK_DIR, { recursive: true });

  for(const sig of ['SIGINT','SIGTERM']){
    process.on(sig, () => {
      log('Shutting down...');
      process.exit(0);
    });
  }

  while(true){
    try{
      const updates = await api('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: JSON.stringify(['message','callback_query'])
      });
      for(const upd of updates){
        offset = upd.update_id + 1;
        handleUpdate(upd).catch(e => log('handleUpdate error:', e.message));
      }
    }catch(e){
      log('Poll error:', e.message.slice(0,100));
      await sleep(5000);
    }
  }
}

main();
