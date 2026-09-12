# Project 6 #325 binary provenance and platform inventory

Status: partial #325 implementation and provenance evidence. The Windows x64 qpdf and Poppler archive/cache contracts are now represented in the runtime manifest and consumer, but this report does not claim platform runtime, signing, release, or #326 acceptance.

## Inspection boundary

I inspected the exact fetched source tree `441aec95e4a147e144e8f88098d9ded2bf3a78d7` with tree-aware Git commands. The task checkout was clean at pre-refresh report head `504157fc3c22be1d4762b522f89d6d103c82e7fe`; this refresh is read-only and its report commit will be a child of that head. I did not merge or rebase the newer main. The exact source tree does not contain this report path, so this branch preserves it as the owned preparatory artifact. The source delta from the report head is 260 paths, including the report deletion, annotation/UI/native changes, two project-owned WASM artifact changes, two annotation-font inputs, two third-party notice additions plus a notice update, the PDF.js provenance update, and five development-script changes. Counts, refs, ownership, and generated manifests may still drift after this inspection, so this report is a snapshot.

The inspection was read-only with respect to binaries and build inputs. I did not install dependencies, run Electron, run a VM, build, package, execute a third-party tool, download an archive, or change GitHub issue state.

## Findings at the inspected exact source SHA

### Tracked third-party resource families

The source manifest at scripts/nativeResourceManifest.ts:149-301 names four tracked third-party families and three global resource groups. The generated Rust tools and the macOS print helper are separate project-owned or generated inputs under .tmp, not third-party runtime families.

| Family | Tracked targets | Files | Bytes | Largest tracked file | Version/provenance evidence | Staging owner | Packaged consumer |
|---|---|---:|---:|---|---|---|---|
| Tesseract | darwin-arm64, linux-x64, win32-x64, plus tessdata | 314 runtime/model files | 728,198,853 | See split output below | Windows installer pin in scripts/bundle-tools-windows.sh:36-37,43; macOS Homebrew and Linux apt have no exact checked-in package identity; tessdata has a pinned ref and per-language SHA-256 in scripts/download-tessdata.sh:8-9,27-62 | scripts/bundle-tesseract-macos.sh, scripts/bundle-tools-linux.sh, scripts/bundle-tools-windows.sh; model refresh is scripts/download-tessdata.sh | tesseract/<platform>-<arch> and filtered tesseract/tessdata; unpaper is macOS/Linux only |
| Poppler | darwin-arm64, linux-x64, win32-x64 | 712 | 93,675,194 | See split output below | Windows x64 archive pin and member contract in scripts/runtimeBinaryManifest.ts; receipt at issuecomment-5599315468; macOS Homebrew and Linux apt have no exact checked-in package identity | scripts/bundle-pdf-tools-macos.sh, scripts/bundle-tools-linux.sh, scripts/bundle-tools-windows.sh | poppler/<platform>-<arch>, with target-specific binaries/data declared in scripts/nativeResourceManifest.ts:167-217 |
| qpdf | darwin-arm64, linux-x64, win32-x64 | 29 | 35,056,584 | See split output below | Windows x64 version/hash pin in scripts/runtimeBinaryManifest.ts:8-21; macOS Homebrew and Linux apt have no exact checked-in package identity | scripts/bundle-pdf-tools-macos.sh, scripts/bundle-tools-linux.sh, scripts/bundle-tools-windows.sh | qpdf/<platform>-<arch>/bin/qpdf |
| DjVuLibre | darwin-arm64, linux-x64, win32-x64 | 28 | 11,039,336 | See split output below | Windows installer/version/hash pin in scripts/bundle-tools-windows.sh:41-45; macOS Homebrew and Linux apt have no exact checked-in package identity | scripts/bundle-djvu-macos.sh, scripts/bundle-tools-linux.sh, scripts/bundle-tools-windows.sh | djvulibre/<platform>-<arch>, with ddjvu, djvused, and djvudump |

The family rows deliberately do not invent totals by hand. The reproducible split output below is authoritative.

#### Reproducible split statistics

This exact-tree command reads Git tree metadata only. It does not materialize or execute any binary.

~~~sh
source_sha=441aec95e4a147e144e8f88098d9ded2bf3a78d7
for family in djvulibre poppler qpdf tesseract; do
  for platform in darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64 win32-arm64; do
    git ls-tree -r -l "$source_sha" -- "resources/$family/$platform" |
      awk -v family="$family" -v platform="$platform" '
        {count++; bytes += $4; if ($4 > largest) {largest = $4; path = $5}}
        END {if (count) printf "%s %s %d %d %d %s\n", family, platform, count, bytes, largest, path}'
  done
done
~~~

Output:

