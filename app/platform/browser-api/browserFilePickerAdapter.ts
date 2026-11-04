import type { TDocumentRef } from '@contracts/documentRef';
import {
    BROWSER_DOCUMENT_CHUNK_SIZE,
    browserDocumentStore,
} from '@app/platform/browserDocumentStore';
import type { IFilePickerAcceptType } from '@app/platform/browser-api/browserFileAccepts';
import { toBrowserOwnedArrayBuffer } from '@app/platform/browser-api/browserPlatformHelpers';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { resolveBrowserCapabilityTier } from '@app/platform/browser/browserCapabilityTier';
import {
    safeGetSessionStorageItem,
    safeSetSessionStorageItem,
} from '@app/utils/browserSafe';

export interface IPickedBrowserFile {
    file: File;
    handle?: FileSystemFileHandle | null;
}

const BROWSER_OPEN_PICKER_MODE_SESSION_KEY = 'evb-viewer:browser:open-picker-mode';
const BROWSER_OPEN_PICKER_MODE_INPUT = 'input';
const BROWSER_INPUT_PICKER_FOCUS_CANCEL_INITIAL_DELAY_MS = 2_000;
const BROWSER_INPUT_PICKER_FOCUS_CANCEL_RETRY_DELAY_MS = 1_000;
const BROWSER_INPUT_PICKER_FOCUS_CANCEL_RETRIES = 3;

type TFileSystemPermissionMode = 'read' | 'readwrite';
type TFileSystemPermissionState = 'granted' | 'denied' | 'prompt';
type TPermissionCapableFileHandle = FileSystemFileHandle & {
    queryPermission?: (descriptor?: { mode?: TFileSystemPermissionMode }) => Promise<TFileSystemPermissionState>;
    requestPermission?: (descriptor?: { mode?: TFileSystemPermissionMode }) => Promise<TFileSystemPermissionState>;
};
let browserFilePickerMessages = {saveExtensionMismatch: (extensions: string) => `File was not saved. Choose a file name ending in ${extensions}.`};

function throwIfAborted(signal?: AbortSignal) {
    signal?.throwIfAborted();
}

export function configureBrowserFilePickerMessages(options: Partial<typeof browserFilePickerMessages>) {
    browserFilePickerMessages = {
        ...browserFilePickerMessages,
        ...options,
    };
}

function getSavePickerExtensions(pickerTypes: IFilePickerAcceptType[]) {
    return [...new Set(pickerTypes.flatMap(type => Object.values(type.accept).flat()))];
}

function assertSaveHandleName(handle: FileSystemFileHandle, pickerTypes: IFilePickerAcceptType[]) {
    const extensions = getSavePickerExtensions(pickerTypes);
    if (extensions.length && !extensions.some(extension => handle.name.toLowerCase().endsWith(extension.toLowerCase()))) {
        throw new Error(browserFilePickerMessages.saveExtensionMismatch(extensions.join(', ')));
    }
}

export function isFileSystemAccessDeniedError(error: unknown) {
    return error instanceof DOMException
        && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
}

export class BrowserFileWriteOutcomeError extends Error {
    public readonly externalWriteCommitted: boolean | null;
    public override readonly cause: unknown;

    public constructor(cause: unknown, externalWriteCommitted: boolean | null) {
        super(normalizeBrowserFileHandleError(cause).message);
        this.name = 'BrowserFileWriteOutcomeError';
        this.externalWriteCommitted = externalWriteCommitted;
        this.cause = cause;
    }
}

function createBrowserFileWritePermissionError() {
    return new Error(
        'Browser write permission was not granted for this file. '
        + 'Choose Save changes in the browser prompt, or use Save As to pick a new output file.',
    );
}

function createBrowserFileWritePermissionChangedError() {
    return new Error(
        'Browser write permission for this file changed while the save waited for other saves. '
        + 'Save again to be asked for write permission.',
    );
}

function normalizeBrowserFileHandleError(error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
}

async function abortBrowserFileWritable(
    writable: FileSystemWritableFileStream,
) {
    try {
        await writable.abort();
        return true;
    } catch {
        return false;
    }
}

