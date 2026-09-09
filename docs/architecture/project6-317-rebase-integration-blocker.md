# Project 6 #317 rebase integration blocker

Date: 2026-09-07

The #317 task branch is rebased onto `origin/main` at
`c86dc691f1676c76194680973ff3537dc597a556`. The two task commits are now
`b894b6066f64d04b964de732f6583bdf821386f2` and
`14d2574876e5077a1817e2a67522ee919f315bae`. The #317 baseline and guard stay
unchanged at 998 violations across 328 files.

## Finding matrix

The current rebased tree reports nine unit-root findings. They are all in
remote-main test files outside the six #317 paths.

| File | Findings | Locations |
| --- | ---: | --- |
| `tests/unit/electron/ocrDocumentTextCatalogAgreement.test.ts` | 1 | line 195 |
| `tests/unit/electron/pageIdentityStore.test.ts` | 3 | lines 1219-1221 |
| `tests/unit/electron/scanCleanupPreview.test.ts` | 4 | file-level new-file review |
| `tests/unit/electron/workingCopyMutationQueue.test.ts` | 1 | line 48 |
| Total | 9 | |

These files were not changed by `80bf5a959` or `8116f884d`. The exact proof
uses the pre-task parent and the old task head:

```sh
git diff --quiet \
  1a65a1d6c95becdae4001f58efea847e02178b69 \
  8116f884d0af2c0b4b50962ae44f859662e36469 -- \
  tests/unit/electron/ocrDocumentTextCatalogAgreement.test.ts \
  tests/unit/electron/pageIdentityStore.test.ts \
  tests/unit/electron/scanCleanupPreview.test.ts \
  tests/unit/electron/workingCopyMutationQueue.test.ts
```

That command exits 0. The integration tree changes each file. These are the
content identities and diff sizes between the fetched c86 base and
`cc23798025347c685866ec15c9ffe05591a16867`:

| File | c86 blob | cc237 blob | `git diff --numstat c86..cc237` |
| --- | --- | --- | --- |
| `ocrDocumentTextCatalogAgreement.test.ts` | `507306e9a8ac6ff7d9ac5bfe5060af6eff1b500f` | `19337f06076cfd78a88ee50b5d7581cf55fb7070` | 22 added, 9 removed |
| `pageIdentityStore.test.ts` | `a246aa610e84251534ea38a7ec770da0946bdf76` | `b24ebff1354936f2b179a89e1f26de56b34e4c3f` | 8 added, 15 removed |
| `scanCleanupPreview.test.ts` | `9b875cb6e615832d0c434f3e8ec78904ea980ed4` | `92322660094811cd0efed7075706442f076682e5` | 7 added, 7272 removed |
| `workingCopyMutationQueue.test.ts` | `26f1496db40ece62974fdb7e71fe7159639b5f71` | `b9a54e738f9976122181fbb6d27f65c265be3d97` | 1 added, 1 removed |

## Reproducible lint comparison

Run the affected unit files from each tree without writing either tree:

```sh
for sha in \
  c86dc691f1676c76194680973ff3537dc597a556 \
  cc23798025347c685866ec15c9ffe05591a16867; do
  for file in \
    tests/unit/electron/ocrDocumentTextCatalogAgreement.test.ts \
    tests/unit/electron/pageIdentityStore.test.ts \
    tests/unit/electron/scanCleanupPreview.test.ts \
    tests/unit/electron/workingCopyMutationQueue.test.ts; do
    git show "$sha:$file" | pnpm exec eslint \
      --stdin --stdin-filename "$file" --no-warn-ignored
  done
done
```

The c86 snapshot reports 1 + 3 + 4 + 1 = 9 findings. The cc237 snapshot
reports zero. The full current integration-candidate unit-root lint still
reports the c86-side nine because this task worktree contains c86's files,
not cc237's integrated versions. This is an external integration blocker, not
an allowance decision for #317.

The guard still rejects a genuinely new unallowlisted file and any increase to
a listed count. A valid shrink remains accepted. The independent baseline
continues to record exactly 998 violations across 328 files. #319 owns future
max-lines ceilings and its allowlist; this note does not change that policy.

Do not add these nine findings to the #317 allowlist, weaken the guard, or edit
the remote-owned tests in this lane. Resolve the skew on the integration tree,
then rerun the unit-root lint there before starting another broad review.
