<!-- Provenance: copied verbatim from .devkit/analysis/scan-cleanup-audit-2026-08-14/COMPLETENESS-CRITIC.md (untracked working artifact), produced 2026-08-14. -->
<!-- Tracked here so the closure numbers this audit reports can be recomputed and re-read from a clone; the body below is unmodified. -->

# Completeness critic — gaps between the six lenses

Six lenses covered the algorithms, the protocol, the preview/final seam, renderer state, oracles, and process — but nobody owned the two boundaries where scan cleanup meets the rest of the world: the shipped artifact and the user's filesystem. The packaged `evb-scan-cleanup` binary is executed by verification on exactly one of five shipped platform-arches (macOS arm64), the only end-to-end packaged behavioural verifier has no CI caller and is gated on an untracked `.devkit` fixture, and the cleaned document — the entire point of the feature — lives only in the OS temp directory, is deliberately excluded from Recent Files, and is pruned by both the app and the OS regardless of continued use. Two smaller gaps: OCR silently shares this binary and its default options with no OCR-side oracle while R11/R13 binarization tuning is in flight, and the binding design charter is `.gitignore`-blocked from ever being committed.

## Structural assessment

Inside the feature, ownership is genuinely good: the output publish path is properly atomic (stage → qpdf validate → copy to dot-prefixed temp in the destination dir → rename, `scan-cleanup-core/runScanCleanupConversion.ts:515-520,1771-1775`), `assertScanCleanupPathWithinRoot` is wired at every manifest path, the scratch sweeper's live-owner guard does protect a real pid-suffixed root (`RAW_RASTER_RETENTION_PREFIX = 'scan-cleanup-rasters-'`, `createScanCleanupPreviewService.ts:146,603`, matching the sweeper's `startsWith('scan-cleanup-')` filter), input limits are bounded, and en/ru parity is gate-enforced. The structural problem is at the edges. First, the *shipped artifact* has no single owner: `scripts/verify-packaged-native-tools.sh` owns per-platform packaging proof but its scan-cleanup coverage exists only in the macOS branch, while `scripts/release/verifyPackagedScanCleanup.ts` — the one component that actually proves the feature works after packaging — sits outside every workflow. Second, the *cleaned document's lifecycle* has no owner at all: it is created into OS temp by `generatedOutputs.ts`, hidden from Recent Files by `openInputPaths.service.ts`, surfaced only by a transient toast in `scanCleanupRunCoordinator.ts`, and deleted by an mtime-based prune plus the OS temp reaper — four components, no invariant, and nothing that says how long a user's result is supposed to survive. The approach doc's own F16 "present but unwired" test, applied outward instead of inward, catches both.

---

## [HIGH] The cleaned document exists only in OS temp, is hidden from Recent Files, and is deleted by both an mtime prune and the OS reaper

- **kind**: design-weakness
- **locations**: electron/features/scan-cleanup/public/generatedOutputs.ts:27, electron/features/scan-cleanup/public/generatedOutputs.ts:31-33, electron/features/scan-cleanup/public/generatedOutputs.ts:95, electron/features/scan-cleanup/public/generatedOutputs.ts:133, electron/utils/appTempDir.ts:21, electron/features/documents/main/openInputPaths.service.ts:206, electron/features/documents/main/openInputPaths.service.ts:232-234, app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator.ts:313-327, app/modules/workspace-shell/composables/useScanCleanupRunCoordinator.ts:91-92

**Evidence**

The output directory is `join(getAppTempDir(), 'scan-cleanup', 'output', randomUUID())` (generatedOutputs.ts:31-33,95), and `getAppTempDir()` resolves to `app.getPath('temp') ?? tmpdir()` (appTempDir.ts:21) — the OS temp directory, which macOS and systemd-tmpfiles reap on their own schedules. `openInputPaths.service.ts` explicitly keeps the result out of history: `const isGenerated = isScanCleanupGeneratedOutputPath(originalPath);` … `if (!isGenerated) { persistRecentInputsAfterOpen([originalPath], owner); }` (206, 232-234). The app's own prune deletes any output dir where `nowMs - metadata.mtimeMs >= SCAN_CLEANUP_OUTPUT_MAX_AGE_MS` (7 days, :27, :133) — mtime, which does not advance when the user merely opens or reads the file — and it runs at every startup (`useScanCleanupRunCoordinator.ts:91-92`, `{immediate: true}`). On the success path the only durability affordance is one transient toast action: `actions: [{label: t('scanCleanup.saveAs'), color: 'neutral', variant: 'outline', onClick: () => { void dependencies?.saveActiveDocumentAs(); }}]` (scanCleanupRunCoordinator.ts:321-326). Note the asymmetry at :320: when opening *fails*, `description` shows `state.outputPdfPath`, so the user can find the file; on success the path is never shown.