~~~text
family platform count bytes largest
djvulibre darwin-arm64 8 3555280 1329360 resources/djvulibre/darwin-arm64/lib/libdjvulibre.21.dylib
djvulibre linux-x64 14 5644440 1876840 resources/djvulibre/linux-x64/lib/libdjvulibre.so.21
djvulibre win32-x64 6 1839616 1133056 resources/djvulibre/win32-x64/bin/libdjvulibre.dll
poppler darwin-arm64 27 14644608 3419584 resources/poppler/darwin-arm64/lib/libpoppler.157.0.0.dylib
poppler linux-x64 384 41478546 5465952 resources/poppler/linux-x64/lib/libcrypto.so.3
poppler win32-x64 301 37552040 7416832 resources/poppler/win32-x64/bin/libcrypto-3-x64.dll
qpdf darwin-arm64 6 16143344 4843760 resources/qpdf/darwin-arm64/lib/libcrypto.3.dylib
qpdf linux-x64 13 10369488 2537224 resources/qpdf/linux-x64/lib/libqpdf.so.29
qpdf win32-x64 10 8543752 7069184 resources/qpdf/win32-x64/bin/qpdf30.dll
tesseract darwin-arm64 76 67971760 10135968 resources/tesseract/darwin-arm64/lib/libavcodec.62.dylib
tesseract linux-x64 150 179240040 30800280 resources/tesseract/linux-x64/lib/libicudata.so.74
tesseract win32-x64 58 167527559 101471336 resources/tesseract/win32-x64/bin/libtesseract-5.dll
~~~

Additional tracked groups:

| Group | Files | Bytes | Largest file |
|---|---:|---:|---|
| resources/tesseract/tessdata | 30 | 313,459,494 | eng.traineddata, 15,400,601 bytes |
| resources/third-party-notices | 6 | 76,099 | GPL-3.0.txt, 35,149 bytes |
| icons and ICONS.md | 7 | 422,461 | resources/icon.icns, 217,797 bytes |
| all tracked resources | 1,096 | 868,468,527 | resources/tesseract/win32-x64/bin/libtesseract-5.dll, 101,471,336 bytes |

The exact all-resource command against the inspected tree was:

~~~sh
source_sha=441aec95e4a147e144e8f88098d9ded2bf3a78d7
git ls-tree -r -l "$source_sha" -- resources |
  awk '{bytes+=$4; count++} END{print "count="count, "bytes="bytes}'
~~~

It returned count=1094 bytes=868458683 for the pre-refresh checkout. The exact source tree returned 1,096 tracked resource paths and 868,468,527 bytes with the tree-aware command below. The two added notice/license files are outside the four native family totals.

The exact source changes two tracked project-owned WASM packaging inputs outside the third-party resource totals:

| Artifact | Previous bytes and blob | Current bytes and blob | Current consumers |
|---|---:|---:|---|
| public/wasm/evb-pdf-image-combine.wasm | 1,195,035, `97c81787b1b00158e8099804107d458ddf2acbd2` | 1,195,639, `05d4fc8054f5b947aca9e31d139334eebb8d00ec` | app browser WASM adapter and scripts/wasm-artifacts.mjs |
| public/wasm/evb-pdf-page-ops.wasm | 1,697,192, `5a6c1b0656e1cd563744b683bbf1475de1124f6e` | 1,705,434, `b4c05105255c83edf6da39eb0608b5288248589c` | app browser WASM adapter and scripts/wasm-artifacts.mjs |

These are generated project-owned artifacts, not third-party runtime families. Their current sizes and blob IDs are evidence only. #325/#324 must keep their source crate, target, required exports, freshness check, and staged/public hash receipt separate from the four native-tool provenance records.

The exact source also adds a tracked DejaVu Sans 2.37 annotation font, `public/fonts/annotation/DejaVuSans.ttf` at 757,076 bytes, with `public/fonts/annotation/LICENSE.txt` at 8,815 bytes. The browser annotation CSS loads the font and `native/pdf-page-ops/src/text_box_font.rs` embeds the same bytes in the native writer. The new `resources/third-party-notices/DejaVu-source.txt` and `resources/third-party-notices/licenses/DejaVu.txt` identify the source and license, but they do not establish a cryptographic upstream archive receipt. This is a third-party runtime/package input outside the four native-tool resource families and must be included in the final asset/provenance review.

The exact vendor-input command against the inspected tree was:

~~~sh
source_sha=441aec95e4a147e144e8f88098d9ded2bf3a78d7
git ls-tree -r -l "$source_sha" -- vendor |
  awk '{bytes+=$4; count++; if ($4 > largest) {largest=$4; file=$5}} END{print "count="count, "bytes="bytes, "largest="largest, file}'
~~~

It returned `count=6 bytes=17666641 largest=9022875 vendor/pdfjs-dist/pdfjs-dist-5.7.304-f029c046.tgz`.

The exact source adds the two DejaVu notice/license files above and changes `vendor/pdfjs-dist/provenance.json` without changing the six-file, 17,666,641-byte vendor total. The largest vendor file remains `pdfjs-dist-5.7.304-f029c046.tgz` at 9,022,875 bytes. That 5.7.304 file is a retained historical artifact. The active root dependency is `file:vendor/pdfjs-dist/pdfjs-dist-6.3.311-6922bee2.tgz`, and the preview alias remains `npm:pdfjs-dist@5.4.296`. The 6.3.311 receipt records fork commit `6922bee2b3dd047c954d5717a533a2d701559c17`, fork tree `0fc8b8db395e8ab30ddec61a78bb9ad72d82512b`, upstream tag `v6.3.289`, upstream commit `1c8020a7d4e43668ac287a3ecf9a8dbea17e4c56`, archive SHA-256 `f1db91efda7463d099e238acc296a78e2dc66889660190136ba5c44a8536f00a`, and manifest SHA-256 `7d3fdea389cf22fe6cba49615f0cf583c22b771b34c261a41fc4b797925664cc`. The current verifier source hash is `02d481b5ef7e81da585d336745d85eea69f8f543329ed4f1c266d7eb2809dd22`. `scripts/verify-pdfjs-provenance.mjs` now separates GNU and BSD tar listing grammars while checking those fields, archive safety, the sorted file manifest, required fork markers, and the installed package. This is stronger source evidence than the native-tool rows, but it is a PDF.js packaging input, not one of the four native runtime families.

