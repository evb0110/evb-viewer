import {lstatSync, realpathSync} from 'fs';
import {dirname, resolve} from 'path';
import {isErrnoException} from '@contracts/runtimeGuards';

const ALLOWED_SYSTEM_SYMLINK_TARGETS = new Map([
    ['/tmp', '/private/tmp'],
    ['/var', '/private/var'],
]);

function isAllowedSystemSymlinkPathSegment(segment: string) {
    const allowedTarget = ALLOWED_SYSTEM_SYMLINK_TARGETS.get(segment);
    if (!allowedTarget) {
        return false;
    }

    try {
        return realpathSync(segment) === allowedTarget;
    } catch {
        return false;
    }
}

export function assertNoSymlinkPathSegments(resolvedPath: string) {
    const segments: string[] = [];
    let currentPath = resolve(resolvedPath);

    for (;;) {
        segments.push(currentPath);
        const parentPath = dirname(currentPath);
        if (parentPath === currentPath) {
            break;
        }
        currentPath = parentPath;
    }

    for (const segment of segments) {
        try {
            if (lstatSync(segment).isSymbolicLink()) {
                if (isAllowedSystemSymlinkPathSegment(segment)) {
                    continue;
                }
                throw new Error(`Invalid file path: symlink path segment is not allowed (${segment})`);
            }
        } catch (error) {
            const code = isErrnoException(error) ? error.code : undefined;
            if (code === 'ENOENT') {
                continue;
            }
            throw error;
        }
    }
}
