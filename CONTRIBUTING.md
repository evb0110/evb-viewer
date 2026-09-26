# Contributing

Thanks for looking. EVB Viewer is maintained by one person, and the most
useful things you can send are usually not code.

## What helps most

- **A scan that comes out wrong.** Cleanup and OCR are the hard parts of this
  project, and a page that defeats them is worth more than a bug report about
  it. Describe the source and what you expected; see
  [what scans work](docs/user/what-scans-work.md) for the document classes the
  engine is built for.
- **Bug reports and feature requests**, through the issue templates.
- **Translations.** The app and the landing site ship several locales and they
  drift. Corrections to any of them are welcome.
- **Documentation fixes**, including anything in this file that turned out to
  be wrong.

## Code changes

Open an issue first, whatever the size of the change. That is the part I most
want from you: the problem, the document that triggered it, and what you
expected instead. Deciding whether a change is worth making, and what shape it
should take, is most of the work.

If we agree it is worth making, I will usually write it myself. This is a
one-person design with invariants that are faster for me to satisfy than to
explain, and the architecture still moves under them, so a patch written
against last month's shape costs you an evening and costs me a redesign. Tell
me in the issue if you want to implement it, and I will say whether I am
already on it.

Small, obvious fixes are the exception: a typo, a broken link, or a one-line
correction can go straight to a pull request.

When something is self-contained enough to hand over, I label it
`good first issue`. That label is often empty, so an empty list means nothing
fits right now, not that help is unwelcome. Say in an issue that you would like
something to work on and I will find one.

Most of the open issues are my own work queue rather than an invitation. The
ones with a bracketed code in the title, like `[SCAUD-84]`, come out of internal
audits and are written for whoever picks them up next, usually me.

## Development

Full setup, commands, and the checks are in
[docs/contributing/development.md](docs/contributing/development.md).

1. Install dependencies with `pnpm install`.
2. Start the desktop development flow with `pnpm dev`, or the browser workspace with `pnpm dev:web`.
3. Keep secrets and local-only paths in `.env` files or ignored `.devkit/` files. Use `.env.example` and `landing/.env.example` as templates.

## Checks

Run `pnpm lint`, `pnpm typecheck`, and the affected unit or integration tests.
Run a targeted behavior or platform test when it covers a risk those checks do
not exercise. See
[local checks](docs/contributing/local-gates.md) for explicit broader and release commands.

Keep tests small and useful. Give an invariant one owning suite with the cases
and platforms it needs. Remove duplicate checks and obsolete test helpers as
you touch them. Remove a check when its value is unclear. Source spelling, file
length, coverage percentages, mock counts, and review rounds are not acceptance
outcomes. Keep actual behavior, data-integrity, and security checks.

For a change a user could see or feel, proof means the behavior observed in the
running app: reproduce the report in a hidden session with real input, show the
same script failing before the change and passing after it, and keep it as a
real-app regression test when the behavior can regress. A passing command is not
proof that a visible bug is gone. When reproduction fails, report "mitigation
applied, not confirmed" with what was attempted. The full procedure, including
the verifier role for delegated work, is in
[fix evidence](docs/internal/agents/fix-evidence.md); expected behavior comes
from the [behavior contract](docs/architecture/behavior-contract.md). For other
changes, proof means running the affected checks that exist.

Do not add tests that assert private call sequences, call counts, or arguments
passed to a mocked collaborator. When you touch a test, check that it would
reject a plausible wrong implementation of the contract it protects; replace or
delete it if it cannot.

Add a test file, CI job, workflow, npm check script, lint rule, vitest project,
or git hook only when the person asking for the change asked for that check. One
focused real-app regression test in an existing lane for a user-facing fix is
pre-authorized: commit it with
`Adds-Checks: real-app regression for a user-facing fix`. New runners, jobs,
lanes, frameworks or monitors still need the request.
Extend an existing test only when user-observable behavior changed and no
check covers it. The commit-msg hook, the pre-push hook, and CI reject a
commit that adds a check unless its message carries an
`Adds-Checks: <the words that asked for it>` trailer. Deleting or editing a
check needs no trailer. The same trailer covers a test retry, a wall-clock
sleep, a raised timeout, or a step allowed to fail: fix the flake or delete the
check instead of tolerating it (see [Flaky checks](docs/contributing/local-gates.md#flaky-checks)).

Use one independent reviewer and one correction follow-up when review adds
value. Optional suggestions do not reopen acceptance. An extra review needs a
specific unresolved high-risk question. Validation runs through the commands
above and hosted CI.

For a change to native tool packaging or resource selection, the resource check
can exercise that boundary:

```bash
pnpm run fetch:runtime-binaries
```

For a change that needs packaged-tool proof, use the existing build or hosted CI:

```bash
scripts/verify-packaged-native-tools.sh <mac|win|linux> <x64|arm64>
```

See [Design charter](docs/architecture/design-charter.md) for the
architectural criteria that reviews apply and that these checks only partly
mechanize.

## Pull Requests

Open an issue first for anything beyond a small obvious fix, so the approach is
agreed before you write code.

- Keep pull requests focused and explain the user-visible behavior change.
- Include screenshots or recordings for UI changes.
- Cover changed behavior with a useful existing or new test. Avoid a new test when an existing check already detects the defect.
- Leave unrelated formatting, generated files, and local artifacts out of the diff.

## Manual Fixtures

Large PDF regression files are intentionally not committed. Put local-only diagnostic PDFs under `.devkit/manual-pdf-fixtures/` or set the `EVB_E2E_*` paths documented in `.env.example`.