### Platform, architecture, Store, and legacy targets

The source matrix declares six tags at scripts/nativeResourceManifest.ts:99-106.

| Target | Tracked resources now | Current consumer | Store versus legacy | Missing evidence |
|---|---|---|---|---|
| macOS arm64 | All four families present | macos-14, mac/arm64, dist-mac-arm64 | Direct-download core | Exact Homebrew formula versions, source commits, bottle URLs/digests, and package receipt |
| macOS x64 | All four families missing | .github/workflows/build-mac-intel.yml | Direct-download supplemental | CI can generate it, but this SHA has no tracked Intel resource set or input receipt |
| Linux x64 | All four families present | ubuntu-22.04, linux/x64, dist-linux-x64 | Direct-download AppImage/DEB | Exact apt versions, package repositories, package hashes, and source package identity |
| Linux arm64 | All four families missing | ubuntu-24.04-arm, linux/arm64, dist-linux-arm64 | Direct-download AppImage/DEB | CI generation is expected, but no tracked output or package receipt exists |
| Windows x64 | All four families present | windows-2022, dist-win-x64, plus the Windows 7 lane | Direct-download current target; Windows 7 is optional legacy | Archive pins exist, but no durable receipt ties each extracted resource file to its archive |
| Windows arm64 | All four families missing | Store windows-11-arm and supplemental direct-download lane | Store plus direct-download supplemental | MSYS2 CLANGARM64 is selected in CI, but no tracked ARM64 resource set or per-file receipt exists |

The core matrix is .github/workflows/build.yml:59-78. The final release orchestration also names supplemental macOS x64, Windows arm64, Windows 7 legacy x64, and Store x64/arm64 jobs in .github/workflows/release-artifacts.yml:231-350 and .github/workflows/release-supplemental.yml:196-263. Store covers x64 and arm64 at .github/workflows/store-appx.yml:40-59 and invokes the Windows bundler at lines 79-83. The legacy lane pins Electron 22 and remains optional at .github/workflows/build-win7-legacy.yml:21-31. The direct Windows workflow records app provenance only after packaging at .github/workflows/build-target.yml:336-347. Store records its own Store provenance at .github/workflows/store-appx.yml:201-209. The exact-main hosted run `34100658659` is green as supplied for this refresh; no hosted run was started locally.

The Store workflow writes two release-root patterns, `release/*-store.appx` and `release/*-store-*-provenance.json` (`.github/workflows/store-appx.yml:281-284`). Both are covered by the root `/release/` ignore rule at `.gitignore:11`. The extracted package and app payload use `.tmp/store-appx-${arch}/...` (`.github/workflows/store-appx.yml:114,197-209`), which is ignored under `.tmp/` and is reported by `git check-ignore` through the `*.tmp` rule at `.gitignore:56`. The downloaded smoke artifact uses `store-artifacts/store-appx-win-${arch}/...` (`.github/workflows/store-appx.yml:317-325`), and that path is not ignored by this checkout. Bare root paths such as `store-appx-x64/...` and `store-appx*` are also not ignored. #325 must test and preserve these exact distinctions. A root prefix that merely contains `store-appx` is not an ignore contract.

These application receipts do not prove which upstream Poppler, qpdf, Tesseract, DjVuLibre, Homebrew, apt, or MSYS2 inputs produced a resource file. The PDF.js receipt proves the recorded fork/archive relationship only when its verifier passes. It does not supply native-tool receipts.

The manifest preserves target-specific packaging. Tesseract's unpaper is not bundled on Windows, Poppler's pdftocairo is Windows-only, and Poppler data/font paths are platform-specific, as declared at scripts/nativeResourceManifest.ts:151-212.

### Current packaged consumers

The generated Electron Builder plan stages tesseract/tessdata, icon.png, third-party-notices, then family roots under tesseract, poppler, qpdf, djvulibre, pdf-print-dialog, and generated Rust tool names. The source of truth is scripts/nativeResourceManifest.ts:149-301; the plan is generated by scripts/generateElectronBuilderResources.ts.

Runtime consumers are:

- Tesseract and unpaper: electron/ocr/, especially electron/ocr/nativeToolPaths.ts, electron/ocr/buildTesseractEnv.ts, and electron/ocr/worker/tryPreprocessOcrImage.ts.
- Poppler: electron/pdf/, electron/native-tools/buildPopplerEnv.ts, and electron/ocr/worker/popplerStage.ts.
- qpdf: native PDF combine and decryption paths under electron/pdf/ and electron/image/.
- DjVuLibre: electron/features/djvu/, with electron/features/djvu/main/nativeToolPaths.ts resolving its packaged binaries.
- Generated project-owned tools: .tmp/<staging-name>/<platform>-<arch>/bin/<binary>, described by packages/contracts/nativeToolProtocols.ts and the generated resource manifest. These are not third-party binaries and need a separate crate, target, protocol, and build receipt.

