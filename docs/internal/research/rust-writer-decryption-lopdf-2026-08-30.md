# Decryption inside the Rust writer (lopdf 0.44)

Research date: 2026-08-30
Issue: evb0110/evb-viewer#154 (part of #150)
Sources: lopdf 0.44.0 registry source (`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/lopdf-0.44.0/`, cited as `lopdf/...`), getrandom 0.4.3 and rand 0.10.2 registry sources, `native/pdf-page-ops`, `app/utils/stripPdfEncryption.ts` and its callers. Read-only; no cargo build was run.

## 1. Revisions and algorithms lopdf 0.44 decrypts

- `/Filter` must be `Standard`; anything else is `Error::UnsupportedSecurityHandler` (`lopdf/src/encryption.rs:556-564`). Public-key handlers are out.
- `/V`: 1, 2, 4, 5 accepted; 0 and 3 are `InvalidVersion`; others `UnsupportedVersion` (`lopdf/src/encryption/algorithms.rs:75-102`).
- `/R`: every dispatch is `2..=4` (MD5/RC4 key path) or `5..=6` (SHA-256 path), else `DecryptionError::UnsupportedRevision`, whose text is "the encryption revision is not implemented in lopdf" (`algorithms.rs:1162-1203`; `encryption.rs:57-58`).
- Crypt filter methods from `/CF`: `V2` → RC4, `AESV2` → AES-128-CBC, `AESV3` → AES-256-CBC, `Identity`/absent → identity; unknown CFM entries are skipped (`lopdf/src/document.rs:385-406`). For `V < 4` the CF map is cleared and the default filter falls back to RC4 (`encryption.rs:572-574`, `662-674`). RC4 key length is capped at 16 bytes (`algorithms.rs:349-351`).
- R5 (Adobe extension) is handled by the one-round SHA-256 shortcut (`algorithms.rs:496-498`); R6 runs Algorithm 2.B with the SHA-256/384/512 rounds (`algorithms.rs:473-577`).
- `EncryptMetadata=false`, `/XRef` streams and per-stream `/Crypt` overrides are honoured during object decryption (`encryption.rs:775-810`).

Owner password caveat. For R5/R6 `compute_file_encryption_key_r6` tries the owner key first and then the user key, so either password yields the file key (`algorithms.rs:400-465`; tests assert both keys are equal, `algorithms.rs:1427-1432`, `1486-1491`). For R2-R4 `authenticate_owner_password_r4` recovers the user password only to authenticate it and discards it (`algorithms.rs:886-889`); `decrypt_raw` then calls `EncryptionState::decode`, which feeds the supplied password straight into the user-password key derivation (`document.rs:455-460`; `encryption.rs:566-567`; `algorithms.rs:302-303`). Result: an owner-only password on R2-R4 authenticates but derives the wrong key (AES padding errors or RC4 garbage). No lopdf test covers owner-password decryption below R5 (`algorithms.rs:1215-1375` only authenticate).

## 2. API: load with password, decrypt in place, save unencrypted

