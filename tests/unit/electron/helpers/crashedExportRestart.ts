import {
    existsSync,
    readdirSync,
} from 'node:fs';
import {
    readFile,
    readdir,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {sweepStaleManagedScratchTempDirs} from '@electron/utils/managedScratchTemp';

// The names makeSiblingTempPath gives a publication stage.
export function listStagedNames(folder: string) {
    return readdirSync(folder).filter(name => /^\.[0-9a-f]{16}\.tmp$/u.test(name));
}

// The next start after a crash: every managed scratch under appTempRoot belongs
// to a process that is gone, and the startup sweep runs with no age floor.
export async function restartAfterCrash(appTempRoot: string) {
    for (const entry of await readdir(appTempRoot)) {
        const markerPath = join(appTempRoot, entry, '.evb-managed-scratch.json');
        if (existsSync(markerPath)) {
            const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
            const deadOwner = {
                ...marker,
                pid: 2_147_483_647,
            };
            await writeFile(markerPath, `${JSON.stringify(deadOwner)}\n`, 'utf8');
        }
    }
    await sweepStaleManagedScratchTempDirs(appTempRoot, 0);
}