**Failure scenario**

A user cleans a 400-page scan (a long, expensive run), the result opens, they dismiss the toast without noticing the outline-styled "Save as…" button, and they keep working with the cleaned document over the following days. The file is not in Recent Files, so after any app restart they cannot reopen it except by remembering a randomUUID path under /var/folders or /tmp. Continued use does not refresh mtime, so the app's own prune deletes it on day 7 — or the OS reaper takes it sooner. The user's expensive result disappears with no warning and no way to recover it short of re-running the whole cleanup.

**Recommendation**

Give the cleaned output an owner and a stated lifetime. Minimum: base the prune on last-access/last-open rather than mtime, and refresh the directory's timestamp whenever the output document is opened, so an in-use result cannot age out. Better: write results to a durable app-data location instead of OS temp (OS reapers are outside the app's control), or register generated outputs in Recent Files under a distinguishable label so a restart can find them. Also show the output path in the success toast description, as the failure path already does.

---

## [HIGH] Packaging verification runs the shipped evb-scan-cleanup binary on macOS only; four of five shipped platform-arches ship with zero execution evidence

- **kind**: coverage-gap
- **locations**: scripts/verify-packaged-native-tools.sh:525-526, scripts/verify-packaged-native-tools.sh:558-560, scripts/verify-packaged-native-tools.sh:585-586, scripts/verify-packaged-native-tools.sh:392-414, scripts/release/native-tool-smoke-policy.mjs:43-49, .github/workflows/build.yml:26-46, .github/workflows/build.yml:288-290

**Evidence**

The macOS branch smokes the binary twice: `run_macos_packaged_tool_smoke "evb-scan-cleanup" "$(packaged_entry_path evb-scan-cleanup)" --version` (525) and `"evb-scan-cleanup-protocol" … --protocol-version` (526). The Linux branch (531-563) does an `ldd` unresolved-symbol scan and then, under `if host_can_execute_target`, runs only `tesseract --version` and `unpaper --help` (559-560). The Windows branch (566-590) does PE import analysis and then only `tesseract --version` (586). `evb-scan-cleanup` appears in neither non-mac branch. This is not forced by cross-compilation: `host_can_execute_target` (392-414) returns 0 for linux:Linux and win:MINGW* at matching arch, and build.yml uses native runners for linux-x64 (ubuntu-latest), linux-arm64 (ubuntu-24.04-arm) and win-x64 (windows-2022, invoked with `shell: bash` → MINGW uname), all of which already execute other packaged tools there. `native-tool-smoke-policy.mjs:43-49` defines both scan-cleanup smoke entries including the generated protocol-version expectation, but that policy is consumed only by the macOS branch's smoke helper — a textbook 'present but unwired' by the approach doc's own F16 test.

**Failure scenario**

A packaged Windows or Linux evb-scan-cleanup that links cleanly but is the wrong build — a stale binary whose protocol version predates a contracts change, or a cross-bundled win-arm64 artifact that aborts at startup — passes ldd/PE analysis, passes the presence check, and ships. The `--protocol-version` assertion that would have caught the contract drift exists and runs only on macOS. Every non-mac user's first cleanup run fails at the sidecar handshake, on a release that was fully green.

**Recommendation**

Add `evb-scan-cleanup --version` and `--protocol-version` to the Linux and Windows `host_can_execute_target` blocks alongside the existing tesseract/unpaper smokes — the policy entries already exist in native-tool-smoke-policy.mjs, so this is wiring, not new machinery. For win-arm64, where the host cannot execute the target, record that gap explicitly in the doc's gate vocabulary rather than leaving it implicit.

