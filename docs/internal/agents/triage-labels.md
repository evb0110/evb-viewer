# Triage labels

Issues live in GitHub; use `gh`. Workflow labels: `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`.

## Platform labels

Every issue carries exactly one or more `platform:` labels saying where the defect
reproduces, which is not the same as where it was observed. An audit run on the
Linux VPS that finds a cross-platform save bug is `platform:any`.

| Label               | Meaning                                                    |
| ------------------- | ---------------------------------------------------------- |
| `platform:any`      | Reproduces on every platform; no OS-specific work           |
| `platform:macos`    | macOS-specific behavior, runner, or API                     |
| `platform:linux`    | Linux-specific behavior, runner, or filesystem              |
| `platform:windows`  | Windows-specific behavior, runner, or path handling         |
| `platform:web`      | Browser build only, not the Electron desktop app            |

Apply more than one OS label when a defect is confirmed on some platforms and
absent on others. Use `platform:any` rather than listing all four.

## Origin and defect family

These two labels measure whether fixes hold: how often an owner-reported defect
family comes back within 14 days.

| Label | Meaning |
| --- | --- |
| `owner-observed` | The owner found it using the app by hand: a video, a screenshot, or a description of what they saw |
| `robot-found` | An automated real-app journey, the dev-build monitor or the explorer found it; triage it before it becomes work |
| `family:<slug>` | The stable defect family, named after the violated statement of the [behavior contract](../../architecture/behavior-contract.md) |

When a task starts from something the owner saw in the app, find or create one
issue for it with `owner-observed`, exactly one `family:` label, and the platform
label. Link the fix commit in a comment. Reuse an existing family when the
symptom violates the same contract statement, even if the cause differs; create
a new `family:` label only when none fits. Do not rename a family to make a
recurrence look new.

Current families: `family:viewport-anchor` (R3), `family:navigation-intent` (R1,
R2), `family:note-window-anchor` (A2), `family:annotation-geometry` (A1),
`family:fit-overflow` (L1), `family:blank-surface` (L2), `family:chrome-layout`
(L4), `family:close-lifecycle` (C1).

A family reappears when a new `owner-observed` issue is created in it within 14
days after the previous one's fix commit. List them with:

```bash
gh issue list --state all --label owner-observed --limit 200 \
  --json number,title,labels,createdAt,closedAt
```
