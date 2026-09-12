# UTM live transport investigation

Date: 2026-09-05.

The live lab exposed failures that the fake-command tests did not exercise.
The image and launcher remain unqualified. This report records transport and
provisioning evidence, not Windows application acceptance.

## Launcher and Dock registration

The current session's process ancestry resolves to `/Applications/ChatGPT.app`.
UTM 4.7.5 answered its version and VM inventory requests without a new consent
prompt. That proves this launcher's current Automation access. It does not
qualify cold boots or grant another launcher access.

The user supplied a recording of a second UTM Dock icon repeatedly appearing
and disappearing during guest-file polling. Two controlled CLI invocations,
held waiting for standard input, produced these Launch Services classifications:

| Executable | Bundle association | Application type |
| --- | --- | --- |
| Installed `UTM.app/Contents/MacOS/utmctl` | `UTM.app` | `Foreground` |
| Byte-identical executable copied outside the app bundle | Standalone executable | `BackgroundOnly` |

The standalone copy passed `codesign --verify --strict`, matched the installed
executable's SHA-256, and returned UTM version 4.7.5. The running UTM application
and its lab helper process identities remained unchanged. The original denied
VM remained stopped. Raw classifications live under the host data root in
`provisioning/2026-09-05/dock-bundled.txt` and `dock-standalone.txt`.

UTM's [CLI source](https://github.com/utmapp/UTM/blob/v4.7.5/utmctl/UTMCtl.swift)
resolves a containing app bundle when present and otherwise targets
`/Applications/UTM.app`. Its `--hide` option closes the UTM library window;
it does not change the CLI process's Launch Services classification.
[Apple documents app registration keys](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/LaunchServicesKeys.html),
but changing the installed application's metadata would also change its signed
bundle. A verified standalone copy preserves the vendor binary and the user's
existing security settings.

Future preparation must refresh the standalone executable after a UTM update.
Every production entry point must use the same verified cache. A missing or
stale cache must yield a preparation remedy rather than silently switching to
the bundled executable. Doctor stays read-only. No TCC database edits, installed
app modifications, re-signing, or permission impersonation are part of this fix.

## UUID lookup

The host config and image manifest held a lowercase UUID. UTM listed the same
lab UUID in uppercase. `status` rejected the lowercase form with "Virtual
machine not found" and accepted the uppercase form. The CLI's source compares
the identifier as an exact string. The transport must uppercase UUID arguments
for every operation while retaining case-insensitive ownership comparisons.

## Guest completion

A PowerShell command that printed a marker and exited 37 returned host exit 0
with empty streams. Another command wrote a JSON inventory file, and a later
file pull retrieved valid JSON. Execution occurred even though the CLI did not
report its result.

The upstream CLI repeatedly reads `hasExited` from a result dictionary, but a
missing key ends its loop and missing result fields default to exit 0 and empty
output. Its Apple Event error handler can also print an error without returning
a failing process exit code. Neither behavior is a guest success signal.

Completion needs a unique guest-written record, a matching request identity,
real stdout and stderr, the actual command exit code, and a bounded deadline.
A missing, malformed, stale, or mismatched completion remains infrastructure
failure. Hash verification and guest readiness must consume this result rather
than infer success from dispatch. File transfer must also reject Apple Event
errors returned with exit 0.

## Provisioning evidence

The existing authorized lab copy booted and completed pending Windows updates.
The observed build is 26200.9168, version 25H2, on ARM64. The QEMU guest agent
runs as SYSTEM. Dedicated `EVBTester` and `EVBLabAdmin` accounts were created;
the test account is not an administrator. Test directories restrict access to
SYSTEM, Administrators, and the test SID, with modify rights limited to the
worker's output, state, and work directories. A scheduled probe running as the
standard test account confirmed writes succeed in outbox, state, and work,
and fail in inbox, staging, worker, node, and tools. Its result is retained as
`user-probe-result.json`.

