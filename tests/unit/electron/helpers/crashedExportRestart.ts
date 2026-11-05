import {
    existsSync,
    readdirSync,
} from 'node:fs';
import {
    chmod,
    lstat,
    readFile,
    readdir,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {vi} from 'vitest';
import {sweepStaleManagedScratchTempDirs} from '@electron/utils/managedScratchTemp';

// The names makeSiblingTempPath gives a publication stage.
export function listStagedNames(folder: string) {
    return readdirSync(folder).filter(name => /^\.[0-9a-f]{16}\.tmp$/u.test(name));
}

// The next start after a crash: every managed scratch under appTempRoot belongs
// to a process that is gone, and the startup sweep runs with no age floor.
export async function restartAfterCrash(appTempRoot: string) {
    let restartAt = Date.now();
    for (const entry of await readdir(appTempRoot)) {
        const markerPath = join(appTempRoot, entry, '.evb-managed-scratch.json');
        if (existsSync(markerPath)) {
            const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
            const deadOwner = {
                ...marker,
                pid: 2_147_483_647,
            };
            await writeFile(markerPath, `${JSON.stringify(deadOwner)}\n`, 'utf8');
            const scratchStat = await lstat(join(appTempRoot, entry));
            restartAt = Math.max(restartAt, Math.floor(scratchStat.mtimeMs), Math.floor(scratchStat.ctimeMs));
        }
    }
    // A simulated next start follows every filesystem write, even when the
    // filesystem timestamp is ahead of the test's millisecond wall clock.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(restartAt);
    try {
        await sweepStaleManagedScratchTempDirs(appTempRoot, 0);
    } finally {
        clock.mockRestore();
    }
}

// An append hook that fails the completion line as a full or read-only scratch
// would: the record turns read-only just before it, so the filesystem refuses it.
export async function refuseCompletionAppend(path: string, data: string) {
    if (data.includes('"kind":"complete"')) {
        await chmod(path, 0o444);
    }
}

// A step a killed process stops at: `stop` never settles, and `reached`
// resolves once the step runs, so a test waits for the step, not for a clock.
export function createStopPoint() {
    const {
        promise: reached, resolve,
    } = Promise.withResolvers<undefined>();
    return {
        reached,
        stop: <T = undefined>() => {
            resolve(undefined);
            return new Promise<T>(() => undefined);
        },
    };
}
