import { existsSync } from 'fs';
import {
    basename,
    dirname,
    extname,
    join,
} from 'path';
import { range } from 'es-toolkit/math';
import { normalizePathForLookup } from '@electron/file-access/workingCopyStore';

const MAX_PATH_COMPONENT_BYTES = 255;

function getUtf8ByteLength(value: string) {
    return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8PathComponent(value: string, maxBytes = MAX_PATH_COMPONENT_BYTES) {
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

function buildNonConflictingOutputPath(targetPath: string, protectedSuffix: string, reservedPaths: Set<string>) {
    let candidatePath = buildOutputPathWithSuffix(targetPath, protectedSuffix);
    let conflictNumber = 1;
    while (reservedPaths.has(normalizePathForLookup(candidatePath)) || existsSync(candidatePath)) {
        candidatePath = buildOutputPathWithSuffix(targetPath, `${protectedSuffix}-${conflictNumber}`);
        conflictNumber += 1;
    }
    reservedPaths.add(normalizePathForLookup(candidatePath));
    return candidatePath;
}

interface IOutputPathTarget {
    path: string;
    suffix: string;
}

export function resolveSuffixedOutputPathConflicts(targets: IOutputPathTarget[], allowSingleOverwrite = true) {
    const reservedPaths = new Set<string>();
    return targets.map(({
        path, suffix, 
    }) => (targets.length === 1 && allowSingleOverwrite
        ? buildOutputPathWithSuffix(path, suffix)
        : buildNonConflictingOutputPath(path, suffix, reservedPaths)));
}

export function resolveOutputPathConflicts(targetPaths: string[], allowSingleOverwrite = true) {
    return resolveSuffixedOutputPathConflicts(targetPaths.map(path => ({
        path,
        suffix: '',
    })), allowSingleOverwrite);
}

export function buildMultiPageTiffOutputPaths(targetPath: string, partCount: number) {
    if (partCount <= 1) {
        return [buildOutputPathWithSuffix(targetPath, '')];
    }
    return range(1, partCount + 1).map(partNumber =>
        buildOutputPathWithSuffix(
            targetPath,
            `-part-${String(partNumber).padStart(3, '0')}`,
        ),
    );
}
