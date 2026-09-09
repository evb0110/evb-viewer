import {
    lstatSync,
    realpathSync,
    statSync,
} from 'fs';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    sep,
} from 'path';
import {ScanCleanupContractError} from '@evb/scan-cleanup/core/errors';

/**
 * A root that has already been resolved to the real directory it names. Only
 * {@link canonicalizeScanCleanupAllowedRoot} issues one, so a caller cannot
 * hand a raw, unchecked string to the containment check by mistake.
 */
export interface IScanCleanupAllowedRoot {
    /** The root exactly as configured, named by errors about the root itself. */
    readonly configuredPath: string;
    /** The symlink-resolved directory every candidate must resolve inside. */
    readonly canonicalPath: string;
}

const issuedAllowedRoots = new WeakSet<IScanCleanupAllowedRoot>();

function isMissingEntry(error: unknown) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Resolve the deepest ancestor that exists and re-append the missing tail, so a
 * destination that has not been created yet is still judged by the real
 * directory it would land in rather than by its spelling.
 */
function canonicalizeThroughExistingAncestor(candidatePath: string, label: string) {
    const missingSegments: string[] = [];
    let ancestor = candidatePath;
    for (;;) {
        try {
            lstatSync(ancestor);
        } catch (error) {
            if (!isMissingEntry(error)) {
                throw new ScanCleanupContractError(`${label} cannot be resolved`);
            }
            const parent = dirname(ancestor);
            if (parent === ancestor) {
                throw new ScanCleanupContractError(`${label} has no existing ancestor`);
            }
            missingSegments.unshift(basename(ancestor));
            ancestor = parent;
            continue;
        }
        let canonicalAncestor: string;
        try {
            canonicalAncestor = realpathSync(ancestor);
        } catch {
            // The segment exists as a link but does not resolve: a dangling or
            // looping symlink names no directory this root can vouch for.
            throw new ScanCleanupContractError(`${label} contains an unresolved symlink`);
        }
        return missingSegments.length === 0
            ? canonicalAncestor
            : join(canonicalAncestor, ...missingSegments);
    }
}

/**
 * Resolve a trusted root once. Errors here describe the configured root itself
 * rather than whichever path was about to be judged against it.
 */
export function canonicalizeScanCleanupAllowedRoot(rootPath: string): IScanCleanupAllowedRoot {
    if (!isAbsolute(rootPath)) {
        throw new ScanCleanupContractError(`allowed root must be an absolute path: ${rootPath}`);
    }
    let canonicalPath: string;
    let isDirectory: boolean;
    try {
        canonicalPath = realpathSync(rootPath);
        isDirectory = statSync(canonicalPath).isDirectory();
    } catch {
        throw new ScanCleanupContractError(`allowed root does not exist: ${rootPath}`);
    }
    if (!isDirectory) {
        throw new ScanCleanupContractError(`allowed root is not a directory: ${rootPath}`);
    }
    const allowedRoot = Object.freeze({
        configuredPath: rootPath,
        canonicalPath,
    });
    issuedAllowedRoots.add(allowedRoot);
    return allowedRoot;
}

/**
 * Judge one path against an already-canonical root. Every failure names the
 * candidate's own label, so an unresolvable candidate is never reported as if
 * the configured root were at fault.
 *
 * The verdict describes the filesystem as it stood when this ran: a path
 * admitted here can be re-pointed afterwards, and this check alone cannot say
 * otherwise. It is a build-time gate, not the last one. The native allowed-root
 * and preflight boundary judge a runnable manifest again before its transaction
 * touches anything.
 */
export function assertScanCleanupPathWithinCanonicalRoot(
    candidatePath: string,
    allowedRoot: IScanCleanupAllowedRoot,
    label: string,
) {
    if (!issuedAllowedRoots.has(allowedRoot)) {
        throw new ScanCleanupContractError(`${label} was judged against a root that was never canonicalized`);
    }
    if (!isAbsolute(candidatePath)) {
        throw new ScanCleanupContractError(`${label} must be an absolute path`);
    }
    const canonicalCandidate = canonicalizeThroughExistingAncestor(candidatePath, label);
    const relativePath = relative(allowedRoot.canonicalPath, canonicalCandidate);
    if (
        relativePath === '..'
        || relativePath.startsWith(`..${sep}`)
        || isAbsolute(relativePath)
    ) {
        throw new ScanCleanupContractError(`${label} is outside its allowed root`);
    }
}
