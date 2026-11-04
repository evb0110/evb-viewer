import { existsSync } from 'fs';
import {
    dirname,
    resolve,
} from 'path';
import { range } from 'es-toolkit/math';
import { normalizePathForLookup } from '@electron/file-access/workingCopyStore';
import { buildOutputPathWithSuffix } from '@electron/utils/boundedPathComponent';

interface IImageExportTarget {
    // The template and protected page/part suffix, before conflict resolution.
    targetPath: string;
    suffix: string;
    allowOverwrite: boolean;
    stagedPath?: string;
}

export interface IStagedImageFile extends IImageExportTarget {stagedPath: string;}

export function resolveOutputPathConflict(
    file: IImageExportTarget,
    reservedPaths: Set<string>,
) {
    const {
        targetPath, suffix: protectedSuffix, allowOverwrite, stagedPath,
    } = file;
    if (stagedPath !== undefined && resolve(dirname(stagedPath)) !== resolve(dirname(targetPath))) {
        throw new Error(`Image export staged output is not beside its target: ${targetPath}`);
    }
    if (allowOverwrite) {
        const candidatePath = protectedSuffix ? buildOutputPathWithSuffix(targetPath, protectedSuffix) : targetPath;
        if (reservedPaths.has(normalizePathForLookup(candidatePath))) {
            throw new Error(`Duplicate image export target: ${candidatePath}`);
        }
        reservedPaths.add(normalizePathForLookup(candidatePath));
        return candidatePath;
    }
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

export function resolveSuffixedOutputPathConflicts(
    targets: IOutputPathTarget[],
    allowSingleOverwrite = true,
    reservedPaths = new Set<string>(),
) {
    return targets.map(({
        path, suffix, 
    }) => resolveOutputPathConflict({
        targetPath: path,
        suffix,
        allowOverwrite: targets.length === 1 && allowSingleOverwrite,
    }, reservedPaths));
}

export function resolveOutputPathConflicts(targetPaths: string[], allowSingleOverwrite = true) {
    return resolveSuffixedOutputPathConflicts(targetPaths.map(path => ({
        path,
        suffix: '',
    })), allowSingleOverwrite);
}

export function buildMultiPageTiffOutputSuffixes(partCount: number) {
    return partCount <= 1 ? [''] : range(1, partCount + 1).map(partNumber =>
        `-part-${String(partNumber).padStart(3, '0')}`,
    );
}
