import { randomUUID } from 'node:crypto';
import {
    copyFile,
    mkdtemp,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/public/nativePageOpsPath';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import {
    PdfCombineCapabilityError,
    isPdfCombineCapabilityError,
} from '@electron/image/pdfCombineErrors';
import { isAbortError } from '@electron/utils/abort';
import { getErrorMessage } from '@electron/utils/error';

const NATIVE_DJVU_BOOKMARK_TIMEOUT_MS = 2 * 60 * 1000;
const QPDF_DJVU_BOOKMARK_PAGE_COUNT_TIMEOUT_MS = 2 * 60 * 1000;
const QPDF_OUTPUT_SUCCESS_EXIT_CODES = [
    0,
    3,
];

interface IBookmarkNativeCommandOptions {
    signal?: AbortSignal | undefined;
    cancelGroup?: string | undefined;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('Operation aborted', 'AbortError');
    }
}

function createNativeBookmarkMutation(totalPages: number, bookmarks: IPdfBookmarkEntry[]) {
    const bookmarkMutation = {
        totalPages,
        untitledLabel: 'Untitled',
        items: bookmarks,
    };
    return {bookmarks: bookmarkMutation};
}

function createNativeCommandCancellationOptions(options: IBookmarkNativeCommandOptions) {
    return {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.cancelGroup ? { cancelGroup: options.cancelGroup } : {}),
    };
}

function padPdfDatePart(value: number, length = 2) {
    return String(value).padStart(length, '0');
}

function createNativeModifiedAt() {
    const date = new Date();
    return [
        'D:',
        padPdfDatePart(date.getUTCFullYear(), 4),
        padPdfDatePart(date.getUTCMonth() + 1),
        padPdfDatePart(date.getUTCDate()),
        padPdfDatePart(date.getUTCHours()),
        padPdfDatePart(date.getUTCMinutes()),
        padPdfDatePart(date.getUTCSeconds()),
        'Z',
    ].join('');
}

async function getBookmarkInputPdfPageCount(
    inputPdfPath: string,
    options: IBookmarkNativeCommandOptions = {},
) {
    const result = await runNativeToolCommand(getPdfNativeToolPaths().qpdf, [
        '--show-npages',
        inputPdfPath,
    ], {
        timeoutMs: QPDF_DJVU_BOOKMARK_PAGE_COUNT_TIMEOUT_MS,
        allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
        commandLabel: 'qpdf(djvu-bookmark-page-count)',
        ...createNativeCommandCancellationOptions(options),
    });
    const pageCount = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error('Failed to read PDF page count for DjVu bookmarks');
    }

    return pageCount;
}

async function tryEmbedBookmarksWithNativePageOps(
    inputPdfPath: string,
    outputPdfPath: string,
    bookmarks: IPdfBookmarkEntry[],
    signal?: AbortSignal,
) {
    throwIfAborted(signal);

    if (bookmarks.length === 0) {
        if (inputPdfPath !== outputPdfPath) {
            await copyFile(inputPdfPath, outputPdfPath);
        }
        return (await stat(outputPdfPath)).size;
    }

    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        throw createDjvuBookmarkCapabilityError(
            'native-unavailable',
            'Native DjVu bookmark embedding tool is unavailable',
        );
    }

    const cancelGroup = `djvu-bookmarks:${randomUUID()}`;
    let tempDir: string | null = null;
    try {
        tempDir = await mkdtemp(join(tmpdir(), 'djvu-bookmarks-'));
        const workingPath = join(tempDir, 'input.pdf');
        const mutationsPath = join(tempDir, 'bookmarks.json');
        const totalPages = await getBookmarkInputPdfPageCount(inputPdfPath, {
            signal,
            cancelGroup,
        });
        throwIfAborted(signal);
        await copyFile(inputPdfPath, workingPath);
        await writeFile(
            mutationsPath,
            JSON.stringify(createNativeBookmarkMutation(totalPages, bookmarks)),
            'utf8',
        );
        await runNativeToolCommand(binaryPath, [
            'save-mutations',
            '--input',
            workingPath,
            '--output',
            workingPath,
            '--mutations-file',
            mutationsPath,
            '--qpdf',
            getPdfNativeToolPaths().qpdf,
            '--modified-at',
            createNativeModifiedAt(),
            '--append',
        ], {
            timeoutMs: NATIVE_DJVU_BOOKMARK_TIMEOUT_MS,
            commandLabel: 'evb-pdf-page-ops(djvu-bookmarks)',
            ...createNativeCommandCancellationOptions({
                signal,
                cancelGroup,
            }),
        });
        throwIfAborted(signal);
        await copyFile(workingPath, outputPdfPath);
        const outputStats = await stat(outputPdfPath);
        return outputStats.size;
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        if (isPdfCombineCapabilityError(error)) {
            throw error;
        }
        throw createDjvuBookmarkCapabilityError(
            'native-failure',
            `Native DjVu bookmark embedding failed: ${getErrorMessage(error)}`,
            error,
        );
    } finally {
        if (tempDir !== null) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        }
    }
}

function createDjvuBookmarkCapabilityError(
    code: 'native-unavailable' | 'native-failure',
    message: string,
    cause?: unknown,
) {
    return new PdfCombineCapabilityError(code, message, {
        ...(cause === undefined ? {} : {cause}),
        operation: 'djvu-bookmarks',
    });
}

export async function embedBookmarksIntoPdfFile(
    inputPdfPath: string,
    outputPdfPath: string,
    bookmarks: IPdfBookmarkEntry[],
    signal?: AbortSignal,
) {
    return tryEmbedBookmarksWithNativePageOps(inputPdfPath, outputPdfPath, bookmarks, signal);
}
