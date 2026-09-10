import {
    existsSync,
    lstatSync,
    realpathSync,
    statSync,
} from 'fs';
import {
    extname,
    resolve,
} from 'path';
import {
    describeReadPathValidationForDiagnostics,
    isAllowedReadPath,
    resolveAllowedReadPath,
    getManagedTempPathAccessDecision,
} from '@electron/utils/pathValidator';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import {
    findWorkingCopyPathByOriginalPath,
    getWorkingCopyBackingEntry,
    getWorkingCopyOwnerWebContentsId,
    hasWorkingCopyTransferAccess,
} from '@electron/file-access/workingCopyStore';
import { isAllowedDjvuViewingPath } from '@electron/features/djvu/public';
import { requireOpenPath } from '@electron/file-access/openPathCapabilities';

const MAX_IPC_READ_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_MAX_IPC_READ_BYTES ?? `${16 * 1024 * 1024}`, 10);
    if (!Number.isFinite(parsed) || parsed < 1024) {
        return 16 * 1024 * 1024;
    }
    return parsed;
})();
const ALLOWED_DOCUMENT_BINARY_READ_EXTENSIONS = new Set([
    '.pdf',
    '.djvu',
    '.djv',
]);
const ALLOWED_IMAGE_BINARY_READ_EXTENSIONS = new Set([
    '.apng',
    '.avif',
    '.bmp',
    '.gif',
    '.jpeg',
    '.jpg',
    '.png',
    '.svg',
    '.svgz',
    '.webp',
    '.ico',
]);
const ALLOWED_DIRECT_SOURCE_READ_EXTENSIONS = new Set([
    '.djvu',
    '.djv',
]);

export function normalizeNonEmptyPath(filePath: unknown) {
    if (typeof filePath !== 'string') {
        throw new Error('Invalid file path: path must be a non-empty string');
    }

    const normalizedPath = filePath.trim();
    if (!normalizedPath) {
        throw new Error('Invalid file path: path must be a non-empty string');
    }
    return normalizedPath;
}

function resolveDirectSourceReadPath(
    normalizedPath: string,
    extension: string,
    senderId?: number,
) {
    if (!ALLOWED_DIRECT_SOURCE_READ_EXTENSIONS.has(extension)) {
        return null;
    }

    const isDirectReadAllowed = typeof senderId === 'number'
        ? isAllowedDjvuViewingPath(normalizedPath, senderId)
        : isAllowedDjvuViewingPath(normalizedPath);
    if (!isDirectReadAllowed) {
        return null;
    }

    const absolutePath = resolve(normalizedPath);
    try {
        // Sync on purpose: packaged Windows Electron mishandles fs.promises
        // metadata calls through its ASAR fs shim (issue #82).
        if (lstatSync(absolutePath).isSymbolicLink()) {
            return null;
        }

        return realpathSync(absolutePath);
    } catch {
        return null;
    }
}

function pathExists(path: string) {
    return existsSync(path);
}

function isOriginalBackedManagedRef(
    normalizedPath: string,
    senderId?: number,
) {
    const entry = getWorkingCopyBackingEntry(normalizedPath, senderId);
    return entry?.backingState === 'lazy-original'
        || entry?.backingState === 'materializing';
}

function isReadablePathAllowedForSender(path: string, senderId?: number) {
    if (getManagedTempPathAccessDecision(
        senderId === undefined ? {} : {senderId},
        path,
    ) === null) {
        return false;
    }
    const owner = getWorkingCopyOwnerWebContentsId(path);
    return owner === undefined || owner === senderId
        || (typeof senderId === 'number' && hasWorkingCopyTransferAccess(path, senderId));
}

export async function resolveReadablePath(
    normalizedPath: string,
    extension: string,
    senderId?: number,
) {
    if (!isReadablePathAllowedForSender(normalizedPath, senderId)) {
        return null;
    }
    if (isOriginalBackedManagedRef(normalizedPath, senderId)) {
        return normalizedPath;
    }

    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(normalizedPath, senderId);
    if (
        mappedWorkingCopyPath
        && isOriginalBackedManagedRef(mappedWorkingCopyPath, senderId)
    ) {
        return mappedWorkingCopyPath;
    }

    const directResolvedPath = await resolveAllowedReadPath(normalizedPath);
    if (directResolvedPath && isReadablePathAllowedForSender(directResolvedPath, senderId)) {
        return directResolvedPath;
    }

    if (await ensureWorkingCopyDirectory(normalizedPath, senderId)) {
        const restoredWorkingCopyPath = await resolveAllowedReadPath(normalizedPath);
        if (restoredWorkingCopyPath && isReadablePathAllowedForSender(restoredWorkingCopyPath, senderId)) {
            return restoredWorkingCopyPath;
        }
    }

    // When renderer still references the original path, remap it to the active
    // working copy path to preserve temp-sandboxed reads.
    if (!mappedWorkingCopyPath) {
        return resolveGrantedReadablePathSync(normalizedPath, senderId)
            ?? resolveDirectSourceReadPath(normalizedPath, extension, senderId);
    }

    const mappedResolvedPath = await resolveAllowedReadPath(mappedWorkingCopyPath);
    if (
        mappedResolvedPath
        && isReadablePathAllowedForSender(mappedWorkingCopyPath, senderId)
        && isReadablePathAllowedForSender(mappedResolvedPath, senderId)
    ) {
        return mappedResolvedPath;
    }

    return resolveGrantedReadablePathSync(normalizedPath, senderId)
        ?? resolveDirectSourceReadPath(normalizedPath, extension, senderId);
}