async function abortAfterBrowserFileWriteError(
    writable: FileSystemWritableFileStream,
    error: unknown,
) {
    if (await abortBrowserFileWritable(writable)) {
        throw normalizeBrowserFileHandleError(error);
    }
    throw new BrowserFileWriteOutcomeError(error, null);
}

async function closeBrowserFileWritable(writable: FileSystemWritableFileStream) {
    try {
        await writable.close();
    } catch (error) {
        if (await abortBrowserFileWritable(writable)) {
            throw normalizeBrowserFileHandleError(error);
        }
        // A close that failed may still have published the file. The caller
        // must not report "no write" unless abort() completed.
        throw new BrowserFileWriteOutcomeError(error, null);
    }
}

// Writes in bounded chunks, so a cancel takes effect between them.
async function writeBrowserFileChunks(
    writable: FileSystemWritableFileStream,
    data: Blob | Uint8Array,
    signal?: AbortSignal,
) {
    const size = data instanceof Blob ? data.size : data.byteLength;
    for (let offset = 0; offset < size; offset += BROWSER_DOCUMENT_CHUNK_SIZE) {
        throwIfAborted(signal);
        const end = Math.min(size, offset + BROWSER_DOCUMENT_CHUNK_SIZE);
        const chunk = data instanceof Blob
            ? data.slice(offset, end)
            : toBrowserOwnedArrayBuffer(data.subarray(offset, end));
        await writable.write(chunk);
    }
    throwIfAborted(signal);
}

// A permission prompt waits for the person, however long they take. Only
// cancelling the operation ends the wait early.
function waitForPermissionAnswer<T>(answer: Promise<T>, signal?: AbortSignal) {
    if (!signal) return answer;
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, {once: true});
        answer.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}

async function queryFileHandleWritePermission(handle: FileSystemFileHandle) {
    const permissionHandle = handle as TPermissionCapableFileHandle;
    const descriptor = { mode: 'readwrite' as const };
    const queryPermission = permissionHandle.queryPermission?.bind(permissionHandle);

    return queryPermission
        ? queryPermission(descriptor)
        : 'granted';
}

export async function ensureFileHandleWritePermission(handle: FileSystemFileHandle, signal?: AbortSignal) {
    const permissionHandle = handle as TPermissionCapableFileHandle;
    const descriptor = { mode: 'readwrite' as const };
    const requestPermission = permissionHandle.requestPermission?.bind(permissionHandle);

    const currentPermission = await queryFileHandleWritePermission(handle);
    if (currentPermission === 'granted') {
        return;
    }

    const nextPermission = requestPermission
        ? await waitForPermissionAnswer(requestPermission(descriptor), signal)
        : currentPermission;
    if (nextPermission !== 'granted') {
        throw createBrowserFileWritePermissionError();
    }
}

// For the physical-save lock: a grant lost while the save waited is a retryable
// failure here. A prompt inside the lock would block every other window's save.
async function assertFileHandleWriteGranted(handle: FileSystemFileHandle) {
    if (await queryFileHandleWritePermission(handle) !== 'granted') {
        throw createBrowserFileWritePermissionChangedError();
    }
}

function shouldUseFileSystemAccessOpenPicker(preferFileSystemAccess: boolean) {
    if (!preferFileSystemAccess) {
        return false;
    }

    return safeGetSessionStorageItem(BROWSER_OPEN_PICKER_MODE_SESSION_KEY)
        !== BROWSER_OPEN_PICKER_MODE_INPUT;
}

function rememberInputOpenPickerMode() {
    safeSetSessionStorageItem(
        BROWSER_OPEN_PICKER_MODE_SESSION_KEY,
        BROWSER_OPEN_PICKER_MODE_INPUT,
    );
}

const BROWSER_FILE_PICKER_SETUP_DENIED_CODE = 'browser-file-picker-setup-denied';

export class BrowserFilePickerSetupDeniedError extends Error {
    public constructor() {
        super(BROWSER_FILE_PICKER_SETUP_DENIED_CODE);
        this.name = 'BrowserFilePickerSetupDeniedError';
    }
}

