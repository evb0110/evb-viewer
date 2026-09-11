import { getCliErrorMessage } from './lib/cli-error.mjs';
import { execFileSync } from 'node:child_process';
import {
    existsSync,
    readFileSync,
    readlinkSync,
    readdirSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '..');
const DEFAULT_BASE_REFS = ['origin/main'];

export function parseArgs(argv) {
    const options = {
        apply: false,
        completed: null,
        help: false,
        into: [...DEFAULT_BASE_REFS],
        target: null,
    };
    for (const arg of argv) {
        if (arg === '--apply') {
            options.apply = true;
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg.startsWith('--completed=')) {
            options.completed = arg.slice('--completed='.length).trim() || null;
        } else if (arg.startsWith('--target=')) {
            options.target = arg.slice('--target='.length).trim() || null;
        } else if (arg.startsWith('--into=')) {
            const refs = arg.slice('--into='.length).split(',').map(ref => ref.trim()).filter(Boolean);
            options.into = [...new Set([
                ...options.into,
                ...refs,
            ])];
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return options;
}

export function parseWorktreeList(porcelain) {
    const worktrees = [];
    let current = null;
    for (const line of porcelain.split('\n')) {
        if (line.startsWith('worktree ')) {
            current = {
                path: line.slice('worktree '.length),
                head: null,
                branch: null,
                detached: false,
                bare: false,
            };
            worktrees.push(current);
        } else if (!current) {
            continue;
        } else if (line.startsWith('HEAD ')) {
            current.head = line.slice('HEAD '.length);
        } else if (line.startsWith('branch ')) {
            current.branch = line.slice('branch '.length).replace(/^refs\/heads\//u, '');
        } else if (line === 'detached') {
            current.detached = true;
        } else if (line === 'bare') {
            current.bare = true;
        }
    }
    return worktrees;
}

export function classifyWorktree(worktree) {
    if (worktree.isPrimary) {
        return {
            action: 'keep',
            reason: 'primary checkout',
        };
    }
    if (worktree.containsCwd) {
        return {
            action: 'keep',
            reason: 'current working directory',
        };
    }
    if (worktree.missing) {
        return {
            action: 'keep',
            reason: 'stale registration cleanup requires a safe metadata-only operation',
        };
    }
    if (worktree.dirtyEntries === null) {
        return {
            action: 'keep',
            reason: 'git status unavailable',
        };
    }
    if (worktree.dirtyEntries > 0) {
        return {
            action: 'keep',
            reason: `${worktree.dirtyEntries} uncommitted change(s)`,
        };
    }
    if (worktree.mergedInto.length === 0) {
        return {
            action: 'keep',
            reason: 'HEAD not merged into any base ref',
        };
    }
    if (!worktree.selectedTarget) {
        return {
            action: 'keep',
            reason: 'not the selected cleanup target',
        };
    }
    if (!worktree.completedTask) {
        return {
            action: 'keep',
            reason: 'completed-task evidence required',
        };
    }
    if (worktree.ownerStatus !== 'absent') {
        return {
            action: 'keep',
            reason: worktree.ownerReason ?? 'live-owner probe did not prove absence',
        };
    }
    return {
        action: 'remove',
        reason: `completed target merged into ${worktree.mergedInto.join(', ')}`,
    };
}

function readCompletionEvidence(filePath) {
    if (!filePath) {
        return null;
    }
    try {
        const evidence = JSON.parse(readFileSync(filePath, 'utf8'));
        if (evidence?.status !== 'completed'
            || typeof evidence.taskKey !== 'string'
            || evidence.taskKey.length === 0
            || typeof evidence.worktreePath !== 'string'
            || !/^[0-9a-f]{40}$/u.test(evidence.head)) {
            return null;
        }
        return evidence;
    } catch {
        return null;
    }
}

function isPathInside(parentPath, childPath) {
    return childPath === parentPath || childPath.startsWith(`${parentPath}${path.sep}`);
}

function probeSessionMetadataOwnership(worktreePath) {
    const sessionsPath = path.join(worktreePath, '.devkit', 'sessions');
    if (!existsSync(sessionsPath)) {
        return {
            status: 'absent',
            reason: null,
        };
    }
    let sessionNames;
    try {
        sessionNames = readdirSync(sessionsPath);
    } catch {
        return {
            status: 'ambiguous',
            reason: 'session ownership probe could not enumerate session roots',
        };
    }
    for (const sessionName of sessionNames) {
        const sessionPath = path.join(sessionsPath, sessionName);
        for (const fileName of [
            'session.json',
            'session-starting.json',
        ]) {
            const metadataPath = path.join(sessionPath, fileName);
            if (!existsSync(metadataPath)) continue;
            let metadata;
            try {
                metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
            } catch {
                return {
                    status: 'ambiguous',
                    reason: `session ownership metadata is unreadable: ${metadataPath}`,
                };
            }
            const pids = [
                metadata?.pid,
                metadata?.electronPid,
                metadata?.nuxtPid,
            ]
                .filter(pid => Number.isInteger(pid) && pid > 0);
            if (pids.length === 0) {
                return {
                    status: 'ambiguous',
                    reason: `session ownership metadata has no valid PID: ${metadataPath}`,
                };
            }
            for (const pid of pids) {
                try {
                    process.kill(pid, 0);
                    return {
                        status: 'active',
                        reason: `session metadata ${metadataPath} names live process ${pid}`,
                    };
                } catch (error) {
                    if (error?.code !== 'ESRCH') {
                        return {
                            status: 'ambiguous',
                            reason: `session ownership for process ${pid} could not be verified`,
                        };
                    }
                }
            }
        }
    }
    return {
        status: 'absent',
        reason: null,
    };
}

function processBelongsToCurrentUser(pid, currentUid) {
    try {
        const status = readFileSync(`/proc/${pid}/status`, 'utf8');
        const match = status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/mu);
        if (!match) {
            return null;
        }
        return match.slice(1).map(Number).includes(currentUid);
    } catch (error) {
        return error?.code === 'ENOENT' ? false : null;
    }
}

function probeWorktreeOwnership(worktreePath) {
    if (process.platform === 'win32' || !existsSync('/proc')) {
        return {
            status: 'ambiguous',
            reason: 'live-owner probe is unavailable on this host',
        };
    }
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (currentUid === null) {
        return {
            status: 'ambiguous',
            reason: 'live-owner probe cannot identify the current user',
        };
    }
    let pids;
    try {
        pids = readdirSync('/proc').filter(name => /^\d+$/u.test(name));
    } catch {
        return {
            status: 'ambiguous',
            reason: 'live-owner probe could not enumerate processes',
        };
    }
    for (const pid of pids) {
        const sameUser = processBelongsToCurrentUser(pid, currentUid);
        if (sameUser === false) continue;
        if (sameUser === null) {
            return {
                status: 'ambiguous',
                reason: `live-owner probe could not identify process ${pid}`,
            };
        }
        let ownerCwd;
        try {
            ownerCwd = readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/u, '');
        } catch (error) {
            if (error?.code === 'ENOENT') continue;
            return {
                status: 'ambiguous',
                reason: `live-owner probe could not inspect process ${pid}`,
            };
        }
        if (isPathInside(worktreePath, path.resolve(ownerCwd))) {
            return {
                status: 'active',
                reason: `process ${pid} has a cwd inside the worktree`,
            };
        }
    }
    return probeSessionMetadataOwnership(worktreePath);
}

function completionMatchesWorktree(completion, worktree) {
    return Boolean(completion) && completion.worktreePath === worktree.path && completion.head === worktree.head;
}

function git(args, cwd = projectRoot) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
}

