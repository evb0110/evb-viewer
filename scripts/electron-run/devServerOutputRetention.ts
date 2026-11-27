import {lstatSync, readFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface IDevServerOutputRetentionPolicy {
    maxAgeMs: number;
    maxFileBytes: number;
    maxRuns: number;
    maxTotalBytes: number;
}

export const DEFAULT_DEV_SERVER_OUTPUT_RETENTION_POLICY: Readonly<IDevServerOutputRetentionPolicy> = {
    maxAgeMs: 14 * DAY_MS,
    maxFileBytes: 32 * 1024 * 1024,
    maxRuns: 50,
    maxTotalBytes: 512 * 1024 * 1024,
};

interface IDevServerOutputRun {
    createdAtMs: number;
    path: string;
    sizeBytes: number;
}

function parseJsonFile(filePath: string) {
    try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

function listDirectories(parentDir: string) {
    try {
        return readdirSync(parentDir, {withFileTypes: true})
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(parentDir, entry.name));
    } catch {
        return [];
    }
}

function listFiles(parentDir: string) {
    try {
        return readdirSync(parentDir, {withFileTypes: true})
            .filter((entry) => entry.isFile())
            .map((entry) => join(parentDir, entry.name));
    } catch {
        return [];
    }
}

function getDirectorySizeBytes(directoryPath: string): number {
    let totalBytes = 0;
    let entries;
    try {
        entries = readdirSync(directoryPath, {withFileTypes: true});
    } catch {
        return 0;
    }

    for (const entry of entries) {
        const entryPath = join(directoryPath, entry.name);
        try {
            if (entry.isDirectory()) {
                totalBytes += getDirectorySizeBytes(entryPath);
            } else {
                totalBytes += lstatSync(entryPath).size;
            }
        } catch {}
    }
    return totalBytes;
}

function getRunCreatedAtMs(runDir: string) {
    for (const filePath of listFiles(runDir)) {
        if (!filePath.endsWith('.json')) {
            continue;
        }
        const createdAt = parseJsonFile(filePath)?.createdAt;
        if (typeof createdAt !== 'string') {
            continue;
        }
        const createdAtMs = Date.parse(createdAt);
        if (Number.isFinite(createdAtMs)) {
            return createdAtMs;
        }
    }

    try {
        return statSync(runDir).mtimeMs;
    } catch {
        return 0;
    }
}

function listRuns(baseDir: string) {
    return listDirectories(baseDir).flatMap((sessionDir) =>
        listDirectories(sessionDir).map(
            (runDir) =>
                ({
                    createdAtMs: getRunCreatedAtMs(runDir),
                    path: resolve(runDir),
                    sizeBytes: getDirectorySizeBytes(runDir),
                }) satisfies IDevServerOutputRun,
        ),
    );
}

function isProcessAlive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error instanceof Error && 'code' in error && error.code !== 'ESRCH';
    }
}

