import {randomUUID} from 'node:crypto';
import {
    rm,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {
    abortErrorFromSignal, isAbortError,
} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';
import {
    decodePdfOcrTextVisibilityReport,
    decodePdfOcrTextVisibilityRequest,
    PDF_OCR_TEXT_VISIBILITY_REQUEST_MAX_BYTES,
    PDF_OCR_TEXT_VISIBILITY_REPORT_MAX_BYTES,
    type IPdfOcrPageTextVisibility,
} from '@contracts/pdfOcrTextVisibility';

const OCR_TEXT_VISIBILITY_TIMEOUT_MS = 2 * 60 * 1000;
// A request batch holds at most a few thousand pages of fixed-size records.
const OCR_TEXT_VISIBILITY_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
// With the layers' text, a record carries the page's recognized text too.
const OCR_TEXT_VISIBILITY_WITH_TEXT_MAX_STDOUT_BYTES = PDF_OCR_TEXT_VISIBILITY_REPORT_MAX_BYTES;

export type TOcrPdfTextVisibilityAnalysis =
    | {
        status: 'available';
        visibility: Map<number, IPdfOcrPageTextVisibility>;
    }
    | {
        status: 'degraded';
        reason: 'native-tool-unavailable' | 'native-tool-failed';
        message: string;
        visibility: Map<number, IPdfOcrPageTextVisibility>;
    };

/**
 * Reads the existing text of the requested pages with the scan the OCR writer
 * replaces text through, in one pass over the document.
 */
export async function inspectPdfPageTextVisibility(input: {
    pdfPath: string;
    pageNumbers: readonly number[];
    pdfPageOpsBinary?: string | undefined;
    qpdfBinary?: string | undefined;
    tempDir: string;
    signal?: AbortSignal;
    withEvbOcrText?: boolean;
}): Promise<TOcrPdfTextVisibilityAnalysis> {
    if (input.pdfPageOpsBinary === undefined) {
        return {
            status: 'degraded',
            reason: 'native-tool-unavailable',
            message: 'evb-pdf-page-ops is unavailable; existing OCR layers could not be inspected',
            visibility: new Map(),
        };
    }
    if (input.pageNumbers.length === 0) {
        return {
            status: 'available',
            visibility: new Map(),
        };
    }
    const pagesPath = join(input.tempDir, `ocr-text-visibility-${randomUUID()}.txt`);
    try {
        await writeFile(pagesPath, `${[...new Set(input.pageNumbers)].join('\n')}\n`);
        const result = await runNativeToolCommand(input.pdfPageOpsBinary, [
            'ocr-text-visibility',
            '--input',
            input.pdfPath,
            '--pages-file',
            pagesPath,
            ...(input.qpdfBinary === undefined ? [] : [
                '--qpdf',
                input.qpdfBinary,
            ]),
            ...(input.withEvbOcrText === true ? ['--with-evb-ocr-text'] : []),
        ], {
            commandLabel: 'evb-pdf-page-ops(ocr-text-visibility)',
            timeoutMs: OCR_TEXT_VISIBILITY_TIMEOUT_MS,
            maxStdoutBytes: input.withEvbOcrText === true
                ? OCR_TEXT_VISIBILITY_WITH_TEXT_MAX_STDOUT_BYTES
                : OCR_TEXT_VISIBILITY_MAX_STDOUT_BYTES,
            rejectOnStdoutTruncation: true,
            ...(input.signal ? {signal: input.signal} : {}),
        });
        const report = decodePdfOcrTextVisibilityReport(JSON.parse(result.stdout));
        return {
            status: 'available',
            visibility: new Map(report.pages.map(page => [
                page.pageNumber,
                page,
            ])),
        };
    } catch (error) {
        if (isAbortError(error) || input.signal?.aborted) {
            throw error;
        }
        return {
            status: 'degraded',
            reason: 'native-tool-failed',
            message: `Existing OCR layers could not be inspected: ${getErrorMessage(error)}`,
            visibility: new Map(),
        };
    } finally {
        await rm(pagesPath, {force: true}).catch(() => undefined);
    }
}

/** One lazy native load owned by one extraction, with one in-flight window. */
export function createPdfPageTextVisibilitySession(input: {
    pdfPath: string;
    pdfPageOpsBinary?: string | undefined;
    qpdfBinary?: string | undefined;
    signal?: AbortSignal | undefined;
}) {
    const controller = new AbortController();
    let request = Promise.withResolvers<string | null>();
    let response: ReturnType<typeof Promise.withResolvers<TOcrPdfTextVisibilityAnalysis>> | undefined;
    let production: Promise<void> | undefined;
    let failure: TOcrPdfTextVisibilityAnalysis | undefined;
    let pending = '';
    let pendingBytes = 0;
    let selected: readonly number[] = [];
    const abort = () => controller.abort(input.signal?.reason);
    const release = () => {
        request.resolve(null);
        response?.reject(abortErrorFromSignal(controller.signal));
    };
    input.signal?.addEventListener('abort', abort, {once: true});
    controller.signal.addEventListener('abort', release, {once: true});
    if (input.signal?.aborted) abort();

    return {
        async inspect(pageNumbers: readonly number[]): Promise<TOcrPdfTextVisibilityAnalysis> {
            controller.signal.throwIfAborted();
            if (pageNumbers.length === 0) return {
                status: 'available',
                visibility: new Map(),
            };
            if (input.pdfPageOpsBinary === undefined) return {
                status: 'degraded',
                reason: 'native-tool-unavailable',
                message: 'evb-pdf-page-ops is unavailable; existing OCR layers could not be inspected',
                visibility: new Map(),
            };
            if (failure) return failure;
            let line: string;
            try {
                if (response) throw new Error('A visibility window is already in flight');
                line = `${JSON.stringify(decodePdfOcrTextVisibilityRequest(pageNumbers))}\n`;
                if (Buffer.byteLength(line) > PDF_OCR_TEXT_VISIBILITY_REQUEST_MAX_BYTES) {
                    throw new Error('OCR visibility request exceeds its byte limit');
                }
            } catch (error) {
                controller.abort(error);
                await production;
                throw error;
            }
            selected = pageNumbers;
            response = Promise.withResolvers<TOcrPdfTextVisibilityAnalysis>();
            const result = response;
            production ??= runNativeToolCommand(input.pdfPageOpsBinary, [
                'ocr-text-visibility',
                '--input',
                input.pdfPath,
                '--pages-stdin',
                '--with-evb-ocr-text',
                ...(input.qpdfBinary === undefined ? [] : [
                    '--qpdf',
                    input.qpdfBinary,
                ]),
            ], {
                commandLabel: 'evb-pdf-page-ops(ocr-text-visibility)',
                timeoutMs: OCR_TEXT_VISIBILITY_TIMEOUT_MS,
                timeoutResetsOnStdout: true,
                longLived: true,
                maxStdoutBytes: 64 * 1024,
                rejectOnStdoutTruncation: false,
                signal: controller.signal,
                stdin: (async function* () {
                    for (;;) {
                        const pages = await request.promise;
                        request = Promise.withResolvers<string | null>();
                        if (pages === null) return;
                        yield pages;
                    }
                })(),
                onStdout(chunk) {
                    pending += chunk;
                    pendingBytes += Buffer.byteLength(chunk);
                    const newline = chunk.indexOf('\n');
                    if (pendingBytes > OCR_TEXT_VISIBILITY_WITH_TEXT_MAX_STDOUT_BYTES + (newline < 0 ? 0 : 1)) {
                        throw new Error('OCR visibility report exceeds its byte limit');
                    }
                    if (newline < 0) return;
                    const end = pending.length - chunk.length + newline;
                    const report = decodePdfOcrTextVisibilityReport(JSON.parse(pending.slice(0, end)));
                    pending = pending.slice(end + 1);
                    if (!response || pending.length > 0 || report.pages.length !== selected.length
                        || report.pages.some((page, index) => page.pageNumber !== selected[index])) {
                        throw new Error('OCR visibility returned an unexpected window');
                    }
                    pendingBytes = 0;
                    response.resolve({
                        status: 'available',
                        visibility: new Map(report.pages.map(page => [
                            page.pageNumber,
                            page,
                        ])),
                    });
                    response = undefined;
                },
            }).then(() => {
                throw new Error('OCR visibility session ended before extraction');
            }).catch((error: unknown) => {
                request.resolve(null);
                if (controller.signal.aborted) {
                    response?.reject(error);
                } else {
                    failure = {
                        status: 'degraded',
                        reason: 'native-tool-failed',
                        message: `Existing OCR layers could not be inspected: ${getErrorMessage(error)}`,
                        visibility: new Map(),
                    };
                    response?.resolve(failure);
                }
                response = undefined;
            });
            request.resolve(line);
            return result.promise;
        },
        async close() {
            request.resolve(null);
            try {
                await production;
            } finally {
                controller.abort();
                input.signal?.removeEventListener('abort', abort);
            }
        },
    };
}