- Load: `LoadOptions { password, .. }` / `LoadOptions::with_password` (`lopdf/src/load_options.rs:33-34`, `67-72`) with `Document::load_with_options`, `load_mem_with_options` or `load_from_with_options` (`lopdf/src/reader.rs:40-44`, `98-108`). When the trailer has `/Encrypt`, `Reader::read` takes `load_encrypted_document` (`reader.rs:855-864`), which extracts raw objects, tries the empty password first, then the supplied one; a wrong supplied password fails the load with `Error::InvalidPassword` (`reader.rs:1195-1214`). If no password is supplied and the empty one fails, the load returns early with the trailer `/Encrypt` intact and only the `/Encrypt` dictionary parsed into `objects` (`reader.rs:895-897`, `1180-1192`).
- On success the reader decrypts every object (errors swallowed per object, `reader.rs:915`), expands object streams, stores `encryption_state` with the old `/Encrypt` object id, then removes the dictionary and the trailer key (`reader.rs:946-955`). The `LoadOptions.filter` callback is not applied on this path (`reader.rs:864` names it `_filter_func`); `max_decompressed_size` still is (`reader.rs:933`).
- In-memory: `Document::decrypt(&str)` (SASLprep/pad sanitised) or `decrypt_raw` authenticates as owner-or-user, decrypts all objects, expands ObjStm, removes `/Encrypt` from trailer and object table, and records `encryption_state` (`document.rs:435-509`). `authenticate_password`, `authenticate_user_password`, `authenticate_owner_password` and raw variants exist (`document.rs:273-362`). Because a load without the right password never parses objects, in practice the password must go through `LoadOptions`; `Document::decrypt` is for documents encrypted in memory.
- Save: `Document::save`/`save_to`/`save_internal` write objects as they are, and `write_trailer` only sets `/Size` (`lopdf/src/writer.rs:14-84`, `256-261`); the xref-stream path sets `/Type /Size /W /Index /Filter` (`writer.rs:221-237`). Nothing in the `Document` writer reads `encryption_state`, and nothing outside key derivation touches `/ID` (`rg 'b"ID"'`: `algorithms.rs:320`, `728`, parser). So after decryption the output is plaintext, `/Encrypt` is gone, and the original `/ID` array is written back unchanged. `lopdf/examples/decrypt.rs:15-29` is exactly load → `decrypt` → `save`.

## 3. Writing encrypted output (for the record)

Yes. `Document::encrypt(&EncryptionState)` encrypts all objects and installs an `/Encrypt` dictionary (`document.rs:416-432`); states are built from `EncryptionVersion::{V1,V2,V4,R5,V5}` (`encryption.rs:139-201`, `226-477`) and encoded by `EncryptionState::encode` (`614-660`). `IncrementalDocument::save` re-encrypts appended objects with the previous state and restores `/Encrypt N G R` in the new trailer (`writer.rs:311-383`). AES IVs come from `rand::rng()` (`lopdf/src/encryption/crypt_filters.rs:133-135`, `219-221`), which matters for item 5.

## 4. Incremental path versus full rewrite

- lopdf's `IncrementalDocument` refuses a still-encrypted previous revision (`writer.rs:284-296`, io `Unsupported`) and, for a decrypted one, writes an encrypted update (item 3). There is no plaintext-append mode, and the spec gives no such thing either: `/Encrypt` applies to the whole file. Producing an unencrypted file therefore requires a full rewrite via `Document::save`.
- `pdf-page-ops` does not use lopdf's `IncrementalDocument`; it has its own (`native/pdf-page-ops/src/incremental_document.rs:21-27`), loads through `Document::load_mem_with_options` with no password (`native/pdf-page-ops/src/load_policy.rs:45-49`, `140`), and refuses when `get_prev_documents().is_encrypted()` (`native/pdf-page-ops/src/incremental.rs:433-437`, `503-507`; compat full-rewrite path `667-671`; same checks in `page_sizes.rs:533-552`, `annotation_index.rs:94`, `text_layer.rs:1488-1696`, `shape_index.rs:307`, `page_geometry.rs:74-125`, `split_pages.rs:775-790`; wasm `page_tree_ops.rs:69-74`). Its revision writer serialises plaintext objects and a trailer without any `encryption_state` handling (`incremental.rs:895-935`; no `Encrypt`/`encryption_state` reference in either file).
- Consequence: because lopdf auto-decrypts empty-user-password files at load (`reader.rs:1196`), such a file passes every `is_encrypted()` guard with `encryption_state` set, and the page-ops incremental writer would append plaintext objects onto an encrypted base. This is an inference from code, not reproduced; it is masked in Electron because the working copy is decrypted by qpdf first (`electron/file-access/workingCopyCreation.ts:119-120`, `146-147`, `155-156`, `228`, `288`) and the browser wasm ops always do a full `save_to` rewrite (`page_tree_ops.rs:77-91`). A Rust decryption step must be followed by a full rewrite, not an append; the page-ops guards should also check `was_encrypted()` (`document.rs:269-271`) before the incremental writer.