The official ARM64 0.1.452 installer is cached and registered with source SHA
`02dfb20d0a32f65ed86162283ab9231725c17bcf` and SHA-256
`02d4d17dad6bec5d1de7233943ebd2dd1887be8af681d342d2b82756e75c4b07`.
The digest matches the [release asset](https://github.com/evb0110/evb-viewer/releases/tag/v0.1.452).
Its cache directory contains the release metadata and build identity sidecar.

Observed machine details and provisioning completion records remain outside
Git under `provisioning/2026-09-05/` in the host data root. Account credentials
remain in the private host secrets directory. This report contains no original
VM UUID or bundle path.

The first unattended test-account logon produced an unlocked, interactive
heartbeat in session 1 with medium integrity and the Default input desktop.
The scheduled task runs as the standard test account. UAC was enabled and
verified after reboot; Defender remained active. The user requested silent
tests. Removing the stopped lab's Sound device caused two observed firmware
stalls without a guest-agent connection. Restoring its original `intel-hda`
device restored boot and guest-agent access. Keep that device layout intact;
the first quiet-startup attempt set and verified guest endpoint mute. The
failed cold-boot evidence remains recorded and does not count as qualification.

At 07:00:23 UTC, the live audio helper ran as the standard test account on the
Default desktop and verified all three default render roles muted. The evidence
is `audio-mute-live.json`. That first helper used the SDK order for the
[IAudioEndpointVolume COM methods](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/endpointvolume.h),
called `SetMute`, then checked `GetMute`. At that stage, logon startup ran this
helper before Node and refused to start the worker if mute verification failed. The lab's
sound hardware and the host volume remain unchanged.

The updated scheduled task then started Node with no main window. Its process
ID and start time matched the heartbeat. After a stopped-to-started cold boot,
automatic sign-in reached the same standard account, the helper again verified
all audio roles muted, and a new boot ID reached an unlocked interactive
heartbeat. `quiet-cold-boot-result.json` records this check. It is one baseline
boot, not the required three disposable-clone restores.

The user subsequently reported that Windows sounds still occurred. These
successful endpoint-mute readings did not prove silence. At 07:34:22 UTC,
provisioning stopped the lab's `Audiosrv` service and changed its startup mode
from Auto to Disabled. `disable-lab-windows-audio-*.json` records both states.
The retained startup policy now requires the service to be Disabled and Stopped.
Endpoint mute alone is no longer an accepted quiet-testing check.

A cold boot at 07:47:42 UTC produced a fresh standard-account service-policy
record at 07:52:45 UTC, with Audiosrv still Disabled and Stopped. The new worker
then reached an unlocked Medium-integrity Default desktop. Evidence is
`audio-service-cold-boot.json`. Sign-in exceeded the initial observation deadline;
this is a policy-persistence check, not a passing reset-time qualification.
No acoustic observation has yet confirmed silence under the stronger policy.

The heartbeat previously reported the short-lived PowerShell probe's process
ID. The worker now passes its own PID, and the probe verifies that Node is its
parent before reporting Node's identity and start time.

QGA transferred the 31,418,167-byte Node archive in 162.2 seconds. The WinApp
archive exceeded a 180-second provisioning transfer deadline. Provisioning
downloaded the official WinApp archive inside the lab and verified the same
SHA-256 before extraction. This was tool provisioning; repeatable candidate
staging needs the read-only ISO path and independent guest hash verification.

## First disposable run

Run `20260905T071416Z-53cd6aad538c` acquired the host lease, copied the stopped
baseline, registered a distinct clone, and reached an interactive desktop. It
failed before installation because Joliet shortened the 75-character input
filenames to 64 characters. The host had expected the original names.

Input media now uses the full 64-character digest without a prefix or extension.
A mounted-image check verified all 13 complete filenames and file hashes, plus
the marker hash. Its evidence is `joliet-mounted-verification.json`. The failed
run's logs remain under its run directory. After inspection, its stopped clone
was removed, with the identity checks and reason recorded in `clone-disposal.json`.

The same attempt exposed cancellation checks that started only after job
publication. The coordinator now checks for cancellation while booting, waiting
for an interactive desktop, and staging inputs, and before publishing a job.
Unit regressions cover cancellation during boot and staging. Live cancellation
of the corrected path remains to be checked.

## Second disposable run

Run `20260905T072155Z-9e9a57140dc3` reached the standard interactive desktop
but failed before installation when directory creation exceeded the 30-second
transport deadline. A separate real command completion probe took 57.246 seconds
and returned its exact quoted Unicode input, stderr, and exit 37. Its evidence
is `exec-completion-live-quoted.json`.

Guest transport initially received a separate 120-second deadline. Native UI actions retain
their 30-second deadline. Transport failures report their cause before attempting
to interpret output as a file hash. The second run remains a failed acceptance
attempt, with no application test executed.

## Third disposable run

Run `20260905T075619Z-e28e95acb72d` reached the guest agent in 167.1 seconds
after clone start and the standard desktop immediately afterward. Its fresh
`audio-service-policy.json` confirms that the clone inherited Disabled and
Stopped Audiosrv.

The 274,496,382-byte installer reached the staging directory through the ISO.
The following separate hash-verification command then exceeded its 120-second
transport deadline. A later instrumented empty-command probe on the retained
clone took 91.5 seconds. Even a trivial command consumes much of that deadline;
the separate file copy is not the only bottleneck. `run3-staging-observation-*.json` records the installer size
and the idle worker heartbeat. No installer ran and no application test executed.

The documented stop command wrote a cancellation request while this attempt
was active, but the recorded terminal outcome is the transport failure. This
attempt therefore does not close the live cancellation gate. The stopped clone
was retained and subsequently restarted for scoped transport diagnosis.


The instrumented `-File` hash probe later passed in 57.385 seconds with exact
expected digest output, exit 0, and empty stderr. Evidence is
`transport-probes/exec-file-instrumented.json`. This disproves a consistent
`-File` translation failure, but does not establish why the earlier attempt
exceeded 120 seconds. The transport deadline is now 180 seconds, separate from
the unchanged 30-second native UI deadline. Batch staging removes repeated
copy and hash command round trips.

## Worker ownership during maintenance

Refreshing a scheduled task does not terminate an existing Node child.
The startup code previously had no worker-level exclusion, so two workers
could replace the heartbeat and boot ID in the same guest root.

The Node entry point now holds a Windows named pipe keyed by the normalized
guest root before modifying either identity file. A second worker fails to
start. Windows releases the pipe when its owner exits; no stale PID file or
process termination is needed to recover ownership. Unit tests cover exclusion
and release. `worker-lock-live-duplicate-*.json` records a real Windows duplicate
start failing with exit 1 while preserving the original heartbeat owner. After
the idle worker was terminated through its verified process handle, PID, start
time, and executable, the task restarted with a new worker and boot ID.
`worker-lock-live-restarted-heartbeat.json` records recovery. The same probe
confirmed Microsoft Print to PDF is present with status Normal.

## Fourth disposable run

Run `20260905T083249Z-ed4994ca48a6` stopped at the 180-second guest-readiness
gate. Its readiness probe still launched a supervised PowerShell command,
although previous trivial-command probes took 57 to 91.5 seconds.

Readiness now uses a read-only QGA pull of the lab marker file. This checks
transport availability without starting a guest shell. The following desktop
check still requires a matching boot token, a heartbeat newer than run start,
the expected lab marker, and an unlocked interactive session. Its ceiling is
now 180 seconds rather than 60, separate from the initial QGA-readiness ceiling.
The fifth attempt verified these readiness changes live; the fourth attempt remains failed.


## Fifth disposable run and UTM crash

Run `20260905T084422Z-b25bf938f923` reached QGA readiness 3.824 seconds after
clone start, then a fresh standard desktop 92.861 seconds later. Batch staging
copied and hash-verified all 13 inputs in 102.985 seconds. The host published
the application job at 08:48:30 UTC.

UTM crashed at 08:49:53 UTC with EXC_BAD_ACCESS in a CoreGraphics image-copy
and CoreAnimation rendering stack. The local crash report is
`~/Library/Logs/DiagnosticReports/UTM-2026-09-05-125001.ips`. This is an
infrastructure failure. The host did not collect a guest result, so it cannot
establish which installer or application steps ran before the crash.

Polling continued after the crash and an Apple Events command reopened UTM.
The operator canceled the attempt at 08:55:19 UTC. Its canceled summary is not
proof of a clean guest cancellation. The stopped clone was retained for
inspection.

A controlled recovery experiment disables automatic resolution and Retina
Mode on the retained disposable clone, then on the stopped lab baseline through UTM settings for the next fresh-run experiment. UTM documents that automatic resolution
changes with window size and recommends disabling Retina Mode to reduce
processing and memory overhead. These settings are an experiment, not a
proven crash fix. See the [UTM display documentation](https://docs.getutm.app/settings-qemu/devices/display/).


The recovered clone reported Audiosrv Disabled and Stopped again. Its worker
refused duplicate execution after finding the original started marker.
`run5-recovery-result.json` records that refusal, not a result of the original
interrupted execution. The retained source fixture in the run evidence shows
that the original worker progressed beyond initial job validation. A subsequent
read-only recursive inventory exceeded 180 seconds and supplied no usable result.

Host commands now require one existing UTM process and pin its executable,
PID, and start time. Missing or replaced processes prevent subsequent Apple
Events dispatch. This reduces unintended app restarts but cannot eliminate the
race between the process check and an Apple Event. Result polling also fails
when the owned clone is no longer running. Cancellation reports a request and
does not claim that the guest received it.


The recovery refusal exposed a guest evidence bug: its failure writer replaced
the existing worker log and manifest. The worker now checks for an existing
started marker or result before reading a new job and returns without writing
those run paths. Tests preserve exact prior result, log, manifest, and artifact
bytes even when the replacement job is malformed. The final prepared worker
was hash-verified in the lab as
`ee2d53632611ada66433bfbd1b90c9cd01021aefd366db15fe18653e842e4dc3`.


`doctor-no-relaunch-live.json` records a live host check with every VM stopped
and UTM closed through its UI. Doctor exited 3 with `utm-app-running` false,
and a subsequent process check confirmed that UTM remained closed. UTM was
then opened normally for the next acceptance attempt.


Run `20260905T092154Z-9fcb987afe97` correctly refused to start because the
retained-clone limit had been reached. After inspection, the stopped fifth
clone was disposed of and its host evidence retained. Its `clone-disposal.json`
records that action. No application case ran in the retention-limit attempt.


## Seventh attempt reaches the installed application

Run `20260905T092328Z-e78f6680b38a` used the fixed-display experiment and
completed staging in 163.532 seconds after desktop readiness. It installed
ARM64 EVB Viewer 0.1.452.0 under the standard account and verified the installed
executable SHA-256 as
`fa37c86bb7024c696ef9b003054bacbfaa64ddf9519ed6a3d4ab6a98af1f8fe0`.
The host collected and validated `guest-result.json` and the source fixture.
UTM did not crash during this attempt.

WIN-PRINT-01 failed while opening its source PDF. The renderer helper waited
for an automation API that the launcher had not enabled. The app also displayed
its first-launch Default Viewer dialog. No printed PDF was produced, and the
host correctly reported the required cold and warm outputs as missing.
This is a failed acceptance run, not a print or oracle pass.

`fresh-audio-service-policy.json` records the clone's fresh standard-account
logon with Audiosrv Disabled and Stopped. Earlier `observed-*.json` files captured
copied baseline records before logon and must not be used as fresh-run evidence.


A standard-account WinApp probe captured the actual first-launch dialog.
`first-launch-ui-live.json` records title Default Viewer, class `#32770`, and
Not Now as Button `CommandLink_102`. The process-scoped invoke succeeded with
InvokePattern; the following window list contained only the main app window.
`first-launch-invoke-live.json` records the result. No default-app registration
was changed.

After the retained clone rebooted, its original guest result remained byte-for-byte
identical to the host copy, SHA-256
`0f9fd5c18ec7b83cb1457a555aabf7e775ab3753eea312f5e9a7906155ce3109`.
`run7-result-preservation-live.json` records this live preservation check.


A focused standard-account probe of the repaired launcher opened the 12-page
source fixture in the retained seventh clone. `viewer-factory-probe.json`
records the page count and the installed app process. The launcher now supplies
the renderer automation variables only for instrumentation runs, and strips
inherited automation variables from both launch profiles before applying the
explicit instrumentation settings. This also confines instrumentation profiles
to the requested test directory. Acceptance launches receive no renderer helper.

The next probe exposed another missing step. `handlePrint` opens the renderer
print-options dialog; it does not submit a native print request. Waiting for
a Windows dialog immediately after that command cannot test printing. This
probe is evidence of document opening only, not a print pass.


## Repeated screenshot crash

UTM crashed again at 10:00:22 UTC during the retained-clone print probe. The
new report, `UTM-2026-09-05-140022.ips`, again shows CoreGraphics image copying
and CoreAnimation layer commit. Fixed guest resolution did not prevent it.
A raw provisioning file read reopened UTM after the crash. The production
runner already guards Apple Events; the local provisioning helper now checks
and pins the app process too. Agents must apply that rule to diagnostic commands
as well as normal runs.

[Upstream issue 7745](https://github.com/utmapp/UTM/issues/7745) reports a
similar UTM 4.7.5 crash caused by a screenshot image retaining freed SPICE
pixel memory. This is a plausible match, not a confirmed diagnosis of our
crash. With every VM stopped, UTM was quit normally and its documented
`NoScreenshot` preference set to true before reopening. This disables UTM's
periodic preview capture for the app; guest display and test screenshots remain
available. `utm-screenshot-preference.json` records the previous unset value
and the change. Repeated live runs must establish whether it prevents recurrence.


The renderer dialog capture, `viewer-print-dom.json`, showed the packaged
printer icon class as `i-ph:printer`. The corrected selector submits the visible
Print button and retains the native print path. A DOM regression now uses that
observed markup. A following live probe displayed the Windows print UI with
Microsoft Print to PDF selected. This build uses the modern Windows print
dialog, so the original `#32770` window record did not match. Native control
qualification and output verification remain open.


`viewer-native-print-save-probe.json` records successful UI Automation selection
of Microsoft Print to PDF, invocation of `PrintButton`, filename ValuePattern
entry, and the Save button invocation. The resulting `printed-probe.pdf` is
62,077 bytes, SHA-256
`35a7c47422a96e59024a1d6a8d4695236d3510cf0585aecdbc4b364ec7cc16b0`,
with 12 letter-size pages and Microsoft Print To PDF as producer. The host
nonblank renderer passed all 12 pages. Text marker extraction failed because
this print path rasterized the pages. That failure is retained in
`printed-probe-oracles.json`; it must not be described as an oracle pass.
The print-target oracle needs rendered-page OCR to verify exact markers and
order without requiring an extractable PDF text layer.


The baseline received worker SHA-256
`6d6ee87b9f19d20f5775afb2b1eefbfd126a5061e41a1af4317e0bb0acb04b2a`
after the launcher and native-dialog fixes. The guest verified that exact hash
and Audiosrv Disabled/Stopped before shutdown at 10:24 UTC. A normal
`utmctl start` then completed without errors. Diagnostic `start --hide` calls
had reported OSStatus -10004 while still starting the VM; subsequent state
inspection, not retrying the mutation, established that the start succeeded.
The production runner uses normal `start` and does not request that UI-hiding
side effect.


The final-worker cold boot produced boot ID
`boot-055bccbf-9a34-4e02-b921-8a8f06574296`, an unlocked desktop, and
a fresh Audiosrv Disabled/Stopped check. Evidence is in
`final-worker-coldboot-heartbeat.json` and `final-worker-coldboot-audio-mute.json`.
The baseline was then shut down normally. `doctor-live-pre-run.json` passes
Automation consent, candidate integrity, the stopped baseline, and the
NoScreenshot preference. Image and launcher qualification remain false.


The explicit OCR oracle passed every marker in the actual printed PDF, in
page order. `printed-probe-ocr-oracles.json` records that result together with
the nonblank rendering pass. OCR applies only to the host-owned WIN-PRINT-01
cold and warm output targets. Other PDF cases still require text extraction.
Missing OCR tooling or an OCR process failure is inconclusive; a wrong or
missing marker fails. The oracle renders the known fixture marker region and
does not accept expected text from the guest.

After integration into current main, all 1,342 script tests passed across
174 files, as did scripts/test TypeScript checks and lint on changed TypeScript
files. The integrated worker SHA-256 is
`04cbed042c6fcb1f5043fc0d6e322a789786a6a6c0b328437e8696383a36eb83`.

## Eighth attempt closes the real print slice

Run `20260905T104407Z-b65415a73ba0` reached the real native print and save
journey. The guest produced nonblank PDFs with all twelve OCR markers in order,
but the host PDF geometry oracle correctly rejected both outputs because
Microsoft Print to PDF was using Letter (`612 x 792` points) while the numbered
fixture contract is A4. This was a Windows image policy defect, not a renderer
or transport success. Its oracle record remains at
`runs/20260905T104407Z-b65415a73ba0/oracle-results.json`.

The permanent repair adds `configure-test-printer.ps1` to provisioning and the
logon task. Administrator provisioning sets Microsoft Print to PDF to A4. Each
interactive logon verifies that setting and refuses to start the worker when it
drifts. The same task verifies that `Audiosrv` is Disabled and Stopped, so a
guest sound event cannot be produced by the Windows audio service during a
test. A fresh baseline boot recorded both policies in
`provisioning/2026-09-05/printer-policy-cold-boot.json` and
`provisioning/2026-09-05/audio-service-printer-cold-boot.json`, with an
unlocked Medium-integrity Default-desktop heartbeat in
`provisioning/2026-09-05/printer-policy-worker-heartbeat.json`.

Run `20260905T112228Z-3fc2426250dd` then passed the complete real workflow. It
started a disposable clone, staged the fixture, installed and launched the
ARM64 candidate, drove the modern Windows print dialog, saved cold and warm
Microsoft Print to PDF outputs, pulled the artifacts through UTM, and ran the
host PDF structure, rendered-page, OCR marker, and generated-PDF checks. Both
outputs are twelve-page A4 PDFs (`595.32 x 841.92` points). The complete
records are `runs/20260905T112228Z-3fc2426250dd/summary.json`,
`guest-result.json`, `oracle-results.json`, and `evidence-manifest.json`; the
PDFs are under
`runs/20260905T112228Z-3fc2426250dd/evidence/artifacts/WIN-PRINT-01/`.

This is the first real Windows application acceptance pass. It does not close
the image or launcher package. Three cold-reset cycles, repeated-run and
two-terminal gates, later-day stability, and human review remain open. The
NoScreenshot preference prevented another observed UTM crash in this run, but
it remains a mitigation rather than a qualified upstream fix.

## Standalone transport verification after the Dock fix

Preparation was rerun from the current checkout. The source executable and the
prepared copy both hash to
`288e61a73f0b70d9986687a8adc0f05bf2009e8f3843754288d2d174551c8ba5`. A fresh
`pnpm windows:test:doctor --json` process then listed the registered VMs through
the prepared copy at
`~/Library/Application Support/EVBViewerWindowsTests/caches/tools/utmctl-probe/utmctl`.
The doctor report records that path in the `utmctl-present` detail. It did not
fall back to `/Applications/UTM.app/Contents/MacOS/utmctl`.

The process table had no dedicated Windows test coordinator to restart. The
only long-lived `tsx` processes were the existing Electron and Nuxt development
session, which was left running. The transport check therefore used a fresh
CLI process so the updated `utmctlClient.ts` was loaded from disk.

## Host input ownership acceptance

The UTM window was inspected through its supported Accessibility controls. Its
`Capture Input` checkbox reported value `0`, and UTM's help text identified
Command+Option as the supported release chord. The checked-in probe uses that
chord and re-reads the checkbox. It never presses the checkbox. The first
attempt to release an already-off control returned `before: 0`, `after: 0`, and
`hostInputAvailable: true`.

Two fresh CLI runs then started disposable clones from the stopped golden image,
completed WIN-PRINT-01, passed every host oracle, and tore the clones down:

| Run | Reset path | Result | Input evidence |
| --- | --- | --- | --- |
| `20260905T130111Z-c46c356e37b2` | Cold clone from stopped golden image | Passed, exit 0 | `runs/20260905T130111Z-c46c356e37b2/input-capture-launch.json`, `input-capture-cleanup.json` |
| `20260905T131030Z-531f4a3b421d` | Repeated cold clone from stopped golden image | Passed, exit 0 | `runs/20260905T131030Z-531f4a3b421d/input-capture-launch.json`, `input-capture-cleanup.json` |

All four records report `after: 0` and `hostInputAvailable: true`. The second
run's clone was also removed, and the registered lab golden image is stopped.
The host input guard runs after every owned `start`, before guest work begins,
and in test, stop, teardown, and error cleanup paths. Image and launcher
qualification remain unset because the broader M0 and M1 reset and review
gates still require their own evidence.