### Provenance status by family

| Family | Present evidence | Missing before upstream identity can be selected |
|---|---|---|
| Tesseract executable | Windows release installer name, tag, and SHA-256; macOS/Linux bundler source commands | Exact macOS Homebrew formula/bottle identity; exact Linux apt package/version/source; per-file mapping from archive/package to staged files |
| Tesseract tessdata | Pinned tessdata_best commit and per-language SHA-256 | A receipt connecting each tracked model to the inspected commit and the manifest entry used to package it |
| Poppler | Windows x64 publisher/release identity, archive size and SHA-256 receipt, five executable members, 26 DLL members, and 272 data members; the runtime manifest validates the pinned archive and required staging members | Build-origin and reproducible-build evidence, Windows runtime/loading and staging acceptance, exact macOS Homebrew and Linux apt identities, and ARM64 evidence |
| qpdf | Windows x64 version and archive SHA-256 in scripts/runtimeBinaryManifest.ts:8-21 | Same missing publisher, archive, package, and target receipt fields for macOS/Linux/ARM64 |
| DjVuLibre | Windows installer/version and SHA-256 | Same missing fields for macOS/Linux/ARM64; exact build/source identity |
| Generated Rust tools | Crate name, binary name, staging name, and protocol version in packages/contracts/nativeToolProtocols.ts | Build target, compiler/toolchain receipt, source commit, input lock identity, and staged-file hash receipt |

Do not select a release asset from a directory name, filename, license notice, or checksum alone. A checksum proves bytes against the thing it was compared with. It does not prove that the thing was the intended upstream release.

## Existing acquisition, cache, checksum, and verification mechanisms

### Third-party resources

scripts/bundle-tools-windows.sh remains the acquisition entry point for Tesseract and DjVuLibre. The qpdf and Poppler x64 identities now live in scripts/runtimeBinaryManifest.ts, and scripts/runRuntimeBinaryArchiveCli.ts verifies each manifest entry before staging. The shared cache helper checks a warm cache, downloads into a uniquely owned partial path, verifies length and SHA-256 before promotion, and removes failed partials. The Poppler consumer copies only validator-returned executables and DLLs, requires the manifest's data directory, and leaves font configuration optional because the receipt contains no font members. Durable input receipts and upstream identity for the remaining archives are still missing.

actions/cache owns the Windows archive cache in .github/actions/setup-release-env/action.yml:75-88. The current key includes the `bundle-tools-windows.sh` and `runtimeBinaryManifest.ts` hashes plus the architecture prefix. A future manifest entry or pin change therefore invalidates the warm key. #325 must keep the target and machine-readable manifest identity in the cache key. A cache-service failure falls through to pinned download. Cache is an accelerator, not provenance. A warm cache with wrong bytes must fail.

scripts/download-tessdata.sh pins tessdata_best commit e12c65a915945e4c28e237a9b52bc4a8f39a0cec, derives language names and expected hashes from the repository registry, validates an existing file before reuse, and validates size and SHA-256 after download at lines 8-9 and 13-64. This is model provenance, not Tesseract executable provenance.

The macOS bundlers copy from Homebrew. They relocate dynamic-library closures but do not pin a formula version, bottle URL, bottle digest, or Homebrew lock receipt in this source. The macOS unpaper script pins source tag unpaper-7.0.0 and commit 5211a623d48858eae154213a61bccbc368b19ca0, but local Homebrew and FFmpeg inputs remain outside a complete receipt.

The Linux bundler installs tesseract-ocr, poppler-utils, qpdf, and djvulibre-bin with apt and copies dependency closures at scripts/bundle-tools-linux.sh:54-90. The workflow pins the Linux container image digest at .github/workflows/build-target.yml:149-156, but apt package versions, repository snapshots, package hashes, and source-package identities are not recorded.

resources/third-party-notices/THIRD-PARTY-NOTICES.md records upstream names and licenses. It does not identify exact release, archive, package, commit, builder environment, or byte hash. A license notice is not provenance.

The inspected tree contains `vendor/pdfjs-dist/provenance.json`, two sorted archive manifests, and `scripts/verify-pdfjs-provenance.mjs`. `package.json` and `pnpm-lock.yaml` pin the active PDF.js dependency to the local 6.3.311 archive and its SRI. It also adds `scripts/ensure-pdfjs-dev-install.mjs`, which reads the local archive version, installed package version, and `public/pdf/.pdfjs-version`, then can invoke `pnpm install --frozen-lockfile` when they differ. Runtime code checks the same stamp and classifies a vendored asset mismatch through `app/utils/isPdfjsAssetVersionMismatch.ts`. These are development/runtime consistency mechanisms, not native-tool provenance or permission to install dependencies in this task. They are useful bounded models for #325/#324 replacement receipts, but #325 must not generalize them into an agent-specific runtime registry or treat PDF.js evidence as proof for the native families.