function isAncestor(head, baseRef) {
    try {
        execFileSync('git', [
            'merge-base',
            '--is-ancestor',
            head,
            baseRef,
        ], {
            cwd: projectRoot,
            stdio: 'ignore',
        });
        return true;
    } catch {
        return false;
    }
}

function countDirtyEntries(worktreePath) {
    try {
        return git([
            'status',
            '--porcelain',
            '--untracked-files=normal',
        ], worktreePath).split('\n').filter(Boolean).length;
    } catch {
        return null;
    }
}

function refExists(ref) {
    try {
        git([
            'rev-parse',
            '--verify',
            '--quiet',
            `${ref}^{commit}`,
        ]);
        return true;
    } catch {
        return false;
    }
}

function directorySizeKiB(dirPath) {
    try {
        const output = execFileSync('du', [
            '-sk',
            dirPath,
        ], {
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        });
        const sizeKiB = Number.parseInt(output.split('\t')[0], 10);
        return Number.isNaN(sizeKiB) ? null : sizeKiB;
    } catch {
        return null;
    }
}

function formatReclaimed(reclaimedKiB) {
    return reclaimedKiB === null
        ? 'reclaimed size unknown (du unavailable)'
        : `reclaimed about ${Math.round(reclaimedKiB / 1024)} MiB`;
}

