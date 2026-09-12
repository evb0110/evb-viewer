# Adversarial review archive — scan-cleanup process rebuild

Four review rounds hardened `../DEV-VALIDATION-APPROACH-2026-08-14.md`
before it became operative:

| Round | Reviewers | Report files here |
|---|---|---|
| 1 | fable-high, opus-high, sol-xhigh | `round1-sol-xhigh.md` |
| 2 | fable-high, opus-high, sol-xhigh | `round2-sol-xhigh.md` |
| 3 | opus-xhigh, sol-xhigh (exhaustive) | `round3-sol-xhigh.md` |
| 4 | opus-xhigh, sol-xhigh (exhaustive, final) | `round4-sol-xhigh.md` |

Only the Codex (sol) reports exist as standalone files; the Claude-side
reviews (fable, opus) ran as in-session subagents, so their full text
lives in session transcripts outside the repository (per the approach's
T2 policy that raw transcript material stays out of the repo). Their
findings and dispositions are incorporated in the approach document
itself — each version's change log and the Part 5 round-4 disposition
section record which reviewer raised what and how it was resolved.

The reports are archived verbatim as emitted by the reviewer runs.
Markdown links inside them use absolute paths from the authoring
machine and references to `.devkit/` (machine-local, untracked) — they
are historical citations, not live links; do not "fix" them, as the
archive's value is that it is unedited.