function resolveGrantedReadablePathSync(normalizedPath: string, senderId?: number) {
    try {
        return requireOpenPath(normalizedPath, senderId);
    } catch {
        return null;
    }
}

/**
 * Read rejections must name what was rejected and whether a working-copy
 * mapping existed, or the failure stage cannot be localized from the
 * renderer-visible error (issue #82 took two release attempts to even find
 * the failing path). Paths already appear in sibling errors ("File not
 * found: ..."), so this leaks nothing new.
 */
export function describeRejectedReadPath(normalizedPath: string, senderId?: number) {
    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(normalizedPath, senderId);
    const scopedBacking = getWorkingCopyBackingEntry(normalizedPath, senderId)?.backingState ?? 'none';
    const unscopedBacking = getWorkingCopyBackingEntry(normalizedPath)?.backingState ?? 'none';
    return 'Invalid file path: reads only allowed within temp directory '
        + `(rejected: ${normalizedPath}; mapped working copy: ${mappedWorkingCopyPath ?? 'none'}; `
        + `backing[sender=${senderId ?? 'none'}]=${scopedBacking}; backing[any]=${unscopedBacking}; `
        + `${describeReadPathValidationForDiagnostics(normalizedPath)})`;
}

export async function resolveExistingReadableBinaryPath(
    filePath: unknown,
    senderId?: number,
) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = extname(normalizedPath).toLowerCase();
    if (!ALLOWED_DOCUMENT_BINARY_READ_EXTENSIONS.has(extension)) {
        throw new Error('Invalid file type: only PDF and DjVu files are allowed');
    }

    return resolveExistingReadablePath(normalizedPath, extension, senderId);
}

export async function resolveExistingReadableDocumentOrImagePath(
    filePath: unknown,
    senderId?: number,
) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = extname(normalizedPath).toLowerCase();
    if (!isAllowedBinaryReadExtension(extension)) {
        throw new Error('Invalid file type: only supported document and image files are allowed');
    }

    return resolveExistingReadablePath(normalizedPath, extension, senderId);
}

async function resolveExistingReadablePath(
    normalizedPath: string,
    extension: string,
    senderId?: number,
) {
    const resolvedPath = await resolveReadablePath(
        normalizedPath,
        extension,
        senderId,
    );
    if (!resolvedPath) {
        throw new Error(describeRejectedReadPath(normalizedPath, senderId));
    }

    if (!isOriginalBackedManagedRef(resolvedPath, senderId) && !pathExists(resolvedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    return resolvedPath;
}

export async function resolveExistingReadablePdfPath(filePath: unknown, senderId?: number) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = extname(normalizedPath).toLowerCase();
    if (extension !== '.pdf') {
        throw new Error('Invalid file type: only PDF files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath, extension, senderId);
    if (!resolvedPath) {
        throw new Error(describeRejectedReadPath(normalizedPath, senderId));
    }

    if (!isOriginalBackedManagedRef(resolvedPath, senderId) && !pathExists(resolvedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    return resolvedPath;
}

export function resolveReadablePathSync(normalizedPath: string, senderId?: number) {
    if (!isReadablePathAllowedForSender(normalizedPath, senderId)) {
        return null;
    }
    if (isOriginalBackedManagedRef(normalizedPath, senderId)) {
        return normalizedPath;
    }

    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(normalizedPath, senderId);
    if (
        mappedWorkingCopyPath
        && isOriginalBackedManagedRef(mappedWorkingCopyPath, senderId)
    ) {
        return mappedWorkingCopyPath;
    }

    if (
        isAllowedReadPath(normalizedPath)
        && existsSync(normalizedPath)
        && isReadablePathAllowedForSender(normalizedPath, senderId)
    ) {
        return normalizedPath;
    }

    if (!mappedWorkingCopyPath) {
        return null;
    }

    if (
        !isAllowedReadPath(mappedWorkingCopyPath)
        || !existsSync(mappedWorkingCopyPath)
        || !isReadablePathAllowedForSender(mappedWorkingCopyPath, senderId)
    ) {
        return null;
    }

    return mappedWorkingCopyPath;
}

export function assertWithinIpcReadBudget(resolvedPath: string, knownSize?: number) {
    const size = knownSize ?? statSync(resolvedPath).size;
    if (size > MAX_IPC_READ_BYTES) {
        throw new Error(`Invalid file: exceeds max IPC read size (${MAX_IPC_READ_BYTES} bytes); use range reads`);
    }
}

export function isAllowedBinaryReadExtension(extension: string) {
    const normalized = extension.toLowerCase();
    return ALLOWED_DOCUMENT_BINARY_READ_EXTENSIONS.has(normalized)
        || ALLOWED_IMAGE_BINARY_READ_EXTENSIONS.has(normalized);
}
