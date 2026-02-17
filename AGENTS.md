# Agent Instructions

These instructions apply to all agents spawned in this project.

## Foundation

**Rule**: Read and follow all instructions in `CLAUDE.md` before starting work.

CLAUDE.md contains project conventions for TypeScript, Vue, scoped styles, icon bundling, and task completion checks. All agents must adhere to these rules.

- If something in this document or in CLAUDE.md is erroneous, feel free to fix, just don't be too verbose

## Verification with Electron Puppeteer

**Rule**: Only if asked by user verify changes you made using the `electron-puppeteer` skill.
Don't verify them piecemeal, only in large batches for speed

The skill is located at `.claude/skills/electron-puppeteer/SKILL.md`. Read it to understand available commands.

**Verification workflow:**
1. After making changes, build the Electron code: `pnpm run build:electron`
2. Start a Puppeteer session: `pnpm electron:run start &`
3. Wait for "Session ready", then verify:
   - `pnpm electron:run health` — confirm `openFileDirect: "function"`
   - `pnpm electron:run screenshot "verify-<change-name>"` — visually confirm the change
   - Test the specific feature you modified (click, type, navigate as needed)
4. Check for regressions: verify existing functionality still works
5. Stop the session when done: `pnpm electron:run stop`

**If the skill fails or behaves unexpectedly:**
- Investigate the root cause (check console output, error messages, process state)
- Fix the issue in `.claude/skills/electron-puppeteer/SKILL.md` if the documentation is wrong or incomplete
- Fix the underlying scripts if the tooling itself is broken
- Document the fix so future agents don't hit the same issue

**If any of the scripts doesn't work:**
- Follow the same flow as for non-working skill: investigate and fix the issue

## Branching ##
NB! Never create branches or switch to branches unless explicitly asked by user or if it's done by your harness

## Commit and Push Workflow

**Rule**: Commit and push after every major verified change.

**Rule**: If you find unrelated changes in the branch, you may proceed with your own work without asking for explicit permission, just don't touch those changes.

After confirming a change works and introduces no regressions:

1. Run completion checks: `pnpm lint && pnpm typecheck`
2. Fix any lint or type errors before committing
3. Stage the files you changed (not `git add -A` — be specific)
4. Commit with a clear message focused on "why"
5. Push to the remote branch
6. Don't touch or (most importantly) reset unrelated changes. 
7. Unless user asks you to commit everything / all changes, only commit the changes you made

Do NOT batch multiple unrelated changes into a single commit. Each commit should represent one logical unit of work.

## Cross-Arch Checks

**Rule**: If your change touches Electron runtime, native binaries/tools, OCR/DjVu paths, workers, or packaging, run architecture checks before finishing.

Required commands:
1. `pnpm lint && pnpm typecheck`
2. `pnpm run check:resources:matrix`
3. If a packaged build exists for a target, run `scripts/verify-packaged-native-tools.sh <mac|win|linux> <x64|arm64>` for that target/arch.

Do not ship Electron changes that rely on `eval` workers or runtime package lookup in production paths.

## Autonomous Continuation

**Rule**: Continue to the next stage of work autonomously after completing the current one.

When you finish a stage:
- Do NOT ask the user for permission to continue
- Do NOT pause to report progress and wait for confirmation
- Assess what the next logical step is and proceed immediately
- If the task has multiple stages, work through all of them sequentially
- Only stop when all stages are complete or you encounter an ambiguous decision that genuinely requires user input

**What counts as "genuinely requires user input":**
- The requirements are unclear or contradictory
- Multiple valid approaches exist with significant trade-offs the user should decide
- A destructive or irreversible action outside the scope of the original task

**What does NOT require user input:**
- Moving to the next file or component in a multi-file change
- Fixing lint/type errors introduced by your changes
- Choosing between equivalent implementation approaches
- Deciding the order of subtasks within a clear overall goal

## Dirty Repo Handling

**Rule**: If unrelated changes are already present (dirty worktree), continue working.

- Do not modify unrelated files
- Do not stage unrelated files
- Do not revert unrelated changes
- Only touch files required for the current task