export function isBrowserFilePickerSetupDeniedError(
    error: unknown,
): error is BrowserFilePickerSetupDeniedError {
    return error instanceof BrowserFilePickerSetupDeniedError;
}

function createBrowserFilePickerSetupDeniedError() {
    return new BrowserFilePickerSetupDeniedError();
}

export async function pickFiles(options: {
    accept: string;
    multiple?: boolean;
    pickerTypes?: IFilePickerAcceptType[];
    preferFileSystemAccess?: boolean;
}) {
    const { openFilePicker } = resolveBrowserCapabilityTier();
    const preferFileSystemAccess = options.preferFileSystemAccess ?? true;
    if (openFilePicker && shouldUseFileSystemAccessOpenPicker(preferFileSystemAccess)) {
        try {
            const handles = await openFilePicker({
                multiple: options.multiple ?? false,
                ...(options.pickerTypes ? { types: options.pickerTypes } : {}),
            });

            return await Promise.all(
                handles.map(async (handle) => ({
                    file: await handle.getFile(),
                    handle,
                })),
            );
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                return [];
            }

            if (isFileSystemAccessDeniedError(error)) {
                rememberInputOpenPickerMode();
                // This first failure is setup failure, not a user cancellation.
                // The next explicit Open action uses the input fallback; never
                // launch a second picker without another user gesture.
                throw createBrowserFilePickerSetupDeniedError();
            }
            throw error;
        }
    }

    return ((await pickInputFiles(options)) ?? []).map(file => ({
        file,
        handle: null,
    }));
}

/** Files chosen through a file input, or null when the choice was cancelled. */
function pickInputFiles(options: {
    accept: string;
    multiple?: boolean;
    directory?: boolean;
}) {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
        return Promise.resolve(null);
    }

    // A browser opens a file chooser only within a user activation and reports
    // no event when it refuses one, so without activation the input would wait
    // forever. The pick ends as cancelled instead.
    const userActivation: UserActivation | undefined = navigator.userActivation;
    if (userActivation?.isActive === false) {
        return Promise.resolve(null);
    }

    return new Promise<File[] | null>((resolve) => {
        const input = document.createElement('input');
        let settled = false;
        let focusFallbackTimer: number | null = null;

        const cleanup = () => {
            if (focusFallbackTimer !== null) {
                window.clearTimeout(focusFallbackTimer);
                focusFallbackTimer = null;
            }
            input.remove();
            window.removeEventListener('focus', handleFocus);
        };

        const finish = (files: File[] | null) => {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            resolve(files);
        };

        const finishSelectedInputFiles = () => {
            const files = Array.from(input.files ?? []);
            if (files.length === 0) {
                return false;
            }

            finish(files);
            return true;
        };

        const scheduleFocusFallbackCancel = (remainingRetries: number, delayMs: number) => {
            focusFallbackTimer = window.setTimeout(() => {
                focusFallbackTimer = null;
                if (settled || finishSelectedInputFiles()) {
                    return;
                }

                if (remainingRetries > 0) {
                    scheduleFocusFallbackCancel(
                        remainingRetries - 1,
                        BROWSER_INPUT_PICKER_FOCUS_CANCEL_RETRY_DELAY_MS,
                    );
                    return;
                }

                finish(null);
            }, delayMs);
        };

        const handleFocus = () => {
            scheduleFocusFallbackCancel(
                BROWSER_INPUT_PICKER_FOCUS_CANCEL_RETRIES,
                BROWSER_INPUT_PICKER_FOCUS_CANCEL_INITIAL_DELAY_MS,
            );
        };

        input.type = 'file';
        input.accept = options.accept;
        input.multiple = options.multiple ?? false;
        input.webkitdirectory = options.directory ?? false;
        input.style.display = 'none';
        const supportsCancelEvent = 'oncancel' in input;
        if (supportsCancelEvent) {
            input.addEventListener(
                'cancel',
                () => {
                    finish(null);
                },
                { once: true },
            );
        }
        input.addEventListener(
            'change',
            () => {
                finish(Array.from(input.files ?? []));
            },
            { once: true },
        );

        document.body.append(input);
        if (!supportsCancelEvent) {
            window.addEventListener('focus', handleFocus, { once: true });
        }
        input.click();
    });
}

