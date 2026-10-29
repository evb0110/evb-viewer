import {randomUUID} from 'node:crypto';
import {
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {isAbortError} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';
import {
    hasNativeErrorCode,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import {
    decodePdfOcrTextVisibilityReport,
    PDF_OCR_TEXT_VISIBILITY_REPORT_MAX_BYTES,
    type IPdfOcrPageTextVisibility,
} from '@contracts/pdfOcrTextVisibility';

const OCR_TEXT_VISIBILITY_TIMEOUT_MS = 2 * 60 * 1000;
// A request batch holds at most a few thousand pages of fixed-size records.
const OCR_TEXT_VISIBILITY_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
// With the layers' text, a record carries the page's recognized text too.
const OCR_TEXT_VISIBILITY_WITH_TEXT_MAX_STDOUT_BYTES = PDF_OCR_TEXT_VISIBILITY_REPORT_MAX_BYTES;
// Failures to read the document itself, which every later request repeats:
// qpdf's whole-document structure limits and an unreadable PDF structure.
const DOCUMENT_FAILURE = /qpdf (?:structure|structural|object)|Failed to parse PDF structure/u;
const DOCUMENT_FAILURE_CODES: ReadonlySet<TNativeErrorCode> = new Set([
    'encrypted',
    'needs-password',
    'corrupt-xref',
]);

// A failure the bytes alone decide repeats for every later request: the
// 760 MB report's structure exceeded qpdf's memory estimate on each of five
// OCR batches after 35-47 s, and on each assistant page read after 34 s.
// Recent ones are remembered per file identity, which any write replaces.
// A qpdf run that timed out, was killed or failed to start also reports a
// document failure, and a later request can pass, so it is not remembered.
const PERSISTENT_DOCUMENT_FAILURE = /qpdf (?:structure|structural|object)\b.*\b(?:exceeds|overflow)\b/u;
const PERSISTENT_DOCUMENT_FAILURE_CODES: ReadonlySet<TNativeErrorCode> = new Set([
    'encrypted',
    'needs-password',
]);
const UNREADABLE_DOCUMENTS_REMEMBERED = 8;
const unreadableDocuments = new Map<string, string>();

async function readDocumentIdentity(pdfPath: string) {
    const fileStat = await stat(pdfPath, {bigint: true}).catch(() => null);
    return fileStat
        ? `${pdfPath}\0${fileStat.dev}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeNs}:${fileStat.ctimeNs}`
        : null;
}

export type TOcrPdfTextVisibilityAnalysis =
    | {
        status: 'available';
        visibility: Map<number, IPdfOcrPageTextVisibility>;
    }
    | {
        status: 'degraded';
        reason: 'native-tool-unavailable' | 'native-tool-failed' | 'document-unreadable';
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
    const identity = await readDocumentIdentity(input.pdfPath);
    const knownFailure = identity === null ? undefined : unreadableDocuments.get(identity);
    if (knownFailure !== undefined) {
        return {
            status: 'degraded',
            reason: 'document-unreadable',
            message: knownFailure,
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
        const message = `Existing OCR layers could not be inspected: ${getErrorMessage(error)}`;
        const documentUnreadable = hasNativeErrorCode(error) && DOCUMENT_FAILURE_CODES.has(error.code)
            || DOCUMENT_FAILURE.test(getErrorMessage(error));
        const persistent = hasNativeErrorCode(error) && PERSISTENT_DOCUMENT_FAILURE_CODES.has(error.code)
            || PERSISTENT_DOCUMENT_FAILURE.test(getErrorMessage(error));
        if (persistent && identity !== null) {
            unreadableDocuments.delete(identity);
            unreadableDocuments.set(identity, message);
            for (const oldest of unreadableDocuments.keys()) {
                if (unreadableDocuments.size <= UNREADABLE_DOCUMENTS_REMEMBERED) break;
                unreadableDocuments.delete(oldest);
            }
        }
        return {
            status: 'degraded',
            reason: documentUnreadable ? 'document-unreadable' : 'native-tool-failed',
            message,
            visibility: new Map(),
        };
    } finally {
        await rm(pagesPath, {force: true}).catch(() => undefined);
    }
}
