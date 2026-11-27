import {existsSync} from 'fs';
import {join} from 'path';

const DEFAULT_NATIVE_RESOURCE_ROOTS = ['tesseract', 'poppler', 'pdf-image-combine', 'pdf-page-ops', 'scan-cleanup'] as const;

interface IResolveNativeResourcesBaseOptions {
    cwd?: string;
    expectedResourceNames?: readonly string[];
    exists?: (path: string) => boolean;
    resourcesPath?: string;
}

function hasExpectedNativeResources(
    resourcesBase: string,
    expectedResourceNames: readonly string[],
    pathExists: (path: string) => boolean,
) {
    return expectedResourceNames.some((resourceName) => pathExists(join(resourcesBase, resourceName)));
}

export function getNativeResourcesBaseCandidates(moduleDir: string, cwd = process.cwd()) {
    return [
        join(cwd, 'resources'),
        join(moduleDir, '..', 'resources'),
        join(moduleDir, '..', '..', 'resources'),
        join(moduleDir, '..', '..', '..', 'resources'),
    ];
}

export function resolveNativeResourcesBase(moduleDir: string, isPackaged: boolean, options: IResolveNativeResourcesBaseOptions = {}) {
    if (isPackaged) {
        return options.resourcesPath ?? process.resourcesPath;
    }

    const pathExists = options.exists ?? existsSync;
    const expectedResourceNames = options.expectedResourceNames ?? DEFAULT_NATIVE_RESOURCE_ROOTS;
    const candidates = getNativeResourcesBaseCandidates(moduleDir, options.cwd);
    const resolved = candidates.find((candidate) => hasExpectedNativeResources(candidate, expectedResourceNames, pathExists));
    return resolved ?? candidates[0]!;
}
