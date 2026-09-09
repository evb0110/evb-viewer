/* eslint-disable custom/file-naming -- The task contract fixes this CLI filename. */
import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    copyFile,
    mkdir,
    mkdtemp,
    open,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {
    join,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    availableParallelism,
    tmpdir,
    totalmem,
} from 'node:os';
import type {
    IScanCleanupDetectionResult,
    IScanCleanupOptions,
    TScanCleanupOutputModeSetting,
    TScanCleanupProgress,
} from '@contracts/electronApiScanCleanup';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import {
    extractPdfMrcLayers,
    extractPdfMrcLayersBatch,
} from '@evb/scan-cleanup/adapters/extractPdfMrcLayers';
import {
    createPdfPageSizeStore,
    readPdfPageSizes,
} from '@evb/scan-cleanup/core/pdfPageSizes';
import {readAvailableScratchBytes} from '@evb/scan-cleanup/core/resolveRasterHandoff';
import {detectSourceDpiDetails} from '@evb/scan-cleanup/core/sourceDpiDetection';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@evb/scan-cleanup/core/pageBatches';
import {
    runScanCleanupDetection,
    type IScanCleanupDetectionDependencies,
} from '@evb/scan-cleanup/core/detection';
import {
    runScanCleanupConversion,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupWorkerPaths,
} from '@evb/scan-cleanup/core/runScanCleanupConversion';
import {
    parseScanCleanupCompactManifest,
    resolveScanCleanupPageScope,
    type IScanCleanupProvenanceStamp,
    type IScanCleanupRepresentationReport,
} from '@evb/scan-cleanup/core/index';
import type {
    IDetectedPageRaster,
    IScanCleanupProcessResult,
    IScanCleanupDetectionResultStore,
    IScanCleanupPageRasterSource,
    IRunScanCleanupPipelineDependencies,
    IReadPdfPageSizesOptions,
    TScanCleanupGetPageCount,
    TScanCleanupGetPageSizes,
    TScanCleanupRunCommand,
    IScanCleanupRunCommandOptions,
    TScanCleanupLog,
} from '@evb/scan-cleanup/core/types';
import {isScanCleanupCliFallbackSentinel} from '@evb/scan-cleanup/core/compactManifest';
import {
    createCliRenderers,
    buildCliRawMaskEvidenceManifest,
    compactScanCleanupDetectionVerdicts,
    requireCliPublishedRaster,
    resolveCliNativeToolPath,
    runCliNativeToolCommand,
    runCliScanCleanupSidecar,
    snapshotCliDiagnosticMasks,
    writeCliWasmPdfPage,
    type ICliPdfCombineWasmPage,
    type ICliRawMaskEvidence,
} from '@scripts/scanCleanupCliAdapters';
import {createCliRetention} from '@scripts/createCliRetention';
import {flattenLayeredManifestPage} from '@scripts/flattenLayeredManifestPage';
import {
    createScanCleanupDetectionCacheKey,
    DEFAULT_SCAN_CLEANUP_DETECTION_CACHE_PATH,
    runScanCleanupDetectionWithCache,
    type IScanCleanupDetectionRunResult,
} from '@scripts/scanCleanupDetectionCache';

const PAGE_OPS_FALLBACK = '__scan_cleanup_cli_page_ops_fallback__';
const IMAGE_COMBINE_FALLBACK = '__scan_cleanup_cli_image_combine_fallback__';
const CLI_PAGE_RASTER_CACHE_LIMIT = SCAN_CLEANUP_STREAMING_BATCH_PAGES;

const cliDetectionFileSystem: NonNullable<IScanCleanupDetectionDependencies['fileSystem']> = {
    copyFile,
    mkdir,
    mkdtemp,
    open,
    readFile: async (path, encoding) => readFile(path, encoding),
    readdir: async (path, options) => readdir(path, options),
    rm,
    stat,
    writeFile,
};

interface IScanCleanupCliArguments {
    sourcePdfPath: string;
    outputPdfPath: string;
    pages?: number[];
    parity: boolean;
    diagnosticEvidenceDirectory?: string;
    diagnosticMaskPages?: number[];
    detectionCachePath?: string;
    refreshDetection: boolean;
    options: IScanCleanupOptions;
}

function buildSourcePageToOutputPages(report: IScanCleanupRepresentationReport) {
    const outputPageByOrdinal = new Map(report.pages.map(page => [
        page.outputOrdinal,
        page.outputPageNumber,
    ] as const));
    const outputPagesBySource = new Map<number, number[]>();
    for (const mapping of report.outputMappings) {
        const outputPages = outputPagesBySource.get(mapping.sourcePage) ?? [];
        if (mapping.outputOrdinal !== null) {
            const outputPageNumber = outputPageByOrdinal.get(mapping.outputOrdinal);
            if (outputPageNumber === undefined) {
                throw new Error(`Representation report is missing output ordinal ${String(mapping.outputOrdinal)}`);
            }
            outputPages.push(outputPageNumber);
        }
        outputPagesBySource.set(mapping.sourcePage, outputPages);
    }
    return [...outputPagesBySource]
        .sort(([left], [right]) => left - right)
        .map(([
            sourcePage,
            outputPages,
        ]) => ({
            outputPages,
            sourcePage,
        }));
}