type TBrowserDirectoryPicker = (options?: {mode?: 'read'}) => Promise<FileSystemDirectoryHandle>;

function isFileHandle(handle: FileSystemHandle): handle is FileSystemFileHandle {
    return handle.kind === 'file';
}

/**
 * The files directly inside a folder the reader chooses, unsorted, or null
 * when the choice was cancelled. A directory input stands in where the browser
 * has no directory picker; it lists subfolders' files too, which are dropped.
 */
export async function pickFolderFiles(): Promise<IPickedBrowserFile[] | null> {
    const showDirectoryPicker = typeof window === 'undefined'
        ? undefined
        : (window as Window & {showDirectoryPicker?: TBrowserDirectoryPicker}).showDirectoryPicker;
    if (typeof showDirectoryPicker === 'function' && shouldUseFileSystemAccessOpenPicker(true)) {
        try {
            const directory = await showDirectoryPicker.call(window, {mode: 'read'});
            const picked: IPickedBrowserFile[] = [];
            for await (const handle of directory.values()) {
                if (isFileHandle(handle)) {
                    picked.push({
                        file: await handle.getFile(),
                        handle,
                    });
                }
            }
            return picked;
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                return null;
            }
            if (isFileSystemAccessDeniedError(error)) {
                rememberInputOpenPickerMode();
                throw createBrowserFilePickerSetupDeniedError();
            }
            throw error;
        }
    }
    const files = await pickInputFiles({
        accept: '',
        multiple: true,
        directory: true,
    });
    return files?.filter(file => !file.webkitRelativePath || file.webkitRelativePath.split('/').length === 2)
        .map(file => ({
            file,
            handle: null,
        })) ?? null;
}

export async function pickSingleFile(options: {
    accept: string;
    pickerTypes?: IFilePickerAcceptType[];
}) {
    const files = await pickFiles(options);
    return files[0] ?? null;
}

// Dispatching the anchor publishes the download, so a cancel is checked
// immediately before it; nothing can take a dispatched download back.
function downloadBlob(blob: Blob, fileName: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
}

/**
 * Downloads a stored document. Its bytes are read a chunk at a time into a
 * Blob, which the browser may keep on disk, so no single buffer bounds the
 * size of the download.
 */
export async function downloadBrowserDocument(
    ref: TDocumentRef,
    fileName: string,
    mimeType: string,
    signal?: AbortSignal,
) {
    const { size } = await browserDocumentStore.stat(ref);
    const parts: Blob[] = [];
    for (let offset = 0; offset < size; offset += BROWSER_DOCUMENT_CHUNK_SIZE) {
        throwIfAborted(signal);
        const length = Math.min(BROWSER_DOCUMENT_CHUNK_SIZE, size - offset);
        const chunk = await browserDocumentStore.readRange(ref, offset, length);
        if (chunk.byteLength !== length) {
            throw new Error(`Browser download read ${chunk.byteLength} of ${length} bytes at ${offset}`);
        }
        parts.push(new Blob([toBrowserOwnedArrayBuffer(chunk)]));
        if (offset > 0) {
            await yieldToBrowser();
        }
    }
    downloadBlob(new Blob(parts, { type: mimeType }), fileName, signal);
}

/** Downloads bytes already in hand. It never opens a picker. */
export function downloadBrowserBytes(bytes: Uint8Array, fileName: string, mimeType: string, signal?: AbortSignal) {
    downloadBlob(new Blob([toBrowserOwnedArrayBuffer(bytes)], { type: mimeType }), fileName, signal);
}

export type TBrowserOutputTarget =
    | {
        fileName: string;
        handle: FileSystemFileHandle
    }
    | {
        fileName: string;
        stagingRef: TDocumentRef
    };

export interface IBrowserOutputSink {
    write(chunk: Uint8Array): Promise<void>;
    /** Publishes the output; after an abort() that came first it discards it and rejects. */
    close(): Promise<void>;
    /** Discards the output; false when it was published first. */
    abort(): Promise<boolean>;
}

interface IBrowserOutput {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
}

