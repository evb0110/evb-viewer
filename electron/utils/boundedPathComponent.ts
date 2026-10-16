import { existsSync } from 'fs';
import {
    basename,
    dirname,
    extname,
    join,
} from 'path';
import { rm } from 'fs/promises';
import { moveFileToMissingPath } from '@electron/utils/atomicReplace';
import { isSameFile } from '@electron/utils/fileIdentity';

export const MAX_PATH_COMPONENT_BYTES = 255;

/** Keeps the longest prefix whose UTF-8 form fits in `maxBytes`, never splitting a code point; this also bounds the UTF-16 units NTFS counts. */
export function truncateUtf8PathComponent(value: string, maxBytes = MAX_PATH_COMPONENT_BYTES) {
    if (maxBytes < 0) {
        throw new Error('Path component byte budget must not be negative');
    }

    let byteLength = 0;
    let result = '';
    for (const character of value) {
        const characterByteLength = Buffer.byteLength(character);
        if (byteLength + characterByteLength > maxBytes) {
            break;
        }
        result += character;
        byteLength += characterByteLength;
    }
    return result;
}

export function buildOutputPathWithSuffix(targetPath: string, suffix: string) {
    const outputDirectory = dirname(targetPath);
    const outputExtension = extname(targetPath);
    const outputStem = basename(targetPath, outputExtension);
    const suffixWithExtension = `${suffix}${outputExtension}`;
    const suffixByteLength = Buffer.byteLength(suffixWithExtension);
    if (suffixByteLength > MAX_PATH_COMPONENT_BYTES) {
        throw new Error('Output filename suffix exceeds the filesystem component limit');
    }
    const boundedStem = truncateUtf8PathComponent(
        outputStem,
        MAX_PATH_COMPONENT_BYTES - suffixByteLength,
    );
    return join(outputDirectory, `${boundedStem}${suffixWithExtension}`);
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