export async function collectWorktrees(baseRefs, {
    targetPath = null, completion = null, ownerProbe = probeWorktreeOwnership,
} = {}) {
    const cwd = await realpath(process.cwd()).catch(() => process.cwd());
    const missingRefs = baseRefs.filter(ref => !refExists(ref));
    if (missingRefs.length > 0) {
        throw new Error(`Unknown base ref(s): ${missingRefs.join(', ')}. Run git fetch --prune origin first.`);
    }
    const entries = parseWorktreeList(git([
        'worktree',
        'list',
        '--porcelain',
    ]));
    const worktrees = [];
    for (const [
        index,
        entry,
    ] of entries.entries()) {
        const worktreePath = await realpath(entry.path).catch(() => entry.path);
        const isPrimary = index === 0;
        const missing = !isPrimary && !existsSync(worktreePath);
        const owner = ownerProbe(worktreePath);
        const dirtyEntries = isPrimary || missing
            ? 0
            : countDirtyEntries(worktreePath);
        const mergedInto = isPrimary || !entry.head
            ? []
            : baseRefs.filter(ref => isAncestor(entry.head, ref));
        const worktree = {
            ...entry,
            path: worktreePath,
            isPrimary,
            containsCwd: cwd === worktreePath || cwd.startsWith(`${worktreePath}${path.sep}`),
            missing,
            dirtyEntries,
            mergedInto,
            completedTask: completionMatchesWorktree(completion, {
                path: worktreePath,
                head: entry.head,
            }),
            selectedTarget: targetPath === worktreePath,
            ownerStatus: owner.status,
            ownerReason: owner.reason,
        };
        worktrees.push({
            ...worktree,
            ...classifyWorktree(worktree),
        });
    }
    return worktrees;
}

function formatRow(worktree) {
    const label = worktree.branch ?? (worktree.detached ? `detached ${worktree.head?.slice(0, 9)}` : 'unknown');
    return `${worktree.action.padEnd(6)} ${label.padEnd(44)} ${worktree.reason.padEnd(38)} ${worktree.path}`;
}

export async function pruneWorktrees(options) {
    if (options.apply && (!options.target || !options.completed)) {
        throw new Error('Apply requires both --target=<worktree> and --completed=<receipt.json>.');
    }
    const completion = readCompletionEvidence(options.completed);
    const targetPath = options.target
        ? await realpath(options.target).catch(() => path.resolve(options.target))
        : null;
    if (options.apply && (!completion || completion.worktreePath !== targetPath)) {
        throw new Error('Completed-task evidence is missing, invalid, or does not name the target worktree.');
    }
    const worktrees = await collectWorktrees(options.into, {
        targetPath,
        completion,
    });
    const removable = worktrees.filter(worktree => worktree.action === 'remove');
    for (const worktree of worktrees) {
        console.log(formatRow(worktree));
    }
    if (removable.length === 0) {
        console.log('No removable worktrees.');
        return {
            removed: [],
            reclaimedKiB: 0,
        };
    }
    if (!options.apply) {
        console.log(`\n${removable.length} worktree(s) would be removed. Re-run with --apply to remove them. Branches are never deleted.`);
        return {
            removed: [],
            reclaimedKiB: 0,
        };
    }

    const removed = [];
    let reclaimedKiB = 0;
    for (const worktree of removable) {
        const latestCompletion = readCompletionEvidence(options.completed);
        const latest = (await collectWorktrees(options.into, {
            targetPath,
            completion: latestCompletion,
        }))
            .find(entry => entry.path === worktree.path);
        if (!latest || latest.head !== worktree.head || latest.action !== 'remove') {
            console.error(`kept ${worktree.path}: target changed or safety checks no longer pass`);
            continue;
        }
        if (worktree.missing) {
            console.error(`kept ${worktree.path}: stale registration cleanup requires a safe metadata-only operation`);
            continue;
        }
        const sizeKiB = directorySizeKiB(worktree.path);
        try {
            git([
                'worktree',
                'remove',
                worktree.path,
            ]);
            removed.push(worktree.path);
            reclaimedKiB = reclaimedKiB === null || sizeKiB === null
                ? null
                : reclaimedKiB + sizeKiB;
            console.log(`removed ${worktree.path}`);
        } catch (error) {
            console.error(`failed to remove ${worktree.path}: ${getCliErrorMessage(error)}`);
        }
    }
    console.log(`Removed ${removed.length} worktree(s), ${formatReclaimed(reclaimedKiB)}.`);
    return {
        removed,
        reclaimedKiB,
    };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

const USAGE = [
    'Usage: pnpm worktrees:prune [--into=<ref>[,<ref>]] [--target=<worktree> --completed=<receipt.json> --apply]',
    '',
    'Lists registered git worktrees and removes the ones whose HEAD is merged into a',
    'base ref (origin/main plus any --into refs) and whose tree is clean. Dry run by',
    'default. Apply requires a completion receipt binding taskKey, worktreePath and',
    'HEAD, plus a single target. A live or unverifiable owner keeps the target. Never',
    'deletes branches, the primary checkout, dirty trees, or the current worktree.',
].join('\n');

if (isMain) {
    try {
        const options = parseArgs(process.argv.slice(2));
        if (options.help) {
            console.log(USAGE);
        } else {
            await pruneWorktrees(options);
        }
    } catch (error) {
        const message = getCliErrorMessage(error);
        console.error(`worktrees-prune: ${message}`);
        console.error(USAGE);
        process.exitCode = 1;
    }
}
