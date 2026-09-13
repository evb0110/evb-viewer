# Windows test lane: setup and repair

This guide is the retained setup for the UTM Windows lane on a Mac. It is
versioned with the runner. A repository pull must never overwrite the
machine-specific configuration it describes, because that configuration lives
outside the checkout.

## Host requirements

| Item | Requirement | How doctor checks it |
| --- | --- | --- |
| macOS session | The coordinator runs in the logged-in GUI session, not over SSH | `SSH_CONNECTION` unset and the launchd manager is `Aqua` |
| UTM | 4.7.5 (QEMU 10.0.2) installed at `/Applications/UTM.app` | `utmctl version` parses to the supported version |
| UTM preview capture | `NoScreenshot=true` for UTM 4.7.5 on this host | Read-only preference check before readiness and runs |
| Automation consent | The launcher that runs `utmctl` (Terminal, iTerm, a LaunchAgent) has Automation permission for UTM | `utmctl list` succeeds; OSStatus -1743 is reported as missing consent, not as an SSH problem |
| Data root | `~/Library/Application Support/EVBViewerWindowsTests/` exists with `config.json` | Config loads and validates |
| Disk | Free space above the configured reserve for one clone plus evidence | Free bytes compared with `retention.minFreeBytes` |
| Candidate | A hash-verified NSIS installer registered in the config or passed with `--artifact` | File exists and its SHA-256 matches |
| Printed page markers | Tesseract available to the host runner for rasterized print outputs | Missing OCR makes marker verification inconclusive, never passing |
| Python oracle | `python3` with Pillow for the generated-PDF verifier | Missing tooling makes the render oracle inconclusive, never passing |
| Host input ownership | UTM `Capture Input` is off for the active lab window | Accessibility probe reads the checkbox before launch and after cleanup; a remaining on state blocks the run |

Set `EVB_WINDOWS_TESTS_ROOT` only for tests or a second lab root. The default
root is the one above.

## Data root layout

```text
EVBViewerWindowsTests/
  config.json            host allowlist, golden image, candidate, retention
  host.lock              exclusive host lock (directory)
  lease.json             current VM lease: host, VM UUID, run ID, owner PID and start time
  images/
    baselines/           stopped, immutable golden images and their manifests
    evb-win-test-*.utm    working copies created per run; failed copies retained here
  caches/
    artifacts/           candidate installers by SHA-256
    fixtures/            generated fixture packs by manifest hash
    tools/               pinned guest tools (Node runtime, winapp CLI)
  runs/<RUN_ID>/         job.json, transitions.ndjson, host.log, guest-result.json,
                         evidence/, evidence-manifest.json, summary.json
  mailbox/               cancellation requests from `windows:test:stop`
```

## First-time host configuration

1. Run `pnpm windows:test:prepare`. It creates the host directories, builds
   `caches/tools/worker/guestWorker.cjs`, copies its PowerShell helpers, and
   generates seven fixtures, copies four tracked fixtures, and writes `caches/fixtures/manifest.json`. It preserves
   existing configuration and refuses to change inputs while a run lease exists.
   It also stages a byte-identical standalone copy of the installed `utmctl` in the
   tools cache. Running it outside `UTM.app` prevents a foreground Dock icon for
   every polling call. Preparation verifies the copy; doctor rejects a stale or
   missing copy with a preparation remedy. It does not create a VM or qualify
   Windows automation.

2. Create a `config.json` like the one below. Placeholder
   UUIDs are shown. Replace `goldenVmId` with the identity of the fresh lab
   image. An empty `allowedTestVmIds` is valid before the first run. The runner
   adds only the new clone identity to its in-memory policy. Never add the
   golden image or personal VM to the destructive allowlist.

   ```json
   {
     "schemaVersion": 1,
     "testImageRoot": "/Users/<you>/Library/Application Support/EVBViewerWindowsTests/images",
     "allowedTestVmIds": [],
     "goldenImageId": "win11-arm64-pro-25h2-baseline-001",
     "goldenVmId": "11111111-2222-4333-8444-555555555555",
     "personalVmIdsDenied": [],
     "candidate": null,
     "environment": "utm-win11-arm64-app-arm64",
     "qualifiedLaunchers": ["/System/Applications/Utilities/Terminal.app"],
     "retention": {
       "passDays": 7,
       "failureDays": 30,
       "maxFailedClones": 1,
       "minFreeBytes": 32212254720
     }
   }
   ```