### Packaged application and release evidence

scripts/release/build-provenance.mjs records Git SHA, app version, architecture, channel, app.asar SHA-256, complete packaged payload file hashes, payload size/count, and lockfile hash. Direct Windows and Store workflows each emit a receipt, but this repository does not invoke `assert-match` to compare those receipts. Direct-versus-Store parity remains pending #325/#326 acceptance. Receipt creation proves application-payload identity for each lane. It does not prove upstream native-tool identity.

scripts/release/release-checksums.mjs creates and verifies release-level SHA256SUMS. .github/workflows/publish-chain.yml:77-100 generates, verifies, publishes, and attests final release assets. Those hashes cover release artifacts and provenance documents, not uncompressed upstream input archives unless a future receipt includes them.

scripts/verify-packaged-native-tools.sh, scripts/release/assert-packaged-app-contents.mjs, and packaged smoke scripts verify paths and behavior. A passing smoke proves that the packaged consumer can run. It does not establish upstream identity.

### Codex CLI mechanism, kept separate

The repository has a relevant but separate pinned-download design for the managed Codex CLI. docs/architecture/adr/0004-assistant-is-optional-with-provider-adapters.md:36-39 requires an artifact manifest, publisher URL, redirects, archive size, and SHA-256 checks. electron/features/agent/codexCli.ts:416-459 downloads to a temporary path, verifies it, extracts only the expected executable, rejects symlinks, and stages atomically. docs/architecture/mcp.md:51-58 identifies the discovery, managed-install, and runtime owners.

For #325, this is a pattern for manifest, fetch, cache, and error semantics. It is not a reason to make native runtime tools agent-specific.

## Required #325 test matrix

Tests should use fixtures or mocked transport and must not require a live third-party download.

| Case | Required assertion |
|---|---|
| Fresh cache | Verify publisher/URL/redirect policy, release or package identity, archive size, SHA-256, extraction root, and target architecture before staging |
| Warm cache | Revalidate the cached archive; cache hit must not bypass identity or checksum |
| Corrupted cache | Refuse the cache and recover through the approved fetch path without writing unverified resources |
| Missing checksum | Fail closed before network or staging and name family, target, asset, and missing field |
| Checksum mismatch | Refuse and remove or quarantine only the owned partial/cache file |
| Unavailable download | Surface source, target, retry exhaustion, and cache state without silently using ambient binaries |
| Offline | Valid warm cache can proceed after revalidation; cold or invalid cache reports bounded unavailable state |
| Manifest-hash invalidation | The qpdf manifest key and filename bind the cache to the manifest identity; remaining families still need the same proof. For each remaining machine-readable manifest, prove the cache key changes and a warm entry from its old manifest cannot be reused |
| Indirect Windows consumption | Exercise build-target.yml, store-appx.yml, supplemental ARM64, and Windows 7 legacy callers, including architecture cache keys, MSYS2, staging, and packaged verification |
| Redirect or publisher drift | Reject unexpected redirect/publisher or record the approved redirect chain |
| Partial archive | Resume only an owned .part file and hash the complete file |
| Cross-target collision | Prove x64 and arm64 cache keys and staging paths cannot cross-consume |

Cover all six tags, all four tracked families, Store and direct Windows, macOS Intel generation, Linux ARM64 generation, and the optional Windows 7 lane. Missing local resource directories are expected CI-generation inputs and must remain visible as missing evidence.

## Owners and reserved paths

These are source-level owners and handoff boundaries observed in exact source `441aec95e4a147e144e8f88098d9ded2bf3a78d7`. Person-level ownership is not asserted where the checkout cannot prove it. Project 4 has merged and released its reservations; the rows below identify the files #325 must coordinate with, not active Project 4 locks. Recheck live writers before implementation.

