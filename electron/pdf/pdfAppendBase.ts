import {
    rename,
    rm,
} from 'fs/promises';
import * as v from 'valibot';
import {
    PDF_APPEND_ADMISSION_SCHEMA,
    type TPdfAppendAdmission,
} from '@contracts/pdfAppendAdmission';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/public/nativePageOpsPath';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { isAbortError } from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('pdf-append-base');

const QPDF_REWRITE_TIMEOUT_MS = 10 * 60 * 1000;
// Admission reads the file tail; only a base above the native eager-load
// ceiling runs qpdf's page-tree walk, which has its own 110-second bound.
const APPEND_ADMISSION_TIMEOUT_MS = 2 * 60 * 1000;
const APPEND_ADMISSION_MAX_OUTPUT_BYTES = 64 * 1024;

/** qpdf could not turn a source into a base that an edit can extend. */
export class PdfAppendBaseRewriteError extends Error {
    constructor(cause: unknown) {
        super(`PDF rewrite failed: ${getErrorMessage(cause)}`, {cause});
        this.name = 'PdfAppendBaseRewriteError';
    }
}

/** Rewrites a PDF through qpdf, which rebuilds a damaged cross-reference table. */
export async function rewritePdfWithQpdf(
    inputPath: string,
    outputPath: string,
    operation?: {
        signal: AbortSignal;
        cancelGroup?: string;
    },
) {
    await runNativeToolCommand(getPdfNativeToolPaths().qpdf, [
        inputPath,
        outputPath,
    ], {
        allowedExitCodes: [
            0,
            3,
        ],
        commandLabel: 'qpdf(rewrite)',
        timeoutMs: QPDF_REWRITE_TIMEOUT_MS,
        ...(operation === undefined ? {} : {
            signal: operation.signal,
            ...(operation.cancelGroup === undefined ? {} : {cancelGroup: operation.cancelGroup}),
        }),
    });
}

/**
 * What the append path would make of this PDF. The native writer answers with
 * its append loaders' own structural acceptance.
 */
async function readPdfAppendAdmission(
    binaryPath: string,
    filePath: string,
    signal?: AbortSignal,
): Promise<TPdfAppendAdmission> {
    const {stdout} = await runNativeToolCommand(binaryPath, [
        'append-admission',
        '--input',
        filePath,
        '--qpdf',
        getPdfNativeToolPaths().qpdf,
    ], {
        timeoutMs: APPEND_ADMISSION_TIMEOUT_MS,
        maxStdoutBytes: APPEND_ADMISSION_MAX_OUTPUT_BYTES,
        rejectOnStdoutTruncation: true,
        commandLabel: 'evb-pdf-page-ops(append-admission)',
        ...(signal === undefined ? {} : {signal}),
    });
    return v.parse(PDF_APPEND_ADMISSION_SCHEMA, JSON.parse(stdout));
}

export async function pdfNeedsAppendBaseRewrite(filePath: string, signal?: AbortSignal) {
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        return false;
    }
    return (await readPdfAppendAdmission(binaryPath, filePath, signal)).verdict === 'repairable';
}

export interface INormalizePdfAppendBaseOptions {
    /** Takes the resources a whole-file rewrite needs before it starts. */
    admitRewrite?: () => Promise<void>;
    signal?: AbortSignal;
}

/**
 * Gives a new working copy a base that edits can be appended to. qpdf opens a
 * PDF whose cross-reference chain it has to rebuild, but an append has no
 * revision to extend there, so such a source is rewritten into `workingPath`
 * before anything reads it. Every object number the viewer later captures
 * then belongs to the file its edits are saved into. A resource ceiling is
 * not damage and is left to the save that meets it.
 *
 * Returns whether `workingPath` now holds a rewritten base.
 */
export async function normalizePdfAppendBase(
    sourcePath: string,
    workingPath: string,
    options: INormalizePdfAppendBaseOptions = {},
) {
    const {signal} = options;
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        return false;
    }
    const admission = await readPdfAppendAdmission(binaryPath, sourcePath, signal);
    if (admission.verdict !== 'repairable') {
        return false;
    }
    await options.admitRewrite?.();
    const rewrittenPath = `${workingPath}.rewritten.pdf`;
    try {
        await rewritePdfWithQpdf(sourcePath, rewrittenPath, signal === undefined ? undefined : {signal});
        const rewritten = await readPdfAppendAdmission(binaryPath, rewrittenPath, signal);
        if (rewritten.verdict === 'repairable') {
            throw new Error(`The rewritten PDF still cannot take an edit: ${rewritten.reason}`);
        }
        await rename(rewrittenPath, workingPath);
    } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
            throw error;
        }
        throw new PdfAppendBaseRewriteError(error);
    } finally {
        await rm(rewrittenPath, {force: true});
    }
    logger.warn('Rewrote a PDF whose cross-reference chain cannot take an edit', {reason: admission.reason});
    return true;
}
