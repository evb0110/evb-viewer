import { realpathSync } from 'fs';
import { resolve } from 'path';
import { createLogger } from '@electron/utils/createLogger';

/**
 * A working copy whose readers cannot be proven stopped is quarantined instead
 * of deleted. Quarantine is deliberately one-way for the life of the session:
 * the only thing that could lift it is proof that the native tree died, and the
 * absence of that proof is exactly what put the path here. The bytes stay on
 * disk, no further close attempt deletes them, and the stale working-copy sweep
 * reclaims them on a later run once no process from this session can hold them.
 *
 * Retaining a temp directory costs disk. Deleting one a Poppler child is still
 * reading costs the user's document, so the trade is not close.
 */
const logger = createLogger('working-copy-quarantine');
// The reasons recorded against one working copy, in the order they arrived. A
// set rather than a list: the close path can reach the same unproven termination
// more than once for the same copy, and repeating a reason in the description
// the caller logs says nothing the first one did not.
const quarantinedWorkingCopies = new Map<string, Set<string>>();

// The path that records a quarantine and the path that asks about one arrive
// from different callers: scan cleanup records the source path it was handed,
// while the close path asks with the working-copy registration key. Two spellings
// of the same file have to answer the same, so the key is the real path while the
// file exists (a symlinked folder such as macOS's /var is another spelling), else
// the resolved path, and on Windows, where the filesystem itself is
// case-insensitive, case-folded as well. POSIX keeps its case, because there two
// spellings that differ in case are two different files.
function normalizeQuarantinePath(workingCopyPath: string) {
    const trimmedPath = typeof workingCopyPath === 'string' ? workingCopyPath.trim() : '';
    if (!trimmedPath) {
        return '';
    }
    let resolvedPath = resolve(trimmedPath);
    try {
        resolvedPath = realpathSync.native(resolvedPath);
    } catch {
        // Gone already: the resolved spelling is the only one left.
    }
    return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

export function quarantineWorkingCopy(workingCopyPath: string, reason: string) {
    const quarantineKey = normalizeQuarantinePath(workingCopyPath);
    if (!quarantineKey) {
        return;
    }
    const reasons = quarantinedWorkingCopies.get(quarantineKey) ?? new Set<string>();
    reasons.add(reason);
    quarantinedWorkingCopies.set(quarantineKey, reasons);
    // Quarantine is an expected outcome of an unprovable termination, not an
    // application fault, so it stays below the severity the renderer turns into
    // a user-visible runtime report while still reaching logs and telemetry.
    // The log carries the path the caller used, which is the one that appears in
    // the rest of that caller's log lines.
    logger.warn(`Quarantined working copy "${workingCopyPath.trim()}": ${reason}`);
}

export function isWorkingCopyQuarantined(workingCopyPath: string) {
    return quarantinedWorkingCopies.has(normalizeQuarantinePath(workingCopyPath));
}

export function describeWorkingCopyQuarantine(workingCopyPath: string) {
    const reasons = quarantinedWorkingCopies.get(normalizeQuarantinePath(workingCopyPath));
    if (!reasons) {
        return '';
    }
    return [...reasons].join('; ');
}

export function clearWorkingCopyQuarantinesForTests() {
    quarantinedWorkingCopies.clear();
}