function normalizeReferencedRunDir(baseDir: string, value: unknown, knownRunDirs: Set<string>) {
    if (typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    const normalizedPath = resolve(isAbsolute(value) ? value : join(baseDir, value));
    return knownRunDirs.has(normalizedPath) ? normalizedPath : null;
}

function collectLatestPointerTargets(baseDir: string, knownRunDirs: Set<string>) {
    const pointerPaths = [
        join(baseDir, 'latest-run.json'),
        ...listDirectories(baseDir).map((sessionDir) => join(sessionDir, 'latest-run.json')),
    ];
    const protectedRunDirs = new Set<string>();
    for (const pointerPath of pointerPaths) {
        const runDir = normalizeReferencedRunDir(baseDir, parseJsonFile(pointerPath)?.runDir, knownRunDirs);
        if (runDir) {
            protectedRunDirs.add(runDir);
        }
    }
    return protectedRunDirs;
}

function collectActiveDescriptorTargets(baseDir: string, runs: IDevServerOutputRun[], knownRunDirs: Set<string>) {
    const protectedRunDirs = new Set<string>();
    for (const run of runs) {
        for (const filePath of listFiles(run.path)) {
            if (!filePath.endsWith('.json')) {
                continue;
            }
            const descriptor = parseJsonFile(filePath);
            const pid = descriptor?.pid;
            if (
                typeof descriptor?.closedAt === 'string' ||
                !Number.isSafeInteger(pid) ||
                (pid as number) < 1 ||
                !isProcessAlive(pid as number)
            ) {
                continue;
            }
            const referencedRunDir = normalizeReferencedRunDir(baseDir, descriptor?.runDir, knownRunDirs);
            if (referencedRunDir) {
                protectedRunDirs.add(referencedRunDir);
            }
        }
    }
    return protectedRunDirs;
}

function normalizePolicyValue(value: number, fallback: number) {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function resolveDevServerOutputRetentionPolicy(
    policy: Partial<IDevServerOutputRetentionPolicy> = {},
): IDevServerOutputRetentionPolicy {
    return {
        maxAgeMs: normalizePolicyValue(
            policy.maxAgeMs ?? DEFAULT_DEV_SERVER_OUTPUT_RETENTION_POLICY.maxAgeMs,
            DEFAULT_DEV_SERVER_OUTPUT_RETENTION_POLICY.maxAgeMs,
        ),
        maxFileBytes: normalizePolicyValue(
            policy.maxFileBytes ?? DEFAULT_DEV_SERVER_OUTPUT_RETENTION_POLICY.maxFileBytes,
            DEFAULT_DEV_SERVER_OUTPUT_RETENTION_POLICY.maxFileBytes,
        ),
        maxRuns: normalizePolicyValue(
            policy.maxRuns ?? DEFAULT_DEV_SERVER_OUTPUT_RETENTION_POLICY.maxRuns,
            DEFAULT_DEV_SERVER_OUTPUT_RETENTION_POLICY.maxRuns,
        ),
        maxTotalBytes: normalizePolicyValue(
            policy.maxTotalBytes ?? DEFAULT_DEV_SERVER_OUTPUT_RETENTION_POLICY.maxTotalBytes,
            DEFAULT_DEV_SERVER_OUTPUT_RETENTION_POLICY.maxTotalBytes,
        ),
    };
}

export function pruneDevServerOutputRuns(options: {
    baseDir: string;
    now?: Date;
    policy?: Partial<IDevServerOutputRetentionPolicy>;
    protectedRunDirs?: Iterable<string>;
}) {
    const baseDir = resolve(options.baseDir);
    const policy = resolveDevServerOutputRetentionPolicy(options.policy);
    const runs = listRuns(baseDir).sort((left, right) => left.createdAtMs - right.createdAtMs);
    const knownRunDirs = new Set(runs.map((run) => run.path));
    const protectedRunDirs = new Set(
        [...(options.protectedRunDirs ?? [])].map((runDir) => resolve(runDir)).filter((runDir) => knownRunDirs.has(runDir)),
    );
    for (const runDir of collectLatestPointerTargets(baseDir, knownRunDirs)) {
        protectedRunDirs.add(runDir);
    }
    for (const runDir of collectActiveDescriptorTargets(baseDir, runs, knownRunDirs)) {
        protectedRunDirs.add(runDir);
    }

    const remainingRuns = new Set(runs);
    let totalBytes = runs.reduce((sum, run) => sum + run.sizeBytes, 0);
    const removeRun = (run: IDevServerOutputRun) => {
        if (!remainingRuns.has(run) || protectedRunDirs.has(run.path)) {
            return false;
        }
        try {
            rmSync(run.path, {
                force: true,
                recursive: true,
            });
        } catch {
            protectedRunDirs.add(run.path);
            return false;
        }
        remainingRuns.delete(run);
        totalBytes = Math.max(0, totalBytes - run.sizeBytes);
        return true;
    };

    const nowMs = (options.now ?? new Date()).getTime();
    for (const run of runs) {
        if (nowMs - run.createdAtMs > policy.maxAgeMs) {
            removeRun(run);
        }
    }
    for (const run of runs) {
        if (remainingRuns.size <= policy.maxRuns) {
            break;
        }
        removeRun(run);
    }
    for (const run of runs) {
        if (totalBytes <= policy.maxTotalBytes) {
            break;
        }
        removeRun(run);
    }
}
