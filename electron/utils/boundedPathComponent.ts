import { existsSync } from 'fs';
import {
    basename,
    dirname,
    join,
} from 'path';
import { rm } from 'fs/promises';
import { moveFileToMissingPath } from '@electron/utils/atomicReplace';
import { isSameFile } from '@electron/utils/fileIdentity';
import {buildOutputFileNameWithSuffix} from '@pdf-core/imageExportFileName';

export function buildOutputPathWithSuffix(targetPath: string, suffix: string) {
    return join(dirname(targetPath), buildOutputFileNameWithSuffix(basename(targetPath), suffix));
}

/**
 * Keeps a file beside `targetPath` as "<stem> (original)<ext>", then "(original 2)" and on, within the filename limit,
 * never over another file. A taken name that already is this file, linked by a move a crash cut short before it
 * unlinked `sourcePath`, is used, and only `sourcePath` goes. `beforeMove` hears the name before the file moves there,
 * so what it records survives a crash in the move. Returns where the file is kept.
 */
export async function keepOriginalBeside(sourcePath: string, targetPath: string, beforeMove?: (keptPath: string) => Promise<void>) {
    for (let copy = 1; ; copy += 1) {
        const keptPath = buildOutputPathWithSuffix(targetPath, copy === 1 ? ' (original)' : ` (original ${copy})`);
        const taken = existsSync(keptPath);
        if (!taken || await isSameFile(keptPath, sourcePath)) {
            await beforeMove?.(keptPath);
            await (taken ? rm(sourcePath, {force: true}) : moveFileToMissingPath(sourcePath, keptPath));
            return keptPath;
        }
    }
}
