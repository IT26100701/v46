# seren-deobfuscator v46 — Laporan Perubahan

Peningkatan atas **seren-deobfuscator-v45**: fix bug + support lebih banyak tipe obfuscation **js-confuser**.

## Fitur Baru (di `plugins/jsconfuser_techniques.js`)

| Fitur | Apa yang di-deobfuscate |
|---|---|
| **Pass `calculator`** | Fold literal math ala JS-Confuser `calculator: true` — `2 ** 300` / `(7 + 5) * 4` / `100 + 50 * 2 - 8 / 4` dievaluasi jadi konstanta |
| **Pass `dispatcher` (2.x)** | Unpack pola `obj["key"](args)` / `obj.key(args)` — objek yang berisi kumpulan fungsi didispatch ke definisi aslinya |
| **Shape A2 (statement-split)** | Dispatcher yang dipecah webcrack/beautifier jadi `obj = {...}; obj["key"](...)` (bukan satu expression) kini terdeteksi |
| **Key identifier + string** | webcrack mengubah `obj["key"]` jadi `obj.key` — deteksi dispatcher menerima dua-duanya |

## Fix Bug

1. **`final_readable.js`** — rename referensi prototype-chain rusak (error `x is not a function` / referensi tak ikut ter-rename). Sebelumnya membuat **hampir semua file gagal** di-deobfuscate.
2. **`generic_deob.js`** — stage `semantic_unshim` dijalankan **dua kali** (double-rename, menimbulkan nama tidak konsisten).
3. **`generic_deob.js`** — default gates tidak punya `string_table` → stage string-table js-confuser tidak pernah jalan.
4. **`deadcode_eliminate.js`** — deklarasi `var/let/const` tidak pernah ditrack (`d.isIdentifier()` salah sasaran: yang dicek VariableDeclarator, bukan Identifier) → rantai reachability lewat variabel putus, fungsi hidup ikut terhapus.
5. **`deadcode_eliminate.js`** — reachability hanya satu arah (body → nama live). Fungsi yang **dipanggil** kode live (callee) ikut terhapus. Kini dua arah (forward + backward fixpoint).
6. **`var_rename_restore.js`** — binding class terdaftar di scope Program **dan** scope class → direname dua kali (deklarasi `instance2`, referensi `instance`). Skip key stale yang sudah ter-rename.

## Hasil Pengujian (semua dieksekusi ulang, output = hasil asli)

| Sampel | Ukuran in → out | Eksekusi |
|---|---|---|
| dispatcher-only | 2.4KB → 1.8KB | ✅ `{total:165.25, hello:"Hello, world!", calls:1}` |
| calc-only | 1.6KB → 1.7KB | ✅ `"66.15\|Hello, x!"` |
| calc-objext | 6.2KB → 5.9KB | ✅ identik |
| hex-rc4 | 3.0KB → 1.7KB | ✅ identik |
| vars-mangled | 1.2KB → 1.8KB | ✅ identik |
| strings-only | 17.4KB → 13.6KB | ✅ identik |
| zero-width | 1.5KB → 1.7KB | ✅ identik |
| cff-only | 461KB → 321KB | ✅ identik |
| all.js | 20MB → 468KB | ✅ syntax VALID |

## Cara Pakai

```bash
node plugins/generic_deob.js input.js output.js
```

## Catatan

- `tests/samples/all.js` (20MB) tidak disertakan di zip ini — jalankan dari proyek sendiri.
- Output final tiap sampel ada di `tests/out/*.final.js`; verifikasi otomatis: `node tests/verify_final.js`.
- `tests/samples/calc-only.js` & `dispatcher-only.js` adalah sampel baru untuk tipe calculator/dispatcher.