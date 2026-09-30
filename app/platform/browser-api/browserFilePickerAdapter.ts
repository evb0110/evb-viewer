import { withTimeout } from 'es-toolkit/promise';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    BROWSER_DOCUMENT_CHUNK_SIZE,
    browserDocumentStore,
} from '@app/platform/browserDocumentStore';
import type { IFilePickerAcceptType } from '@app/platform/browser-api/browserFileAccepts';
import {
    buildBrowserByteLimitError,
    toBrowserOwnedArrayBuffer,
} from '@app/platform/browser-api/browserPlatformHelpers';
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

const BROWSER_DOWNLOAD_FALLBACK_MAX_BYTES = 64 * 1024 * 1024;
const BROWSER_OPEN_PICKER_MODE_SESSION_KEY = 'evb-viewer:browser:open-picker-mode';
const BROWSER_OPEN_PICKER_MODE_INPUT = 'input';
const BROWSER_FILE_HANDLE_PERMISSION_TIMEOUT_MS = 120_000;
const BROWSER_FILE_HANDLE_WRITE_PHASE_TIMEOUT_MS = 180_000;
const BROWSER_INPUT_PICKER_FOCUS_CANCEL_INITIAL_DELAY_MS = 2_000;
const BROWSER_INPUT_PICKER_FOCUS_CANCEL_RETRY_DELAY_MS = 1_000;
const BROWSER_INPUT_PICKER_FOCUS_CANCEL_RETRIES = 3;

type TFileSystemPermissionMode = 'read' | 'readwrite';
type TFileSystemPermissionState = 'granted' | 'denied' | 'prompt';
type TPermissionCapableFileHandle = FileSystemFileHandle & {
    queryPermission?: (descriptor?: { mode?: TFileSystemPermissionMode }) => Promise<TFileSystemPermissionState>;
    requestPermission?: (descriptor?: { mode?: TFileSystemPermissionMode }) => Promise<TFileSystemPermissionState>;
};
let browserLargeSaveHandleHintProvider = () => (
    'Use a browser with local file system access enabled to save large documents.'
);

function throwIfAborted(signal?: AbortSignal) {
    signal?.throwIfAborted();
}

export function configureBrowserFilePickerMessages(options: { largeSaveHandleHint?: () => string; }) {
    browserLargeSaveHandleHintProvider = options.largeSaveHandleHint ?? browserLargeSaveHandleHintProvider;
}

export function isFileSystemAccessDeniedError(error: unknown) {
    return error instanceof DOMException
        && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
}

