# Stress campaign fixes, September 5, 2026

The campaign exposed an annotation-save crash, dense-annotation stalls and
memory growth, missing annotation icons, DjVu automation timeouts, and a broken
forced-low profile probe. The follow-up uses the original fixtures and leaves
performance thresholds and accepted benchmark files unchanged.

The supplied T3 thread `e2b14234-b6af-4524-bf5e-1b8b7c5c3e1e`, titled
"Take Over Stress Testing", supplies campaign context. Its messages were read
without changing T3 state. Fresh reproductions and regression tests provide the
acceptance evidence.

## Causes and changes

Committed FreeText editors remained in the bridge's pending draft set. Saving
tried to re-enter edit mode after their page layer had detached and crashed.
The bridge now removes editors when PDF.js commits their content to annotation
storage. A regression test reproduces the detached-editor failure.

Dense annotation imports repeatedly cloned and fingerprinted the entire store,
then emitted it to subscribers that copied their projections again. CPU
profiling identified this work during legacy summary and shape reconciliation.
The viewport held at most six rendered page canvases, about 47 MB of pixels,
which did not explain the allocation volume. Store batching now publishes one
complete collection per reconciliation. Tests preserve individual undo entries,
nested batching, and notification recovery after a callback throws.
The persisted import transaction also advances a clean saved baseline one
entity at a time. It falls back to full comparison after a semantic mutation,
identity change, or history replay. Regression tests cover dirty-to-clean
restoration and unchanged identity bindings as well as linear import work.
Marker geometry also uses rendered pages, hidden annotation filtering normalizes
IDs once per page, and raster concurrency respects a lower resource tier.

PDF.js constructs note-icon URLs at runtime. CSS-derived asset copying omitted
those icons, and annotation rendering did not set the image resource path.
Asset generation now retains all runtime annotation icons, and rendering uses
`/pdfjs/images/`.

The sandboxed preload's Buffer implementation rejected the `base64url` encoding
label. Profile decoding now translates the wire representation to ordinary
base64 while retaining canonical-encoding and profile validation. A test uses a
Buffer implementation that rejects the unsupported label.

Native DjVu rendered successfully, but the generic readiness predicate required
a PDF page track. It now accepts the native document-source viewer and still
requires visible, committed chassis state. Workspace automation also reports
the native DjVu source path without requiring a PDF projection.

The annotation driver previously waited on a global editor count even though
virtualization removes editors on other pages. It now scrolls to the target
page, creates text with the pointer helper, and follows the new editor's stable
ID on that page. Per-note waits remain bounded and CDP handles are disposed.

Startup now bounds Puppeteer page discovery so an unresponsive target reaches
the existing Electron retry path. Body readiness uses a main-world boolean
query instead of allocating an element handle through Puppeteer's isolated
query context. The five-second body deadline remains unchanged and its timer
is cleared when the query settles. Stress campaigns share one E2E renderer
server while each scenario retains its own Electron process and profile.
Tests cover shutdown, calibration failure, environment restoration, and
concurrent stop calls. Operator cards identify sessions through their PID
metadata and CDP endpoint.

## Runtime evidence

Reproduction began at `573bf535c39eff918afb918eaa1888f988dc4c8f` in the assigned
T3 worktree on macOS, Node 24.11.1 and pnpm 10.32.1. Renderer dimensions were
1280 by 800 at device scale factor 1. Save scenarios used working copies.
The primary checkout's default Electron session remained untouched.

| Scenario | Original failure | Verified result |
| --- | --- | --- |
| Visible annotation save | Three text boxes on pages 1, 3, and 5 left the document dirty and raised a toolbar failure. | Save and native Cmd+S reach a clean state. `qpdf --check` passes and PDF object inspection confirms exactly the three expected `STRESS` notes. |
| Automated annotation save | The free-text creation step timed out. | Creates 20 notes, saves, undoes, redoes, and saves again. The final driver run took 17.7 seconds with no functional findings. An earlier passing run's saved PDF contains all 20 expected texts on their assigned pages. |
| Native DjVu | The 501-page document rendered but open waited 120 seconds and failed. | Open takes about two seconds, then navigation and scrolling pass with no findings. |
| Forced-low calibration | The bridge reported an unknown effective tier. | Reports `low`; all five affected scenarios pass with zero findings. |
| Dense annotation scrolling | The original campaign peaked at 4,121 MiB with an 84-second wheel step, 27.6-second long-task p95, and 50 icon errors. | The final baseline run peaks at 1,891 MiB and completes the first wheel step in 49.9 seconds, below the unchanged 3,072 MiB and 60-second limits. Long-task p95 is 253 ms with zero findings. Forced-low also passes with zero findings. |

