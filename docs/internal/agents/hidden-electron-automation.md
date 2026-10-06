# Hidden Electron automation

## Development target

For feature debugging or UI acceptance, use the running Electron dev app from
the current checkout. Identify it through the current
`.devkit/sessions/<session>/session.json`, then attach to that session's exact
Electron PID, profile, and CDP port. A generic `Electron` app-name match is not
enough because packaged and stale automation apps can use the same identity.

`/Applications/EVB Viewer.app` is the installed packaged app, not the default
development target. Use it only when the task explicitly covers packaged or
release behavior. Keep that scope separate from source and dev-app acceptance.

The display name `Electron`, bundle ID `com.github.Electron`, and foreground
window are not target identifiers. Never pass them to Computer Use. Pass only
the full app path reported for the resolved session. Use that app binding for
visual state and accessibility checks, then use the session CDP endpoint for
clicks, typing, key presses, menu traversal, and loops. If the resolver is not
ready, or the accessibility result shows more than the target window, stop and
report the ambiguous session instead of choosing a visible Electron window.
If the resolver reports only the shared `node_modules` Electron runtime path,
Computer Use has no safe target; use the session CDP endpoint without opening an
app by name.

On the user's Mac, all agent-owned Electron runs must start without a window,
focus change, or Dock icon. This includes packaged smoke tests and ad hoc CDP
probes. `app.dock.hide()` and `app.setActivationPolicy('accessory')` run after
macOS registers the app, so environment flags alone cannot prevent a Dock flash.

Development automation uses `electronRunLaunchConfig.ts`. Hidden or no-focus
macOS launches require its copied bundle with boolean `LSUIElement=true`.
The launcher verifies that value before every launch, including cached bundles.
If preparation or verification fails, stop and fix the harness. Do not retry
through stock Electron, a direct original app executable, or raw `open -a`.

Hidden macOS sessions also pass `-AppleShowScrollBars Always`. With the
system's automatic setting, scroll bars switch between overlay and classic as
a mouse connects or sleeps, and every viewport width changes with them.

Hidden Windows and Linux (X11) windows are never shown. Their compositor draws
only while a copy is pending, so the main process keeps a frame subscription on
them; without it `page.screenshot` never returns. Hidden macOS windows draw
without one. Never show, move off-screen or fade a hidden window to get frames.

Hidden macOS sessions render on the GPU, as the owner's app does. They used to
pass `--disable-gpu`, which put them on a software path no person runs.

## What an E2E renderer sees

A hidden window is not a person's window, and each host used to differ from
the next. Linux Xvfb gave a focused 900x672 page at scale 1. A Retina Mac gave
an unfocused 900x668 page at scale 2, where `focus` and `blur` never fire and
`:focus` never matches. `tests/e2e/electron/helpers/userEnvironment.ts` owns
one state for every hidden E2E session on every host, and the session fails
before its first test when the renderer cannot reach it:

- The page has focus through CDP focus emulation, and so does every window
  the app opens later. The session controller sets it for every hidden or
  no-focus session, so `record` and agent reproductions get it too.
  Main-process focus is not emulated, so `BrowserWindow.isFocused()` stays
  false.
- The content area is 900x672 through a real window resize, not emulation.
- The scale is pinned at launch with `--force-device-scale-factor`, 1 by
  default. A session that needs high-DPI rendering passes
  `extraEnv: {EVB_AUTOMATION_DEVICE_SCALE_FACTOR: '2'}` rather than
  emulating a scale with `page.setViewport`.
- The reset between tests restores all of this. Viewport emulation survives a
  renderer reload and a real resize stays until it is undone, so one test's
  `page.setViewport` or `windowResize` used to become the next test's
  starting state.

The session log prints the state it reached as one `[E2E environment]` line.
The visible-window fixture keeps the real window and its real focus.

## What automation cannot do as a person does

Click with `clickAsUser` or `clickFoundAsUser` from
`tests/e2e/electron/helpers/userInput.ts`. They wheel the target into view,
aim within its visible area after ancestor clipping, wait until it stops moving
after hover, refuse a point another element covers, and send trusted CDP input.
An oversized target can be clicked in the part already visible; an offscreen
nested scroll panel is revealed before wheeling inside it.
`element.click()` inside the page skips hit testing, pointer events, hover and
focus, so it reaches a button under a dialog. It is setup, never the action
under test. The same holds for writing `scrollTop` and dispatching synthetic
events.