## 5. wasm32-unknown-unknown

- The encryption module is unconditional (`lopdf/src/lib.rs:6`) with non-optional pure-Rust deps `aes 0.9`, `cbc 0.2`, `ecb 0.2`, `md-5 0.11`, `sha2 0.11`, `stringprep 0.1.5` (unicode-bidi/normalization/properties), `rand 0.10`, `getrandom 0.4` (`lopdf/Cargo.toml` `[dependencies]`; stringprep `Cargo.toml`). The only lopdf feature touching this is `wasm_js = ["getrandom/wasm_js"]`.
- getrandom 0.4.3 emits `compile_error!` on wasm32-unknown-unknown unless `wasm_js` or an opt-in backend is chosen (`getrandom-0.4.3/src/backends.rs:170-181`); the custom backend needs `--cfg getrandom_backend="custom"` plus an exported `__getrandom_v03_custom` (`src/backends/custom.rs:9-10`, `README.md:140-160`). Its README warns against enabling `wasm_js` in libraries (`README.md:82-84`).
- This repo already does that: `pdf-page-ops` depends on `lopdf 0.44.0, default-features = false` and `getrandom 0.4.2` (`native/pdf-page-ops/Cargo.toml`), the wasm build passes `--cfg getrandom_backend="custom"` (`scripts/wasm-artifacts.mjs:1`, `60-67`), and `lib.rs:115-127` defines a zero-filling backend; CI installs the target (`.github/workflows/ci.yml:634`). So lopdf's crypto already compiles for wasm today with no extra feature flag. Decryption never draws randomness; encryption would get all-zero IVs under this backend, so `Document::encrypt` must stay off the wasm path (or the backend must be wired to `crypto.getRandomValues`).

## 6. Exact gap: TS strip today versus Rust

Today:
- Browser: `stripPdfEncryption` runs at working-copy creation (`app/platform/browser-api/browserWorkingCopyService.ts:60-70`, `createBrowserDocumentsFileCapability.ts:718`). It handles `/R == 6` only (`app/utils/stripPdfEncryption.ts:340`), empty user password only (`157-172`, no owner branch), AES-256-CBC for every string and stream regardless of `/CF`, `/StmF`, `/StrF`, `Identity`, `EncryptMetadata` or `/Crypt` overrides (`174-193`, `201-283`), skips `/XRef` streams (`243-246`), requires WebCrypto (`308-310`), rewrites through pdf-lib (`317-320`, `369`), and returns the original bytes on any failure. Its one unit test covers a malformed `/Encrypt` ref (`tests/unit/app/utils/stripPdfEncryption.test.ts:13-20`).
- Electron: `qpdf --decrypt` with no `--password` (`electron/utils/decryptPdfFileIfNeeded.ts:53-60`); qpdf handles all standard revisions but only files openable without a password (`qpdf --help=--decrypt`, `--help=--password`).

Moving decryption into Rust (lopdf 0.44, full rewrite) adds:
- R2/R3/R4 (RC4 40-128 bit, AESV2) and R5, in the browser too.
- Correct crypt-filter dispatch, `Identity`, `EncryptMetadata=false`, per-stream `/Crypt`.
- User-supplied passwords: user password on all revisions; owner password on R5/R6.
- Explicit `InvalidPassword` failures instead of silent passthrough; a single implementation for Electron and browser.

Remaining gaps after the move:
- Owner-only password on R2-R4 (lopdf derives the wrong key; needs an Algorithm 7 key recovery patch, locally or upstream).
- Non-`Standard` security handlers (unsupported in both).
- Encrypted loads bypass the page-ops ObjStm admission filter (`reader.rs:864`) and stay bounded by `pdf-page-ops` load ceilings and wasm memory.
- The empty-password auto-decrypt plus incremental append hazard in item 4.
