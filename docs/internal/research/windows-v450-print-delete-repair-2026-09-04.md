# Windows 0.1.450 print and page deletion

## Report and acceptance

The reporter uses Windows 11 Pro and EVB Viewer 0.1.450. Printing produces an
empty file of about 3 KB. The page deletion failure has a confirmed sequence:
delete pages at the beginning of a book, save, then delete pages at the end.
The second deletion reports `page-ops:delete-ranges` and
`Page identity state belongs to a stale document revision`. Repeating it fails
again. The reporter's original PDF was not supplied.

Acceptance uses a numbered PDF with text and vector content. Delete leading
pages, save, delete trailing pages, save, and reopen. Verify the surviving page
markers and page count. Print through Microsoft Print to PDF and inspect the
saved PDF's text and rendered content. Repeat the sequence in Windows under
UTM on the local Mac.

## Initial reproductions

The official 0.1.450 ARM64 installer reproduces the deletion failure in Windows.
Deleting the first page leaves 11 pages. Save advances the document revision
to 3 while the identity ledger retains revision 2. Deleting the last page then
fails. The repair keeps the stale-operation fence and advances the identity
ledger inside the shared revision transaction. The regression also covers
publication failure, recovery, rollback, corrupt ledgers, and legacy ledgers.

On the same Windows installation, Microsoft Print to PDF turns a fresh
12-page fixture into an 881-byte, one-page PDF with no text. The output passes
`qpdf --check`, showing why structural checks alone cannot detect this bug.
Its SHA-256 is
`e320a829d5582c3121a4179f7ca1eb4dc0cf3548c328c96b616f1189a0885c15`.

The app attached its content security policy to every response in Electron's
default session. Its `frame-ancestors 'none'` directive blocked Chromium's
built-in PDF viewer subframe with `ERR_BLOCKED_BY_RESPONSE`. A standalone
Windows comparison confirms the cause. Without the app header, the hidden
PDF window emits readiness after 1,422 ms. With the header, the viewer subframe
fails and never emits readiness, even after showing the window. The repair
limits the app header to its trusted renderer origin and preserves the PDF
viewer's own response headers. App CSP and permission restrictions remain.

A hidden Electron 43.4.1 window reproduces empty PDF output when printing after
`ready-to-show` but before `-pdf-ready-to-print`. The generated-text fixture
produced a 943-byte PDF without text. Waiting for the PDF readiness event
produced 106,165 bytes with the expected text. This first runtime reproduction
used immediate printing, so it establishes the readiness race but does not
prove the existing two-second delay fails for that small fixture.

A 2,243-page fixture takes 2,631 ms to emit readiness, exceeding the old delay.
Immediate printing produces 969 bytes and no text. Readiness-gated printing
produces 181,074,972 bytes, 2,243 pages, and the expected text.

Electron emits the PDF readiness event when the PDF viewer removes its print
restriction. The application must subscribe before loading the PDF and wait
for that event before native print dispatch. Cancellation and failed loading
must remove the listener. The readiness deadline starts after the initial
load resolves, so loading time does not consume the plugin readiness budget.
Renderer exit, destruction, and window closure also terminate the wait.

A later Windows run exposed an unbounded `ready-to-show` wait before the PDF
readiness promise. That ordering could mask the readiness timeout and leave
"Preparing print" indefinitely. The PDF path now waits directly on plugin
readiness. `ready-to-show` supplies diagnostics only. Regression tests cover
printing when that event never arrives and timeout when neither event arrives.

## Windows VM recovery

The existing ARM64 VM initially stalled at firmware `Start boot option` under
UTM 4.6.5. Cold boot reached automatic repair and then stalled again. Its disk,
configuration, UEFI variables, and TPM state were preserved before repair.

The official UTM 4.7.5 build 118 update reached Windows recovery. The OS volume
was accessible as F:, with the EFI and recovery partitions present. The
Startup Repair log's final boot-log, bugcheck, and cloud-remediation checks
reported zero error codes. A normal boot reached the guest agent, then
restarted during desktop initialization. Changing the display device to
unaccelerated `virtio-ramfb` allowed Windows to reach and retain its desktop.
Windows reports Professional edition, version 25H2, build 26200.8655.
The recovery retained the original disk and TPM state. No Windows reset or
reinstallation was needed. A normal restart returned to the desktop, and the
guest's live OS caption confirms Microsoft Windows 11 Pro.

