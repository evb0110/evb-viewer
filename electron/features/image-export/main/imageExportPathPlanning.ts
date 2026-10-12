import { existsSync } from 'fs';
import { range } from 'es-toolkit/math';
import { normalizePathForLookup } from '@electron/file-access/workingCopyStore';
import { buildOutputPathWithSuffix } from '@electron/utils/boundedPathComponent';

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
        ? (suffix ? buildOutputPathWithSuffix(path, suffix) : path)
        : buildNonConflictingOutputPath(path, suffix, reservedPaths)));
}

export function resolveOutputPathConflicts(targetPaths: string[], allowSingleOverwrite = true) {
    return resolveSuffixedOutputPathConflicts(targetPaths.map(path => ({
        path,
        suffix: '',
    })), allowSingleOverwrite);
}

export function buildMultiPageTiffOutputPaths(targetPath: string, partCount: number) {
    return partCount <= 1 ? [targetPath] : range(1, partCount + 1).map(partNumber =>
        buildOutputPathWithSuffix(
            targetPath,
            `-part-${String(partNumber).padStart(3, '0')}`,
        ),
    );
}
