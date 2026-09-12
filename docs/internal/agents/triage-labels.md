# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

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