function createBrowserFileWriteTimeoutError(phase: string) {
    const error = new Error(
        `Browser file save did not finish while waiting for ${phase}. `
        + 'If Chrome is showing a file permission prompt, choose Save changes or Cancel and try again.',
    );
    error.name = 'BrowserFileWriteTimeoutError';
    return error;
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

function normalizeBrowserFileHandleError(error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
}

async function runBrowserFileHandlePhase<T>(
    phase: string,
    timeoutMs: number,
    operation: () => Promise<T>,
) {
    try {
        return await withTimeout(operation, timeoutMs);
    } catch (error) {
        if (
            error instanceof Error
            && (error.name === 'TimeoutError' || error.constructor.name === 'TimeoutError')
        ) {
            throw createBrowserFileWriteTimeoutError(phase);
        }
        throw error;
    }
}

async function abortBrowserFileWritable(
    writable: FileSystemWritableFileStream,
) {
    try {
        await runBrowserFileHandlePhase(
            'aborting file writer',
            BROWSER_FILE_HANDLE_WRITE_PHASE_TIMEOUT_MS,
            () => writable.abort(),
        );
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

async function closeBrowserFileWritable(
    writable: FileSystemWritableFileStream,
) {
    try {
        await runBrowserFileHandlePhase(
            'closing file writer',
            BROWSER_FILE_HANDLE_WRITE_PHASE_TIMEOUT_MS,
            () => writable.close(),
        );
    } catch (error) {
        if (await abortBrowserFileWritable(writable)) {
            throw normalizeBrowserFileHandleError(error);
        }
        // close() may still resolve after its deadline. The caller must not
        // report "no write" unless abort() completed, because that late close
        // can publish the file after the save request has returned.
        throw new BrowserFileWriteOutcomeError(error, null);
    }
}

async function ensureFileHandleWritePermission(handle: FileSystemFileHandle) {
    const permissionHandle = handle as TPermissionCapableFileHandle;
    const descriptor = { mode: 'readwrite' as const };
    const queryPermission = permissionHandle.queryPermission?.bind(permissionHandle);
    const requestPermission = permissionHandle.requestPermission?.bind(permissionHandle);

    const currentPermission = queryPermission
        ? await runBrowserFileHandlePhase(
            'file write permission check',
            BROWSER_FILE_HANDLE_PERMISSION_TIMEOUT_MS,
            () => queryPermission(descriptor),
        )
        : 'granted';
    if (currentPermission === 'granted') {
        return;
    }

    const nextPermission = requestPermission
        ? await runBrowserFileHandlePhase(
            'file write permission',
            BROWSER_FILE_HANDLE_PERMISSION_TIMEOUT_MS,
            () => requestPermission(descriptor),
        )
        : currentPermission;
    if (nextPermission !== 'granted') {
        throw createBrowserFileWritePermissionError();
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

function buildBrowserLargeJobError(
    label: string,
    maxBytes: number,
    hint?: string,
) {
    return buildBrowserByteLimitError(
        label,
        maxBytes,
        'inputs',
        hint,
    );
}

function buildBrowserLargeDownloadFallbackError(
    label: string,
    maxBytes: number,
) {
    return buildBrowserLargeJobError(label, maxBytes, browserLargeSaveHandleHintProvider());
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

    if (typeof document === 'undefined' || typeof window === 'undefined') {
        return [];
    }

    // A browser opens a file chooser only within a user activation and reports
    // no event when it refuses one, so without activation the input would wait
    // forever. The pick ends as cancelled instead.
    const userActivation: UserActivation | undefined = navigator.userActivation;
    if (userActivation?.isActive === false) {
        return [];
    }

    return new Promise<IPickedBrowserFile[]>((resolve) => {
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

        const finish = (files: File[]) => {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            resolve(
                files.map((file) => ({
                    file,
                    handle: null,
                })),
            );
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

                finish([]);
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
        input.style.display = 'none';
        const supportsCancelEvent = 'oncancel' in input;
        if (supportsCancelEvent) {
            input.addEventListener(
                'cancel',
                () => {
                    finish([]);
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

export async function pickSingleFile(options: {
    accept: string;
    pickerTypes?: IFilePickerAcceptType[];
}) {
    const files = await pickFiles(options);
    return files[0] ?? null;
}

async function saveBlobToPickerOrDownload(
    blob: Blob,
    suggestedName: string,
    pickerTypes: IFilePickerAcceptType[],
    options: {
        signal?: AbortSignal;
        downloadFallbackLabel?: string;
        downloadFallbackMaxBytes?: number;
        canDownloadWithoutHandle?: boolean;
    } = {},
) {
    throwIfAborted(options.signal);
    const { saveFilePicker } = resolveBrowserCapabilityTier();
    if (saveFilePicker) {
        try {
            throwIfAborted(options.signal);
            const handle = await saveFilePicker({
                suggestedName,
                types: pickerTypes,
            });

            throwIfAborted(options.signal);
            await ensureFileHandleWritePermission(handle);
            throwIfAborted(options.signal);
            const writable = await runBrowserFileHandlePhase(
                'opening file for writing',
                BROWSER_FILE_HANDLE_PERMISSION_TIMEOUT_MS,
                () => handle.createWritable(),
            );
            try {
                throwIfAborted(options.signal);
                await runBrowserFileHandlePhase(
                    'writing file bytes',
                    BROWSER_FILE_HANDLE_WRITE_PHASE_TIMEOUT_MS,
                    () => writable.write(blob),
                );
                throwIfAborted(options.signal);
            } catch (error) {
                await abortAfterBrowserFileWriteError(writable, error);
            }
            await closeBrowserFileWritable(writable);
            throwIfAborted(options.signal);
            return {
                canceled: false,
                fileName: handle.name || suggestedName,
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

    const maxDownloadBytes = options.downloadFallbackMaxBytes ?? BROWSER_DOWNLOAD_FALLBACK_MAX_BYTES;
    if (
        options.canDownloadWithoutHandle === false
        || blob.size > maxDownloadBytes
    ) {
        throw buildBrowserLargeDownloadFallbackError(
            options.downloadFallbackLabel ?? 'Saving documents',
            maxDownloadBytes,
        );
    }

    throwIfAborted(options.signal);
    const href = URL.createObjectURL(blob);
    try {
        throwIfAborted(options.signal);
    } catch (error) {
        URL.revokeObjectURL(href);
        throw error;
    }
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = suggestedName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1_000);

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
        });

        return {
            canceled: false,
            fileName: handle.name || options.suggestedName,
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
        downloadFallbackLabel?: string;
        downloadFallbackMaxBytes?: number;
        canDownloadWithoutHandle?: boolean;
    },
) {
    const fallbackOptions = {
        ...(options.downloadFallbackLabel ? { downloadFallbackLabel: options.downloadFallbackLabel } : {}),
        ...(options.signal === undefined ? {} : {signal: options.signal}),
        ...(options.downloadFallbackMaxBytes !== undefined
            ? { downloadFallbackMaxBytes: options.downloadFallbackMaxBytes }
            : {}),
        ...(options.canDownloadWithoutHandle !== undefined
            ? { canDownloadWithoutHandle: options.canDownloadWithoutHandle }
            : {}),
    };

    return saveBlobToPickerOrDownload(
        new Blob([toBrowserOwnedArrayBuffer(bytes)], { type: options.mimeType }),
        options.suggestedName,
        options.pickerTypes,
        fallbackOptions,
    );
}

export async function writeBytesToHandle(
    handle: FileSystemFileHandle,
    data: Uint8Array,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    await ensureFileHandleWritePermission(handle);
    throwIfAborted(signal);
    const writable = await runBrowserFileHandlePhase(
        'opening file for writing',
        BROWSER_FILE_HANDLE_PERMISSION_TIMEOUT_MS,
        () => handle.createWritable(),
    );
    try {
        throwIfAborted(signal);
        await runBrowserFileHandlePhase(
            'writing file bytes',
            BROWSER_FILE_HANDLE_WRITE_PHASE_TIMEOUT_MS,
            () => writable.write(toBrowserOwnedArrayBuffer(data)),
        );
        throwIfAborted(signal);
    } catch (error) {
        await abortAfterBrowserFileWriteError(writable, error);
    }

    await closeBrowserFileWritable(writable);
}

export async function writeDocumentRefToHandle(
    handle: FileSystemFileHandle,
    ref: TDocumentRef,
) {
    await ensureFileHandleWritePermission(handle);
    const writable = await runBrowserFileHandlePhase(
        'opening file for writing',
        BROWSER_FILE_HANDLE_PERMISSION_TIMEOUT_MS,
        () => handle.createWritable(),
    );
    try {
        const { size } = await browserDocumentStore.stat(ref);
        for (let offset = 0; offset < size; offset += BROWSER_DOCUMENT_CHUNK_SIZE) {
            const chunk = await browserDocumentStore.readRange(
                ref,
                offset,
                Math.min(BROWSER_DOCUMENT_CHUNK_SIZE, size - offset),
            );
            await runBrowserFileHandlePhase(
                'writing file chunk',
                BROWSER_FILE_HANDLE_WRITE_PHASE_TIMEOUT_MS,
                () => writable.write(toBrowserOwnedArrayBuffer(chunk)),
            );
            if (offset > 0) {
                await yieldToBrowser();
            }
        }
    } catch (error) {
        await abortAfterBrowserFileWriteError(writable, error);
    }

    await closeBrowserFileWritable(writable);
}
