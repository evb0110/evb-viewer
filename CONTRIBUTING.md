# Contributing

Thanks for helping improve EVB Viewer. This project is currently maintained by its owner, with code contributions limited to approved contributors. Ideas, bug reports, and feature requests are welcome as GitHub issues.

## Contribution Policy

- If you are not already an approved contributor, please open an issue instead of a pull request.
- Unsolicited pull requests from unapproved contributors will be closed without review. This avoids asking contributors to spend time on code that the maintainer may need to redesign or reimplement.
- Approval is by prior invitation from the maintainer. Opening an issue or pull request does not itself grant contributor status.
- A detailed issue is the best way to contribute: explain the problem, the desired outcome, relevant use cases, and any examples or screenshots that may help.

This policy may change as the project and its maintenance capacity evolve.

## Development

1. Install dependencies with `pnpm install`.
2. Start the desktop development flow with `pnpm dev`, or the browser workspace with `pnpm dev:web`.
3. Keep secrets and local-only paths in `.env` files or ignored `.devkit/` files. Use `.env.example` and `landing/.env.example` as templates.

## Checks

Run `pnpm validate:iteration` while editing and `pnpm validate` for the
change's affected checks. Run a targeted behavior or platform test when it
covers a risk that the selected plan cannot exercise. See
[local checks](docs/local-gates.md) for explicit broader and release commands.

Keep tests small and useful. Give an invariant one owning suite with the cases
and platforms it needs. Remove duplicate checks and obsolete test helpers as
you touch them. Remove a check when its value is unclear. Source spelling, file
length, coverage percentages, mock counts, and review rounds are not acceptance
outcomes. Keep actual behavior, data-integrity, and security checks.

Add a test file, CI job, workflow, npm check script, lint rule, vitest project,
or git hook only when the person asking for the change asked for that check.
Proof, acceptance, and evidence mean running the affected checks that exist.
Extend an existing test only when user-observable behavior changed and no
check covers it. The commit-msg hook, the pre-push hook, and CI reject a
commit that adds a check unless its message carries an
`Adds-Checks: <the words that asked for it>` trailer. Deleting or editing a
check needs no trailer.

Use one independent reviewer and one correction follow-up when review adds
value. Optional suggestions do not reopen acceptance. An extra review needs a
specific unresolved high-risk question. The pre-push hook checks commit
attribution. Validation runs through the commands above and hosted CI.

For a change to native tool packaging or resource selection, the resource check
can exercise that boundary:

```bash
pnpm run check:resources:matrix
```

For a change that needs packaged-tool proof, use the existing build or hosted CI:

```bash
scripts/verify-packaged-native-tools.sh <mac|win|linux> <x64|arm64>
```

See [Design Principles](docs/architecture/design-principles.md) for the
architectural criteria that reviews apply and that these checks only partly
mechanize.

## Pull Requests

Pull requests are accepted only from approved contributors who have been invited by the maintainer. If you have not been invited, open a bug report or feature request instead; unsolicited pull requests will be closed without review.

- Keep pull requests focused and explain the user-visible behavior change.
- Include screenshots or recordings for UI changes.
- Cover changed behavior with a useful existing or new test. Avoid a new test when an existing check already detects the defect.
- Leave unrelated formatting, generated files, and local artifacts out of the diff.

## Manual Fixtures

Large PDF regression files are intentionally not committed. Put local-only diagnostic PDFs under `.devkit/manual-pdf-fixtures/` or set the `EVB_E2E_*` paths documented in `.env.example`.
