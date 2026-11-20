# SEREN Deobfuscator

Universal JavaScript deobfuscation pipeline. One command, staged, hard-decoding —
no manual triage.

```
node index.js                 # run the Telegram bot
node plugins/generic_deob.js <input.js> <output.js>    # run the pipeline directly
```

## Pipeline order

Stage 0 runs **before** anything static, because obfuscated code always decodes
itself at runtime: executing it in a sandbox and intercepting the decoder sites
produces cleaner results than purely static analysis.

| # | Stage | What it removes |
|---|-------|-----------------|
| 0 | `runtime_decode` | runs the code in a sandbox, substitutes literal decoder results |
| 1 | `stripInvisible` | invisible/zero-width characters |
| 2 | `webcrack` | string arrays, decoder inlining, VM unpacking |
| 3 | `sandbox capture` | payload served from disk/network at runtime |
| 4 | `jsobf_tea` | TEA-encrypted string tables |
| 5 | `jsobf_cvc` | CVC / CJK obfuscator family (multi-layer) |
| 6 | `concat fold` | `"a" + "b" + …` |
| G | `cff_unroll` | basic control-flow flattening |
| G2 | `cff_hard_unroll` | template-CFF via **execution trace** (hash-based dispatchers, nested dispatchers) |
| I | `jsobf_jsconfuser` | JS-Confuser string decoder + global concealing |
| I2 | `jsconfuser_techniques` | opaque predicates, duplicate literals, object extraction, RGF, string splitting, calculator, flatten, computed keys |
| I3 | `var_mask_restore` | JS-Confuser variable masking (rest-parameter arrays) |
| J | `xor_cipher_decode` | XOR / RC4 / Caesar / Base64 / custom ciphers |
| K | `vm_hard_decode` | VM interpreter dispatchers |
| L | `vm_trace` | dumps VM state traces for manual review |
| F2–F10 | cleanup chain | `final_readable`, `semantic_unshim`, `vm_prune_and_unflatten`, `deadcode_eliminate`, `var_rename_restore`, `final_surgical_cleanup`, `structure_cleanup` |
| F9b | `semantic_naming` | last pass: replaces numbered markers (`fnN`, `valueN`) with the binding's real role |

## Design notes

**Execution-trace CFF, not static simulation.** Template-CFF dispatchers choose
their case with a runtime hash function, so the branch cannot be folded
statically. `cff_hard_unroll` instruments each `switch` with a state snapshot,
runs the program in a sandbox, and replays the recorded order.

**Babel caches NodePath objects on the AST nodes themselves.** After any pass
that replaces or removes nodes, a later `traverse()` re-walks detached paths and
can hand you `path.id === undefined` — or a `findParent()` that walks the wrong
tree. Passes that read binding information regenerate and re-parse first
(`renewAst()`).

**`t.cloneNode(0)` returns the number `0`**, which `replaceWith()` rejects as
falsy. Raw values coming out of a literal array must go through a `toNode()`
helper that builds primitives explicitly.

**A decoder call site that runs many times cannot be collapsed to one literal.**
A single AST node stands for every execution of that site. Recording only the
last result makes the whole call collapse to that value, which silently
corrupts the program when the earlier executions returned something else.
`runtime_decode` therefore records *every* value a site produced and only
substitutes a literal when all executions agree; if they disagree the site is
unwrapped back to the original call. Note the distinct case where the loop
passes the same argument each time — executions agree, so the literal is safe
and the loop is left intact.

**Babel's `errorRecovery` silently accepts an orphan `break`.** `node --check`
rejects the output while Babel's own parse says it is fine. Validity is
therefore checked with `vm.Script` (V8), and a `break` is only legal if a loop
or switch exists **in the same function scope chain** — not merely somewhere up
the ancestor path.

## Configuration

Copy `config.example.json` to `settings/config.json` and fill in the values.

## Requirements

Node 18+ and the Babel toolchain in `package.json` (`@babel/parser`,
`@babel/traverse`, `@babel/generator`, `@babel/types`).