| Area | Current owner or reservation | Owned or reserved paths | Integration note |
|---|---|---|---|
| Resource manifest | Packaging/resource manifest owner | scripts/nativeResourceManifest.ts, scripts/generateElectronBuilderResources.ts, .tmp/generated-electron-builder-resources.yml | Shared with packaging and workflows; exact source still needs a #325 manifest decision |
| Fetch and cache | Native bundler owner | scripts/bundle-tools-windows.sh, scripts/bundle-tools-linux.sh, scripts/bundle-*.sh, scripts/download-tessdata.sh, scripts/sha256-file.sh, .github/actions/setup-release-env/action.yml | Project 4 reservation released; #325 implementation must preserve cache ownership and add receipts |
| Staging | Build/native staging owner | scripts/build-native-tool.mjs, scripts/cargo-artifacts.mjs, .tmp/<tool>/<platform>-<arch>/, resources/<family>/<platform>-<arch>/ | .tmp is generated; tracked resources were protected |
| Packaging | Electron Builder packaging owner | package.json, pnpm-lock.yaml, vendor/pdfjs-dist/, generated Electron Builder config, scripts/generateElectronBuilderResources.ts, .github/workflows/build-target.yml, .github/workflows/store-appx.yml | Project 4 reservation released; PDF.js now has a separate checked-in provenance path |
| PDF.js development/runtime consistency | Development and PDF.js runtime owners | scripts/ensure-pdfjs-dev-install.mjs, scripts/electron-run/electronRunNuxtServer.ts, scripts/pdfjsDevInstallTypes.d.ts, app/utils/isPdfjsAssetVersionMismatch.ts, app/services/pdfjs/runtimeLib.ts, app/modules/workspace-shell/useWorkspaceOrchestration.ts, public/pdf/.pdfjs-version, node_modules/pdfjs-dist/ | Exact source checks archive, installed, and public versions, then classifies a stamp mismatch; it may request a frozen install on development mismatch |
| Project-owned WASM inputs | Native/WASM artifact owner | public/wasm/evb-pdf-image-combine.wasm, public/wasm/evb-pdf-page-ops.wasm, scripts/wasm-artifacts.mjs, scripts/check-wasm-freshness.mjs, scripts/pre-push-gate.mjs, native/pdf-image-combine/, native/pdf-page-ops/ | Current source changed both public WASM files; recheck source commit, target, exports, freshness, and public hash receipt after final integration |
| DejaVu annotation font | Annotation UI/native writer owner | public/fonts/annotation/DejaVuSans.ttf, public/fonts/annotation/LICENSE.txt, native/pdf-page-ops/src/text_box_font.rs, app/assets/css/pdf-viewer.scss, resources/third-party-notices/DejaVu-source.txt, resources/third-party-notices/licenses/DejaVu.txt | Current source adds the 757,076-byte font and 8,815-byte license; recheck browser/native consumers and upstream font receipt |
| Release verification | Release verification owner | scripts/verify-packaged-native-tools.sh, scripts/release/build-provenance.mjs, scripts/release/release-checksums.mjs, scripts/release/assert-packaged-*, .github/workflows/release*.yml, .github/workflows/publish-chain.yml | Add new checks without replacing current gates |
| Windows VM/Store | Windows acceptance owner | scripts/windows-test/, .github/workflows/store-appx.yml, VM leases and test processes outside this checkout | Project 4 reservation released; no VM was started in this task |
| Workflows | CI/release workflow owner | .github/workflows/build*.yml, .github/workflows/ci.yml, .github/workflows/release*.yml, .github/actions/setup-release-env/action.yml | Project 4 reservation released; #325 must coordinate changes here with the integrator |
| Documentation | This assignment | docs/internal/project6-325-binary-provenance-platform-inventory.md | Only file this assignment may change |
| #325 task ownership | No active T3 #325 owner found | Historical lane-288-packaged-smoke and related mappings are deleted; PR #289 is merged | Historical evidence, not an active reservation |
| Project 4 | Released integration reservation | Exact source `441aec95e4a147e144e8f88098d9ded2bf3a78d7`; prior hosted run `34100658659` belongs to an older evidence boundary | Historical ownership signal only; no current hosted acceptance is claimed |

## PR #349 overlap and final Project 4 state