function printUsage() {
    process.stderr.write([
        'Usage: pnpm tsx scripts/scan-cleanup-convert.ts --source <pdf> --out <pdf> [flags]',
        '',
        'Flags:',
        '  --no-crop-content',
        '  --no-match-page-size',
        '  --output-mode auto|bw|gray|color|mixed',
        '  --pages <list-or-ranges>',
        '  --preserve-original-quality',
        '  --layout-mode auto|force-single|force-two-page',
        '  --binarization auto|otsu|sauvola|wolf',
        '  --no-normalize-illumination',
        '  --reading-order ltr|rtl',
        '  --thickness <number>',
        '  --despeckle-level off|cautious|normal|aggressive',
        '  --auto-dewarp [--auto-dewarp-depth <number>]',
        '  --skip-blank-pages',
        '  --parity',
        `  --detection-cache [<directory-or-json-path>] (default: ${DEFAULT_SCAN_CLEANUP_DETECTION_CACHE_PATH})`,
        '  --refresh-detection',
        '  --diagnostic-evidence-dir <directory>',
        '  --diagnostic-mask-pages <output-page-list-or-ranges>',
    ].join('\n') + '\n');
}

function parsePageList(value: string) {
    const pages: number[] = [];
    for (const token of value.split(',')) {
        const range = token.trim();
        if (!range) continue;
        const separator = range.indexOf('-');
        if (separator < 0) {
            const page = Number.parseInt(range, 10);
            if (!Number.isSafeInteger(page) || page < 1) {
                throw new Error(`Invalid page selector: ${range}`);
            }
            pages.push(page);
            continue;
        }
        const first = Number.parseInt(range.slice(0, separator), 10);
        const last = Number.parseInt(range.slice(separator + 1), 10);
        if (
            !Number.isSafeInteger(first)
            || !Number.isSafeInteger(last)
            || first < 1
            || last < first
        ) {
            throw new Error(`Invalid page range: ${range}`);
        }
        for (let page = first; page <= last; page += 1) pages.push(page);
    }
    if (pages.length === 0) throw new Error('The --pages selector is empty');
    const orderedPages = pages.sort((left, right) => left - right);
    for (let index = 1; index < orderedPages.length; index += 1) {
        if (orderedPages[index] === orderedPages[index - 1]) {
            throw new Error(`Duplicate page selector: ${String(orderedPages[index])}`);
        }
    }
    return orderedPages;
}

function parseMargins(value: string) {
    const values = value.split(',').map(item => Number.parseFloat(item.trim()));
    if (values.length === 1 && Number.isFinite(values[0])) {
        return {
            leftMm: values[0]!,
            topMm: values[0]!,
            rightMm: values[0]!,
            bottomMm: values[0]!,
        };
    }
    if (values.length !== 4 || values.some(valueItem => !Number.isFinite(valueItem))) {
        throw new Error(`Invalid margins: ${value}`);
    }
    return {
        leftMm: values[0]!,
        topMm: values[1]!,
        rightMm: values[2]!,
        bottomMm: values[3]!,
    };
}

