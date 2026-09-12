import {
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {
    basename,
    dirname,
    join,
} from 'path';
import type {
    IPdfMrcLayers,
    TScanCleanupLog,
    TScanCleanupRunCommand,
    IScanCleanupRunCommandOptions,
} from '@evb/scan-cleanup/core/types';
import {getErrorMessage} from '@contracts/getErrorMessage';
import {mapScanCleanupRasterPages} from '@evb/scan-cleanup/core/resolveRasterHandoff';
import {
    decode as decodePng,
    encode as encodePng,
} from 'fast-png';

interface IPdfImagesRow {
    bitsPerComponent: number;
    dpi: number;
    encoding: string;
    generationNumber: number;
    height: number;
    imageNumber: number;
    objectNumber: number;
    pageNumber: number;
    type: string;
    width: number;
}

export interface IPdfMrcLayerTarget {
    backgroundOutputPath: string;
    foregroundOutputPath: string;
    pageNumber: number;
    selectionMaskOutputPath: string;
}

function parsePdfImagesRows(output: string) {
    const rows: IPdfImagesRow[] = [];
    for (const line of output.split(/\r?\n/u)) {
        const parts = line.trim().split(/\s+/u);
        if (parts.length < 14) continue;
        const pageNumber = Number.parseInt(parts[0] ?? '', 10);
        const imageNumber = Number.parseInt(parts[1] ?? '', 10);
        const width = Number.parseInt(parts[3] ?? '', 10);
        const height = Number.parseInt(parts[4] ?? '', 10);
        const bitsPerComponent = Number.parseInt(parts[7] ?? '', 10);
        const objectNumber = Number.parseInt(parts[10] ?? '', 10);
        const generationNumber = Number.parseInt(parts[11] ?? '', 10);
        const xDpi = Number.parseFloat(parts[12] ?? '');
        const yDpi = Number.parseFloat(parts[13] ?? '');
        if (
            !Number.isSafeInteger(pageNumber)
            || pageNumber <= 0
            || !Number.isSafeInteger(imageNumber)
            || imageNumber < 0
            || !Number.isSafeInteger(width)
            || width <= 0
            || !Number.isSafeInteger(height)
            || height <= 0
            || !Number.isSafeInteger(bitsPerComponent)
            || bitsPerComponent <= 0
            || !Number.isSafeInteger(objectNumber)
            || objectNumber <= 0
            || !Number.isSafeInteger(generationNumber)
            || generationNumber < 0
            || !Number.isFinite(xDpi)
            || xDpi <= 0
            || !Number.isFinite(yDpi)
            || yDpi <= 0
        ) {
            continue;
        }
        rows.push({
            pageNumber,
            imageNumber,
            type: parts[2] ?? '',
            width,
            height,
            bitsPerComponent,
            encoding: parts[8] ?? '',
            generationNumber,
            objectNumber,
            dpi: Math.min(xDpi, yDpi),
        });
    }
    return rows;
}

type TPdfMrcMaskDecode = IPdfMrcLayers['selectionMaskDecode'];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown) {
    return isRecord(error)
        && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

function qpdfObjectTable(value: unknown) {
    if (!isRecord(value) || !Array.isArray(value.qpdf)) {
        return null;
    }
    const qpdf: unknown[] = value.qpdf;
    const table = [...qpdf].reverse().find(entry =>
        isRecord(entry) && Object.keys(entry).some(key => key.startsWith('obj:')),
    );
    // A narrowed query whose objects are all absent yields no obj entry at all,
    // which is an empty answer rather than malformed output.
    return isRecord(table) ? table : {};
}

function qpdfStreamDictionary(
    objects: Record<string, unknown>,
    reference: string,
) {
    const object = objects[`obj:${reference}`];
    if (!isRecord(object) || !isRecord(object.stream) || !isRecord(object.stream.dict)) {
        return null;
    }
    return object.stream.dict;
}

function pdfImagesRowReference(row: IPdfImagesRow) {
    return `${String(row.objectNumber)} ${String(row.generationNumber)} R`;
}

function resolveMrcMaskDecode(maskDictionary: Record<string, unknown> | null) {
    if (
        maskDictionary?.['/Filter'] !== '/JBIG2Decode'
        || maskDictionary['/BitsPerComponent'] !== 1
    ) {
        return null;
    }
    const decode = maskDictionary['/Decode'];
    if (decode === undefined) {
        return 'default';
    }
    if (
        Array.isArray(decode)
        && decode.length === 2
        && decode[0] === 0
        && decode[1] === 1
    ) {
        return 'default';
    }
    if (
        Array.isArray(decode)
        && decode.length === 2
        && decode[0] === 1
        && decode[1] === 0
    ) {
        return 'inverted';
    }
    return null;
}

function qpdfObjectSelectors(references: readonly string[]) {
    return references.flatMap((reference) => {
        const parsed = /^(\d+) (\d+) R$/u.exec(reference);
        return parsed === null ? [] : [`--json-object=${parsed[1]!},${parsed[2]!}`];
    });
}

async function queryQpdfObjects(input: {
    pdfPath: string;
    qpdfBinary: string;
    runCommand: TScanCleanupRunCommand;
    commandOptions: IScanCleanupRunCommandOptions;
    references: readonly string[];
}) {
    const selectors = qpdfObjectSelectors(input.references);
    if (selectors.length === 0) {
        return {};
    }
    const result = await input.runCommand(
        input.qpdfBinary,
        [
            '--json',
            '--json-stream-data=none',
            '--json-key=qpdf',
            ...selectors,
            input.pdfPath,
        ],
        {
            ...input.commandOptions,
            commandLabel: `qpdf(MRC-mask-dictionaries,objects=${String(selectors.length)})`,
            // A batch's worth of image dictionaries is kilobytes; this ceiling
            // only exists so a pathological dictionary fails loudly instead of
            // parsing truncated JSON as a syntax error.
            maxStdoutBytes: 4_194_304,
            rejectOnStdoutTruncation: true,
        },
    );
    const objects = qpdfObjectTable(JSON.parse(result.stdout) as unknown);
    if (objects === null) {
        throw new Error('qpdf JSON contains no object table');
    }
    return objects;
}

// Polarity needs a handful of dictionary entries, so the two passes ask qpdf
// for exactly the foreground objects of the batch and then for the masks they
// point at. Dumping the whole object table instead made peak memory scale with
// the document rather than with the number of masks, which could exhaust the
// scan-cleanup worker's heap on a large book.
function createMrcMaskDecodeLookup(input: {
    pdfPath: string;
    qpdfBinary: string;
    runCommand: TScanCleanupRunCommand;
    commandOptions: IScanCleanupRunCommandOptions;
    log: TScanCleanupLog;
}) {
    const decodeByForeground = new Map<string, TPdfMrcMaskDecode | null>();
    let unavailable = false;
    let pending: Promise<unknown> = Promise.resolve();

    const inspect = async (foregrounds: readonly IPdfImagesRow[]) => {
        const references = [...new Set(
            foregrounds
                .map(pdfImagesRowReference)
                .filter(reference => !decodeByForeground.has(reference)),
        )];
        if (unavailable || references.length === 0) {
            return;
        }
        try {
            const foregroundObjects = await queryQpdfObjects({
                ...input,
                references,
            });
            const maskByForeground = new Map<string, string>();
            for (const reference of references) {
                const maskReference = qpdfStreamDictionary(foregroundObjects, reference)?.['/SMask'];
                if (typeof maskReference === 'string') {
                    maskByForeground.set(reference, maskReference);
                }
            }
            const maskObjects = await queryQpdfObjects({
                ...input,
                references: [...new Set(maskByForeground.values())],
            });
            for (const reference of references) {
                const maskReference = maskByForeground.get(reference);
                decodeByForeground.set(
                    reference,
                    maskReference === undefined
                        ? null
                        : resolveMrcMaskDecode(qpdfStreamDictionary(maskObjects, maskReference)),
                );
            }
        } catch (error) {
            input.commandOptions.signal?.throwIfAborted();
            if (isAbortError(error)) {
                throw error;
            }
            unavailable = true;
            input.log(
                'warn',
                `PDF MRC compact reuse skipped because source mask polarity could not be read: ${
                    getErrorMessage(error)
                }`,
            );
        }
    };

    return async (foregrounds: readonly IPdfImagesRow[]) => {
        // One inspection at a time, so concurrent batches share a cache entry
        // instead of racing two qpdf runs for the same objects.
        const run = pending.catch(() => undefined).then(() => inspect(foregrounds));
        pending = run.catch(() => undefined);
        await run;
        return (foreground: IPdfImagesRow) =>
            decodeByForeground.get(pdfImagesRowReference(foreground)) ?? null;
    };
}

interface IPdfMrcRowSelection {
    background: IPdfImagesRow;
    foreground: IPdfImagesRow;
    selection: IPdfImagesRow;
}

function selectPdfMrcRows(rows: readonly IPdfImagesRow[]): IPdfMrcRowSelection | null {
    const candidateIndex = rows.reduce((best, row, index) => {
        if (row.type !== 'smask' || row.bitsPerComponent !== 1) {
            return best;
        }
        if (best < 0) {
            return index;
        }
        const bestRow = rows[best]!;
        return row.width * row.height > bestRow.width * bestRow.height ? index : best;
    }, -1);
    if (candidateIndex < 0) {
        return null;
    }
    const selection = rows[candidateIndex]!;
    const foreground = rows[candidateIndex - 1];
    if (
        foreground === undefined
        || foreground.type !== 'image'
        || foreground.width !== selection.width
        || foreground.height !== selection.height
    ) {
        return null;
    }
    const selectionAspect = selection.width / selection.height;
    const background = rows
        .filter(row =>
            row.imageNumber !== foreground.imageNumber
            && row.type === 'image'
            && row.bitsPerComponent > 1
            && row.dpi <= selection.dpi
            && Math.abs(row.width / row.height / selectionAspect - 1) <= 0.02,
        )
        .sort((left, right) =>
            right.width * right.height - left.width * left.height,
        )[0];
    return background === undefined ? null : {
        background,
        foreground,
        selection,
    };
}

async function readableFile(path: string) {
    try {
        const value = await stat(path);
        return value.isFile() && value.size > 0;
    } catch {
        return false;
    }
}

async function normalizeSelectionPng(path: string) {
    const decoded = decodePng(await readFile(path));
    if (decoded.depth === 8 && decoded.channels === 1) {
        return;
    }
    if (decoded.depth !== 1 || decoded.channels !== 1) {
        throw new Error('PDF MRC selection mask is not a one-bit grayscale PNG');
    }
    const rowBytes = Math.ceil(decoded.width / 8);
    const expanded = new Uint8Array(decoded.width * decoded.height);
    for (let y = 0; y < decoded.height; y += 1) {
        for (let x = 0; x < decoded.width; x += 1) {
            const packed = decoded.data[y * rowBytes + Math.floor(x / 8)]!;
            expanded[y * decoded.width + x] = packed & (0x80 >> (x % 8)) ? 255 : 0;
        }
    }
    await writeFile(path, encodePng({
        channels: 1,
        data: expanded,
        depth: 8,
        height: decoded.height,
        width: decoded.width,
    }));
}

const MRC_EXTRACTION_BATCH_PAGE_LIMIT = 16;
const MRC_EXTRACTION_BATCH_SPAN_LIMIT = 24;

function chunkMrcTargets(targets: readonly IPdfMrcLayerTarget[]) {
    const chunks: IPdfMrcLayerTarget[][] = [];
    for (const target of [...targets].sort((left, right) => left.pageNumber - right.pageNumber)) {
        const chunk = chunks.at(-1);
        if (
            chunk === undefined
            || chunk.length >= MRC_EXTRACTION_BATCH_PAGE_LIMIT
            || target.pageNumber - chunk[0]!.pageNumber >= MRC_EXTRACTION_BATCH_SPAN_LIMIT
        ) {
            chunks.push([target]);
        } else {
            chunk.push(target);
        }
    }
    return chunks;
}

function numberedOutputPath(prefix: string, imageNumber: number, extension: string) {
    return `${prefix}-${String(imageNumber).padStart(3, '0')}.${extension}`;
}

function numberedPageOutput(path: string) {
    const match = /-(\d+)\.(?:jpe?g|ppm)$/u.exec(path);
    return match === null ? Number.POSITIVE_INFINITY : Number.parseInt(match[1]!, 10);
}

/**
 * Extracts reusable MRC layers without asking `pdfimages -png` to decompress
 * every high-resolution JP2 foreground. `-all` publishes the original compact
 * JP2/JBIG2 streams quickly; only the small continuous-tone backgrounds are
 * wrapped in a temporary PDF and rendered to pipeline-readable PPM in one
 * bounded batch.
 *
 * The returned JBIG2 selection mask is decoded by evb-scan-cleanup. Keeping it
 * compressed here avoids hundreds of multi-megapixel PNG decodes before the
 * actual cleanup has even started.
 */
export async function extractPdfMrcLayersBatch(input: {
    pdfPath: string;
    targets: readonly IPdfMrcLayerTarget[];
    pdfimagesBinary: string | undefined;
    qpdfBinary: string;
    pdfImageCombineBinary: string;
    pdftoppmBinary: string;
    runCommand: TScanCleanupRunCommand;
    log: TScanCleanupLog;
    rasterConcurrency: number;
    signal?: AbortSignal;
    onProgress?: (completedPages: number, totalPages: number) => void;
}) {
    const extracted = new Map<number, IPdfMrcLayers>();
    if (input.pdfimagesBinary === undefined || input.targets.length === 0) {
        return extracted;
    }
    const pdfimagesBinary = input.pdfimagesBinary;
    const commandOptions = {
        log: input.log,
        ...(input.signal === undefined ? {} : {signal: input.signal}),
    };
    let completedPages = 0;
    const failures: Array<{
        error: unknown;
        pages: number[]
    }> = [];
    const lookupMrcMaskDecode = createMrcMaskDecodeLookup({
        pdfPath: input.pdfPath,
        qpdfBinary: input.qpdfBinary,
        runCommand: input.runCommand,
        commandOptions,
        log: input.log,
    });
    const completePages = (count: number) => {
        completedPages += count;
        input.onProgress?.(completedPages, input.targets.length);
    };
    await mapScanCleanupRasterPages(
        chunkMrcTargets(input.targets),
        input.rasterConcurrency,
        async (targets, chunkIndex) => {
            try {
                input.signal?.throwIfAborted();
                const firstPage = targets[0]!.pageNumber;
                const lastPage = targets.at(-1)!.pageNumber;
                const outputDirectory = dirname(targets[0]!.selectionMaskOutputPath);
                if (targets.some(target =>
                    dirname(target.backgroundOutputPath) !== outputDirectory
            || dirname(target.foregroundOutputPath) !== outputDirectory
            || dirname(target.selectionMaskOutputPath) !== outputDirectory,
                )) {
                    throw new Error('PDF MRC batch outputs must share one scratch directory');
                }
                const batchName = `.mrc-batch-${String(chunkIndex)}-${String(firstPage)}-${String(lastPage)}`;
                const rawPrefix = join(outputDirectory, `${batchName}-raw`);
                const backgroundPdfPath = join(outputDirectory, `${batchName}-backgrounds.pdf`);
                const decodedPrefixName = `${batchName}-background`;
                const decodedPrefix = join(outputDirectory, decodedPrefixName);
                try {
                    const listing = await input.runCommand(
                        pdfimagesBinary,
                        [
                            '-f',
                            String(firstPage),
                            '-l',
                            String(lastPage),
                            '-list',
                            input.pdfPath,
                        ],
                        {
                            ...commandOptions,
                            commandLabel: `pdfimages(MRC-batch-list,pages=${String(firstPage)}-${String(lastPage)})`,
                        },
                    );
                    const rows = parsePdfImagesRows(listing.stdout);
                    const selectedCandidates = targets.flatMap(target => {
                        const selection = selectPdfMrcRows(
                            rows.filter(row => row.pageNumber === target.pageNumber),
                        );
                        // Compact passthrough is intentionally conservative. Unknown
                        // encodings keep the ordinary raster reconstruction path.
                        return selection !== null
                    && selection.background.encoding === 'jpx'
                    && selection.foreground.encoding === 'jpx'
                    && selection.selection.encoding === 'jbig2'
                            ? [{
                                target,
                                selection,
                            }]
                            : [];
                    });
                    if (selectedCandidates.length === 0) {
                        completePages(targets.length);
                        return;
                    }
                    const maskDecodeOf = await lookupMrcMaskDecode(
                        selectedCandidates.map(candidate => candidate.selection.foreground),
                    );
                    const selected = selectedCandidates.flatMap(candidate => {
                        const selectionMaskDecode = maskDecodeOf(candidate.selection.foreground);
                        return selectionMaskDecode === null
                            ? []
                            : [{
                                ...candidate,
                                selectionMaskDecode,
                            }];
                    });
                    if (selected.length === 0) {
                        completePages(targets.length);
                        return;
                    }
                    await input.runCommand(
                        pdfimagesBinary,
                        [
                            '-f',
                            String(firstPage),
                            '-l',
                            String(lastPage),
                            '-all',
                            input.pdfPath,
                            rawPrefix,
                        ],
                        {
                            ...commandOptions,
                            commandLabel: `pdfimages(MRC-batch-raw,pages=${String(firstPage)}-${String(lastPage)})`,
                        },
                    );
                    const available = [];
                    for (const candidate of selected) {
                        const backgroundPath = numberedOutputPath(
                            rawPrefix,
                            candidate.selection.background.imageNumber,
                            'jp2',
                        );
                        const foregroundPath = numberedOutputPath(
                            rawPrefix,
                            candidate.selection.foreground.imageNumber,
                            'jp2',
                        );
                        const selectionPath = numberedOutputPath(
                            rawPrefix,
                            candidate.selection.selection.imageNumber,
                            'jb2e',
                        );
                        if (
                            await readableFile(backgroundPath)
                    && await readableFile(foregroundPath)
                    && await readableFile(selectionPath)
                        ) {
                            available.push({
                                ...candidate,
                                backgroundPath,
                                foregroundPath,
                                selectionPath,
                            });
                        }
                    }
                    if (available.length > 0) {
                        await input.runCommand(
                            input.pdfImageCombineBinary,
                            [
                                '--output',
                                backgroundPdfPath,
                                '--dpi',
                                '72',
                                '--',
                                ...available.map(candidate => candidate.backgroundPath),
                            ],
                            {
                                ...commandOptions,
                                commandLabel: `evb-pdf-image-combine(MRC-backgrounds,pages=${String(firstPage)}-${String(lastPage)})`,
                            },
                        );
                        await input.runCommand(
                            input.pdftoppmBinary,
                            [
                                '-f',
                                '1',
                                '-l',
                                String(available.length),
                                '-r',
                                '72',
                                backgroundPdfPath,
                                decodedPrefix,
                            ],
                            {
                                ...commandOptions,
                                commandLabel: `pdftoppm(MRC-backgrounds,pages=${String(firstPage)}-${String(lastPage)})`,
                            },
                        );
                        const siblings = await readdir(outputDirectory);
                        const decodedBackgrounds = siblings
                            .filter(name =>
                                name.startsWith(`${decodedPrefixName}-`)
                        && name.endsWith('.ppm'),
                            )
                            .map(name => join(outputDirectory, name))
                            .sort((left, right) => numberedPageOutput(left) - numberedPageOutput(right));
                        if (decodedBackgrounds.length !== available.length) {
                            throw new Error(
                                `MRC decoder published ${String(decodedBackgrounds.length)} background(s) `
                        + `for ${String(available.length)} page(s)`,
                            );
                        }
                        for (const [
                            index,
                            candidate,
                        ] of available.entries()) {
                            await Promise.all([
                                rename(decodedBackgrounds[index]!, candidate.target.backgroundOutputPath),
                                // The high-resolution JPX foreground is already the
                                // source's compact, quality-bearing layer. Re-encoding
                                // it as DCT adds no information and expands compact MRC
                                // books by several times. Keep it byte-for-byte and
                                // clean only the low-resolution paper layer.
                                rename(candidate.foregroundPath, candidate.target.foregroundOutputPath),
                                rename(candidate.selectionPath, candidate.target.selectionMaskOutputPath),
                            ]);
                            extracted.set(candidate.target.pageNumber, {
                                backgroundDpi: candidate.selection.background.dpi,
                                backgroundPath: candidate.target.backgroundOutputPath,
                                foregroundDpi: candidate.selection.foreground.dpi,
                                foregroundHeight: candidate.selection.foreground.height,
                                foregroundPath: candidate.target.foregroundOutputPath,
                                foregroundWidth: candidate.selection.foreground.width,
                                selectionMaskDecode: candidate.selectionMaskDecode,
                                selectionMaskPath: candidate.target.selectionMaskOutputPath,
                            });
                        }
                    }
                    completePages(targets.length);
                } finally {
                    const siblings = await readdir(outputDirectory).catch(() => []);
                    await Promise.all([
                        rm(backgroundPdfPath, {force: true}),
                        ...siblings
                            .filter(name =>
                                name.startsWith(`${batchName}-raw-`)
                        || name.startsWith(`${decodedPrefixName}-`),
                            )
                            .map(name => rm(join(outputDirectory, name), {force: true})),
                    ]);
                }
            } catch (error) {
                // Do not let the mapper reject while sibling native commands
                // are still running. Every chunk first completes its own
                // cleanup. Successful siblings remain reusable; only this
                // chunk falls back to raster reconstruction.
                input.signal?.throwIfAborted();
                if (isAbortError(error)) {
                    throw error;
                }
                failures.push({
                    error,
                    pages: targets.map(target => target.pageNumber),
                });
                completePages(targets.length);
            }
        },
    );
    for (const failure of failures) {
        input.log(
            'warn',
            `PDF MRC compact reuse skipped for page(s) ${failure.pages.join(', ')}; `
            + `using raster reconstruction for that chunk (${
                getErrorMessage(failure.error)
            })`,
        );
    }
    return extracted;
}

/**
 * Extracts the two authoritative ownership inputs from a PDF MRC page:
 * the low-resolution continuous-tone background, high-resolution foreground
 * image, and high-resolution selection mask. Keeping the original JP2
 * foreground is what lets cleanup whiten paper without repainting maps and
 * photographs black or expanding a compact MRC page into a full-page raster.
 *
 * Only a one-bit soft mask is accepted. Its white samples mean "select the
 * attached foreground image", which is an unambiguous contract; independent
 * one-bit images and PDF image masks have format-dependent polarity and remain
 * on the ordinary raster fallback.
 */
export async function extractPdfMrcLayers(input: {
    pdfPath: string;
    pageNumber: number;
    backgroundOutputPath: string;
    foregroundOutputPath: string;
    selectionMaskOutputPath: string;
    pdfimagesBinary: string | undefined;
    runCommand: TScanCleanupRunCommand;
    log: TScanCleanupLog;
    signal?: AbortSignal;
}) {
    if (input.pdfimagesBinary === undefined) {
        return null;
    }
    const commonArgs = [
        '-f',
        String(input.pageNumber),
        '-l',
        String(input.pageNumber),
    ];
    const commandOptions = {
        log: input.log,
        ...(input.signal === undefined ? {} : {signal: input.signal}),
    };
    const listing = await input.runCommand(
        input.pdfimagesBinary,
        [
            ...commonArgs,
            '-list',
            input.pdfPath,
        ],
        {
            ...commandOptions,
            commandLabel: `pdfimages(MRC-list,page=${String(input.pageNumber)})`,
        },
    );
    const rows = parsePdfImagesRows(listing.stdout);
    const selected = selectPdfMrcRows(rows);
    if (selected === null) {
        return null;
    }

    const outputDirectory = dirname(input.selectionMaskOutputPath);
    if (
        dirname(input.backgroundOutputPath) !== outputDirectory
        || dirname(input.foregroundOutputPath) !== outputDirectory
    ) {
        throw new Error('PDF MRC layer outputs must share one scratch directory');
    }
    const prefixName = `.${basename(input.selectionMaskOutputPath)}-extract`;
    const prefix = join(outputDirectory, prefixName);
    const rawPrefixName = `.${basename(input.foregroundOutputPath)}-raw`;
    const rawPrefix = join(outputDirectory, rawPrefixName);
    try {
        await input.runCommand(
            input.pdfimagesBinary,
            [
                ...commonArgs,
                '-png',
                input.pdfPath,
                prefix,
            ],
            {
                ...commandOptions,
                commandLabel: `pdfimages(MRC-mask,page=${String(input.pageNumber)})`,
            },
        );
        const extractedSelectionPath =
            `${prefix}-${String(selected.selection.imageNumber).padStart(3, '0')}.png`;
        const extractedBackgroundPath =
            `${prefix}-${String(selected.background.imageNumber).padStart(3, '0')}.png`;
        if (!await readableFile(extractedSelectionPath)) {
            throw new Error(
                `pdfimages did not publish the MRC selection mask for page ${String(input.pageNumber)}`,
            );
        }
        if (!await readableFile(extractedBackgroundPath)) {
            throw new Error(
                `pdfimages did not publish the MRC background for page ${String(input.pageNumber)}`,
            );
        }
        await normalizeSelectionPng(extractedSelectionPath);
        await input.runCommand(
            input.pdfimagesBinary,
            [
                ...commonArgs,
                '-all',
                input.pdfPath,
                rawPrefix,
            ],
            {
                ...commandOptions,
                commandLabel: `pdfimages(MRC-raw,page=${String(input.pageNumber)})`,
            },
        );
        const extractedForegroundPath =
            `${rawPrefix}-${String(selected.foreground.imageNumber).padStart(3, '0')}.jp2`;
        if (!await readableFile(extractedForegroundPath)) {
            // Compact reuse is intentionally conservative. A transformed
            // raster fallback is safer than pretending an unknown foreground
            // encoding is JPEG 2000 and publishing a broken PDF.
            return null;
        }
        await Promise.all([
            rename(extractedSelectionPath, input.selectionMaskOutputPath),
            rename(extractedBackgroundPath, input.backgroundOutputPath),
            rename(extractedForegroundPath, input.foregroundOutputPath),
        ]);
        return {
            backgroundDpi: selected.background.dpi,
            backgroundPath: input.backgroundOutputPath,
            foregroundDpi: selected.foreground.dpi,
            foregroundHeight: selected.foreground.height,
            foregroundPath: input.foregroundOutputPath,
            foregroundWidth: selected.foreground.width,
            selectionMaskDecode: 'default',
            selectionMaskPath: input.selectionMaskOutputPath,
        } satisfies IPdfMrcLayers;
    } finally {
        const siblings = await readdir(outputDirectory).catch(() => []);
        await Promise.all(siblings
            .filter(name =>
                name.startsWith(`${prefixName}-`)
                || name.startsWith(`${rawPrefixName}-`),
            )
            .map(name => rm(join(outputDirectory, name), {force: true})));
    }
}
