import { existsSync } from 'fs';
import {
    basename,
    dirname,
    extname,
    join,
} from 'path';
import { range } from 'es-toolkit/math';
import { isErrnoException } from '@contracts/runtimeGuards';
import { moveFileToMissingPath } from '@electron/utils/atomicReplace';

const MAX_PATH_COMPONENT_BYTES = 255;

function getUtf8ByteLength(value: string) {
    return Buffer.byteLength(value, 'utf8');
}

/** Keeps the longest prefix whose UTF-8 form fits in `maxBytes`, never splitting a code point; this also bounds the UTF-16 units NTFS counts. */
export function truncateUtf8PathComponent(value: string, maxBytes = MAX_PATH_COMPONENT_BYTES) {
    if (maxBytes < 0) {
        throw new Error('Path component byte budget must not be negative');
    }

    let byteLength = 0;
    let result = '';
    for (const character of value) {
        const characterByteLength = getUtf8ByteLength(character);
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
    const suffixByteLength = getUtf8ByteLength(suffixWithExtension);
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
 * Moves a file beside `targetPath` as `<stem> (<label>)<ext>`, then `<stem> (<label> 2)<ext>` and on, never over an
 * existing file. Returns the new path, or `sourcePath` when no name is free or the move fails.
 */
export async function moveFileToLabelledPathBeside(sourcePath: string, targetPath: string, label: string) {
    for (const number of range(1, 100)) {
        const candidatePath = buildOutputPathWithSuffix(targetPath, number === 1 ? ` (${label})` : ` (${label} ${number})`);
        try {
            if (!existsSync(candidatePath)) {
                await moveFileToMissingPath(sourcePath, candidatePath);
                return candidatePath;
            }
        } catch (error) {
            if (!isErrnoException(error) || error.code !== 'EEXIST') return sourcePath;
        }
    }
    return sourcePath;
}