function parseArguments(argv: readonly string[]): IScanCleanupCliArguments {
    const options: IScanCleanupOptions = {
        preserveOriginalQuality: false,
        layoutMode: 'auto',
        outputMode: 'auto',
        binarization: 'auto',
        normalizeIllumination: true,
        readingOrder: 'ltr',
        thickness: 0,
        crop: true,
        matchPageSize: true,
        pageAlignment: 'top-center',
        marginsMm: {
            leftMm: 5,
            topMm: 5,
            rightMm: 5,
            bottomMm: 5,
        },
        despeckleLevel: 'normal',
        autoDewarp: false,
        autoDewarpDepth: undefined,
        skipBlankPages: false,
        pageOverrides: {},
    };
    let sourcePdfPath: string | undefined;
    let outputPdfPath: string | undefined;
    let pages: number[] | undefined;
    let parity = false;
    let diagnosticEvidenceDirectory: string | undefined;
    let diagnosticMaskPages: number[] | undefined;
    let detectionCachePath: string | undefined;
    let refreshDetection = false;
    const valueFor = (index: number, flag: string) => {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`${flag} requires a value`);
        }
        return value;
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]!;
        if (argument === '--') continue;
        switch (argument) {
            case '--source':
                sourcePdfPath = resolve(valueFor(index, argument));
                index += 1;
                break;
            case '--out':
                outputPdfPath = resolve(valueFor(index, argument));
                index += 1;
                break;
            case '--no-crop-content':
                options.crop = false;
                break;
            case '--no-match-page-size':
                options.matchPageSize = false;
                break;
            case '--output-mode': {
                const value = valueFor(index, argument);
                const normalized = value === 'gray' ? 'grayscale' : value;
                if (![
                    'auto',
                    'bw',
                    'grayscale',
                    'color',
                    'mixed',
                ].includes(normalized)) {
                    throw new Error(`Invalid output mode: ${value}`);
                }
                options.outputMode = normalized as TScanCleanupOutputModeSetting;
                index += 1;
                break;
            }
            case '--pages':
                pages = parsePageList(valueFor(index, argument));
                index += 1;
                break;
            case '--preserve-original-quality':
                options.preserveOriginalQuality = true;
                break;
            case '--layout-mode': {
                const value = valueFor(index, argument);
                if (![
                    'auto',
                    'force-single',
                    'force-two-page',
                ].includes(value)) {
                    throw new Error(`Invalid layout mode: ${value}`);
                }
                options.layoutMode = value as IScanCleanupOptions['layoutMode'];
                index += 1;
                break;
            }
            case '--binarization': {
                const value = valueFor(index, argument);
                if (![
                    'auto',
                    'otsu',
                    'sauvola',
                    'wolf',
                ].includes(value)) {
                    throw new Error(`Invalid binarization method: ${value}`);
                }
                options.binarization = value as NonNullable<IScanCleanupOptions['binarization']>;
                index += 1;
                break;
            }
            case '--no-normalize-illumination':
                options.normalizeIllumination = false;
                break;
            case '--reading-order': {
                const value = valueFor(index, argument);
                if (value !== 'ltr' && value !== 'rtl') throw new Error(`Invalid reading order: ${value}`);
                options.readingOrder = value;
                index += 1;
                break;
            }
            case '--thickness': {
                const value = Number.parseFloat(valueFor(index, argument));
                if (!Number.isFinite(value) || value < -5 || value > 5) {
                    throw new Error(`Invalid thickness: ${String(value)}`);
                }
                options.thickness = value;
                index += 1;
                break;
            }
            case '--margins-mm':
                options.marginsMm = parseMargins(valueFor(index, argument));
                index += 1;
                break;
            case '--despeckle-level': {
                const value = valueFor(index, argument);
                if (![
                    'off',
                    'cautious',
                    'normal',
                    'aggressive',
                ].includes(value)) {
                    throw new Error(`Invalid despeckle level: ${value}`);
                }
                options.despeckleLevel = value as NonNullable<IScanCleanupOptions['despeckleLevel']>;
                index += 1;
                break;
            }
            case '--auto-dewarp':
                options.autoDewarp = true;
                break;
            case '--auto-dewarp-depth': {
                const value = Number.parseFloat(valueFor(index, argument));
                if (!Number.isFinite(value) || value < 0.5 || value > 4) {
                    throw new Error(`Invalid auto-dewarp depth: ${String(value)}`);
                }
                options.autoDewarpDepth = value;
                options.autoDewarp = true;
                index += 1;
                break;
            }
            case '--skip-blank-pages':
                options.skipBlankPages = true;
                break;
            case '--parity':
                parity = true;
                break;
            case '--detection-cache': {
                const value = argv[index + 1];
                detectionCachePath = value === undefined || value.startsWith('--')
                    ? resolve(DEFAULT_SCAN_CLEANUP_DETECTION_CACHE_PATH)
                    : resolve(value);
                if (value !== undefined && !value.startsWith('--')) index += 1;
                break;
            }
            case '--refresh-detection':
                refreshDetection = true;
                break;
            case '--diagnostic-evidence-dir':
                diagnosticEvidenceDirectory = resolve(valueFor(index, argument));
                index += 1;
                break;
            case '--diagnostic-mask-pages':
                diagnosticMaskPages = parsePageList(valueFor(index, argument));
                index += 1;
                break;
            case '--help':
            case '-h':
                printUsage();
                process.exitCode = 0;
                throw new Error('');
            default:
                throw new Error(`Unknown argument: ${argument}`);
        }
    }
    if (sourcePdfPath === undefined || outputPdfPath === undefined) {
        printUsage();
        throw new Error('--source and --out are required');
    }
    if (sourcePdfPath === outputPdfPath) throw new Error('--source and --out must differ');
    if ((diagnosticEvidenceDirectory === undefined) !== (diagnosticMaskPages === undefined)) {
        throw new Error('--diagnostic-evidence-dir and --diagnostic-mask-pages must be used together');
    }
    return {
        sourcePdfPath,
        outputPdfPath,
        ...(pages === undefined ? {} : {pages}),
        parity,
        ...(detectionCachePath === undefined ? {} : {detectionCachePath}),
        refreshDetection,
        ...(diagnosticEvidenceDirectory === undefined ? {} : {diagnosticEvidenceDirectory}),
        ...(diagnosticMaskPages === undefined ? {} : {diagnosticMaskPages}),
        options,
    };
}

function resolveTool(binaryName: string, crateName: string, envName?: string) {
    const envOverride = envName === undefined ? undefined : process.env[envName];
    const resolved = resolveCliNativeToolPath(binaryName, crateName, process.cwd(), envOverride);
    if (resolved === null) throw new Error(`Native tool is unavailable: ${crateName}/${binaryName}`);
    if (isScanCleanupCliFallbackSentinel(resolved)) {
        throw new Error(`Native tool path collides with the CLI fallback sentinel namespace: ${resolved}`);
    }
    return resolved;
}

function cliLog(level: 'debug' | 'warn' | 'error', message: string) {
    if (level !== 'debug' || process.env.EVB_SCAN_CLEANUP_CLI_DEBUG === '1') {
        process.stderr.write(`[scan-cleanup] ${level}: ${message}\n`);
    }
}

function nativeOptions(
    options: IScanCleanupRunCommandOptions | undefined,
    fallbackLog: TScanCleanupLog,
): IScanCleanupRunCommandOptions {
    return {
        ...(options ?? {}),
        log: options?.log ?? fallbackLog,
    };
}