3. Verify the actual launcher and grant Automation consent only if needed. Run the read-only `pnpm windows:test:doctor` from the launcher you
   will use. If macOS denies the request, grant Automation access to UTM in
   System Settings. Do not paste raw VM listings into reports. Repeat for each
   launcher and record its application path in `qualifiedLaunchers`. Doctor detects the enclosing application from process ancestry, with
   `TERM_PROGRAM` as a Terminal or iTerm fallback. For other launchers, set
   `EVB_WINDOWS_TESTS_LAUNCHER` to the qualified application path. This records
   the launcher identity, it does not grant macOS permission. Keep
   `qualifiedLaunchers` empty until a launcher's consent is verified; doctor
   keeps such a host unqualified.

   If the launcher never appears with a UTM entry, inspect its signed entitlements
   and `NSAppleEventsUsageDescription`. A hardened-runtime launcher needs
   `com.apple.security.automation.apple-events` to send Apple Events. The installed
   T3 Code Nightly build inspected on 2026-09-05 lacks both entries. Its UTM request
   fails with -1743 without exposing a UTM toggle. This requires a corrected launcher
   build, or a user-started run from a separately authorized terminal. Permission
   granted to ChatGPT does not grant permission to T3. Do not edit the TCC database
   or re-sign a running launcher as a workaround. See
   [Apple's Apple Events entitlement documentation](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events).
4. Build the separate golden image below. Doctor will continue to fail the
   image and candidate checks until those prerequisites exist. Run it again
   after completing setup.

## Golden image build

The normal source is Microsoft Windows 11 Pro ARM64 media in a new UTM VM.
The existing lab on this host is a recorded exception: the user authorized a
one-time stopped copy of the personal VM on 2026-09-05. Continue provisioning
that lab copy. The original remains denied as every automated operation target.
Copying does not remove personal files, credentials, or inherited settings.

1. Install Windows with a nonproduction local account for the test user and a
   separate local administrator. Keep UAC, Defender and device encryption at
   their defaults and record the activation state. Probe these settings before
   acceptance, including on a copied lab. The authorized lab copy inherited
   disabled UAC, so provisioning must enable it and verify it after reboot.
   Record encryption and activation status without exporting recovery keys or
   product keys. Confine test activity to the dedicated account and test root.
2. As administrator, create the guest directories and ACLs:
   `C:\EVBViewerTests\inbox`, `outbox`, `state`, `staging`, `work`. SYSTEM and
   Administrators get full control; the test user gets read on `inbox` and
   `staging`, modify on `outbox`, `state` and `work`; other users get no
   access. Verify the effective rights from both accounts.
3. Write `C:\EVBViewerTests\state\test-marker.json` with exactly the keys
   `imageId` and `guestTestMarker`. Use the configured image ID and a random
   marker value. The same values go into the image manifest.
4. Install a Windows ARM64 Node 22 runtime on the lab image. Copy the prepared
   `caches/tools/worker/` directory to `C:\EVBViewerTests\worker`. The host
   preparation command does not download Windows tools. The native UI driver
   and selector records still require the M0b on-image feasibility checks.
5. Register the worker logon task by running
   `scripts/windows-test/guest/powershell/register-worker-logon-task.ps1`
   as administrator. The task starts the worker in the test user's
   interactive session at logon and writes the boot ID. Its hidden PowerShell
   entry point validates the lab marker and standard test account, verifies
   Windows Audio is stopped with startup disabled and Microsoft Print to PDF
   is set to A4, then starts Node without a console window.
   Registration runs `disable-test-audio.ps1` to configure the lab's `Audiosrv`
   service and `configure-test-printer.ps1 -Configure` to set the printer
   policy. `state\audio-mute.json` and `state\printer-policy.json` record the
   checks. A failed policy check prevents worker startup. It stores no credentials.
   The Node entry point holds a Windows named pipe for the guest root before
   changing heartbeat or boot identity. A second worker must refuse to start.
   Updating a scheduled task does not terminate its existing Node child. After
   refreshing the worker, cold-boot the baseline and verify a fresh heartbeat
   before making test clones. Do not kill processes by executable name.
6. Decide the sign-in policy for unattended cold boots. The lane does not
   choose a personal-account autologon. If automatic sign-in for the isolated
   lab account is not configured, runs after a reset are assisted and the
   ledger's M0a gate stays open.

   If a copied image has only an administrator account, use the retained
   `scripts/windows-test/guest/powershell/ensure-standard-test-user.ps1` helper
   from an elevated guest-agent command or an elevated PowerShell opened by the
   native-input route. Pipe a disposable password to its standard input. The
   helper prints only the account name and `standard=true`, removes the account
   from Administrators, and adds it to Users. Sign out and sign in as that
   account before registering or starting the worker. The worker's administrator
   token refusal remains enabled.
7. Keep the baseline device layout stable. The lab booted with Intel HD Audio,
   stalled in firmware after removing that device, and booted again after
   restoring it. Endpoint mute reported success but the user still heard
   Windows sounds. Quiet testing therefore disables the lab's Windows Audio
   service and verifies its state at worker logon. Keep the virtual audio card
   and host volume unchanged.
   Remove installation media and external drive references. Keep every disk,
   EFI and TPM file inside the lab bundle, with no symbolic links. Shut the VM
   down and keep its bundle under the configured `testImageRoot`, normally
   `images/baselines/`. Write `images/baselines/<goldenImageId>.json` with the
   observed identity and configuration below. Set `goldenVmId` and
   `goldenImageId` in the host config.

   Before promotion, verify the Drive entries without printing full paths:

   ```sh
   plutil -convert json -o - "/absolute/path/to/<golden>.utm/config.plist" \
     | jq '[.Drive[] | {interface: .Interface, removable: (.Removable // false), imageName: (.ImageName // "" | split("/")[-1] | split("\\\\")[-1])}]'
   ```

   With every VM stopped and UTM quit normally, back up `config.plist`. Remove
   only removable or CD entries with no image, or entries whose image is
   outside the bundle. Delete Drive entries from the highest index first so
   later indices do not move. For example, this removes two empty CD entries
   at indices 2 and 0 while preserving the system disk:

   ```sh
   cp -p "/absolute/path/to/<golden>.utm/config.plist" \
     "/absolute/path/to/<golden>.utm/config.plist.pre-media-removal.bak"
   /usr/libexec/PlistBuddy \
     -c 'Delete :Drive:2' \
     -c 'Delete :Drive:0' \
     "/absolute/path/to/<golden>.utm/config.plist"
   ```

   Run the redacted Drive listing again. Confirm that every remaining
   `ImageName` is a basename inside the bundle, that the bundle has no
   symbolic links, and that `pnpm windows:test:doctor` passes before changing
   the golden-image fields.
8. Run `pnpm windows:test:doctor` again. The golden VM must be stopped and
   registered.

The manifest must match `scripts/windows-test/images/imageManifest.ts`. This
example is unqualified. Replace its placeholders with observed lab values;
keep qualification fields null until the ledger's cold-reset checks pass.

```json
{
  "schemaVersion": 1,
  "imageId": "win11-arm64-pro-25h2-baseline-001",
  "vmId": "11111111-2222-4333-8444-555555555555",
  "bundlePath": "/Users/<you>/Library/Application Support/EVBViewerWindowsTests/images/baselines/EVB-Lab-Golden.utm",
  "createdAt": "ACTUAL_UTC_CREATION_TIME",
  "windowsBuild": "ACTUAL_WINDOWS_BUILD",
  "osArch": "arm64",
  "utmVersion": "4.7.5",
  "qemuVersion": "10.0.2",
  "driverVersions": {"qemu-guest-agent": "ACTUAL_VERSION"},
  "disks": [{"diskId": "ACTUAL_DISK_ID", "purpose": "Windows system disk", "resetPolicy": "restore-from-baseline"}],
  "guestTestMarker": "THE_MARKER_FROM_THE_GUEST",
  "qualifiedAt": null,
  "qualification": null
}
```

After updating the runner, prepare the host files again and refresh the worker
copy in the lab image before requalifying it. `prepare` changes host files only.

## Candidate artifacts

Pass a candidate with `--artifact /absolute/path/to/EVB-Viewer-Setup.exe`.
This is a one-run override, it does not update `config.json` or copy the
installer into the cache. Place a build identity sidecar next to the installer
with the suffix `.meta.json`, for example:

```json
{"version":"0.1.450","sourceSha":"FULL_BUILD_COMMIT_SHA","appArch":"arm64"}
```

Use the actual build identity. To make a candidate the default, record its
absolute `artifactPath`, `fileName`, `version`, `sourceSha`, `appArch` and
SHA-256 as `candidate` in the host configuration. The runner checks the file
against that digest. There is no implicit latest build.

## Running

```sh
pnpm windows:test:doctor
pnpm windows:test --suite critical
pnpm windows:test:report --run RUN_ID
```

### Native-input provisioning recovery

Use the retained windows:test:provision command when a stopped or newly
copied QEMU VM has no QEMU guest agent. This route needs a logged-in Aqua
session, UTM Automation consent for the launcher, enough free space for one
clone, and Screen Recording permission if screenshots are part of the
qualification. The clone must be registered under a test-only name, have its
bundle inside testImageRoot, and be claimed from one before/after UTM
inventory. The personal VM named Windows is never an owned target. A one-time
campaign authorization to copy it does not change this reusable policy.

Create a local-only plan under .devkit with vmId, bundlePath, beforeVmIds, and
steps. The step kinds are scanCodes, keystroke, mouseClick, pushFile, and
pullEvidence. Keep the plan
out of commits and logs. Run:

~~~sh
pnpm windows:test:provision --plan /absolute/path/to/.devkit/windows-provision-plan.json
~~~

The command rechecks the existing identity guard before every event. It sends
only UTM's QEMU native AppleScript input commands, using an exact claimed UUID.
keystroke text must be ASCII. The command prints step numbers and two readiness
fields only. A pushFile step stages a command or secret through the guest file
channel. A later keystroke runs the pushed script with all output redirected to
a guest result file, and pullEvidence retrieves that file. It never prints
input text, UUIDs, bundle paths, passwords, or evidence payloads.

guestAgentAvailable is true only when the existing guest channel can read the
lab marker through QEMU guest agent transport. workerReady is true only when
that transport can read a current worker heartbeat. Input delivery does not
make either state ready. After each input event, take a fresh screenshot of the
clone's UTM window and inspect it before sending the next event. Resolve the
window by its registered test-only display name. If capture fails, grant Screen
Recording to the launcher and record that infrastructure gap rather than
claiming a guest state.

For the missing-agent branch, first observe guestAgentAvailable=false. Use
native input to sign in, open an elevated PowerShell with Win+R and
Ctrl+Shift+Enter, then run a short command that downloads or reads the
prepared recovery script from the lab's approved host-served URL or UTM
shared directory. That script installs QEMU guest agent, creates the marked
guest directories, installs the pinned Windows Node runtime, copies the
prepared worker and PowerShell helpers, and registers
register-worker-logon-task.ps1. Reboot or sign out and back in as required.
The flow is complete only after the guest channel reads the marker and the
worker publishes a fresh heartbeat. If the marker becomes readable but the
heartbeat does not, report guestAgentAvailable=true and workerReady=false and
repair the worker separately.

When the agent is available, stop using native typing for file transfer and
diagnosis. Run `utmctl file push` for the prepared worker and
`ensure-standard-test-user.ps1`, then run the registration and start commands
with `utmctl exec`. Pull `state/startup-validation.json`,
`state/worker-logon.json`, and `state/heartbeat.json` with `utmctl file pull`.
The first file records account, desktop, marker, and policy failures. A
heartbeat is the only evidence that the worker is ready. A successful task
registration or a delivered input event does not count.

Before any account change or reboot, run the allowlisted
`ensure-guest-agent-service.ps1` helper through `utmctl exec`. It checks the
installed service, sets `qemu-ga` to Automatic, applies restart actions for
failures, and returns bounded service metadata plus event IDs from the System
log. Do not copy event message text into host output. If the service is not
installed, return to the missing-agent native-input branch and install it
before continuing.

For a no-logon recovery, the retained `scripts/windows-test/guest/autostart-worker.cmd`
and `machine-startup-scripts.ini` can be pushed into the Windows Startup and
Group Policy Machine Startup locations. The command writes
`state/autostart-marker.json` before launching Node. Push the worker bundle and
Node archive beside the command, stop and start the clone, then use bounded
marker and heartbeat pulls. Empty or merely readable files are not success;
the marker content must identify the attempted stage.

Successful evidence consists of the redacted provisioning output, fresh
screenshots for each input step, the guest marker read, a fresh heartbeat with
the Windows build and architecture, and the normal run evidence under
runs/<RUN_ID>/. Do not preserve a failed lab clone after the campaign. Stop
it, delete it through the owned target path, confirm no test clone remains, and
check free space with df. Confirm the original Windows VM is stopped and was
not modified.

## Decision path

1. Run `pnpm windows:test:prepare`. Pass when the standalone `utmctl` copy and
   metadata verify. If it fails, repair preparation and stop before polling.
2. Resolve the clone from the structured local session identity. Pass when its
   bundle UUID and name match exactly one registered test VM. If identity or
   registration is ambiguous, stop without sending UTM commands.
3. Run the read-only screen and input-capture check before native input. Pass
   when the UTM window is identified and `Capture Input` is off. If screen
   capture fails, record the exact host permission error, request Screen
   Recording, and continue only with guest-agent evidence. Never infer guest
   login from a native input call returning successfully.
4. Boot or observe the owned clone, then pull the lab marker and boot token
   with the prepared standalone `utmctl`. Pass when the QEMU guest agent
   answers and the marker is non-empty. If the pull fails or is empty, inspect
   the guest-agent service through the supported evidence path before retrying.
5. Pull the heartbeat and boot token again. Pass only when the shared fresh
   interactive heartbeat check finds the current boot ID, matching lab marker,
   nonzero interactive session, Default desktop, and unlocked state, with a
   timestamp after this run. If it fails, pull bootstrap records, task output,
   worker stderr, and extraction evidence. Do not change logon settings until
   those records identify the first failed step.
6. Stage bootstrap files with verified push and host readback, or use the
   configured input media batch. Pass when every expected hash matches in the
   guest. If a hash differs, stop the run and preserve the evidence.
7. After fresh worker readiness, run the requested WIN-SAVE matrix. If the
   minimal `cmd.exe` guest-exec probe does not complete, record that as the
   first failing operation and leave the matrix unqualified.

## Observed qualification status

The prepared standalone `utmctl` path and the retained clone identity checks
work. The clone is registered and running. Guest file pulls complete, but the
returned state files are zero bytes. The first failing live operation is a
minimal `cmd.exe` guest-exec probe that does not complete. No fresh worker
heartbeat or WIN-SAVE measurement exists.

Screen capture is denied on this host with `could not create image from
display`. Record that host limitation and continue with guest-agent evidence;
it does not prove anything about guest login. Native input calls and absent
markers are not readiness evidence.

Every run copies the complete stopped lab bundle into the configured test-image
root, assigns a new UUID and network MAC addresses, imports it into UTM, and boots it.
The copy path does not use `utmctl clone`, which writes into UTM's own storage.
It then waits for the worker heartbeat with the current boot ID, stages the artifact
and fixtures with hash verification, writes the job, and polls the guest
outbox until the result or the deadline. The prepared read-only ISO uses full
64-character digest filenames, which fit Joliet without truncation. One guest
operation validates the media marker, copies the installer and fixtures, and
verifies every destination hash before job publication.
The summary and evidence stay under
`runs/<RUN_ID>/` and are never rewritten.

Guest-agent readiness uses a read-only marker-file pull. Desktop readiness
then requires a fresh matching heartbeat within 180 seconds; a copied heartbeat
from the baseline is rejected.

Host PowerShell transport has a 180-second command deadline. It is separate
from the 30-second native UI step deadline. A live transport probe took 57
seconds on this lab, and the old shared deadline stopped a real staging run.

### Host input ownership

The Windows lane keeps the host keyboard and mouse available throughout a run.
The launcher compiles and runs the checked-in macOS Accessibility probe
`scripts/windows-test/host/utmInputCaptureProbe.swift`. After every owned clone
starts, it finds that clone's UTM window by the registered display name and
reads the supported `Capture Input` toolbar checkbox. A checked control is
released with UTM's documented Command+Option chord, then read again. The
launcher does not click the checkbox and does not send guest keyboard or mouse
events through the host.

An absent window, ambiguous UTM process, missing checkbox, checked state that
survives the chord, or a UTM process that remains frontmost is an infrastructure
failure. The launch probe hides a focused UTM window before guest work begins.
The cleanup path repeats the release and hides a focused UTM window. The probe
records `before`, `after`, UTM PID, frontmost PID, and `hostInputAvailable` in
`runs/<RUN_ID>/input-capture-launch.json` and
`runs/<RUN_ID>/input-capture-cleanup.json`. Repeat the check after a cold reset
and keep both records with the run evidence. Both records must report
`after: 0` and `hostInputAvailable: true`. Never proceed from a screenshot or
from a unit-test result alone.

## Repair

| Symptom | Cause | Repair |
| --- | --- | --- |
| `doctor` reports `automation-consent-missing` with OSStatus -1743 | The current launcher has no Automation permission for UTM | Open System Settings, Privacy and Security, Automation, allow the launcher to control UTM; run doctor from that launcher; add it to `qualifiedLaunchers` only after its documented live qualification passes |
| A second UTM Dock icon appears and disappears while polling | The bundled CLI registers as a foreground application | Run preparation and use the verified standalone CLI. Do not edit UTM.app, re-sign it, or change TCC. See the [live transport report](../../internal/research/utm-windows-live-transport-2026-09-05.md). |
| UTM closes during a run | Host application crash or exit | Preserve the crash report and run evidence. The runner refuses commands after the pinned UTM process disappears or changes. Reopen UTM normally, inspect the stopped clone, and use a new run ID. |
| Host shortcuts stop working, UTM remains focused, or `Capture Input` is checked | The UTM display window captured or retained host focus | Release Command+Option in the active lab window. Run doctor and inspect the input-capture records. The launcher hides a focused UTM window and fails closed if capture remains on or UTM remains frontmost. It never clicks that checkbox. |
| Windows sounds occur during testing | Endpoint mute is insufficient or the audio service policy changed | Run the marker-checked administrator audio provisioning helper in the lab, then cold boot and verify `Audiosrv` is Disabled and Stopped. Worker startup refuses a failed check. |
| Print output is Letter instead of the A4 fixture geometry | Microsoft Print to PDF kept its Windows default paper size | Run `configure-test-printer.ps1 -Configure -GuestRoot C:\EVBViewerTests` as the lab administrator, then cold boot and confirm `state\printer-policy.json` reports `A4`. Worker startup refuses printer drift. |
| `status` reports VM not found for a registered UUID | UTM compares UUID arguments as case-sensitive strings | The transport must pass uppercase UUIDs for every operation; retain case-insensitive ownership checks. |
| `exec` returns exit 0 and empty output for a failing guest command | Dispatch completed without a valid guest result | Require the unique guest completion record and actual exit code. Never treat the CLI return alone as completion. |
| Exit 6 with an active run ID | Another coordinator owns the lease | Wait, or `pnpm windows:test:stop --run RUN_ID` from any terminal |
| Exit 6 but no coordinator process exists | Stale lease after a crash or host reboot | `pnpm windows:test:stop --run RUN_ID` performs stale-owner recovery under the host lock; it stops only the owned clone |
| Exit 3 "desktop not ready" | Guest is locked, in Session 0, or the logon task did not run | Sign in to the test user in the UTM window, confirm the task exists, then rerun |
| Exit 3 "image drift" | A pre-existing EVB installation, pending reboot, or unexpected OS build in the clone | Do not patch the clone; rebuild or requalify the golden image per the migration policy |
| Retained failed clone blocks the next run | `retention.maxFailedClones` reached | Inspect the clone, then delete it from the UTM UI, or raise the limit; the runner never deletes the only failure evidence automatically |
| Oracle reports `inconclusive` for rendering | `python3` or Pillow missing on the host | Install Pillow for the host `python3`; inconclusive is never a pass |
| `winapp` selector ambiguity error | Two controls match a selector on this Windows build | Update `tests/windows/native-ui/selectors.json` with the automation ID and record the verified image |

Never delete `lease.json`, `host.lock`, a run directory or a clone by hand
while a coordinator may be alive. The documented recovery path goes through
`windows:test:stop`.


## UTM preview capture crash mitigation

Two live attempts crashed UTM 4.7.5 in CoreGraphics image copying and
CoreAnimation commit. [UTM issue 7745](https://github.com/utmapp/UTM/issues/7745)
reports a similar screenshot lifetime bug. Fixed guest resolution did not
prevent the second crash. The lab host now uses `NoScreenshot=true`.

This is an application-wide preference that disables UTM's automatic VM
preview captures. It leaves guest display and worker screenshots available.
Record the old value, verify that every VM is already stopped, quit UTM normally, then use the
supported preference command `defaults write com.utmapp.UTM NoScreenshot -bool YES`.
Reopen UTM normally. If the previous value was unset, restore it with
`defaults delete com.utmapp.UTM NoScreenshot` after testing. See the
[UTM preferences documentation](https://docs.getutm.app/preferences/macos/).
Do not silently upgrade the shared app to a beta or claim this mitigation
fixes the upstream defect without repeated live-run evidence.