---

## [MEDIUM] The only end-to-end packaged scan-cleanup verifier has no CI caller and is additionally gated on an untracked .devkit fixture

- **kind**: process-weakness
- **locations**: scripts/release/verifyPackagedScanCleanup.ts:1, scripts/release/verify-local-package.mjs:144-160, scripts/release/verify-local-package.mjs:161-173, package.json:101, .github/workflows/release.yml:151, .github/workflows/release-artifacts.yml:117, .gitignore:30

**Evidence**

`verifyPackagedScanCleanup.ts` (935 lines) is the strongest gate in the repo: it launches the packaged `EVB Viewer` over CDP, drives detection and a real cleanup, asserts `page-plan evidence: pinned=N absent=0 mismatched=0` in the worker log, and audits the rasterized artifact. Its sole caller is `runPackagedScanCleanupVerifier` in verify-local-package.mjs, which first returns early unless `target.platform === 'mac'` (144-146), then returns early again unless `.devkit/scan-cleanup-release-fixture.json` exists (154-160) — and `.devkit/` is gitignored (.gitignore:30), so that file cannot exist on any CI runner. The entry point `release:verify:package:local` (package.json:101) appears in no workflow: release.yml:151 and release-artifacts.yml:117 run only `release:verify:checks`. In the approach doc's own vocabulary this gate is `manual (invocable, no caller)`, while its in-code comment claims a fixture 'makes it REQUIRED'.

**Failure scenario**

A regression that only manifests after packaging — an asar/asarUnpack path change, a resource-manifest rename, a signing step that strips an entitlement the sidecar needs — is invisible to every automated gate. The verifier that would catch it in minutes never runs unless the maintainer both remembers the manual command and has hand-created an untracked fixture on that machine; the regression is discovered by a user on a shipped build.

**Recommendation**

Either wire this into the release workflow with a committed fixture (a small synthetic scan PDF checked into tests/fixtures rather than a machine-local .devkit path), or reclassify it honestly as `manual` in the approach doc and remove the 'makes it REQUIRED' framing from the comment. The current state is the enforcement-rot pattern F16 was written to catch.

---

## [MEDIUM] OCR preprocessing shells out to the same scan-cleanup binary with CleanupOptions::default(), and no oracle covers that path while binarization tuning is in flight

- **kind**: coverage-gap
- **locations**: electron/ocr/worker/tryPreprocessOcrImage.ts:85-113, native/scan-cleanup/src/adapters/batch_cli.rs:419-450, native/scan-cleanup/src/domain/options.rs:487-531, tests/unit/electron/ocrWorkerPreprocessOcrImage.test.ts:16, native/scan-cleanup/tests/page_cli.rs:2297

**Evidence**

OCR invokes the shared binary directly: `runNativeToolCommand(scanCleanupBinary, ['--input', …, '--ocr-mode', '--options', JSON.stringify({dpi})], {commandLabel: 'evb-scan-cleanup(ocr-preprocess)'})` (tryPreprocessOcrImage.ts:85-113). The CLI does `options.as_deref().map(parse_options).transpose()?.unwrap_or_default()` then sets `options.ocr_mode = true` (batch_cli.rs:419-450), so every field except dpi comes from `CleanupOptions::default()` — `binarization: Auto`, `normalize_illumination: true`, `despeckle: true`, `output_mode: Bw` (options.rs:487-531). Every binarization/weight change under R11/R13 therefore changes OCR input pixels. Coverage: `tests/unit/electron/ocrWorkerPreprocessOcrImage.test.ts` mocks the command entirely (`vi.mock('@electron/ocr/worker/runOcrCommand', …)`, :16) and asserts only argv shape and unpaper/raw fallback ordering; on the native side `ocr_mode` appears in exactly one integration test, `per_page_ocr_mode_writes_atomic_png_and_metadata` (page_cli.rs:2297), which checks atomicity, not output quality. No test relates a binarization change to OCR accuracy. (The dimension-preservation invariant is genuinely fail-safe — batch_cli.rs hard-errors if OCR mode changes output dimensions — so this is quality degradation, not content loss.)

**Failure scenario**