/**
 * Opens one output file for streamed bytes. As on desktop, a cancel wins until
 * the output is published, also while it closes.
 */
export async function openBrowserOutputSink(
    target: TBrowserOutputTarget,
    options: {
        mimeType: string;
        signal?: AbortSignal
    },
): Promise<IBrowserOutputSink> {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([
        options.signal,
        controller.signal,
    ]) : controller.signal;
    const output = await openBrowserOutput(target, options.mimeType, signal);
    let closing: Promise<void> | undefined;
    return {
        write: chunk => output.write(chunk),
        close: () => closing ??= output.close().catch(async (error: unknown) => {
            if (signal.aborted) await output.abort();
            throw error;
        }),
        async abort() {
            controller.abort();
            // A close whose outcome is unknown may still publish, so it is not a discard.
            if (closing) return closing.then(() => false, error => !(error instanceof BrowserFileWriteOutcomeError));
            await output.abort();
            return true;
        },
    };
}

/**
 * With a handle the bytes go to the file a chunk at a time. Without one they
 * are staged as chunks of the store record `stagingRef` and downloaded as one
 * file on close, so neither path holds the whole output in memory.
 */
async function openBrowserOutput(
    target: TBrowserOutputTarget,
    mimeType: string,
    signal: AbortSignal,
): Promise<IBrowserOutput> {
    throwIfAborted(signal);
    if ('handle' in target) {
        const {handle} = target;
        await ensureFileHandleWritePermission(handle, signal);
        throwIfAborted(signal);
        const writable = await handle.createWritable();
        return {
            async write(chunk) {
                try {
                    await writeBrowserFileChunks(writable, chunk, signal);
                } catch (error) {
                    await abortAfterBrowserFileWriteError(writable, error);
                }
            },
            async close() {
                throwIfAborted(signal);
                await closeBrowserFileWritable(writable);
            },
            abort: async () => {
                await abortBrowserFileWritable(writable);
            },
        };
    }

    const {stagingRef} = target;
    await browserDocumentStore.prepareChunkedDocument(stagingRef);
    let buffer = new Uint8Array(BROWSER_DOCUMENT_CHUNK_SIZE);
    let filled = 0;
    let chunkCount = 0;
    let fileSize = 0;
    const flush = async () => {
        await browserDocumentStore.writeChunk(stagingRef, chunkCount, buffer.subarray(0, filled));
        chunkCount += 1;
        fileSize += filled;
        filled = 0;
        buffer = new Uint8Array(BROWSER_DOCUMENT_CHUNK_SIZE);
    };
    return {
        async write(chunk) {
            for (let offset = 0; offset < chunk.byteLength;) {
                throwIfAborted(signal);
                const length = Math.min(chunk.byteLength - offset, buffer.byteLength - filled);
                buffer.set(chunk.subarray(offset, offset + length), filled);
                filled += length;
                offset += length;
                if (filled === buffer.byteLength) await flush();
            }
        },
        async close() {
            throwIfAborted(signal);
            if (filled > 0) await flush();
            await browserDocumentStore.finalizeChunkedDocument(stagingRef, {
                fileSize,
                chunkCount,
                chunkSize: BROWSER_DOCUMENT_CHUNK_SIZE,
            });
            await downloadBrowserDocument(stagingRef, target.fileName, mimeType, signal);
        },
        abort: () => browserDocumentStore.clearChunkedDocument(stagingRef),
    };
}