The backup's EFI boot files report version 10.0.28000.342, while its WinRE
image reports 26100.8655, from the 24H2 build family. Those file versions do
not identify the running OS, which the guest confirms as 25H2. The downloaded
official 25H2 ARM64 ISO is recovery
boot media only, not an offline component-repair source for an unmatched OS.
Its SHA-256 is
`638aa2c88e94385b00f4f178d071e3df0b7d9e335577a83bd533b7f2eb65adf0`.

## Verification status

The full typecheck and affected validation pass, including 1,308 related tests
and the architecture boundary check. The affected scan-cleanup native oracle
reports zero catastrophes. The final affected validation includes the CSP
correction and passes lint, typechecking, and all 96 related test files.

The first patched Windows candidate passes delete-first, save, delete-last,
save. Both sidecars advance together, page IDs remain stable, and the saved
PDF contains the expected ten markers, original pages 2 through 11. The PDF
passes structural and rendered compatibility checks. Its print attempt
stops at the readiness deadline, which exposed the separate CSP failure.
The corrected CSP candidate prints the original fixture through Microsoft
Print to PDF as 12 visible pages, 198,835 bytes. Its SHA-256 is
`dd4b497ac3a06af406261e5ab0cf5ac4cef663b5c611bb12d2f1500188925752`.
The driver converts text to outlines, so plain text extraction is empty.
Rendered OCR finds every expected marker from `WIN450-PAGE-01` through
`WIN450-PAGE-12`. The compatibility classifier reports zero failures, and the
contact sheet shows all 12 pages with text, borders, and colored circles.

The final V6 candidate repeats delete-first, save, delete-last, save in a
fresh Windows profile. The saved PDF has ten pages and markers 02 through 11.
Its SHA-256 is
`d655221441991f175b1f75b1ec3a0f55b98aa63a1dd1383fbde7e0230981de59`.
Both successive Microsoft Print to PDF jobs reach the native dialog and
produce 165,964-byte PDFs with ten pages. Their SHA-256 hashes are
`ff7cdcefe6d3a57f437404d40b7179c5c1950c84f672cbfe8ec01579c5a9843a`
and
`ae2a85e21d74c0e15607925016d9e9059914f19211065105ee9e9d6bdef5f1b1`.
Reopening the first printed PDF in
EVB Viewer shows original page 2 first and original page 11 last. All three
outputs pass the rendered compatibility classifier with zero failures.
The Windows trace records PDF readiness before native dispatch. It also
records `ready-to-show` on this successful run, so it does not establish why
that event was absent or missed in the earlier stalled run.

The tested candidate uses Electron 43.4.1 and the official 0.1.450 ARM64 native
binaries, whose source is unchanged by this repair. Its replacement app.asar
SHA-256 is
`d89022276b096318194175315a25e06175715bd4741d021d9f17341f0745d3b7`.
The actual guest is ARM64 Windows 11 Pro. The reporter's CPU architecture and
original book remain unavailable, so this proof covers the reported sequence
on the numbered fixture, not that exact book or an x64 guest.

Three local CodeRabbit passes reviewed the complete change against `main`.
Accepted findings added stricter revision fences, rollback coverage after an
actual identity rebase, renderer lifecycle cleanup, and a readiness deadline
that starts after loading. Recovery also quarantines unfenced ledgers when a
revision sidecar is corrupt, with or without a pending journal. Access-denied
revision reads fail closed. The leaf rebase function still rejects a missing
revision fence. The final affected validation passes after those corrections.

## Primary references

- [UTM Windows display issue](https://github.com/utmapp/UTM/issues/6332)
- [UTM 4.7.5 release](https://github.com/utmapp/UTM/releases/tag/v4.7.5)
- [Electron blank print report](https://github.com/electron/electron/issues/43235)
- [Electron PDF readiness change](https://github.com/electron/electron/pull/43436)
- [Microsoft Windows recovery environment](https://support.microsoft.com/en-us/windows/experience/backup-recovery/windows-recovery-environment)
- [Microsoft Windows 11 ARM64 media and hashes](https://www.microsoft.com/en-us/software-download/windows11arm64)
