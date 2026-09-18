# Recorded automation

Use the shared Electron runner for agent-operated UI work on macOS, Linux and
Windows. It accepts shell commands from any provider. Recording and input
observation are implemented by the runner, not by a model's computer-use tools.

## Start and operate

Inspect existing sessions with `pnpm electron:run list`. Build Electron with
`pnpm build:electron` if the checkout has no current build. Choose a new task
session name, keeping the user's `default` session untouched:

```sh
pnpm electron:run -s proof-my-task record
pnpm electron:run -s proof-my-task recording mark 'Open the fixture'
pnpm electron:run -s proof-my-task openPdf /absolute/path/to/fixture.pdf
pnpm electron:run -s proof-my-task recording
```

`record` starts a hidden, no-focus session through the shared launcher and waits
for both a renderer stream frame and encoder output before exposing the command server. macOS
uses the verified LSUIElement bundle. Linux still needs an X display; on the VPS
use its existing `DISPLAY=:1`, preserving the desktop services. No host screen
or host pointer is captured. Normal developer `start`/`startd` behavior is
unchanged; `EVB_RECORD_SESSION=1` also enables capture for existing controlled
session entrypoints.

Use `click`, `type`, `waitfor`, `resize`, `screenshot`, and `run-file` on that same
session. `run-file` executes Puppeteer code with `page` and `screenshot` available.
Use observable readiness rather than sleeps. Capture logs classify `openPdf` as
an app API call, `run`/`eval` as direct evaluation, and click/type as UI input.
Delivered pointer, wheel and non-character key events are recorded separately, including
input issued within a script. Typed text and raw evaluation source are omitted
from the command log, but visible document content remains in the video.

The provider chooses actions; saved scripts make those actions repeatable.
Neither rendering times nor encoded bytes are promised to match across machines.

## Finish and inspect

```sh
pnpm electron:run -s proof-my-task stop
pnpm electron:run -s proof-my-task recording
```

The final command prints the retained manifest and review paths, including after
the app has stopped. It recovers decodable partial footage if the controller
exited before finalization. Recovery stays failed, never becomes a passing run.
For live sessions the command only reports status; it never finalizes another
owner's recording.

Evidence lives under `.devkit/sessions/<session>/recordings/<run>/`:

- `index.html`: offline review page with selectable window tracks, clickable
  action timestamps and an orange input-coordinate overlay.
- `window-*.mp4`: actual rendered pixels, including idle time. New windows get
  separate tracks. Only EVB Viewer app renderer routes are recorded; hidden
  PDF print-support pages are excluded. Windows guest-desktop footage covers
  native print and save dialogs. Output is 1280×800 with aspect-preserving letterboxing.
- `actions.jsonl`: commands, delivered inputs, markers, errors and track boundaries.
- `manifest.json`: source identity, capture scope, status, paths and video probes.

### Agent visual review

Before presenting a recording as proof, prepare a review package and inspect it:

```sh
pnpm electron:run -s proof-my-task recording review
# Also accepts a recording directory or manifest collected from Windows or another host:
pnpm electron:run recording review /absolute/path/to/recording
# Revisit exact video timestamps at full resolution, selecting a window when needed:
pnpm electron:run recording review /absolute/path/to/recording --track window-1 --at 12.3,18.7
# Investigate a transient state or motion in a bounded interval:
pnpm electron:run recording review /absolute/path/to/recording --from 10 --to 13 --step 0.1
```

The command fully decodes each selected video to detect corruption, preserves the
source and its capture status, and writes a unique `reviews/review-*` directory.
It contains a browser-friendly MP4 copy, full-resolution PNG frames, contact
sheets labeled with frame numbers and video seconds, and `review.json` linking
frames to session timestamps, actions, hashes and sampling coverage. Default
sampling covers the full duration every five seconds, both ends, and before/after
meaningful actions. Explicit `--at` times replace that sampling. Times are relative
to the selected track; extraction selects the containing frame on the recorder's
constant-frame-rate timeline and reports its `frameSeconds`. Use a time strictly
before the video's end.
Extraction is bounded to 600 frames per track; split larger investigations into
explicit intervals. A failed capture remains failed even when its video decodes.

