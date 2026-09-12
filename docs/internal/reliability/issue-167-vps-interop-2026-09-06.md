# Issue #167 VPS interoperability evidence

Date: 2026-09-06

This report records the Linux VPS evidence for issue #167, "Verify annotation
interoperability autonomously on the VPS". It does not claim verification in
Acrobat Reader, macOS Preview, or on a Mac. The owner's separate visual check
is outside this project gate.

## Candidate and scope

The candidate is branch `ticket/196-renderer-interface` at commit
`d66433d2801df25b33769e616a41292cc51e3`, with the validated pending
candidate changes listed below. The integration reference was `origin/main` at
`4b0b13a013ae309b30a76a9c734f672215a6fc7b`. Integrated-main
verification was still pending at report creation.

The committed corpus and its generator use two complementary inputs. The
synthetic fixture contains the controlled five-kind interoperability set and
the stock fixture is the result of saving that input through the unpatched
`pdfjs-dist-codex-preview` 5.4.296 writer. The README and manifest state this
provenance precisely. The synthetic annotation dictionaries are not described
as having been authored by pdf.js.

| Fixture | Pages | Bytes | SHA-256 |
| --- | ---: | ---: | --- |
| `tests/fixtures/electron/interop/synthetic-annotation-interoperability.pdf` | 1 | 8,126 | `ef11566db8d123ab0c2af16d13958fafc4bba716c0b5d1ad61757362f8a59597` |
| `tests/fixtures/electron/interop/stock-pdfjs-save-of-synthetic.pdf` | 1 | 9,214 | `17714bae1958fd2389f908deeac3643d99a032d38e501ece1863c3596472dbe4` |

The manifest reports 2 ready entries, all five canonical kinds, all eight
required scenario families, and 26 scenarios. `generate-interop-corpus.mjs
--check` and the strict verifier reject missing, empty, non-ready, incomplete,
or silently skipped corpus data.

## Structural and rendering evidence

The verifier commands were:

```sh
node scripts/verify-interop-corpus.mjs
node scripts/verify-interop-rendering.mjs \
  --artifact-dir .devkit/artifacts/issue-167-interop-negative-control-final
```

The renderer used qpdf for structural validation and Poppler's `pdftoppm` at
144 DPI for independent Linux rendering. It rendered each fixture once with
annotations and once with `-hide-annotations`. For each selected text-box,
highlight, native Text note, stamp, and Square annotation, the normal crop had
paint, the hidden crop was white at mean 65,535, and the hidden-minus-normal
delta was at least 1,024. The observed deltas were:

| Kind | Normal mean | Hidden mean | Delta |
| --- | ---: | ---: | ---: |
| text-box | 61,944.9 | 65,535 | 3,590.1 |
| highlight | 53,713 | 65,535 | 11,822 |
| native Text note | 51,696.5 | 65,535 | 13,838.5 |
| stamp | 30,497.3 | 65,535 | 35,037.7 |
| Square shape | 59,694.1 | 65,535 | 5,840.9 |

The retained normal and negative-control images are in
`.devkit/artifacts/issue-167-interop-negative-control-final`. The two fixtures have
qpdf exit code 0 and no warnings. Poppler emitted its expected blank-legacy-AP
warning while rendering the controlled legacy note.

Tool versions and commands recorded by the verifier:

```text
qpdf 11.9.0
pdfinfo 24.02.0
pdftoppm 24.02.0
ImageMagick 6.9.12-98 Q16 x86_64 18038
normal:      pdftoppm -png -singlefile -r 144 -f 1 -l 1
negative:    pdftoppm -hide-annotations -png -singlefile -r 144 -f 1 -l 1
```

The hidden-annotation render is a bounded negative control for these five
controlled kinds. It is not a general screenshot-diff framework.

## Native, corpus, Electron, and encryption gates

- The JavaScript corpus unit suite passed 7/7.
- The Rust contract and discovery tests passed 2/2. They require a non-empty
  ready corpus, complete required-case and required-kind declarations, and
  existing ready files.
- The final focused #167 Electron gate passed 2/2 in
  `.devkit/analysis/gates/2026-09-06T18-18-14-963Z-812978-fc5a8a7c.ndjson`.
  It imported the corpus, edited and saved a text box, reopened two fresh
  copies, entered the supported encrypted-input password, created a note with
  real pointer input, saved an unencrypted output, independently rendered it,
  and reopened it without a password. qpdf reported `File is not encrypted`
  for the saved encrypted-input output.
- The required private-fixture #350 gate passed 4/4 in
  `.devkit/analysis/gates/2026-09-06T13-23-39-763Z-127335-2b23fb2a.ndjson`.
  It covered legacy identity through pointer selection, sidebar and popup
  deletion, edit migration, reopen, reply/Popup cleanup, and neighboring-note
  preservation. The private fixture was copied fresh for each mutation.