async function saveBlobToPickerOrDownload(
    blob: Blob,
    suggestedName: string,
    pickerTypes: IFilePickerAcceptType[],
    options: {signal?: AbortSignal} = {},
) {
    throwIfAborted(options.signal);
    const { saveFilePicker } = resolveBrowserCapabilityTier();
    if (saveFilePicker) {
        try {
            throwIfAborted(options.signal);
            const handle = await saveFilePicker({
                suggestedName,
                types: pickerTypes,
                excludeAcceptAllOption: getSavePickerExtensions(pickerTypes).length > 0,
            });

            assertSaveHandleName(handle, pickerTypes);
            throwIfAborted(options.signal);
            await ensureFileHandleWritePermission(handle, options.signal);
            throwIfAborted(options.signal);
            const writable = await handle.createWritable();
            try {
                await writeBrowserFileChunks(writable, blob, options.signal);
            } catch (error) {
                await abortAfterBrowserFileWriteError(writable, error);
            }
            await closeBrowserFileWritable(writable);
            throwIfAborted(options.signal);
            return {
                canceled: false,
                fileName: handle.name,
                handle,
            };
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                return {
                    canceled: true,
                    fileName: suggestedName,
                    handle: null,
                };
            }

            throw error;
        }
    }

    if (typeof document === 'undefined' || typeof URL === 'undefined') {
        return {
            canceled: false,
            fileName: suggestedName,
            handle: null,
        };
    }

    downloadBlob(blob, suggestedName, options.signal);

    return {
        canceled: false,
        fileName: suggestedName,
        handle: null,
    };
}

export async function pickSaveTarget(options: {
    suggestedName: string;
    pickerTypes: IFilePickerAcceptType[];
}) {
    const { saveFilePicker } = resolveBrowserCapabilityTier();
    if (!saveFilePicker) {
        return {
            canceled: false,
            fileName: options.suggestedName,
            handle: null,
        };
    }

    try {
        const handle = await saveFilePicker({
            suggestedName: options.suggestedName,
            types: options.pickerTypes,
            excludeAcceptAllOption: getSavePickerExtensions(options.pickerTypes).length > 0,
        });

        assertSaveHandleName(handle, options.pickerTypes);
        return {
            canceled: false,
            fileName: handle.name,
            handle,
        };
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            return {
                canceled: true,
                fileName: options.suggestedName,
                handle: null,
            };
        }

        throw error;
    }
}

export async function saveBytesToPickerOrDownload(
    bytes: Uint8Array,
    options: {
        suggestedName: string;
        mimeType: string;
        pickerTypes: IFilePickerAcceptType[];
        signal?: AbortSignal;
    },
) {
    return saveBlobToPickerOrDownload(
        new Blob([toBrowserOwnedArrayBuffer(bytes)], { type: options.mimeType }),
        options.suggestedName,
        options.pickerTypes,
        options.signal === undefined ? {} : {signal: options.signal},
    );
}

export async function writeBytesToHandle(
    handle: FileSystemFileHandle,
    data: Uint8Array,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    await ensureFileHandleWritePermission(handle, signal);
    await writeBytesAfterPermission(handle, data, signal);
}

// Inside the physical-save lock, after the caller's preflight. It never prompts.
// The grant is checked before a writer exists, so a conflict or cancellation has no
// writer to abort.
export async function writeBytesToHandleInSaveLock(
    handle: FileSystemFileHandle,
    data: Uint8Array,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    await assertFileHandleWriteGranted(handle);
    await writeBytesAfterPermission(handle, data, signal);
}

async function writeBytesAfterPermission(
    handle: FileSystemFileHandle,
    data: Uint8Array,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const writable = await handle.createWritable();
    try {
        await writeBrowserFileChunks(writable, data, signal);
    } catch (error) {
        await abortAfterBrowserFileWriteError(writable, error);
    }

    await closeBrowserFileWritable(writable);
}

// Inside the physical-save lock, after the caller's preflight. It never prompts.
export async function writeDocumentRefToHandle(
    handle: FileSystemFileHandle,
    ref: TDocumentRef,
) {
    await assertFileHandleWriteGranted(handle);
    const writable = await handle.createWritable();
    let size = 0;
    try {
        ({ size } = await browserDocumentStore.stat(ref));
        for (let offset = 0; offset < size; offset += BROWSER_DOCUMENT_CHUNK_SIZE) {
            const chunk = await browserDocumentStore.readRange(
                ref,
                offset,
                Math.min(BROWSER_DOCUMENT_CHUNK_SIZE, size - offset),
            );
            await writable.write(toBrowserOwnedArrayBuffer(chunk));
            if (offset > 0) {
                await yieldToBrowser();
            }
        }
    } catch (error) {
        await abortAfterBrowserFileWriteError(writable, error);
    }

    await closeBrowserFileWritable(writable);
}