Use the model's image-reading tool to open every contact sheet, then open the
full-resolution frames supporting each expected outcome. Contact sheets are an
overview, not evidence that small text is correct or motion is smooth. Request
additional timestamps or dense intervals until the relevant behavior is visible;
play the video when the claim depends on continuous motion. Image-capable agents
can do this without computer-use tools or another provider's API credentials.

Write `assessment.md` beside `review.json`: each expected outcome gets a
pass/fail/inconclusive verdict, observed behavior, inspected track/timestamps/frame
paths, and limitations. Extraction always reports `visualAssessment: required`;
only the agent's actual inspection supports its written verdict. If a provider
cannot read images, its visual verdict is inconclusive. Check persisted output
separately when saving is part of the task. A video does not establish PDF validity.
Preserve failures and include the assessment with the delivered evidence.

Serve the review directory as HTML in the thread browser preview or open it
locally in a browser. `pnpm electron:run recording serve <review-directory>`
prints a loopback URL with correct MIME types and byte-range video seeking.
Open that URL in the thread's browser preview, which can display the host page
to a remote client; a phone's own `127.0.0.1` is not the Mac. The server stays
in the foreground until Ctrl+C. Retain it while the user is inspecting the
evidence, and stop only that task-owned server when no longer needed.
Verify the delivered page renders, video duration matches
the probe, and seeking reaches the final state. T3's plain file-link route may
serve HTML as text and does not preserve relative assets. In that case use the
thread preview with a loopback static server or provide direct MP4 links; an
unopened `index.html` link is not a verified delivery. Keep recordings private
unless publication is authorized.

Encoding streams through a bounded latest-frame buffer at 15 FPS. Completed
MP4 fragments survive an interrupted process. A lag over five seconds or an
encoder failure marks capture failed and blocks subsequent mutating commands.
The recorder finishes before normal app teardown; app startup before attachment,
native menus/dialogs, and OS desktop pixels are outside renderer capture.
Recording health is separate from the outcome of the actions being tested.

## Windows and native UI

The renderer recorder uses the same code on Windows. For the packaged Windows
lab, follow [UTM tests](utm-windows-tests.md); keep the guest interactive and
unlocked and keep host input capture off. Native file/print dialogs require a
desktop or native-window recording inside that guest. Renderer video must never
be presented as proof of a native dialog. Lock, secure-desktop transitions and
capture loss are explicit evidence gaps, not permission to capture the host.

For lab runs use `EVB_RECORD_SESSION=1 pnpm windows:test ...` (with the usual
suite/environment arguments). The host sends that request in the validated guest
job. Instrumented launches produce renderer tracks plus **guest desktop** footage;
native acceptance launches produce guest desktop footage through FFmpeg `gdigrab`.
Prepare with `EVB_RECORD_SESSION=1 pnpm windows:test:prepare`. This downloads a
pinned, SHA-256-verified FFmpeg build for the qualified guest architecture. The
existing input staging and hash checks deliver FFmpeg/FFprobe into each run; no
global guest PATH changes are needed. The normal evidence collector retrieves
the videos. Repeat preparation after updating the worker code. Do not bypass a failing `windows:test:doctor` preflight.

## Installation

`node scripts/installRecordingSkill.mjs` installs a single canonical skill in
`~/.agents/skills/evb-viewer-recording` and exposes it through each supported
provider's skill directory. Run it from the checkout deployed on each machine.
The CLI does not need provider credentials. Reload skills or start a new provider
session to discover an installation made after that session started.

Supported discovery paths cover Codex, Claude Code, Pi, OpenCode and Gemini CLI.
Older Gemini releases also receive a pointer in their global `GEMINI.md`.
All other shell-capable providers can follow this document directly. Provider
model selection and credentials are unchanged.
