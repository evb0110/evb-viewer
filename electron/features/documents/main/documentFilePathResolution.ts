import {getInputFileExtension} from '@electron/utils/documentFileTypes';
import {
    existsSync,
    lstatSync,
    realpathSync,
    statSync,
} from 'fs';
import {resolve} from 'path';
import {
    describeReadPathValidationForDiagnostics,
    isAllowedReadPath,
    resolveAllowedReadPath,
    getManagedTempPathAccessDecision,
} from '@electron/utils/pathValidator';
import {
    findWorkingCopyPathByOriginalPath,
    getOpenDocument,
    getWorkingCopyBackingEntry,
} from '@electron/file-access/documentStore';
import { isAllowedDjvuViewingPath } from '@electron/features/djvu/public';
import { requireOpenPath } from '@electron/file-access/openPathCapabilities';

const MAX_IPC_READ_BYTES = 16 * 1024 * 1024;
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
    if (typeof filePath !== 'string' || !filePath.trim()) {
        throw new Error('Invalid file path: path must be a non-empty string');
    }
    return filePath;
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

/** An open document's ref: its bytes are reached through the document store, not at the path itself. */
function isManagedRef(normalizedPath: string, senderId?: number) {
    return getWorkingCopyBackingEntry(normalizedPath, senderId) !== null;
}

function isReadablePathAllowedForSender(path: string, senderId?: number) {
    if (getManagedTempPathAccessDecision(
        senderId === undefined ? {} : {senderId},
        path,
    ) === null) {
        return false;
    }
    // A file of an open document belongs to the window that owns the document.
    return getOpenDocument(path) === null || getOpenDocument(path, senderId) !== null;
}

async function resolveReadablePath(
    normalizedPath: string,
    extension: string,
    senderId?: number,
) {
    if (!isReadablePathAllowedForSender(normalizedPath, senderId)) {
        return null;
    }
    if (isManagedRef(normalizedPath, senderId)) {
        return normalizedPath;
    }
    // The renderer may still name the original of an open document.
    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(normalizedPath, senderId);
    if (mappedWorkingCopyPath) {
        return mappedWorkingCopyPath;
    }

    const directResolvedPath = await resolveAllowedReadPath(normalizedPath);
    if (directResolvedPath && isReadablePathAllowedForSender(directResolvedPath, senderId)) {
        return directResolvedPath;
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
function describeRejectedReadPath(normalizedPath: string, senderId?: number) {
    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(normalizedPath, senderId);
    const scopedDocument = isManagedRef(normalizedPath, senderId) ? 'yes' : 'no';
    const unscopedDocument = isManagedRef(normalizedPath) ? 'yes' : 'no';
    return 'Invalid file path: reads only allowed within temp directory '
        + `(rejected: ${normalizedPath}; mapped working copy: ${mappedWorkingCopyPath ?? 'none'}; `
        + `document[sender=${senderId ?? 'none'}]=${scopedDocument}; document[any]=${unscopedDocument}; `
        + `${describeReadPathValidationForDiagnostics(normalizedPath)})`;
}

export async function resolveExistingReadableBinaryPath(
    filePath: unknown,
    senderId?: number,
) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = getInputFileExtension(normalizedPath);
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
    const extension = getInputFileExtension(normalizedPath);
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

    if (!isManagedRef(resolvedPath, senderId) && !pathExists(resolvedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    return resolvedPath;
}

export async function resolveExistingReadablePdfPath(filePath: unknown, senderId?: number) {
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const extension = getInputFileExtension(normalizedPath);
    if (extension !== '.pdf') {
        throw new Error('Invalid file type: only PDF files are allowed');
    }

    const resolvedPath = await resolveReadablePath(normalizedPath, extension, senderId);
    if (!resolvedPath) {
        throw new Error(describeRejectedReadPath(normalizedPath, senderId));
    }

    if (!isManagedRef(resolvedPath, senderId) && !pathExists(resolvedPath)) {
        throw new Error(`File not found: ${normalizedPath}`);
    }

    return resolvedPath;
}

export function resolveReadablePathSync(normalizedPath: string, senderId?: number) {
    if (!isReadablePathAllowedForSender(normalizedPath, senderId)) {
        return null;
    }
    if (isManagedRef(normalizedPath, senderId)) {
        return normalizedPath;
    }
    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(normalizedPath, senderId);
    if (mappedWorkingCopyPath) {
        return mappedWorkingCopyPath;
    }
    return isAllowedReadPath(normalizedPath) && existsSync(normalizedPath) ? normalizedPath : null;
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