function resolveWasmManifestPage(parts: string[]): ICliPdfCombineWasmPage | null {
    const kind = parts[0];
    const widthPoints = Number.parseFloat(parts[1] ?? '');
    const heightPoints = Number.parseFloat(parts[2] ?? '');
    if (
        !Number.isFinite(widthPoints)
        || widthPoints <= 0
        || !Number.isFinite(heightPoints)
        || heightPoints <= 0
    ) {
        return null;
    }
    if (kind === 'image-bilevel' && parts[3] !== undefined) {
        return {
            heightPoints,
            input: {
                kind: 'mask',
                imagePath: parts[3],
            },
            widthPoints,
        };
    }
    if (kind === 'image' && parts[3] !== undefined) {
        return {
            heightPoints,
            input: {
                kind: 'image',
                imagePath: parts[3],
            },
            widthPoints,
        };
    }
    if (kind === 'image-jpeg' && parts[4] !== undefined) {
        const jpegQuality = Number.parseInt(parts[3] ?? '', 10);
        return Number.isSafeInteger(jpegQuality) && jpegQuality > 0
            ? {
                heightPoints,
                input: {
                    kind: 'image',
                    imagePath: parts[4],
                },
                jpegQuality,
                widthPoints,
            }
            : null;
    }
    if (kind === 'layered-jpeg' && parts[5] !== undefined) {
        const jpegQuality = Number.parseInt(parts[3] ?? '', 10);
        return Number.isSafeInteger(jpegQuality) && jpegQuality > 0 && parts[4] !== undefined
            ? {
                heightPoints,
                input: {
                    backgroundPath: parts[4],
                    kind: 'layered',
                    maskPath: parts[5],
                },
                jpegQuality,
                widthPoints,
            }
            : null;
    }
    if (kind === 'layered-color-jpeg' && parts[8] !== undefined) {
        const jpegQuality = Number.parseInt(parts[3] ?? '', 10);
        const color = [
            Number.parseInt(parts[6] ?? '', 10),
            Number.parseInt(parts[7] ?? '', 10),
            Number.parseInt(parts[8], 10),
        ];
        return Number.isSafeInteger(jpegQuality)
            && jpegQuality > 0
            && parts[4] !== undefined
            && parts[5] !== undefined
            && color.every(channel => Number.isSafeInteger(channel) && channel >= 0 && channel <= 255)
            ? {
                heightPoints,
                input: {
                    backgroundPath: parts[4],
                    foregroundColor: color as [number, number, number],
                    kind: 'layered-color',
                    maskPath: parts[5],
                },
                jpegQuality,
                widthPoints,
            }
            : null;
    }
    return null;
}

async function combineCliPagePdfs(
    pagePdfPaths: readonly string[],
    outputPath: string,
    qpdfBinary: string,
    options: IScanCleanupRunCommandOptions,
) {
    const qpdfArgs = [
        '--empty',
        '--pages',
        ...pagePdfPaths.flatMap(pagePath => [
            pagePath,
            '1',
        ]),
        '--',
        outputPath,
    ];
    await runCliNativeToolCommand(qpdfBinary, qpdfArgs, options);
}

async function runImageCombineFallback(
    outputPath: string,
    manifestPath: string,
    qpdfBinary: string,
    img2pdfBinary: string,
    magickBinary: string,
    options: IScanCleanupRunCommandOptions,
) {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'scan-cleanup-combine-'));
    try {
        const lines = parseScanCleanupCompactManifest(await readFile(manifestPath, 'utf8'));
        const pagePdfPaths: string[] = [];
        for (const [
            index,
            line,
        ] of lines.entries()) {
            const parts = line.split('\t');
            const kind = parts[0];
            if (kind === undefined || parts[1] === undefined || parts[2] === undefined) {
                throw new Error(`Invalid scan-cleanup combine manifest line ${String(index + 1)}`);
            }
            const pagePdfPath = join(temporaryDirectory, `page-${String(index + 1)}.pdf`);
            const wasmPage = resolveWasmManifestPage(parts);
            let writtenWithWasm = false;
            if (wasmPage !== null) {
                try {
                    writtenWithWasm = await writeCliWasmPdfPage(
                        wasmPage,
                        pagePdfPath,
                        temporaryDirectory,
                        magickBinary,
                        index,
                        options,
                    );
                } catch (error) {
                    options.log?.('debug', `CLI PDF image combine WASM skipped page ${String(index + 1)}: ${String(error)}`);
                }
            }
            if (!writtenWithWasm) {
                let inputPath: string;
                if (
                    kind === 'layered-jpeg'
                    || kind === 'soft-layered-jpeg'
                    || kind === 'affine-masked-layered-jpeg'
                    || kind === 'layered-color-jpeg'
                ) {
                    inputPath = await flattenLayeredManifestPage(
                        parts,
                        temporaryDirectory,
                        magickBinary,
                        options,
                    );
                } else {
                    const manifestInputPath = parts.at(-1);
                    if (manifestInputPath === undefined) {
                        throw new Error(`Image-combine manifest page ${String(index + 1)} has no input path`);
                    }
                    inputPath = manifestInputPath;
                }
                await runCliNativeToolCommand(img2pdfBinary, [
                    '--nodate',
                    '--pillow-limit-break',
                    '--pagesize',
                    `${parts[1]}ptx${parts[2]}pt`,
                    '--fit',
                    'fill',
                    '--output',
                    pagePdfPath,
                    inputPath,
                ], options);
            }
            pagePdfPaths.push(pagePdfPath);
            options.onStdout?.(JSON.stringify({
                processed: index + 1,
                total: lines.length,
                percent: (index + 1) / Math.max(1, lines.length) * 100,
                elapsedMs: 0,
                estimatedRemainingMs: null,
            }) + '\n');
        }
        await combineCliPagePdfs(pagePdfPaths, outputPath, qpdfBinary, options);
        return {
            exitCode: 0,
            stdout: '',
            stderr: '',
        } satisfies IScanCleanupProcessResult;
    } finally {
        await rm(temporaryDirectory, {
            force: true,
            recursive: true,
        });
    }
}

