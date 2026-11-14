import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import * as v from 'valibot';
import {BROWSER_OCR_ENGINE_REVISION} from '@contracts/browserOcrEngine';
import {OCR_WORD_GEOMETRY_SCHEMA} from '@contracts/browserPageOpsWorker';
import type {IDocumentRevisionInfo} from '@contracts/documentRevision';
import type {
    IOcrDiagnostic,
    IOcrSearchablePdfOptions,
    TOcrSearchablePdfPages,
} from '@contracts/electronApiOcr';
import {
    EARLY_PRINT_MODEL_CODES,
    OCR_LANGUAGE_MODEL_SHA256,
    type TOcrModelCode,
} from '@contracts/ocrLanguages';
import {canReadEarlyPrint} from '@ocr-core/earlyPrintReading';
import {iterateOcrPageRequestBatches} from '@ocr-core/ocrPageSelection';
import type {IOcrRecognizedPage} from '@ocr-core/recognizeOcrPages';
import {
    getNativeToolBuildIdentity,
    getRuntimeToolArchiveIdentity,
} from '@electron/native-tools/runNativeToolCommand';

const CHECKPOINT_VERSION = 5;
const OCR_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const finiteSchema = v.pipe(v.number(), v.finite());
const checkpointSchema = v.object({
    version: v.literal(CHECKPOINT_VERSION),
    pdfSha256: v.string(),
    page: v.object({
        pageNumber: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        languages: v.array(v.string()),
        text: v.string(),
        wordEdits: v.array(v.strictObject({
            word: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
            from: v.string(),
            to: v.string(),
        })),
        wordGeometry: OCR_WORD_GEOMETRY_SCHEMA,
        preprocessInverse: v.optional(v.object({
            rasterWidthPx: v.pipe(finiteSchema, v.gtValue(0)),
            rasterHeightPx: v.pipe(finiteSchema, v.gtValue(0)),
            matrix: v.pipe(v.array(v.pipe(v.array(finiteSchema), v.length(3))), v.length(3)),
        })),
        diagnostics: v.custom<IOcrDiagnostic[]>(Array.isArray),
    }),
});

/**
 * One checkpoint directory per job identity: the same document revision,
 * pages, options, engine, tools and models. A changed recipe starts over.
 */
export function createOcrCheckpointFingerprint(job: {
    sourcePdfPath: string;
    documentRevision: Pick<IDocumentRevisionInfo, 'token'>;
    pages: TOcrSearchablePdfPages;
    options: IOcrSearchablePdfOptions;
}) {
    const selection = job.pages;
    const languages = Array.isArray(selection) ? selection.flatMap(page => page.languages)
        : selection.kind === 'pages' ? selection.pages.flatMap(page => page.languages) : selection.languages;
    const models = [...new Set([
        ...languages,
        ...(canReadEarlyPrint(languages) ? EARLY_PRINT_MODEL_CODES : []),
    ])].sort() as TOcrModelCode[];
    return createHash('sha256').update(JSON.stringify({
        sourcePdfPath: job.sourcePdfPath,
        documentRevision: job.documentRevision.token,
        pages: selection,
        options: job.options,
        recipe: {
            version: 4,
            engine: BROWSER_OCR_ENGINE_REVISION,
            scanCleanup: getNativeToolBuildIdentity('evb-scan-cleanup'),
            pageOps: getNativeToolBuildIdentity('evb-pdf-page-ops'),
            poppler: getRuntimeToolArchiveIdentity('poppler'),
            qpdf: getRuntimeToolArchiveIdentity('qpdf'),
            models: models.map(model => [
                model,
                OCR_LANGUAGE_MODEL_SHA256[model],
            ]),
        },
    })).digest('hex');
}

/** Removes checkpoint directories of jobs nobody resumed within a week. */
export async function cleanupStaleOcrJobDirectories(rootDir: string, now = Date.now()) {
    const entries = await readdir(rootDir, {withFileTypes: true}).catch(() => []);
    await Promise.all(entries.filter(entry => entry.isDirectory()).map(async (entry) => {
        const path = join(rootDir, entry.name);
        const info = await stat(path).catch(() => null);
        if (info && now - info.mtimeMs > OCR_JOB_TTL_MS) {
            await rm(path, {
                recursive: true,
                force: true,
            });
        }
    }));
}

function checkpointPaths(checkpointDir: string, pageNumber: number) {
    return {
        json: join(checkpointDir, `page-${pageNumber}.json`),
        pdf: join(checkpointDir, `page-${pageNumber}.pdf`),
    };
}

function sha256(bytes: Uint8Array) {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Persists a recognized page so an interrupted job resumes after it: the
 * page PDF first, then the record naming its digest, each renamed into place.
 */
export async function persistOcrPageCheckpoint(checkpointDir: string, page: IOcrRecognizedPage) {
    const paths = checkpointPaths(checkpointDir, page.pageNumber);
    const suffix = `.${process.pid}.${randomUUID()}.tmp`;
    const {
        pdf, ...record
    } = page;
    try {
        await writeFile(`${paths.pdf}${suffix}`, pdf);
        await writeFile(`${paths.json}${suffix}`, JSON.stringify({
            version: CHECKPOINT_VERSION,
            pdfSha256: sha256(pdf),
            page: record,
        }));
        await rename(`${paths.pdf}${suffix}`, paths.pdf);
        await rename(`${paths.json}${suffix}`, paths.json);
    } finally {
        await Promise.all([
            rm(`${paths.pdf}${suffix}`, {force: true}),
            rm(`${paths.json}${suffix}`, {force: true}),
        ]).catch(() => undefined);
    }
}

async function readCheckpoint(checkpointDir: string, pageNumber: number) {
    const paths = checkpointPaths(checkpointDir, pageNumber);
    try {
        const parsed = v.safeParse(checkpointSchema, JSON.parse(await readFile(paths.json, 'utf8')), {abortEarly: true});
        if (!parsed.success || parsed.output.page.pageNumber !== pageNumber) return null;
        return {
            pdfPath: paths.pdf,
            pdfSha256: parsed.output.pdfSha256,
            page: parsed.output.page as Omit<IOcrRecognizedPage, 'pdf'>,
        };
    } catch {
        return null;
    }
}

/** The page an earlier run recognized, when its record and PDF are intact; otherwise none. */
export async function restoreOcrPageCheckpoint(checkpointDir: string, pageNumber: number): Promise<IOcrRecognizedPage | null> {
    const checkpoint = await readCheckpoint(checkpointDir, pageNumber);
    const pdf = checkpoint && await readFile(checkpoint.pdfPath).catch(() => null);
    if (checkpoint && pdf && pdf.byteLength > 0 && sha256(pdf) === checkpoint.pdfSha256) {
        return {
            ...checkpoint.page,
            pdf,
        };
    }
    const paths = checkpointPaths(checkpointDir, pageNumber);
    await Promise.all([
        rm(paths.json, {force: true}),
        rm(paths.pdf, {force: true}),
    ]).catch(() => undefined);
    return null;
}

/** The checkpointed pages of a selection in page order, one record at a time, for the text-layer writer. */
export async function* iterateOcrPageCheckpoints(
    selection: TOcrSearchablePdfPages,
    checkpointDir: string,
    signal: AbortSignal,
) {
    for (const batch of iterateOcrPageRequestBatches(selection)) {
        for (const request of batch) {
            signal.throwIfAborted();
            const checkpoint = await readCheckpoint(checkpointDir, request.pageNumber);
            if (checkpoint) yield checkpoint;
        }
    }
}
