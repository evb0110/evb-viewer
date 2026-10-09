# PDF password-open retry

- Status: implemented for issue #178. The renderer retry loop is
  `openPdfAfterPasswordPrompt()` in
  `app/modules/workspace-shell/composables/document-session/openPdfAfterPasswordPrompt.ts`.
  It was added in commit `9dbd4cfc8`, which keeps the prompt open while a
  wrong password is checked.

Issue #198 chooses the document-open call graph as the password retry seam.
The renderer retry loop calls `openDocumentDirect` with the source path and the
password the user supplies. The Electron main process
owns each attempt: it creates an unowned working copy, proves the password with
the native PDF writer, and registers the working copy only after decryption
succeeds.

`TOpenFileResult` in `packages/contracts/electronApiDocuments.ts` carries the
result across the preload IPC codec. A successful attempt returns `kind: 'pdf'`.
An encrypted PDF that needs another attempt returns
`kind: 'pdf-needs-password'` and retains only `originalPath`. A PDF whose
encryption is not supported returns `kind: 'pdf-unsupported-encryption'`.
The two failure kinds carry no working-copy path, so the renderer cannot
publish a partial or failed attempt.

The main process writes the password to a managed mode-600 scratch file and
deletes that directory after the native writer returns, including failure and
abort paths. The startup managed-scratch sweep removes a directory left by a
process that exits before its cleanup path runs. The native writer always
writes a separate output, then atomically replaces the temporary working copy
only after it reports a valid decrypted result. A wrong-password result leaves
the encrypted source untouched. The open attempt's cleanup path removes any
unclaimed working copy on cancellation, navigation, renderer destruction, or a
failure before publication.

The working-copy creation IPC remains a separate snapshot call graph. Password-protected
opens call the document-open method, and the renderer retry flow handles the two
failure kinds. Keep that boundary: password failures must not be encoded as
rejected working-copy IPC calls, and an arbitrary working-copy string must not be
treated as an open result.
