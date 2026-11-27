import {isAbsolute, relative, sep} from 'node:path';

/**
 * Strict-descendant containment expressed through the path API rather than a
 * `${root}/` prefix, so the assertion means the same thing on a Windows path
 * as on a POSIX one and cannot be satisfied by a sibling directory whose name
 * merely starts with the root.
 */
export function isPathWithinRoot(candidatePath: string, rootPath: string) {
    const relativePath = relative(rootPath, candidatePath);
    return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}