async function runPageOpsFallback(
    args: string[],
    qpdfBinary: string,
    options: IScanCleanupRunCommandOptions,
) {
    if (args[0] === 'page-sizes') {
        throw new Error('CLI page-ops fallback delegates page geometry to pdfinfo');
    }
    if (args[0] !== 'split-pages') throw new Error(`Unsupported CLI page-ops operation: ${args[0] ?? ''}`);
    const inputPath = args[args.indexOf('--input') + 1];
    const outputPath = args[args.indexOf('--output') + 1];
    const instructionsPath = args[args.indexOf('--instructions-file') + 1];
    if (!inputPath || !outputPath || !instructionsPath) throw new Error('Invalid CLI page-ops fallback arguments');
    const instructions = JSON.parse(await readFile(instructionsPath, 'utf8')) as {pages?: Array<{sourcePageIndex?: number}>;};
    const pages = instructions.pages ?? [];
    if (pages.length === 0) throw new Error('CLI page-ops fallback received no pages');
    const qpdfArgs = [
        '--empty',
        '--coalesce-contents',
        '--pages',
        ...pages.flatMap(page => [
            inputPath,
            String((page.sourcePageIndex ?? 0) + 1),
        ]),
        '--',
        outputPath,
    ];
    await runCliNativeToolCommand(qpdfBinary, qpdfArgs, options);
    return {
        exitCode: 0,
        stdout: '',
        stderr: '',
    } satisfies IScanCleanupProcessResult;
}

function getProgressKey(progress: TScanCleanupProgress) {
    return `${progress.stage}:${String(progress.completedUnits)}:${String(progress.totalUnits)}`;
}

type TScanCleanupCliDetectionRequestFields = Pick<IRunScanCleanupPipelineRequest,
    | 'detectionResultStore'
    | 'documentPriorByPage'
    | 'layoutByPage'
    | 'outputModeRecommendations'
    | 'pagePlanEvidenceByPage'
    | 'softAlphaForegroundRecommendations'
    | 'sourcePageMetadataByPage'
>;

/**
 * Keep the CLI's legacy object fields as a small-document adapter. A large
 * detection result is handed to conversion as its open sidecar store, so
 * this helper never creates one object entry per source page.
 */
export function buildScanCleanupCliDetectionRequestFields(
    detection: IScanCleanupDetectionRunResult,
): TScanCleanupCliDetectionRequestFields {
    if (
        detection.resultStore !== undefined
        && (detection.results.length === 0
            || detection.resultStore.pageCount > SCAN_CLEANUP_STREAMING_BATCH_PAGES)
    ) {
        return {detectionResultStore: detection.resultStore};
    }
    const layoutByPage: NonNullable<IRunScanCleanupPipelineRequest['layoutByPage']> = {};
    const pagePlanEvidenceByPage: NonNullable<IRunScanCleanupPipelineRequest['pagePlanEvidenceByPage']> = {};
    const outputModeRecommendations: NonNullable<IRunScanCleanupPipelineRequest['outputModeRecommendations']> = {};
    const softAlphaForegroundRecommendations: NonNullable<IRunScanCleanupPipelineRequest['softAlphaForegroundRecommendations']> = {};
    const sourcePageMetadataByPage: NonNullable<IRunScanCleanupPipelineRequest['sourcePageMetadataByPage']> = {};
    const documentPriorByPage: NonNullable<IRunScanCleanupPipelineRequest['documentPriorByPage']> = {};
    for (const result of detection.results) {
        const key = String(result.pageNumber);
        layoutByPage[key] = result.classification;
        if (result.pagePlanEvidence !== undefined) pagePlanEvidenceByPage[key] = result.pagePlanEvidence;
        if (result.recommendedOutputMode !== undefined) {
            outputModeRecommendations[key] = result.recommendedOutputMode;
        }
        if (result.softAlphaForegroundRecommendation !== undefined) {
            softAlphaForegroundRecommendations[key] = result.softAlphaForegroundRecommendation;
        }
        if (result.sourcePageMetadata !== undefined) {
            sourcePageMetadataByPage[key] = result.sourcePageMetadata;
        }
        if (result.documentPrior !== null) documentPriorByPage[key] = result.documentPrior;
    }
    return {
        documentPriorByPage,
        layoutByPage,
        outputModeRecommendations,
        pagePlanEvidenceByPage,
        softAlphaForegroundRecommendations,
        sourcePageMetadataByPage,
    };
}