An R11/R13 tuning change improves the visual scan-cleanup oracle's scores while pushing Auto binarization slightly darker on faint typescript. OCR accuracy on those documents drops measurably. Every gate stays green — the OCR test is mocked and the scan-cleanup oracles never look at recognition output — and the regression surfaces as user-reported bad search results with no link back to the commit that caused it.

**Recommendation**

Add one OCR-side oracle over a small fixture set that asserts recognition quality (character-error-rate or a token-match floor) through the real `--ocr-mode` path, and run it whenever the binarization/weighting code changes. Alternatively pin the OCR preprocessing options explicitly at the call site instead of inheriting `CleanupOptions::default()`, so viewer-facing tuning cannot silently reach OCR.

---

## [MEDIUM] All Rust validation runs on ubuntu-latest x64 only, for a tool shipped to five platform-arches and developed on macOS arm64

- **kind**: process-weakness
- **locations**: .github/workflows/ci.yml:239, .github/workflows/ci.yml:268, .github/workflows/ci.yml:271, .github/workflows/ci.yml:278, .github/workflows/build.yml:26-46

**Evidence**

`pr_native_build_safety` declares `runs-on: ubuntu-latest` (ci.yml:239) and is the sole home of `pnpm run test:rust` (268), `pnpm run lint:rust` (271), cargo-deny (274), and `pnpm run build:strict` (278). build.yml ships five platform-arches (mac/arm64, linux/x64, linux/arm64, win/x64, win/arm64) but runs no Rust tests on any of them. The maintainer's own local gate runs on macOS arm64. So the imaging code is tested on exactly one target triple, which is neither the development platform nor four of the five shipped ones.

**Failure scenario**

Any behaviour that varies by target — float rounding or SIMD-lane differences in the imaging kernels between x86-64 and aarch64, filesystem case-sensitivity in path handling, Windows path separators in the sidecar's own file I/O — produces different pixel output or an outright failure on a shipped platform while CI is green. The repo's own CLAUDE.md already warns that local green is not CI green; the same reasoning applies one level out, and nothing currently covers it.

**Recommendation**

Run `test:rust` on at least one aarch64 runner (macos-14 or ubuntu-24.04-arm are already in the build matrix) and on windows-2022, even if only on native-touching PRs. If that is judged too expensive, record the single-target limitation explicitly in the approach doc so the next reader does not mistake the green check for cross-platform evidence.

---

## [MEDIUM] The binding design charter is .gitignore-blocked from ever being committed, so it is invisible to CodeRabbit and to any fresh clone

- **kind**: process-weakness
- **locations**: .gitignore:16-30, .coderabbit.yaml:1

**Evidence**

`.gitignore:23-24` lists `AGENTS.md` and `CLAUDE.md` (alongside `GEMINI.md`, `.claude/`, `.devkit/`) under a comment declaring `scripts/lib/local-artifact-policy.mjs` the canonical list, and pre-commit/pre-push hooks reject every case variant at any depth. `git ls-files --error-unmatch CLAUDE.md` fails; `git check-ignore -v CLAUDE.md` → `.gitignore:24`. Yet `CLAUDE.md` carries the project's binding Design section ('Prefer deletion and reuse', 'Give each state and lifecycle one owner', 'New layers must replace old ones') and the CodeRabbit workflow contract. Meanwhile `.coderabbit.yaml`'s path_instructions for app/, electron/, native/, tests/, scripts/ and workflows contain none of those design rules. The reviewer whose job is to enforce the charter has never seen it.

**Failure scenario**

A PR adds exactly the kind of one-consumer wrapper, duplicate state container, or compatibility shim without a removal condition that the charter forbids. CodeRabbit approves it — it was never given the rules — and the maintainer must catch it by hand every time. This is the same failure that forced the ledger out of `.devkit` under S1: a document that governs the work cannot be enforced from a location the tooling cannot read.

**Recommendation**

Move the durable Design/OCR/UI/Native-CI rules out of the ignored CLAUDE.md into a tracked file (e.g. docs/architecture/design-charter.md), and reference them from `.coderabbit.yaml` path_instructions so the reviewer applies them. Keep only genuinely machine-local agent preferences in the ignored files.