The earlier public [PR #349 changed-file list](https://github.com/evb0110/evb-viewer/pull/349/files) reported head SHA bea27ef44334a2207e994876a272c49b06955671, base own-annotations, 148 commits, and 1,729 changed files. Its workflow list included:

~~~text
.github/workflows/build-mac-intel.yml
.github/workflows/build-target.yml
.github/workflows/build-win7-legacy.yml
.github/workflows/build.yml
.github/workflows/ci.yml
.github/workflows/release-artifacts.yml
.github/workflows/release-drill.yml
.github/workflows/release-supplemental.yml
.github/workflows/release.yml
.github/workflows/store-appx.yml
~~~

That list did not include resources/, scripts/bundle-tools-*, scripts/download-tessdata.sh, or the native resource manifest. The overlap was material because the workflows consume bundlers, stage payloads, build Store AppX, and publish release evidence. Exact source `441aec95e4a147e144e8f88098d9ded2bf3a78d7` leaves those fetch, workflow, Store, release, and Windows VM paths unchanged from the report head, but adds DejaVu annotation font and notice inputs, changes the PDF.js provenance metadata/verifier, and changes project-owned WASM and annotation/native source. Those are separate #324/#325 recheck inputs. The unpublished candidate `8b8daf216328931576328fd47ed7f8745e27b6ff` and PR head are historical moving signals, not current implementation bases. Project 4 released its reservations before this refresh.

## Bounded handoff

### #325 implementation handoff

1. The qpdf Windows x64 entry and its manifest-bound fetch/cache path are implemented and tested. Add machine-readable entries for each remaining third-party family and target. Include upstream identity, publisher/source URL, redirect policy, release or package identity, archive size, SHA-256, extraction rules, architecture, and direct-download/Store/legacy classification.
2. The qpdf path covers fresh, warm, corrupt, missing-checksum, mismatch, unavailable, offline, partial, redirect-drift, and cross-target behavior. Extend those fetch/cache cases to the remaining entries, key CI fetch caches by each machine-readable manifest hash and target, then revalidate every cached archive. Reuse the Windows and Codex patterns without making the runtime registry agent-specific.
3. Add receipts tying verified input archive/package identity to the staged resource set and target. Keep application provenance and upstream provenance separate.
4. Add fixture/mock tests for the matrix above, including indirect Windows workflow and Store calls.
5. Add credential-safe read-only commands for tracked files, bytes, largest files, hashes, target classification, staging paths, and Store AppX ignore status. No download or third-party execution.
6. Remove tracked third-party runtime files only after the verified replacement path is ready, and only with release-verification and Windows-VM cache acceptance. That removal is part of the implementation handoff, not permission to perform it in this inventory task. This task leaves all tracked runtime files untouched.
7. Add the exact `.gitignore` acceptance and regression test. Keep `release/*-store.appx`, `release/*-store-*-provenance.json`, and `.tmp/store-appx-${arch}/...` ignored. Cover the currently unignored `store-artifacts/store-appx-win-${arch}/...` and bare root `store-appx*` paths without weakening the existing rules.

For the #324/#326 replacement-source contract, the source manifest must name the upstream publisher, stable source/release identity, URL and redirect policy, target architecture, archive/package hash, extraction boundary, and staged-file receipt. Fetch/cache must key by the manifest hash and target, revalidate warm entries, fail closed on unavailable or offline invalid inputs, and never fall back to ambient binaries. The current role owners are the manifest/resource owner, native fetch/cache owner, staging owner, packaging/release-verification owner, and Windows VM/Store acceptance owner listed above. No named #324 reservation is proven by this source; the integrator must recheck ownership after the final Project 4/native merge.

Project 4 has released its reservation, but #325 still needs a fresh writer/process check immediately before editing overlapping files. This inventory task leaves every runtime resource and packaging input untouched.

### #326 delivery and documentation handoff

After #325 passes local tests and hosted platform evidence, document the manifest schema, cache ownership, receipt format, offline behavior, quarantine policy, and operator commands. Repository guidance must link the settled no-history-rewrite decision. It must say that reducing current-tree or build-time downloads does not rewrite historical Git pack storage, which remains unchanged unless a separate history-rewrite decision is made. Attach exact-SHA evidence for core targets, macOS Intel, Windows Store x64/arm64, Windows direct x64/arm64, and the optional legacy lane. Keep upstream provenance separate from release SHA256SUMS, app payload provenance, and license notices.

## Project 4 release record

The source handoff inspected here is exact object `441aec95e4a147e144e8f88098d9ded2bf3a78d7`. It is not an ancestor of this report branch, so the task used tree-aware reads and did not merge it. The source diff from report head changed 260 paths. It changed the tracked DejaVu annotation font and notices, PDF.js provenance metadata/verifier, two project-owned public WASM artifacts, and related annotation/native/UI paths, but not the fetch/cache, workflow, manifest, release, Store, or platform-acceptance paths covered by this inventory. Project 4 released its reservations before this refresh. No current hosted acceptance is claimed for this newer SHA.

## Post-Project-4 recheck list

- [x] Confirm exact source `441aec95e4a147e144e8f88098d9ded2bf3a78d7`, clean pre-refresh report head `504157fc3c22be1d4762b522f89d6d103c82e7fe`, tree-aware read-only inspection, and released Project 4 reservation.
- [x] Re-run tracked counts, byte totals, per-family/per-target counts, largest files, target-directory presence, project-owned WASM identities, and annotation-font inputs. Native resources are 1,096 files and 868,468,527 bytes, including the two new notice/license files. Vendor PDF.js remains six files and 17,666,641 bytes; both public WASM artifacts and the annotation font are recorded above.
- [x] Re-read the manifest, package configuration, bundlers, workflows, Store consumer, release verification, and PDF.js provenance/dev-install/runtime mechanisms. Exact source adds no native-tool receipt and no fetch, workflow, manifest, or platform-acceptance drift, but it changes tracked packaging/runtime inputs, the PDF.js verifier/provenance metadata, and DejaVu font evidence.
- [x] Re-check all six tags, including macOS x64, Linux arm64, and Windows arm64. Tracked native resources remain absent for the three supplemental targets; release workflows generate supplemental macOS x64 and Windows arm64, Store covers Windows x64/arm64, and Windows 7 remains optional legacy x64.
- [ ] Obtain upstream version, publisher, URL, redirect, archive-size, package, source-commit, and SHA-256 evidence for every native family and target. Presence, filename, license notice, and release checksum do not satisfy this.
- [ ] Implement and run fresh-cache, warm-cache, corrupted-cache, missing-checksum, mismatch, unavailable, offline, partial, redirect-drift, and cross-target tests in #325.
- [ ] Re-check indirect Windows consumption through build-target.yml, Store AppX, supplemental ARM64, and Windows 7 legacy after #325 changes. Confirm no wrong-architecture or unverified cache entry can be consumed.
- [ ] Re-check direct-download and Store payload provenance parity, then separately verify upstream native-input receipts.
- [ ] After the final Project 4/native integration commit, re-read the exact manifest, fetch/cache keys, staging roots, packaging consumers, project-owned WASM inputs, release verification, Store/Windows VM acceptance, and ownership state. Re-run all counts, hashes, and target checks against that final SHA.
- [x] Reconcile the historical PR #349 head and candidate `8b8daf216328931576328fd47ed7f8745e27b6ff` against the exact source. They are historical signals; no newer Project 4 candidate is selected here.
- [x] Reconfirm `.gitignore` behavior for exact Store paths. `release/*-store.appx`, `release/*-store-*-provenance.json`, and `.tmp/store-appx-${arch}/...` are ignored. `store-artifacts/store-appx-win-${arch}/...` and bare root `store-appx*` are not ignored. No tracked release/AppX/provenance artifact was found.
- [x] Check Markdown tooling and run `git diff --check` after the report refresh. No Markdown checker is installed; `git diff --check` passed. The final diff is report-only before commit.

## Evidence commands and limitations

Successful read-only commands included:

~~~sh
git status --short --branch
git rev-parse HEAD
git diff --quiet
~~~

The task branch was clean at pre-refresh report head `504157fc3c22be1d4762b522f89d6d103c82e7fe`. The exact source object was read directly as `441aec95e4a147e144e8f88098d9ded2bf3a78d7`; it was not merged or used to rewrite this artifact branch. This report-only refresh is a child of the pre-refresh head, whose new SHA is returned with this report.

`git rev-parse --git-common-dir` returned `/Users/evb/WebstormProjects/evb-viewer/.git`, and `git status --short --branch` remained clean in this linked task worktree. No primary checkout was opened or modified.

The statistics command returned the exact counts recorded above. The target presence command returned:

~~~text
darwin-x64 tesseract=missing poppler=missing qpdf=missing djvulibre=missing
darwin-arm64 tesseract=present poppler=present qpdf=present djvulibre=present
linux-x64 tesseract=present poppler=present qpdf=present djvulibre=present
linux-arm64 tesseract=missing poppler=missing qpdf=missing djvulibre=missing
win32-x64 tesseract=present poppler=present qpdf=present djvulibre=present
win32-arm64 tesseract=missing poppler=missing qpdf=missing djvulibre=missing
~~~

The exact-tree equivalence command was:

~~~sh
for p in resources vendor .github/workflows .github/actions \
  scripts/bundle-tools-windows.sh scripts/bundle-tools-linux.sh \
  scripts/nativeResourceManifest.ts package.json pnpm-lock.yaml .gitignore \
  public/fonts/annotation public/wasm; do
  git diff --quiet 441aec95e4a147e144e8f88098d9ded2bf3a78d7 HEAD -- "$p" \
    && echo "UNCHANGED $p" || echo "CHANGED $p"
done
git ls-tree -r --name-only 441aec95e4a147e144e8f88098d9ded2bf3a78d7 -- resources | wc -l
git ls-tree -r --name-only 441aec95e4a147e144e8f88098d9ded2bf3a78d7 -- vendor | wc -l
git diff --name-only HEAD 441aec95e4a147e144e8f88098d9ded2bf3a78d7 | wc -l
~~~

It reported `CHANGED resources`, `CHANGED vendor`, `CHANGED public/fonts/annotation`, and `CHANGED public/wasm`; the workflow, bundler, manifest, package, lockfile, and `.gitignore` paths were `UNCHANGED`. It returned 1,096 resource paths, 6 vendor paths, and 260 source-delta paths. The exact source has no report path. `.gitignore` is identical to the exact source, so the recorded Store ignore results remain applicable.

The exact `.gitignore` evidence command was read-only:

~~~sh
for p in \
  release/EVB-Viewer-0.0.0-store-x64.appx \
  release/EVB-Viewer-0.0.0-store-arm64.appx \
  release/EVB-Viewer-0.0.0-store-x64-provenance.json \
  .tmp/store-appx-x64/app/resources/app.asar \
  store-artifacts/store-appx-win-x64/EVB-Viewer-0.0.0-store-x64.appx \
  store-appx-x64/app/resources/app.asar \
  store-appx-x64; do
  if git check-ignore -v -- "$p"; then :; else echo "NOT_IGNORED $p"; fi
done
~~~

It returned:

~~~text
.gitignore:11:/release/  release/EVB-Viewer-0.0.0-store-x64.appx
.gitignore:11:/release/  release/EVB-Viewer-0.0.0-store-arm64.appx
.gitignore:11:/release/  release/EVB-Viewer-0.0.0-store-x64-provenance.json
.gitignore:56:*.tmp  .tmp/store-appx-x64/app/resources/app.asar
NOT_IGNORED store-artifacts/store-appx-win-x64/EVB-Viewer-0.0.0-store-x64.appx
NOT_IGNORED store-appx-x64/app/resources/app.asar
NOT_IGNORED store-appx-x64
~~~

The TypeScript manifest CLI was attempted but could not run because this isolated checkout has no installed tsx package. I did not install dependencies because the task excludes dependency installation. Static manifest inspection and shell-only Git/filesystem commands were used instead. Generated-manifest rendering and executable source-matrix validation remain post-Project-4 checks, not claimed passing evidence.

No `markdownlint` or `markdownlint-cli2` executable was installed, and `package.json` has no Markdown-check script. `git diff --check` passed for the report refresh. No build, package, Electron, VM, release, or third-party binary command was run.

The checkout was clean before the refresh, and exact source object `441aec95e4a147e144e8f88098d9ded2bf3a78d7` was inspected without merging, rebasing, or rewriting history. The report-only refresh commit and post-commit status must be recorded after Markdown checks and `git diff --check` pass.