The first local dense reproduction lacked ignored native tools. Later runs
reused the original fixture manifest and native binaries. The page-operations
binary SHA-256 was
`88bebd2d768c51818598283124119d4d807408e15e88b79c5d63d8cee8fb3a57`.
Instrumented diagnostic timings are not acceptance measurements. Failed
intermediate experiments were reverted, including a visual snapshot change and
an unsafe hidden-ID cache.

The original corrupt-file recovery scenarios succeeded. Their expected parse
errors remain diagnostic evidence, not a reason to suppress error reporting.
The 4,000-page deterministic scenario also completed every functional step.
Its single 2,529 ms long task occurred near Fit Width; other profiles reported
115 to 244 ms p95. The external navigation workflow reported 212 ms p95 and no
findings, but did not exercise Fit Width. The artifacts do not establish a
source-level cause for that isolated slow operation. The final baseline passes
with zero findings and 183 ms long-task p95, including Fit Width.
The Linux cgroup profile `slow-b` is unsupported on this macOS host.

## Verification before publication

Upstream main through `a3dadd32a482a7ef8d79f66a6e28a7deb5bdecb1` was integrated
without changing the task patch or other checkouts. The last upstream change
only updated Sentry operations documentation.

| Final campaign | Result |
| --- | --- |
| Baseline | Seven of nine scenarios passed initially. Outline and scanned-document startup failed before opening; both pass with zero findings after the body-probe change. Together these runs cover all nine workflows. |
| Forced-low | Five of five affected scenarios pass with zero findings. |
| Slow-a, 4x CPU | Annotation save and DjVu pass. Dense scrolling passes on a clean repeat with zero findings, 1,549 MiB peak RSS and 128 ms long-task p95. |
| Slow-a-gpu, 4x CPU and software rendering | Five of five scenarios pass. Two minor timing findings remain: outline long-task p95 of 559 ms and a scanned-document wheel step of 60,873 ms against the unchanged 60,000 ms limit. |
| Slow-c | All three affected scenarios pass with zero findings. Dense scrolling peaks at 1,727 MiB with 455 ms long-task p95. |

The first final slow-a dense run lost the document view while retaining the
file tab and opening state. This overlapped the documentation-only upstream
integration. Logs do not prove a reload or its cause. The identical scenario
passed in 108.1 seconds with source and Git activity paused. The failed run's
screenshot, workspace state, and metrics remain in the local evidence. No
speculative workspace restoration change was made. Further recurrence needs a
trace of source changes, restoration claims, and document-session identity.

The baseline corrupt-file scenario retains its expected console-error finding.
No performance threshold, error allowlist, or accepted benchmark was relaxed.
The final baseline saved PDF passes `qpdf --check`; object inspection confirms
all 20 expected note texts and their assigned pages.

Full lint, type checking, and dead-code/duplication checks pass. Electron build
and bundle integrity pass, including 60 bundle checks. Full coverage passes
11,592 tests in 1,318 files with two workers, together with the coverage ratchet
and zero-execution tripwire. This full run preceded the final import and
readiness refinements. Those changes pass 78 and 63 focused tests respectively;
the review fixes pass 23 tests. A subsequent full typecheck and production app
build pass. The affected scan-cleanup gate runs its native corpus of 51 fixtures
with zero catastrophes; export inputs are unaffected.

Two complete CodeRabbit CLI passes reviewed the task on this Mac against
`origin/main`, including untracked files. Neither reported major or critical
findings. Both first-pass findings were accepted: recompute pending-draft state
after a blur commit, and restore the test JSON spy even if import throws. The
state regression failed before the fix and passed afterward.

The two second-pass suggestions were declined. Removing session metadata even
when process shutdown fails would discard recovery evidence for a possibly
live process. Expanding the import work-count fixture was unnecessary because
the existing 32-entry assertion already detects repeated full-baseline scans.
No paid review capacity or fail-open path was used. Raw review logs and
individual dispositions remain in `.devkit/stress/fix-evidence/`.