- The lifecycle and stamp gate passed 8 tests in
  `.devkit/analysis/gates/2026-09-06T13-25-11-224Z-129085-ddb4a7b4.ndjson`.
  Nine historical annotation-history cases were explicitly skipped and are
  not counted as evidence.
- The exact 882-page annotation matrix passed 2/2 in
  `.devkit/analysis/gates/2026-09-06T13-29-03-256Z-133454-a5905ec9.ndjson`.
  It used the required 882-page fixture, 722,178,517 bytes,
  SHA-256 `1660bced91f628b9acbb2fc0f9dac29fe783a3f43d26231d8f3b0c73133b21b6`.
- The exact 2,646-page acceptance passed 2/2 in
  `.devkit/analysis/gates/2026-09-06T13-34-08-713Z-138382-9b88235f.ndjson`.
  It used the required 2,168,527,413-byte fixture with SHA-256
  `5609c151c1cec881da4b97ec7028250574f8f0ee67540dcdc8808cc7b8ab0aea`.
- Strict WASM freshness initially failed because both committed browser
  artifacts predated the candidate native sources. Rebuilding through the
  repository scripts made the final strict check pass in
  `.devkit/analysis/gates/2026-09-06T13-51-53-283Z-156371-93d4b983.ndjson`.
  The two build gates were
  `.devkit/analysis/gates/2026-09-06T13-49-46-629Z-154013-580ffc99.ndjson`
  and
  `.devkit/analysis/gates/2026-09-06T13-50-15-142Z-154887-9f17c366.ndjson`.

## Remaining project evidence

The broad mixed-size Viewer Smoke gate is retained as historical evidence at
`.devkit/analysis/gates/2026-09-06T09-13-35-511Z-3977170-a1fd46a8.ndjson`,
at `viewerSmoke.e2e.test.ts:2730`. The retained artifact captures toolbar
state `2 / 4` at `158%` with page 2 selected and the wide page track visible.
Its session-combined log does not retain the serialized page snapshots,
page-track width, or raster-readiness values from the thrown assertion. Later
focused runs passed, and the correctly configured broad run passed 24/24 at
`.devkit/analysis/gates/2026-09-06T18-02-34-043Z-784584-3bda45c5.ndjson`.
The historical red remains visible and is not waived.

Required publication, integrated-main verification, the #168 target build and
receipt, and the remaining #196, #168, #350, and Project 4 state updates remain
pending. This report must be amended with the final integrated commit and its
verification artifacts before issue #167 or Project 4 closes.

## Validation correction after the initial report

The first required full validation after the helper and corpus changes was
`2026-09-06T14-09-29-744Z-201920-9b583548`. It reached 10,799 passing unit
tests and failed only at the build-strict WASM freshness check and the
zero-execution coverage tripwire. The latter identified the two new interop
scripts before their direct execution test was included in the coverage run.
The CSS policy violation, inherited Clippy warning, and stale regression-topology
expectation were corrected separately and their focused checks passed.

The interop unit lane now executes the deterministic generator and the
independent Linux renderer, including the annotation-hidden negative control,
and passes 7/7. Its coverage summary records nonzero executed lines for both
`scripts/generate-interop-corpus.mjs` and
`scripts/verify-interop-rendering.mjs`. The coordinator rebuilt both WASM
artifacts after the final Rust source edit through the gated commands
`2026-09-06T14-24-00-862Z-240326-e817ad73` and
`2026-09-06T14-24-11-008Z-241233-bf675254`; the strict freshness check now
passes. The required full validation must still be rerun on this settled tree.

The subsequent required validation ran at
`.devkit/gates/2026-09-06T143553Z/01-validate.log`. Full coverage, the
zero-execution tripwire, build strict, native tests, lint, and blocking Electron
smoke passed. `typecheck.full` alone failed because the new direct call to
`verifyInteropRendering` omitted its typed `inputPaths` property. Adding
`inputPaths: []` fixed that call. The focused interop unit run then passed 7/7,
and the tests/scripts typecheck passed. The complete validation gate must be
rerun on this fixed tree before publication.

## Final candidate evidence before publication

The settled candidate passed the required validation gate at
`.devkit/gates/2026-09-06T173538Z/01-validate.log`, then passed #350 in
`2026-09-06T17-47-42-656Z-764581-4f680ff6`, exact 882 in
`2026-09-06T17-50-28-015Z-768152-47f266e1`, exact 2,646 in
`2026-09-06T17-59-21-375Z-780331-bc823f92`, and correctly configured broad
Viewer Smoke in `2026-09-06T18-02-34-043Z-784584-3bda45c5`. The fresh #167
real-Electron gate passed both tests in
`2026-09-06T18-18-14-963Z-812978-fc5a8a7c`. These runs used the canonical
named-session lifecycle and the required native-page-ops admission check.

The local CodeRabbit service closed its WebSocket before returning findings.
`coderabbit doctor` passed all nine checks. This is recorded as a review
service fail-open condition. It is not a review approval.
