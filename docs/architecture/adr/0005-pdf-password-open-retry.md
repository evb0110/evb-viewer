# PDF password-open retry

- Status: implemented for issue #178. The renderer retry loop is
  `openPdfAfterPasswordPrompt()` in
  `app/modules/workspace-shell/composables/document-session/openPdfAfterPasswordPrompt.ts`.
  It was added in commit `9dbd4cfc8`, which keeps the prompt open while a
  wrong password is checked.

Issue #198 chooses the document-open call graph as the password retry seam.
The renderer retry loop calls `openDocumentDirect` with the source path and the
password the user supplies. The Electron main process
owns each attempt: it opens a document-store directory, proves the password
with the native PDF writer and returns the document reference only after the
first mutation commits decrypted bytes. A failed attempt discards its directory.

`TOpenFileResult` in `packages/contracts/electronApiDocuments.ts` carries the
result across the preload IPC codec. A successful attempt returns `kind: 'pdf'`.
An encrypted PDF that needs another attempt returns
`kind: 'pdf-needs-password'` and retains only `originalPath`. A PDF whose
encryption is not supported returns `kind: 'pdf-unsupported-encryption'`.
The two failure kinds carry no document reference, so the renderer cannot
publish a partial or failed attempt.

The main process writes the password to a managed mode-600 scratch file and
deletes that directory after the native writer returns, including failure and
abort paths. The startup managed-scratch sweep removes a directory left by a
process that exits before its cleanup path runs. The native writer writes separate output, and the document store
commits its revision only after decryption and append-base normalization succeed.
The encrypted source stays untouched. Cancellation, navigation, renderer
destruction or failure before the open publishes releases the unclaimed document.

Snapshot creation remains a separate call graph. Password-protected
opens call the document-open method, and the renderer retry flow handles the two
failure kinds. Keep that boundary: password failures must not be encoded as
rejected snapshot IPC calls, and an arbitrary document reference must not be
treated as an open result.