async function main() {
    const argumentsValue = parseArguments(process.argv.slice(2));
    const sourceStats = await stat(argumentsValue.sourcePdfPath);
    const qpdfBinary = resolveTool('qpdf', 'qpdf');
    const pdfinfoBinary = resolveTool('pdfinfo', 'poppler');
    const pdftoppmBinary = resolveTool('pdftoppm', 'poppler');
    const pdfimagesBinary = resolveTool('pdfimages', 'poppler');
    const scanCleanupBinary = resolveTool('evb-scan-cleanup', 'scan-cleanup', 'EVB_SCAN_CLEANUP_PATH');
    const pageOpsBinary = argumentsValue.parity
        ? resolveTool('evb-pdf-page-ops', 'pdf-page-ops', 'EVB_PDF_PAGE_OPS_PATH')
        : PAGE_OPS_FALLBACK;
    const imageCombineBinary = argumentsValue.parity
        ? resolveTool('evb-pdf-image-combine', 'pdf-image-combine', 'EVB_PDF_IMAGE_COMBINE_PATH')
        : IMAGE_COMBINE_FALLBACK;
    const img2pdfBinary = process.env.EVB_SCAN_CLEANUP_IMG2PDF_PATH ?? 'img2pdf';
    const magickBinary = process.env.EVB_SCAN_CLEANUP_MAGICK_PATH ?? 'magick';
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'scan-cleanup-cli-'));
    const detectionEvidenceDirectory = join(temporaryRoot, 'detection-evidence');
    const conversionEvidenceDirectory = join(temporaryRoot, 'conversion-evidence');
    const nativeEvidenceDirectory = argumentsValue.diagnosticEvidenceDirectory === undefined
        ? conversionEvidenceDirectory
        : join(argumentsValue.diagnosticEvidenceDirectory, 'native');
    await mkdir(detectionEvidenceDirectory, {recursive: true});
    await mkdir(conversionEvidenceDirectory, {recursive: true});
    if (argumentsValue.diagnosticEvidenceDirectory !== undefined) {
        await mkdir(join(argumentsValue.diagnosticEvidenceDirectory, 'native'), {recursive: true});
    }
    const log = cliLog satisfies TScanCleanupLog;
    let rawMaskEvidence: ICliRawMaskEvidence[] = [];
    const runCommand: TScanCleanupRunCommand = async (command, args, options) => {
        if (command === IMAGE_COMBINE_FALLBACK) {
            return runImageCombineFallback(
                args[args.indexOf('--output') + 1]!,
                args[args.indexOf('--compact-manifest') + 1]!,
                qpdfBinary,
                img2pdfBinary,
                magickBinary,
                nativeOptions(options, log),
            );
        }
        if (command === PAGE_OPS_FALLBACK) {
            return runPageOpsFallback(args, qpdfBinary, nativeOptions(options, log));
        }
        if (
            argumentsValue.diagnosticEvidenceDirectory !== undefined
            && argumentsValue.diagnosticMaskPages !== undefined
            && command === imageCombineBinary
        ) {
            const manifestIndex = args.indexOf('--compact-manifest');
            const manifestPath = manifestIndex < 0 ? undefined : args[manifestIndex + 1];
            // The same sidecar also serves source-MRC extraction operations.
            // Evidence capture must observe the final compact combine without
            // changing or rejecting those earlier extraction calls.
            if (manifestPath !== undefined) {
                rawMaskEvidence = await snapshotCliDiagnosticMasks(
                    manifestPath,
                    argumentsValue.diagnosticMaskPages,
                    argumentsValue.diagnosticEvidenceDirectory,
                );
            }
        }
        return runCliNativeToolCommand(command, args, nativeOptions(options, log));
    };
    const renderers = createCliRenderers(runCommand, pdfinfoBinary);
    const getPageCount: TScanCleanupGetPageCount = async (pdfPath, options) => {
        const result = await runCommand(qpdfBinary, [
            '--show-npages',
            pdfPath,
        ], {
            allowedExitCodes: [
                0,
                3,
            ],
            commandLabel: 'qpdf(cli-page-count)',
            ...(options?.signal === undefined ? {} : {signal: options.signal}),
            log,
        });
        const pageCount = Number.parseInt(result.stdout.trim(), 10);
        if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error('Failed to read PDF page count');
        return pageCount;
    };
    const getPageSizes: TScanCleanupGetPageSizes = async (pdfPath, options: IReadPdfPageSizesOptions) =>
        readPdfPageSizes(pdfPath, {
            ...options,
            runCommand,
        });
    const detectSourceDpi = async (
        pdfPath: string,
        _pdfimages: string | undefined,
        sourceLog: TScanCleanupLog,
        commandEnv?: NodeJS.ProcessEnv,
        signal?: AbortSignal,
        pages?: readonly number[],
        onProgress?: (completedPages: number, totalPages: number) => void,
    ) => detectSourceDpiDetails(
        pdfPath,
        pdfimagesBinary,
        sourceLog,
        commandEnv,
        signal,
        pages,
        onProgress,
        runCommand,
    );
    const detectRasterPages = (
        pdfPath: string,
        signal: AbortSignal,
    ): Promise<IScanCleanupPageRasterSource> => {
        const cache = new Map<number, Promise<IDetectedPageRaster | undefined>>();
        let documentDpi: number | null = null;
        const getPageRaster = (pageNumber: number) => {
            const cached = cache.get(pageNumber);
            if (cached !== undefined) {
                return cached;
            }
            const pending = (async () => {
                signal.throwIfAborted();
                const result = await detectSourceDpi(
                    pdfPath,
                    pdfimagesBinary,
                    log,
                    undefined,
                    signal,
                    [pageNumber],
                );
                documentDpi = Math.max(documentDpi ?? 0, result.documentDpi ?? 0) || null;
                return result.pageRasterByNumber.get(pageNumber);
            })();
            cache.set(pageNumber, pending);
            if (cache.size > CLI_PAGE_RASTER_CACHE_LIMIT) {
                const oldest = cache.keys().next().value;
                if (oldest !== undefined && oldest !== pageNumber) cache.delete(oldest);
            }
            return pending;
        };
        return Promise.resolve({
            detected: true,
            get documentDpi() {
                return documentDpi;
            },
            getPageRaster,
        });
    };
    const getPageSizeStoreForDetection = (pdfPath: string, signal: AbortSignal) => Promise.resolve(
        createPdfPageSizeStore(pdfPath, {
            ...(pageOpsBinary === PAGE_OPS_FALLBACK ? {} : {pdfPageOpsBinary: pageOpsBinary}),
            pdfinfoBinary,
            qpdfBinary,
            log,
            runCommand,
            signal,
            tempDir: temporaryRoot,
            resolveSuspiciousCropBoxFallback: false,
        }),
    );
    const getPageSizesForDetection = (pdfPath: string, signal: AbortSignal) =>
        getPageSizes(pdfPath, {
            pdfinfoBinary,
            log,
            runCommand,
            signal,
            tempDir: temporaryRoot,
            resolveSuspiciousCropBoxFallback: false,
        });
    const retention = createCliRetention(
        temporaryRoot,
        argumentsValue.sourcePdfPath,
        (pdfPath, signal) => getPageCount(pdfPath, {signal}),
        getPageSizesForDetection,
        detectRasterPages,
        getPageSizeStoreForDetection,
    );
    const policy: IScanCleanupRuntimePolicy = {
        logicalCpus: availableParallelism(),
        rasterConcurrency: Math.max(1, Math.min(8, availableParallelism())),
        rasterStreaming: process.platform !== 'win32',
        totalRamBytes: totalmem(),
    };
    const logProgress = (prefix: string) => {
        let previous = '';
        return (_results: IScanCleanupDetectionResult[], progress: TScanCleanupProgress) => {
            const key = getProgressKey(progress);
            if (key === previous) {
                return;
            }
            previous = key;
            process.stderr.write(
                `[scan-cleanup] ${prefix} ${progress.stage} ${String(progress.completedUnits)}/${String(progress.totalUnits)}\n`,
            );
        };
    };
    const startedAt = performance.now();
    let detectionResultStore: IScanCleanupDetectionResultStore | undefined;
    try {
        const detectionCacheKey = argumentsValue.detectionCachePath === undefined
            ? undefined
            : await createScanCleanupDetectionCacheKey(
                argumentsValue.sourcePdfPath,
                argumentsValue.options,
                {
                    pdftoppmBinaryPath: pdftoppmBinary,
                    scanCleanupBinaryPath: scanCleanupBinary,
                },
            );
        const documentPageCount = await getPageCount(argumentsValue.sourcePdfPath);
        // An omitted CLI page list means the complete source. Keep that scope
        // lazy so a million-page conversion does not allocate one number per
        // page before detection or conversion starts.
        const sourcePageNumbers = argumentsValue.pages === undefined
            ? undefined
            : resolveScanCleanupPageScope(argumentsValue.pages, documentPageCount);
        process.env.EVB_SCAN_CLEANUP_EVIDENCE_DIR = detectionEvidenceDirectory;
        const detectionStartedAt = performance.now();
        const detectionDependencies: IScanCleanupDetectionDependencies = {
            fileSystem: cliDetectionFileSystem,
            getAvailableScratchBytes: readAvailableScratchBytes,
            getTempDir: () => temporaryRoot,
            getPdftoppmBinary: () => pdftoppmBinary,
            resolveBinary: () => scanCleanupBinary,
            renderPage: renderers.renderPage,
            renderPagePpm: renderers.renderPagePpm,
            createRasterPipes: async (paths, signal, pipeLog) => {
                await runCommand('mkfifo', [...paths], {
                    commandLabel: 'mkfifo(scan-cleanup-cli-detection-streams)',
                    log: pipeLog,
                    signal,
                });
            },
            runSidecar: runCliScanCleanupSidecar,
        };
        const detection = await runScanCleanupDetectionWithCache({
            cachePath: argumentsValue.detectionCachePath,
            key: detectionCacheKey,
            refresh: argumentsValue.refreshDetection,
            log: message => process.stderr.write(`[scan-cleanup] ${message}\n`),
            detect: () => runScanCleanupDetection(
                {
                    ownerId: 'scan-cleanup-cli',
                    documentRevision: `${String(sourceStats.mtimeMs)}:${String(sourceStats.size)}`,
                    sourcePdfPath: argumentsValue.sourcePdfPath,
                    options: argumentsValue.options,
                },
                new AbortController().signal,
                retention,
                detectionDependencies,
                policy,
                logProgress('detect'),
                log,
            ),
        });
        const detectionDurationMs = performance.now() - detectionStartedAt;
        detectionResultStore = detection.resultStore;
        if (detection.results.length === 0 && detectionResultStore === undefined) {
            throw new Error('Scan cleanup detection returned no bounded result store');
        }
        if (argumentsValue.diagnosticEvidenceDirectory !== undefined) {
            const evidenceDirectory = argumentsValue.diagnosticEvidenceDirectory;
            await Promise.all(detection.results.map(result => writeFile(
                join(
                    evidenceDirectory,
                    `analysis-${String(result.pageNumber)}.json`,
                ),
                JSON.stringify({
                    pageNumber: result.pageNumber,
                    classification: result.classification,
                    ...(result.recommendedOutputMode === undefined
                        ? {}
                        : {recommendedOutputMode: result.recommendedOutputMode}),
                    ...(result.recommendedOutputModeReason === undefined
                        ? {}
                        : {recommendedOutputModeReason: result.recommendedOutputModeReason}),
                    ...(result.outputModeDiagnostics === undefined
                        ? {}
                        : {outputModeDiagnostics: result.outputModeDiagnostics}),
                }, null, 2) + '\n',
            )));
        }
        process.env.EVB_SCAN_CLEANUP_EVIDENCE_DIR = nativeEvidenceDirectory;
        const conversionStartedAt = performance.now();
        const conversionDependencies: IRunScanCleanupPipelineDependencies = {
            getPageCount,
            getPageSizeStore: (pdfPath, options) => createPdfPageSizeStore(pdfPath, {
                ...options,
                runCommand,
            }),
            getPageSizes,
            detectSourceDpi,
            createRasterPipes: async (paths: readonly string[], signal: AbortSignal, pipeLog: TScanCleanupLog) => {
                await runCommand('mkfifo', [...paths], {
                    commandLabel: 'mkfifo(scan-cleanup-cli-raster-streams)',
                    log: pipeLog,
                    signal,
                });
            },
            renderPage: renderers.renderPage,
            renderPagePpm: renderers.renderPagePpm,
            runSidecar: runCliScanCleanupSidecar,
            runCommand,
            getAvailableScratchBytes: readAvailableScratchBytes,
            extractMrcLayers: async input => extractPdfMrcLayers({
                ...input,
                runCommand,
            }),
            extractMrcLayersBatch: async input => extractPdfMrcLayersBatch({
                ...input,
                runCommand,
            }),
            requirePublishedRaster: requireCliPublishedRaster,
        };
        const paths: IScanCleanupWorkerPaths = {
            qpdfBinary,
            pdftoppmBinary,
            pdfimagesBinary,
            pdfinfoBinary,
            scanCleanupBinary,
            pdfImageCombineBinary: imageCombineBinary,
            pdfPageOpsBinary: pageOpsBinary,
            provenanceStampSupport: true,
            tempDir: temporaryRoot,
        };
        const request: IRunScanCleanupPipelineRequest = {
            sourcePdfPath: argumentsValue.sourcePdfPath,
            outputPdfPath: argumentsValue.outputPdfPath,
            options: argumentsValue.options,
            ...(sourcePageNumbers === undefined ? {} : {sourcePageNumbers}),
            ...buildScanCleanupCliDetectionRequestFields({
                results: detection.results,
                ...(detectionResultStore === undefined ? {} : {resultStore: detectionResultStore}),
            }),
        };
        const summary = await runScanCleanupConversion(
            request,
            paths,
            new AbortController().signal,
            progress => {
                const next = getProgressKey(progress);
                process.stderr.write(
                    `[scan-cleanup] convert ${next}\n`,
                );
            },
            policy,
            log,
            conversionDependencies,
        );
        const conversionDurationMs = performance.now() - conversionStartedAt;
        const outputStats = await stat(argumentsValue.outputPdfPath);
        const report = JSON.parse(await readFile(
            join(nativeEvidenceDirectory, 'scan-cleanup-representation-report.json'),
            'utf8',
        )) as IScanCleanupRepresentationReport;
        const stamp = JSON.parse(await readFile(
            join(nativeEvidenceDirectory, 'scan-cleanup-provenance-stamp.json'),
            'utf8',
        )) as IScanCleanupProvenanceStamp;
        const summaryPath = `${argumentsValue.outputPdfPath}.summary.json`;
        const machineSummary = {
            source: argumentsValue.sourcePdfPath,
            output: argumentsValue.outputPdfPath,
            pages: summary.inputPages,
            outputPages: summary.outputPages,
            sourceBytes: sourceStats.size,
            outputBytes: outputStats.size,
            outputToSourceRatio: outputStats.size / sourceStats.size,
            parity: argumentsValue.parity,
            assemblerBackend: stamp.buildIds.assemblerBackend,
            transportMode: stamp.buildIds.transportMode,
            timings: {
                detectionMs: detectionDurationMs,
                conversionMs: conversionDurationMs,
                totalMs: performance.now() - startedAt,
            },
            detection: {
                pages: detectionResultStore?.pageCount ?? detection.results.length,
                results: detection.results.length === 0
                    ? []
                    : compactScanCleanupDetectionVerdicts(detection.results),
            },
            conversionSummary: summary,
            sourcePageToOutputPages: buildSourcePageToOutputPages(report),
            perPageStreamSizes: report.pages,
            representation: {
                outputBytes: report.outputBytes,
                outputToSourceByteRatio: report.outputToSourceByteRatio,
                outputMappings: report.outputMappings,
                resolvedPlanSha256: stamp.resolvedPlanSha256,
                assemblerBackend: stamp.buildIds.assemblerBackend,
                transportMode: stamp.buildIds.transportMode,
            },
        };
        await writeFile(summaryPath, JSON.stringify(machineSummary, null, 2) + '\n');
        if (argumentsValue.diagnosticEvidenceDirectory !== undefined) {
            const evidenceManifest = buildCliRawMaskEvidenceManifest(
                argumentsValue.outputPdfPath,
                rawMaskEvidence,
                report.pages,
            );
            await writeFile(
                join(argumentsValue.diagnosticEvidenceDirectory, 'raw-mask-manifest.json'),
                JSON.stringify(evidenceManifest, null, 2) + '\n',
            );
        }
        process.stderr.write(`[scan-cleanup] wrote ${summaryPath}\n`);
    } finally {
        delete process.env.EVB_SCAN_CLEANUP_EVIDENCE_DIR;
        try {
            await detectionResultStore?.close();
        } finally {
            await rm(temporaryRoot, {
                force: true,
                recursive: true,
            });
        }
    }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void main().catch(error => {
        if (error instanceof Error && getErrorMessage(error) === '') {
            return;
        }
        process.stderr.write(`[scan-cleanup] error: ${getErrorMessage(error)}\n`);
        process.exitCode = 1;
    });
}