These paths stay outside trusted page input. Name the gap when a report
depends on one:

- OS key routing to the application menu. A CDP key event reaches only the
  renderer, so Cmd+W or Ctrl+W typed through `page.keyboard` exercises only
  renderer handlers. Checked on macOS and on Linux under Xvfb, with the
  window hidden and mapped; Windows is unchecked. Press the accelerator with
  `activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+W'})` or
  `{id: 'new-pane-down'}` from `userInput.ts` (session command
  `activateMenuItem accelerator|id <value>`). The main process resolves the
  item from the installed menu, the first match in menu order as AppKit does,
  and runs it as a key press would: a disabled or hidden item does not run,
  and the focused window, or the first one in a hidden session, is the target,
  so window targeting and the text-field Undo branch run for real. The call
  returns once the item is chosen and the item runs right after, so an item
  that closes the window or quits still reports; wait for the effect. On macOS,
  Quit sends `terminate:` and Close, Minimize, Cut, Copy and Paste run their
  Linux and Windows role action; other AppKit-only roles report
  `unsupported-role`. Menu items run through their real handler; OS key
  routing itself still needs a visible-window lane, or X11 input on Linux
  (`unsavedWorkQuit`).
- Main-process focus checks, such as Escape leaving zen mode, which requires
  `window.isFocused()`.
- Native open, save and print dialogs, which E2E answers through
  `EVB_E2E_*_DIALOG_PATH` and `EVB_PRINT_DIALOG_TEST_MODE`. The visible-window
  nightly lane covers macOS printing.
- Trackpad phases. CDP wheel events carry no begin, end or momentum phase;
  `startTrustedWheelFling` approximates the momentum tail.
- Input queued behind a busy renderer. Puppeteer waits for each event to be
  acknowledged before it sends the next, so a person's burst of clicks during
  a long task arrives differently.

## Packaged runs

Use the shared runner with an unused task-owned directory and a free CDP port:

```bash
node --import tsx scripts/release/runPackagedAutomation.ts \
  --executable '/path/to/EVB Viewer.app/Contents/MacOS/EVB Viewer' \
  --work-directory .devkit/reports/my-task/run-1 \
  -- --remote-debugging-port=62859
```

Keep the runner attached until the test finishes. Close the app through CDP,
or send SIGTERM to this runner's exact PID. The runner forwards termination to
its own child tree and removes the copied bundle after exit. It retains the
task's profile for evidence or a later reopen. Choose a different directory for
concurrent runs. Never use the default dev session or the user's normal profile.

Scripts with their own process lifecycle use `preparePackagedAutomationLaunch`
from `scripts/release/preparePackagedAutomationLaunch.ts`, then spawn its returned
`executablePath` with its returned `env`. Remove its `bundleDirectory` after the
owned process tree exits. The helper removes inherited `ELECTRON_RUN_AS_NODE`,
forces hidden/no-focus settings, and prepares a unique APFS clone on macOS.
Never replace the returned path or environment with the original inputs.

The original package remains unchanged. The automation copy has modified
launch metadata, so report original artifact identity and copied launch path
separately. A hidden copy tests packaged application behavior. It does not prove
the original signature, Gatekeeper startup, Dock registration, or activation.
The `LSUIElement` edit breaks a Developer ID seal and macOS kills such an app
about two seconds after launch, so the preparer re-signs the copy ad hoc without
the hardened runtime; the original bundle is never touched.

## Visible acceptance and ownership

Dock reactivation and production LaunchServices tests have visible assertions.
Run them on an isolated hosted CI runner. On this Mac they require the user's
explicit request for that visible run and the documented production-identity
opt-in. Setting `CI=true` locally does not authorize or isolate a visible run.
Keep these assertions intact; do not substitute hidden-copy results.

Before parallel GUI work, identify the current app path, PID, profile, and owner.
Reserve the automation slot and sequence launches with dependency installs.
Clean up only the processes and bundles created by the current run. Preserve
the user's installed app, primary dev session, and other tasks' processes.
