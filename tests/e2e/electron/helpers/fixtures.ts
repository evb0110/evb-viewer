import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    copyFileSync,
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
    basename,
    dirname,
    join,
    resolve,
} from 'node:path';
import {readFile} from 'node:fs/promises';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFString,
    StandardFonts,
    degrees,
    drawImage,
    rgb,
} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createCanvas} from '@napi-rs/canvas';
import { getE2ERunId } from '@scripts/electron-run/electronRunRunId';
import { getCurrentSessionName } from '@scripts/electron-run/electronRunSessionPaths';
import { createPdfjsNodeDocumentOptions } from '@electron/search/createPdfjsNodeDocumentOptions';
import { runNativeCommand } from '@electron/native-tools/runNativeCommand';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import { prependDirectoryToPath } from '@electron/native-tools/toolRegistry';
import { resolvePlatformArchTag } from '@electron/utils/platformArch';
import { PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES } from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfNativePreviewRouting';
import { EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeImportLimit';
import {applyCombinedPdfPageLabels} from '@pdf-core/pdfCombineCatalog';
import { writePdfBookmarkOutlines } from '@pdf-core/writePdfBookmarkOutlines';
import { getAnnotationAuthor } from '@app/services/pdf/getAnnotationAuthor';

const FIXTURE_ROOT_DIR = resolve(process.cwd(), '.devkit', 'tmp', 'e2e-fixtures');
const RUN_FIXTURE_ROOT_DIR = resolve(process.cwd(), '.devkit', 'tmp', 'e2e-run-fixtures');
const FIXTURE_CACHE_DIR = resolve(process.cwd(), '.devkit', 'tmp', 'e2e-fixture-cache');
const TRACKED_PROJECT_FIXTURE_DIR = resolve(process.cwd(), 'tests', 'fixtures', 'electron');
const LEGACY_PROJECT_FIXTURE_DIR = resolve(process.cwd(), '.devkit', 'test-pdfs');
const PROJECT_ROOT_FIXTURE_DIR = resolve(process.cwd(), '.devkit');
const LARGE_PDF_FIXTURE_ENV_VAR = 'EVB_E2E_LARGE_PDF_FIXTURE';
const LARGE_PDF_REQUIRE_ENV_VAR = 'EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE';
const DEFAULT_LARGE_PDF_FIXTURE = 'large-pdf-fixtures/turkish-english-lexicon-letter-bookmarks.pdf';
// Above the preview threshold so the fixture exercises native first paint and
// the handoff to PDF.js.
const NATIVE_LARGE_PDF_FIXTURE_BYTES = PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES + (1024 * 1024);
// Above the shape-scan cap, so the annotation-save lane covers saving a document
// whose embedded shape layer is too large to scan, and far below the
// opening-preview threshold so this fixture does not pay the native render cost.
const ANNOTATION_LARGE_PDF_FIXTURE_BYTES = EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES * 2;
const DJVU_FIXTURE_ENV_VAR = 'EVB_E2E_DJVU_FIXTURE';
const DEFAULT_DJVU_FIXTURE = 'djvu-fixtures/viewer-smoke.djvu';
const TRACKED_DJVU_CORPUS_FIXTURE = resolve(
    process.cwd(),
    'tests',
    'fixtures',
    'djvu',
    'sources',
    'browser-boundary-501-pages.djvu',
);
const NATIVE_DJVU_SEARCH_FIXTURE_PAGE_COUNT = 501;
const NATIVE_DJVU_SEARCH_FIXTURE_LATE_PAGE = 450;
const NATIVE_DJVU_SEARCH_FIXTURE_SENTINEL = 'EVB_LATE_DJVU_SENTINEL_450';

const GENERATED_DJVU_FIXTURE_PAGE_COUNT = 100;
const GENERATED_DJVU_FIXTURE_WIDTH = 1200;
const GENERATED_DJVU_FIXTURE_HEIGHT = 1600;
const GENERATED_DJVU_FIXTURE_DPI = 150;
const GENERATED_DJVU_FIXTURE_FILENAME = [
    'generated-viewer-smoke',
    `${GENERATED_DJVU_FIXTURE_PAGE_COUNT}p`,
    `${GENERATED_DJVU_FIXTURE_WIDTH}x${GENERATED_DJVU_FIXTURE_HEIGHT}`,
    `${GENERATED_DJVU_FIXTURE_DPI}dpi.djvu`,
].join('-');

/**
 * The resolution the scanned fixtures draw their page rasters at: 1224x1584 px
 * on Letter. Callers that need every analysis stage to land on one pixel grid
 * pass their own DPI instead.
 */
const SCANNED_FIXTURE_BASE_DPI = 144;

export interface IPdfAnnotationSummary {
    total: number;
    bySubtype: Record<string, number>;
}

interface IQpdfObjectRef {
    generationNumber: number;
    objectNumber: number;
}

export interface IPdfAnnotationDetails {
    author: string | null;
    subtype: string;
}

export interface IPdfTextAnnotationRecord {
    contents: string;
    name: string;
    popup: string | null;
    ref: string;
    replyTo: string | null;
    subtype: string;
}

export interface IForeignNoteReplyFixture {
    parentName: string;
    parentText: string;
    replyNames: readonly string[];
    replyTexts: readonly string[];
}

export interface IPdfPageSnapshot {
    pageNumber: number;
    rotation: number;
    textSnippet: string;
}

export interface IFixtureAvailability {
    path: string | null;
    reason: string;
    required: boolean;
}

export interface INativeDjvuSearchFixtureAvailability extends IFixtureAvailability {
    pageCount: number;
    pageNumber: number;
    sentinel: string;
}

export interface IFixtureDescribeSelector {
    (name: string, fn: () => void): unknown;
    skip: IFixtureDescribeSelector;
}

interface IPathFixtureAvailabilityOptions {
    path: string;
    label: string;
    requiredEnvVar: string;
}

interface IDjvuFixtureAvailabilityOptions {
    corpusFixturePath?: string | null;
    devkitFixtureDir?: string;
    env?: NodeJS.ProcessEnv;
    generate?: boolean;
    generatedFixtureFactory?: () => string;
    trackedFixtureDir?: string;
}

const reportedMissingFixtureReasons = new Set<string>();

function isEnvFlagEnabled(envVar: string, env: NodeJS.ProcessEnv = process.env) {
    return env[envVar] === '1';
}

export function resolvePathFixtureAvailability(options: IPathFixtureAvailabilityOptions): IFixtureAvailability {
    const absolutePath = resolve(options.path);
    const required = isEnvFlagEnabled(options.requiredEnvVar);

    if (!existsSync(absolutePath)) {
        return {
            path: null,
            reason: `${options.label} fixture does not exist: ${absolutePath}`,
            required,
        };
    }

    if (!statSync(absolutePath).isFile()) {
        return {
            path: null,
            reason: `${options.label} fixture must point to a file: ${absolutePath}`,
            required,
        };
    }

    return {
        path: absolutePath,
        reason: `Using ${options.label} fixture: ${absolutePath}`,
        required,
    };
}

export function selectFixtureDescribe<TDescribe extends IFixtureDescribeSelector>(
    describeFn: TDescribe,
    fixture: IFixtureAvailability,
) {
    if (fixture.path) {
        return describeFn;
    }

    if (fixture.required) {
        throw new Error(`Required fixture missing: ${fixture.reason}`);
    }

    if (!reportedMissingFixtureReasons.has(fixture.reason)) {
        reportedMissingFixtureReasons.add(fixture.reason);
        console.info(`SKIPPED (fixture missing): ${fixture.reason}`);
    }

    return describeFn.skip;
}

function getFixtureDir(sessionName = getCurrentSessionName()) {
    const safeSessionName = sessionName.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
    return join(FIXTURE_ROOT_DIR, safeSessionName);
}

function getRunFixtureDir(owner: string, runId = getE2ERunId()) {
    const safeRunId = runId.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
    const safeOwner = owner.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
    if (!safeOwner || safeOwner === '.' || safeOwner === '..') {
        throw new Error('Run fixture owner must identify one bounded directory');
    }
    return join(RUN_FIXTURE_ROOT_DIR, safeRunId, safeOwner);
}

function ensureFixtureDir(sessionName = getCurrentSessionName()) {
    mkdirSync(getFixtureDir(sessionName), { recursive: true });
}

export function cleanupSessionFixtures(sessionName = getCurrentSessionName()) {
    rmSync(getFixtureDir(sessionName), {
        recursive: true,
        force: true,
    });
}

export function cleanupRunFixtures(owner: string) {
    rmSync(getRunFixtureDir(owner), {
        recursive: true,
        force: true,
    });
}

export function createFixturePath(filename: string) {
    ensureFixtureDir();
    return join(getFixtureDir(), filename);
}

function prependFixtureLibraryPath(env: NodeJS.ProcessEnv, key: string, value: string) {
    const current = env[key]?.trim();
    const delimiter = process.platform === 'win32' ? ';' : ':';
    env[key] = current ? `${value}${delimiter}${current}` : value;
}

function buildDjvusedFixtureEnv(command: string) {
    let env: NodeJS.ProcessEnv = {
        ...process.env,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        LC_CTYPE: 'C.UTF-8',
    };
    if (!command.includes('/') && !command.includes('\\')) {
        return env;
    }

    const libDir = resolve(dirname(command), '..', 'lib');
    if (!existsSync(libDir)) {
        return env;
    }
    if (process.platform === 'win32') {
        env = prependDirectoryToPath(libDir, env);
    } else {
        prependFixtureLibraryPath(env, 'DYLD_LIBRARY_PATH', libDir);
        prependFixtureLibraryPath(env, 'LD_LIBRARY_PATH', libDir);
    }
    return env;
}

async function resolveDjvusedFixtureTool() {
    const binaryName = process.platform === 'win32' ? 'djvused.exe' : 'djvused';
    const bundledPath = resolveNativeToolPath({
        binaryName,
        binaryRelativePath: [
            'bin',
            binaryName,
        ],
        crateName: 'djvulibre',
        currentDir: process.cwd(),
        includeRustTargetCandidates: false,
        isPackaged: false,
        platformArch: resolvePlatformArchTag(),
        projectRoot: process.cwd(),
        resourcesBase: resolve(process.cwd(), 'resources'),
    });
    const attempts: string[] = [];
    const candidates = Array.from(new Set([
        ...(bundledPath ? [bundledPath] : []),
        binaryName,
    ]));

    for (const command of candidates) {
        const env = buildDjvusedFixtureEnv(command);
        try {
            const result = await runNativeCommand(command, [
                TRACKED_DJVU_CORPUS_FIXTURE,
                '-e',
                'n',
            ], {
                commandLabel: 'djvused E2E fixture probe',
                defaultCwdToCommandDir: true,
                env,
                maxStderrBytes: 16 * 1024,
                maxStdoutBytes: 16 * 1024,
                prependCommandDirToPath: true,
                timeoutMs: 15_000,
                windowsHide: true,
            });
            if (Number.parseInt(result.stdout.trim(), 10) === NATIVE_DJVU_SEARCH_FIXTURE_PAGE_COUNT) {
                return {
                    available: true as const,
                    command,
                    env,
                };
            }
            attempts.push(`${command}: unexpected page count ${result.stdout.trim() || '(empty)'}`);
        } catch (error) {
            attempts.push(`${command}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return {
        available: false as const,
        attempts,
    };
}

function createLatePageDjvuTextScript() {
    return [
        `select ${NATIVE_DJVU_SEARCH_FIXTURE_LATE_PAGE}`,
        'set-txt',
        '(page 0 0 512 512',
        '  (line 48 360 464 424',
        `    (word 64 360 248 424 "${NATIVE_DJVU_SEARCH_FIXTURE_SENTINEL}")`,
        `    (word 272 360 456 424 "${NATIVE_DJVU_SEARCH_FIXTURE_SENTINEL}")))`,
        '.',
        '',
    ].join('\n');
}

export async function createNativeDjvuLatePageSearchFixture(
    targetFilename = `native-djvu-search-${Date.now()}.djvu`,
): Promise<INativeDjvuSearchFixtureAvailability> {
    if (!existsSync(TRACKED_DJVU_CORPUS_FIXTURE) || !statSync(TRACKED_DJVU_CORPUS_FIXTURE).isFile()) {
        throw new Error(`Tracked native DjVu search fixture is missing: ${TRACKED_DJVU_CORPUS_FIXTURE}`);
    }

    const resolvedTool = await resolveDjvusedFixtureTool();
    if (!resolvedTool.available) {
        return {
            pageCount: NATIVE_DJVU_SEARCH_FIXTURE_PAGE_COUNT,
            pageNumber: NATIVE_DJVU_SEARCH_FIXTURE_LATE_PAGE,
            path: null,
            reason: `djvused is unavailable for native DjVu search E2E: ${resolvedTool.attempts.join(' | ')}`,
            required: false,
            sentinel: NATIVE_DJVU_SEARCH_FIXTURE_SENTINEL,
        };
    }

    const targetPath = createFixturePath(targetFilename);
    const scriptPath = createFixturePath(`${targetFilename}.dsed`);
    copyFileSync(TRACKED_DJVU_CORPUS_FIXTURE, targetPath);
    writeFileSync(scriptPath, createLatePageDjvuTextScript(), 'ascii');
    try {
        await runNativeCommand(resolvedTool.command, [
            targetPath,
            '-f',
            scriptPath,
            '-s',
        ], {
            commandLabel: 'djvused E2E late-page text injection',
            defaultCwdToCommandDir: true,
            env: resolvedTool.env,
            maxStderrBytes: 32 * 1024,
            maxStdoutBytes: 32 * 1024,
            prependCommandDirToPath: true,
            timeoutMs: 30_000,
            windowsHide: true,
        });
        const verification = await runNativeCommand(resolvedTool.command, [
            targetPath,
            '-e',
            `select ${NATIVE_DJVU_SEARCH_FIXTURE_LATE_PAGE}; print-pure-txt`,
        ], {
            commandLabel: 'djvused E2E late-page text verification',
            defaultCwdToCommandDir: true,
            env: resolvedTool.env,
            maxStderrBytes: 32 * 1024,
            maxStdoutBytes: 32 * 1024,
            prependCommandDirToPath: true,
            timeoutMs: 30_000,
            windowsHide: true,
        });
        const sentinelMatches = verification.stdout.match(
            new RegExp(NATIVE_DJVU_SEARCH_FIXTURE_SENTINEL, 'gu'),
        )?.length ?? 0;
        if (sentinelMatches !== 2) {
            throw new Error(`Injected DjVu sentinel verification found ${sentinelMatches} matches instead of 2`);
        }
    } catch (error) {
        rmSync(targetPath, {force: true});
        throw error;
    } finally {
        rmSync(scriptPath, {force: true});
    }

    return {
        pageCount: NATIVE_DJVU_SEARCH_FIXTURE_PAGE_COUNT,
        pageNumber: NATIVE_DJVU_SEARCH_FIXTURE_LATE_PAGE,
        path: targetPath,
        reason: `Using generated native DjVu late-page search fixture: ${targetPath}`,
        required: true,
        sentinel: NATIVE_DJVU_SEARCH_FIXTURE_SENTINEL,
    };
}

export function copyProjectFixture(sourceFilename: string, targetFilename?: string) {
    ensureFixtureDir();
    const sourcePath = resolveProjectFixturePath(sourceFilename);
    const targetPath = join(getFixtureDir(), targetFilename ?? sourceFilename);
    writeFileSync(targetPath, readFileSync(sourcePath));
    return targetPath;
}

function resolveProjectFixturePath(sourceFilename: string) {
    const candidatePaths = [
        join(TRACKED_PROJECT_FIXTURE_DIR, sourceFilename),
        join(LEGACY_PROJECT_FIXTURE_DIR, sourceFilename),
    ];
    const sourcePath = candidatePaths.find(existsSync);

    if (sourcePath) {
        return sourcePath;
    }

    throw new Error(`Fixture does not exist in any known location: ${candidatePaths.join(', ')}`);
}



function resolveLargePdfFixturePath() {
    const overridePath = process.env[LARGE_PDF_FIXTURE_ENV_VAR]?.trim();
    const candidatePaths = overridePath
        ? [resolve(overridePath)]
        : [
            resolve(TRACKED_PROJECT_FIXTURE_DIR, DEFAULT_LARGE_PDF_FIXTURE),
            resolve(PROJECT_ROOT_FIXTURE_DIR, DEFAULT_LARGE_PDF_FIXTURE),
        ];
    const candidatePath = candidatePaths.find(candidate => existsSync(candidate) && statSync(candidate).isFile());

    if (!candidatePath) {
        return null;
    }
    return candidatePath;
}

function formatFixtureSize(value: number) {
    return value < 1024 * 1024
        ? `${value} bytes`
        : `${Math.round(value / 1024 / 1024 * 10) / 10} MiB`;
}

// Both large-PDF lanes need a document larger than anything that may enter the
// repository, so they provision one instead of skipping. The generator writes a
// small pdf-lib document — including the existing FreeText note the
// annotation-save lane asserts — and sparse-pads it, so the file costs a few
// hundred KiB of real disk whatever its declared size.
function provisionLargePdfFixture(
    label: string,
    targetBytes: number,
    pageCount?: number,
): IFixtureAvailability {
    const required = isEnvFlagEnabled(LARGE_PDF_REQUIRE_ENV_VAR);
    const fixturePath = join(
        FIXTURE_CACHE_DIR,
        `${label}-${targetBytes}${pageCount === undefined ? '' : `-${pageCount}p`}.pdf`,
    );

    try {
        if (!existsSync(fixturePath) || statSync(fixturePath).size !== targetBytes) {
            mkdirSync(FIXTURE_CACHE_DIR, {recursive: true});
            execFileSync(process.execPath, [
                resolve(process.cwd(), 'scripts', 'generate-large-pdf-e2e-fixture.mjs'),
                `--output=${fixturePath}`,
                `--bytes=${targetBytes}`,
                ...(pageCount === undefined ? [] : [`--pages=${pageCount}`]),
            ], {stdio: 'pipe'});
        }

        const size = statSync(fixturePath).size;
        if (size !== targetBytes) {
            throw new Error(`generated ${formatFixtureSize(size)} instead of ${formatFixtureSize(targetBytes)}`);
        }
        return {
            path: fixturePath,
            reason: `Using generated ${label} large PDF fixture: ${fixturePath} (${formatFixtureSize(size)})`,
            required,
        };
    } catch (error) {
        return {
            path: null,
            reason: `Generated ${label} large PDF fixture is not available`
                + ` (scripts/generate-large-pdf-e2e-fixture.mjs): ${error instanceof Error ? error.message : String(error)}`,
            required,
        };
    }
}

// The two large-PDF lanes sit on opposite sides of the same threshold: the
// The opening-preview lane needs an oversized sparse fixture to exercise the
// native-raster-to-PDF.js handoff. The annotation-save lane uses a smaller,
// content-rich fixture so it can verify existing and newly added notes.
export function resolveLargePdfFixtureAvailability(): IFixtureAvailability {
    const fixturePath = resolveLargePdfFixturePath();
    const required = isEnvFlagEnabled(LARGE_PDF_REQUIRE_ENV_VAR);

    if (fixturePath) {
        const size = statSync(fixturePath).size;
        return {
            path: fixturePath,
            reason: `Using large PDF fixture: ${fixturePath} (${formatFixtureSize(size)})`,
            required,
        };
    }

    const overridePath = process.env[LARGE_PDF_FIXTURE_ENV_VAR]?.trim();
    if (overridePath) {
        return {
            path: null,
            reason: `${LARGE_PDF_FIXTURE_ENV_VAR} points to a missing fixture: ${resolve(overridePath)}`,
            required,
        };
    }

    return provisionLargePdfFixture('annotation-save', ANNOTATION_LARGE_PDF_FIXTURE_BYTES);
}

export function resolveNativeLargePdfFixtureAvailability(pageCount?: number): IFixtureAvailability {
    return provisionLargePdfFixture('native-preview', NATIVE_LARGE_PDF_FIXTURE_BYTES, pageCount);
}

export function copyLargePdfFixture(targetFilename?: string) {
    const fixture = resolveLargePdfFixtureAvailability();
    const sourcePath = fixture.path;
    if (!sourcePath) {
        throw new Error(`Large PDF fixture is not available: ${fixture.reason}`);
    }
    ensureFixtureDir();
    const targetPath = join(getFixtureDir(), targetFilename ?? basename(sourcePath));
    copyFileSync(sourcePath, targetPath);
    return targetPath;
}


export async function createMultiPageTextFixturePdf(filename: string, pageCount = 3) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);

    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = doc.addPage([
            612,
            792,
        ]);
        page.drawText(`E2E Multi Page Fixture ${pageNumber}/${pageCount}`, {
            x: 70,
            y: 710,
            size: 24,
            font,
            color: rgb(0.13, 0.13, 0.13),
        });
        page.drawText(`Page ${pageNumber} sample text for annotations`, {
            x: 70,
            y: 660,
            size: 16,
            font,
            color: rgb(0.22, 0.22, 0.22),
        });
    }

    const bytes = await doc.save();
    writeFileSync(filePath, bytes);

    return filePath;
}

/**
 * Creates the deterministic text used by the EVB text-markup acceptance
 * tests. Each page has three separate renderer text runs so a selection can
 * prove line geometry and page splitting without depending on a bundled PDF.
 */
export async function createTextMarkupAcceptanceFixturePdf(filename: string, pageCount = 2) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = document.addPage([
            612,
            792,
        ]);
        [
            {
                label: 'Markup page',
                y: 700,
            },
            {
                label: 'second line',
                y: 660,
            },
            {
                label: 'third line',
                y: 620,
            },
        ].forEach(({
            label,
            y,
        }) => {
            page.drawText(`${label} ${pageNumber}`, {
                x: 72,
                y,
                size: 20,
                font,
                color: rgb(0.13, 0.13, 0.13),
            });
        });
    }

    writeFileSync(filePath, await document.save());
    return filePath;
}

export const SEARCH_MATCH_SCROLL_FIXTURE_PAGE_COUNT = 241;
export const SEARCH_MATCH_SCROLL_FIXTURE_TARGET_PAGE = SEARCH_MATCH_SCROLL_FIXTURE_PAGE_COUNT;
export const SEARCH_MATCH_SCROLL_FIXTURE_QUERY = 'EVB_SEARCH_SCROLL_SENTINEL';
export const SEARCH_MATCH_SCROLL_FIXTURE_TARGET_MATCH = 4;

/**
 * Create the deterministic large document used by the search-result viewport
 * test. The last page has four identical matches, with the selected fourth
 * match close to the bottom edge so a page-only jump leaves it out of view.
 */
export async function createSearchMatchScrollFixturePdf(
    filename: string,
    pageCount = SEARCH_MATCH_SCROLL_FIXTURE_PAGE_COUNT,
) {
    if (pageCount < 2) {
        throw new Error('Search match scroll fixture requires at least two pages');
    }

    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = doc.addPage([
            612,
            792,
        ]);
        page.drawText(`E2E search match scroll fixture page ${pageNumber}/${pageCount}`, {
            x: 60,
            y: 735,
            size: 14,
            font,
            color: rgb(0.13, 0.13, 0.13),
        });

        if (pageNumber < pageCount) {
            page.drawText(`${SEARCH_MATCH_SCROLL_FIXTURE_QUERY} page ${pageNumber}`, {
                x: 60,
                y: 690,
                size: 16,
                font,
                color: rgb(0.22, 0.22, 0.22),
            });
            continue;
        }

        [
            700,
            600,
            500,
            100,
        ].forEach((y, index) => {
            page.drawText(`${SEARCH_MATCH_SCROLL_FIXTURE_QUERY} match ${index + 1}`, {
                x: 60,
                y,
                size: 16,
                font,
                color: rgb(0.22, 0.22, 0.22),
            });
        });
    }

    const bytes = await doc.save();
    writeFileSync(filePath, bytes);
    return filePath;
}

/**
 * Creates an externally authored Highlight whose quad is on blank page
 * space. The parser should retain it as a normal store-owned text markup,
 * while derived selected text remains absent.
 */
export async function createForeignHighlightNoTextFixturePdf(filename: string) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const document = await PDFDocument.create();
    const page = document.addPage([
        612,
        792,
    ]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText('Foreign highlight fixture text is elsewhere', {
        x: 72,
        y: 700,
        size: 20,
        font,
        color: rgb(0.13, 0.13, 0.13),
    });

    const annotation = document.context.register(document.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Highlight'),
        P: page.ref,
        F: PDFNumber.of(4),
        M: PDFString.of('D:20260902000000Z'),
        NM: PDFHexString.fromText('foreign-highlight-without-text'),
        Rect: [
            420,
            100,
            500,
            116,
        ],
        QuadPoints: [
            420,
            116,
            500,
            116,
            420,
            100,
            500,
            100,
        ],
        C: [
            1,
            0.8,
            0,
        ],
        CA: PDFNumber.of(0.45),
        Contents: PDFString.of(''),
    }));
    page.node.set(PDFName.of('Annots'), document.context.obj([annotation]));

    writeFileSync(filePath, await document.save());
    return filePath;
}

export async function createForeignNoteReplyFixturePdf(filename: string): Promise<IForeignNoteReplyFixture & {filePath: string}> {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const document = await PDFDocument.create();
    const page = document.addPage([
        612,
        792,
    ]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText('Foreign note reply fixture', {
        font,
        size: 20,
        x: 72,
        y: 720,
    });

    const context = document.context;
    const parentName = 'foreign-note-with-replies';
    const parentText = 'Foreign parent note';
    const replyTexts = [
        'First foreign reply',
        'Second foreign reply',
    ] as const;
    const replyNames = [
        'foreign-reply-1',
        'foreign-reply-2',
    ] as const;
    const parentRef = context.nextRef();
    const popupRef = context.nextRef();
    const replyRefs = replyTexts.map(() => context.nextRef());
    context.assign(parentRef, context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Text'),
        Rect: [
            280,
            600,
            312,
            632,
        ],
        NM: PDFHexString.fromText(parentName),
        Contents: PDFHexString.fromText(parentText),
        Popup: popupRef,
        Open: false,
        C: [
            1,
            0.8,
            0,
        ],
        T: PDFHexString.fromText('Foreign author'),
        M: PDFString.of('D:20260902090000Z'),
        P: page.ref,
    }));
    context.assign(popupRef, context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Popup'),
        Rect: [
            280,
            600,
            312,
            632,
        ],
        Parent: parentRef,
        Contents: PDFHexString.fromText(parentText),
        Open: false,
        P: page.ref,
    }));
    replyRefs.forEach((replyRef, index) => {
        context.assign(replyRef, context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Text'),
            Rect: [
                280,
                560 - index * 40,
                312,
                592 - index * 40,
            ],
            NM: PDFHexString.fromText(replyNames[index] ?? ''),
            Contents: PDFHexString.fromText(replyTexts[index] ?? ''),
            IRT: parentRef,
            RT: PDFName.of('R'),
            T: PDFHexString.fromText(`Reply author ${index + 1}`),
            M: PDFString.of(`D:2026090209${String(index + 1).padStart(2, '0')}00Z`),
            P: page.ref,
        }));
    });
    page.node.set(PDFName.of('Annots'), context.obj([
        parentRef,
        popupRef,
        ...replyRefs,
    ]));
    writeFileSync(filePath, await document.save({
        addDefaultPage: false,
        useObjectStreams: false,
    }));

    return {
        filePath,
        parentName,
        parentText,
        replyNames,
        replyTexts,
    };
}

export async function createPasswordProtectedFixturePdf(filename: string) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const encoded = readFileSync(
        join(TRACKED_PROJECT_FIXTURE_DIR, 'password-protected.pdf.b64'),
        'utf8',
    );
    writeFileSync(filePath, Buffer.from(encoded.trim(), 'base64'));
    return filePath;
}

export async function createOutlinePageLabelFixturePdf(filename: string) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    for (let pageNumber = 1; pageNumber <= 4; pageNumber += 1) {
        const page = doc.addPage([
            612,
            792,
        ]);
        page.drawText(`Metadata matrix page ${pageNumber}`, {
            x: 70,
            y: 710,
            size: 24,
            font,
        });
    }

    applyCombinedPdfPageLabels(doc, [
        {
            pageIndex: 0,
            style: 'r',
            prefix: 'front-',
            start: 1,
        },
        {
            pageIndex: 2,
            style: 'D',
            prefix: 'chapter-',
            start: 1,
        },
    ]);
    writePdfBookmarkOutlines(doc, [
        {
            title: 'Parent',
            pageIndex: 0,
            pageYRatio: null,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [{
                title: 'Child',
                pageIndex: 2,
                pageYRatio: null,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }],
        },
        {
            title: 'Appendix',
            pageIndex: 3,
            pageYRatio: null,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        },
    ]);
    writeFileSync(filePath, await doc.save());
    return filePath;
}

export async function createCompactPageLabelsFixturePdf(filename: string, pageCount = 201) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    for (let pageNumber = 0; pageNumber < pageCount; pageNumber += 1) {
        const page = doc.addPage([
            612,
            792,
        ]);
        page.drawText(`Compact page label fixture ${pageNumber + 1}/${pageCount}`, {
            x: 72,
            y: 720,
            size: 12,
            font,
        });
    }

    const {context} = doc;
    const pageLabels = context.register(context.obj({Nums: [
        0,
        context.register(context.obj({
            S: PDFName.of('r'),
            St: PDFNumber.of(1),
        })),
        40,
        context.register(context.obj({
            P: PDFString.of('Main-'),
            S: PDFName.of('D'),
            St: PDFNumber.of(1),
        })),
        100,
        context.register(context.obj({
            S: PDFName.of('R'),
            St: PDFNumber.of(1),
        })),
        150,
        context.register(context.obj({
            P: PDFString.of('Appendix-'),
            S: PDFName.of('a'),
            St: PDFNumber.of(1),
        })),
    ]}));
    doc.catalog.set(PDFName.of('PageLabels'), pageLabels);
    writeFileSync(filePath, await doc.save());
    return filePath;
}

export async function createMixedSizeTextFixturePdf(filename: string) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pageSizes = [
        {
            height: 792,
            width: 612,
        },
        {
            height: 420,
            width: 920,
        },
        {
            height: 920,
            width: 420,
        },
        {
            height: 610,
            width: 760,
        },
    ] as const;

    for (const [
        index,
        pageSize,
    ] of pageSizes.entries()) {
        const {
            height,
            width,
        } = pageSize;
        const page = doc.addPage([
            width,
            height,
        ]);
        page.drawText(`Mixed-size page ${index + 1}`, {
            x: 40,
            y: height - 70,
            size: 28,
            font,
            color: rgb(0.13, 0.13, 0.13),
        });
        page.drawRectangle({
            x: 32,
            y: 32,
            width: width - 64,
            height: height - 64,
            borderWidth: 4,
            borderColor: rgb(0.2 + index * 0.1, 0.35, 0.65 - index * 0.1),
        });
    }

    writeFileSync(filePath, await doc.save());
    return filePath;
}


/**
 * A scanned document whose pages carry the same paper size but visibly
 * different ink extents, so content cropping produces a different intrinsic
 * page for every variant. Matching page size has nothing to prove on a fixture
 * whose pages all crop alike.
 */
export async function createVariedContentScannedFixturePdf(
    filename: string,
    pageCount: number,
    rasterDpi = SCANNED_FIXTURE_BASE_DPI,
) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const rasterScale = rasterDpi / SCANNED_FIXTURE_BASE_DPI;
    const cacheKey = createHash('sha256')
        .update(`varied-content-scanned-v1:${pageCount}${rasterScale === 1 ? '' : `:${rasterDpi}`}`)
        .digest('hex');
    const cachePath = join(FIXTURE_CACHE_DIR, `${cacheKey}.pdf`);
    if (existsSync(cachePath)) {
        copyFileSync(cachePath, filePath);
        return filePath;
    }
    const variants = [
        {
            inset: 80,
            lines: 30,
        },
        {
            inset: 200,
            lines: 22,
        },
        {
            inset: 140,
            lines: 26,
        },
        {
            inset: 260,
            lines: 16,
        },
    ];
    const doc = await PDFDocument.create();
    const images = await Promise.all(variants.map(async variant => {
        const canvas = createCanvas(Math.round(1224 * rasterScale), Math.round(1584 * rasterScale));
        const context = canvas.getContext('2d');
        context.scale(rasterScale, rasterScale);
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, 1224, 1584);
        context.fillStyle = '#1a1a1a';
        context.font = '30px serif';
        for (let line = 0; line < variant.lines; line += 1) {
            context.fillText(
                'Scanned body text measured by the content detector',
                variant.inset,
                variant.inset + (line * 44),
            );
        }
        return doc.embedJpg(canvas.toBuffer('image/jpeg', 0.82));
    }));
    for (let pageNumber = 0; pageNumber < pageCount; pageNumber += 1) {
        const page = doc.addPage([
            612,
            792,
        ]);
        page.drawImage(images[pageNumber % images.length]!, {
            x: 0,
            y: 0,
            width: 612,
            height: 792,
        });
    }
    const bytes = await doc.save();
    mkdirSync(FIXTURE_CACHE_DIR, {recursive: true});
    writeFileSync(cachePath, bytes);
    copyFileSync(cachePath, filePath);
    return filePath;
}

/**
 * A book scanned as spreads: every sheet is two Letter pages side by side, with
 * a clear gutter between them and the same page-relative ink on each side. The
 * document it should produce is Letter pages — half the sheet — so a matched
 * canvas taken from the sheet leaves every output page half empty and twice as
 * wide as the book.
 */
export async function createSpreadScannedFixturePdf(
    filename: string,
    pageCount: number,
    rasterDpi = SCANNED_FIXTURE_BASE_DPI,
) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const rasterScale = rasterDpi / SCANNED_FIXTURE_BASE_DPI;
    const cacheKey = createHash('sha256')
        .update(`spread-scanned-v1:${pageCount}${rasterScale === 1 ? '' : `:${rasterDpi}`}`)
        .digest('hex');
    const cachePath = join(FIXTURE_CACHE_DIR, `${cacheKey}.pdf`);
    if (existsSync(cachePath)) {
        copyFileSync(cachePath, filePath);
        return filePath;
    }
    const sheetWidthPx = 2_448;
    const sheetHeightPx = 1_584;
    const halfWidthPx = sheetWidthPx / 2;
    const doc = await PDFDocument.create();
    const canvas = createCanvas(
        Math.round(sheetWidthPx * rasterScale),
        Math.round(sheetHeightPx * rasterScale),
    );
    const context = canvas.getContext('2d');
    context.scale(rasterScale, rasterScale);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, sheetWidthPx, sheetHeightPx);
    context.fillStyle = '#1a1a1a';
    context.font = '34px serif';
    for (const halfLeft of [
        0,
        halfWidthPx,
    ]) {
        // Body text drawn page-relative, so each half's ink covers the same
        // share of the page it belongs to.
        for (let line = 0; line < 26; line += 1) {
            context.fillText(
                'Scanned body text on one page of the spread',
                halfLeft + 150,
                160 + (line * 52),
            );
        }
    }
    // The gutter: paper the splitter can cut along, with the shadow a bound
    // book leaves at the fold.
    context.fillStyle = '#ffffff';
    context.fillRect(halfWidthPx - 60, 0, 120, sheetHeightPx);
    context.fillStyle = '#8a8a8a';
    context.fillRect(halfWidthPx - 2, 0, 4, sheetHeightPx);
    const image = await doc.embedJpg(canvas.toBuffer('image/jpeg', 0.85));
    for (let pageNumber = 0; pageNumber < pageCount; pageNumber += 1) {
        const page = doc.addPage([
            1_224,
            792,
        ]);
        page.drawImage(image, {
            x: 0,
            y: 0,
            width: 1_224,
            height: 792,
        });
    }
    const bytes = await doc.save();
    mkdirSync(FIXTURE_CACHE_DIR, {recursive: true});
    writeFileSync(cachePath, bytes);
    copyFileSync(cachePath, filePath);
    return filePath;
}

/**
 * A scan of one original at three settings, which is what a mixed scanning
 * session leaves in a PDF: Letter at 288 DPI, the same Letter paper at 144, and
 * the same original again at 144 carried as a physically half-size page. The
 * document therefore differs in source resolution *and* in page rectangle, and
 * the two differ independently — the second page is the document's rectangle
 * already and is only short of its grid.
 *
 * Every page draws the same markers in page-relative coordinates — a bar from
 * 10% to 90% of the width and a block in the upper left quarter — so the three
 * page kinds are indistinguishable *after* a document-wide scale
 * normalization, and unmistakably different if a smaller page is merely padded
 * onto the larger sheet or left on its own coarser grid.
 */
export async function createMixedScaleScannedFixturePdf(filename: string, pageCount: number) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const cacheKey = createHash('sha256')
        .update(`mixed-scale-scanned-v2:${pageCount}`)
        .digest('hex');
    const cachePath = join(FIXTURE_CACHE_DIR, `${cacheKey}.pdf`);
    if (existsSync(cachePath)) {
        copyFileSync(cachePath, filePath);
        return filePath;
    }
    const doc = await PDFDocument.create();
    const drawVariant = (widthPx: number, heightPx: number) => {
        const canvas = createCanvas(widthPx, heightPx);
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, widthPx, heightPx);
        context.fillStyle = '#111111';
        context.fillRect(widthPx * 0.1, heightPx * 0.4, widthPx * 0.8, heightPx * 0.05);
        context.fillRect(widthPx * 0.12, heightPx * 0.12, widthPx * 0.24, heightPx * 0.18);
        context.font = `${Math.round(heightPx * 0.03)}px serif`;
        for (let line = 0; line < 8; line += 1) {
            context.fillText(
                'Scanned body text at the document scale',
                widthPx * 0.1,
                heightPx * (0.55 + line * 0.045),
            );
        }
        return canvas.toBuffer('image/jpeg', 0.85);
    };
    const variants = await Promise.all([
        {
            // Letter at 288 DPI: the finest scan in the document, and therefore
            // the pixel grid every page of it has to end up on.
            widthPoints: 612,
            heightPoints: 792,
            widthPx: 2_448,
            heightPx: 3_168,
        },
        {
            // The same Letter paper scanned at half that resolution. Its
            // rectangle already matches the document's, so the only thing
            // matching has to fix is its grid.
            widthPoints: 612,
            heightPoints: 792,
            widthPx: 1_224,
            heightPx: 1_584,
        },
        {
            // And the same original again at 144 DPI, carried as a physically
            // half-size page, which is how a mixed scanning session leaves one.
            widthPoints: 306,
            heightPoints: 396,
            widthPx: 612,
            heightPx: 792,
        },
    ].map(async variant => ({
        ...variant,
        image: await doc.embedJpg(drawVariant(variant.widthPx, variant.heightPx)),
    })));
    for (let pageNumber = 0; pageNumber < pageCount; pageNumber += 1) {
        const variant = variants[pageNumber % variants.length]!;
        const page = doc.addPage([
            variant.widthPoints,
            variant.heightPoints,
        ]);
        page.drawImage(variant.image, {
            x: 0,
            y: 0,
            width: variant.widthPoints,
            height: variant.heightPoints,
        });
    }
    const bytes = await doc.save();
    mkdirSync(FIXTURE_CACHE_DIR, {recursive: true});
    writeFileSync(cachePath, bytes);
    copyFileSync(cachePath, filePath);
    return filePath;
}

/**
 * One scanned original presented at the same rectangle through all four source
 * rotations. The quarter-turned pages carry a landscape MediaBox and a
 * `/Rotate`, which is how a scanner leaves a turned sheet, so every page
 * presents Letter portrait and the document canvas is the same rectangle for
 * all four. Rotation is therefore the only thing that varies between them.
 */
export async function createRotatedScannedFixturePdf(
    filename: string,
    rasterDpi = SCANNED_FIXTURE_BASE_DPI,
) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const rasterScale = rasterDpi / SCANNED_FIXTURE_BASE_DPI;
    const cacheKey = createHash('sha256')
        .update(`rotated-scanned-v2${rasterScale === 1 ? '' : `:${rasterDpi}`}`)
        .digest('hex');
    const cachePath = join(FIXTURE_CACHE_DIR, `${cacheKey}.pdf`);
    if (existsSync(cachePath)) {
        copyFileSync(cachePath, filePath);
        return filePath;
    }
    const doc = await PDFDocument.create();
    const ink = {
        insetXPx: 150,
        insetYPx: 110,
        lines: 24,
    };
    // A quarter-turned sheet carries a landscape raster on a landscape
    // MediaBox. Reusing the portrait raster would squeeze it onto the turned
    // page and give that page two different source resolutions.
    const [
        portrait,
        landscape,
    ] = await Promise.all([
        doc.embedJpg(drawScannedPageJpeg(1_224, 1_584, ink, rasterScale)),
        doc.embedJpg(drawScannedPageJpeg(1_584, 1_224, ink, rasterScale)),
    ]);
    for (const rotation of [
        0,
        90,
        180,
        270,
    ]) {
        const swapsAxes = rotation === 90 || rotation === 270;
        const page = doc.addPage(swapsAxes ? [
            792,
            612,
        ] : [
            612,
            792,
        ]);
        page.drawImage(swapsAxes ? landscape : portrait, {
            x: 0,
            y: 0,
            width: swapsAxes ? 792 : 612,
            height: swapsAxes ? 612 : 792,
        });
        page.setRotation(degrees(rotation));
    }
    const bytes = await doc.save();
    mkdirSync(FIXTURE_CACHE_DIR, {recursive: true});
    writeFileSync(cachePath, bytes);
    copyFileSync(cachePath, filePath);
    return filePath;
}

/**
 * A scan on paper small enough that a margin inside the supported 0-25 mm range
 * can reach or exceed the canvas it is laid out on. The margin fitter's
 * boundary cannot be reached on Letter without asking for a margin the product
 * refuses, so the paper shrinks instead of the request growing.
 *
 * This is the one scanned fixture with no fixed logical raster: its pixel
 * dimensions are the requested paper at the requested DPI, and its ink extents,
 * font and line pitch are fractions of those dimensions. It therefore hands the
 * draw helper an already-scaled canvas and a scale of 1, where the fixed-size
 * fixtures hand it their logical size and `rasterDpi / SCANNED_FIXTURE_BASE_DPI`.
 * Both reach the same raster: the helper multiplies the dimensions by the scale
 * and scales the drawing context by it, so scaling the dimensions up front and
 * asking for no context scale is the same image. The cache key carries the DPI,
 * so two resolutions of one paper size are two documents.
 */
export async function createSmallCanvasScannedFixturePdf(
    filename: string,
    widthPoints: number,
    heightPoints: number,
    rasterDpi = SCANNED_FIXTURE_BASE_DPI,
) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const widthPx = Math.round(widthPoints / 72 * rasterDpi);
    const heightPx = Math.round(heightPoints / 72 * rasterDpi);
    const cacheKey = createHash('sha256')
        .update(`small-canvas-scanned-v1:${widthPoints}:${heightPoints}:${rasterDpi}`)
        .digest('hex');
    const cachePath = join(FIXTURE_CACHE_DIR, `${cacheKey}.pdf`);
    if (existsSync(cachePath)) {
        copyFileSync(cachePath, filePath);
        return filePath;
    }
    const doc = await PDFDocument.create();
    const images = await Promise.all([
        {
            insetXPx: Math.round(widthPx * 0.12),
            insetYPx: Math.round(heightPx * 0.14),
            lines: 6,
        },
        {
            insetXPx: Math.round(widthPx * 0.2),
            insetYPx: Math.round(heightPx * 0.22),
            lines: 4,
        },
    ].map(async ink => doc.embedJpg(drawScannedPageJpeg(widthPx, heightPx, {
        ...ink,
        fontPx: Math.max(8, Math.round(heightPx * 0.05)),
        linePitchPx: Math.max(10, Math.round(heightPx * 0.08)),
        text: 'Scanned body text',
    }, 1))));
    for (const image of images) {
        const page = doc.addPage([
            widthPoints,
            heightPoints,
        ]);
        page.drawImage(image, {
            x: 0,
            y: 0,
            width: widthPoints,
            height: heightPoints,
        });
    }
    const bytes = await doc.save();
    mkdirSync(FIXTURE_CACHE_DIR, {recursive: true});
    writeFileSync(cachePath, bytes);
    copyFileSync(cachePath, filePath);
    return filePath;
}

/**
 * A spread whose two leaves were printed with visibly different ink extents:
 * the left leaf carries a wide, tall block and the right leaf a narrow, short
 * one. Splitting it produces two pages whose crops differ, which is what makes
 * a shared spread placement decision observable — equal crops would agree by
 * construction.
 */
export async function createUnequalSpreadScannedFixturePdf(
    filename: string,
    pageCount: number,
    rasterDpi = SCANNED_FIXTURE_BASE_DPI,
) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const rasterScale = rasterDpi / SCANNED_FIXTURE_BASE_DPI;
    const cacheKey = createHash('sha256')
        .update(`unequal-spread-scanned-v1:${pageCount}${rasterScale === 1 ? '' : `:${rasterDpi}`}`)
        .digest('hex');
    const cachePath = join(FIXTURE_CACHE_DIR, `${cacheKey}.pdf`);
    if (existsSync(cachePath)) {
        copyFileSync(cachePath, filePath);
        return filePath;
    }
    const sheetWidthPx = 2_448;
    const sheetHeightPx = 1_584;
    const halfWidthPx = sheetWidthPx / 2;
    const doc = await PDFDocument.create();
    const canvas = createCanvas(
        Math.round(sheetWidthPx * rasterScale),
        Math.round(sheetHeightPx * rasterScale),
    );
    const context = canvas.getContext('2d');
    context.scale(rasterScale, rasterScale);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, sheetWidthPx, sheetHeightPx);
    context.fillStyle = '#1a1a1a';
    context.font = '34px serif';
    for (const leaf of [
        {
            left: 0,
            insetX: 120,
            insetY: 120,
            lines: 26,
        },
        {
            left: halfWidthPx,
            insetX: 300,
            insetY: 320,
            lines: 14,
        },
    ]) {
        for (let line = 0; line < leaf.lines; line += 1) {
            context.fillText(
                'Scanned body text on one leaf of the spread',
                leaf.left + leaf.insetX,
                leaf.insetY + (line * 52),
            );
        }
    }
    context.fillStyle = '#ffffff';
    context.fillRect(halfWidthPx - 60, 0, 120, sheetHeightPx);
    context.fillStyle = '#8a8a8a';
    context.fillRect(halfWidthPx - 2, 0, 4, sheetHeightPx);
    const image = await doc.embedJpg(canvas.toBuffer('image/jpeg', 0.85));
    for (let pageNumber = 0; pageNumber < pageCount; pageNumber += 1) {
        const page = doc.addPage([
            1_224,
            792,
        ]);
        page.drawImage(image, {
            x: 0,
            y: 0,
            width: 1_224,
            height: 792,
        });
    }
    const bytes = await doc.save();
    mkdirSync(FIXTURE_CACHE_DIR, {recursive: true});
    writeFileSync(cachePath, bytes);
    copyFileSync(cachePath, filePath);
    return filePath;
}

/**
 * Letter scanned both ways round in one session. The two rectangles have the
 * same area, so the document canvas is decided by the width tie-break and lands
 * on the landscape sheet; the portrait pages are then paper that is larger than
 * the canvas they have to fit, which is the placement case a canvas measured
 * from a different layout produces.
 */
export async function createMixedOrientationScannedFixturePdf(
    filename: string,
    pageCount: number,
    rasterDpi = SCANNED_FIXTURE_BASE_DPI,
) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const rasterScale = rasterDpi / SCANNED_FIXTURE_BASE_DPI;
    const cacheKey = createHash('sha256')
        .update(`mixed-orientation-scanned-v1:${pageCount}${rasterScale === 1 ? '' : `:${rasterDpi}`}`)
        .digest('hex');
    const cachePath = join(FIXTURE_CACHE_DIR, `${cacheKey}.pdf`);
    if (existsSync(cachePath)) {
        copyFileSync(cachePath, filePath);
        return filePath;
    }
    const doc = await PDFDocument.create();
    const variants = await Promise.all([
        {
            widthPoints: 792,
            heightPoints: 612,
            widthPx: 1_584,
            heightPx: 1_224,
        },
        {
            widthPoints: 612,
            heightPoints: 792,
            widthPx: 1_224,
            heightPx: 1_584,
        },
    ].map(async variant => ({
        ...variant,
        image: await doc.embedJpg(drawScannedPageJpeg(variant.widthPx, variant.heightPx, {
            insetXPx: 140,
            insetYPx: 120,
            lines: 18,
        }, rasterScale)),
    })));
    for (let pageNumber = 0; pageNumber < pageCount; pageNumber += 1) {
        const variant = variants[pageNumber % variants.length]!;
        const page = doc.addPage([
            variant.widthPoints,
            variant.heightPoints,
        ]);
        page.drawImage(variant.image, {
            x: 0,
            y: 0,
            width: variant.widthPoints,
            height: variant.heightPoints,
        });
    }
    const bytes = await doc.save();
    mkdirSync(FIXTURE_CACHE_DIR, {recursive: true});
    writeFileSync(cachePath, bytes);
    copyFileSync(cachePath, filePath);
    return filePath;
}

function drawScannedPageJpeg(widthPx: number, heightPx: number, ink: {
    insetXPx: number;
    insetYPx: number;
    lines: number;
    fontPx?: number;
    linePitchPx?: number;
    text?: string;
}, rasterScale: number) {
    const canvas = createCanvas(Math.round(widthPx * rasterScale), Math.round(heightPx * rasterScale));
    const context = canvas.getContext('2d');
    context.scale(rasterScale, rasterScale);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, widthPx, heightPx);
    context.fillStyle = '#1a1a1a';
    context.font = `${String(ink.fontPx ?? 32)}px serif`;
    for (let line = 0; line < ink.lines; line += 1) {
        context.fillText(
            ink.text ?? 'Scanned body text measured by the content detector',
            ink.insetXPx,
            ink.insetYPx + (line * (ink.linePitchPx ?? 46)),
        );
    }
    return canvas.toBuffer('image/jpeg', 0.85);
}

export async function createLargeScannedFixturePdf(
    filename: string,
    pageCount = 431,
    attachmentSizeBytes = 28 * 1024 * 1024,
    rasterScale = 1,
    options: {runOwner?: string} = {},
) {
    const fixtureDir = options.runOwner
        ? getRunFixtureDir(options.runOwner)
        : getFixtureDir();
    mkdirSync(fixtureDir, {recursive: true});
    const filePath = join(fixtureDir, filename);
    const cacheKey = createHash('sha256')
        .update(`large-scanned-v3:${pageCount}:${attachmentSizeBytes}:${rasterScale}`)
        .digest('hex');
    const cachePath = join(FIXTURE_CACHE_DIR, `${cacheKey}.pdf`);
    if (existsSync(cachePath)) {
        copyFileSync(cachePath, filePath);
        return filePath;
    }

    const canvas = createCanvas(1224 * rasterScale, 1584 * rasterScale);
    const context = canvas.getContext('2d');
    context.scale(rasterScale, rasterScale);
    context.fillStyle = '#f8f7f3';
    context.fillRect(0, 0, 1224, 1584);
    context.fillStyle = '#242424';
    context.font = 'bold 54px serif';
    context.fillText('E2E scanned PDF fixture', 110, 150);
    context.font = '28px serif';
    for (let line = 0; line < 34; line += 1) {
        context.fillText(
            `Scanned page sample row ${String(line + 1).padStart(2, '0')}`,
            110,
            250 + (line * 34),
        );
    }

    const doc = await PDFDocument.create();
    const scannedPageImage = await doc.embedJpg(canvas.toBuffer('image/jpeg', 0.78));
    for (let pageNumber = 0; pageNumber < pageCount; pageNumber += 1) {
        const marker = resolveScannedFixturePageMarkerRgb(pageNumber + 1);
        const page = doc.addPage([
            612,
            792,
        ]);
        page.drawImage(scannedPageImage, {
            x: 0,
            y: 0,
            width: 612,
            height: 792,
        });
        // A page-specific vector marker makes stale or incorrectly reused
        // canvases observable without duplicating the large scanned image.
        page.drawRectangle({
            x: SCANNED_FIXTURE_MARKER_X,
            y: SCANNED_FIXTURE_MARKER_Y,
            width: SCANNED_FIXTURE_MARKER_SIZE,
            height: SCANNED_FIXTURE_MARKER_SIZE,
            color: rgb(marker.red / 255, marker.green / 255, marker.blue / 255),
        });
    }

    const attachment = new Uint8Array(attachmentSizeBytes);
    let attachmentState = 0x6d2b79f5;
    for (let index = 0; index < attachment.length; index += 1) {
        attachmentState ^= attachmentState << 13;
        attachmentState ^= attachmentState >>> 17;
        attachmentState ^= attachmentState << 5;
        attachment[index] = attachmentState >>> 24;
    }
    await doc.attach(attachment, 'scanned-source-payload.bin', {
        mimeType: 'application/octet-stream',
        description: 'Native-speed payload for large scanned-PDF Electron rendering coverage',
        creationDate: new Date('2026-01-01T00:00:00.000Z'),
        modificationDate: new Date('2026-01-01T00:00:00.000Z'),
    });

    const bytes = await doc.save();
    mkdirSync(FIXTURE_CACHE_DIR, {recursive: true});
    writeFileSync(cachePath, bytes);
    copyFileSync(cachePath, filePath);
    return filePath;
}

export const SCANNED_FIXTURE_MARKER_X = 24;
export const SCANNED_FIXTURE_MARKER_Y = 720;
export const SCANNED_FIXTURE_MARKER_SIZE = 40;

export function resolveScannedFixturePageMarkerRgb(pageNumber: number) {
    const normalized = Math.max(1, Math.trunc(pageNumber));
    return {
        red: 32 + ((normalized * 53) % 192),
        green: 32 + ((normalized * 97) % 192),
        blue: 32 + ((normalized * 151) % 192),
    };
}

export function createPngFixture(filename: string) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const bytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4'
        + 'z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
        'base64',
    );
    writeFileSync(filePath, bytes);
    return filePath;
}

export function createCorruptPdfFixture(filename: string) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    // The PDF signature makes the direct-open route claim this as a PDF, but
    // the truncated object and missing cross-reference table make it
    // impossible for either preflight validation or PDF.js to accept.
    writeFileSync(filePath, Buffer.from([
        '%PDF-1.7',
        '1 0 obj',
        '<< /Type /Catalog /Pages 2 0 R >>',
        'endobj',
        '2 0 obj',
        '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
        'endobj',
        '3 0 obj',
        '<< /Type /Page /Parent 2 0 R',
    ].join('\n')));
    return filePath;
}

export async function createBlankFixturePdf(filename: string, pageCount = 1) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);

    const doc = await PDFDocument.create();
    for (let pageNumber = 0; pageNumber < pageCount; pageNumber += 1) {
        doc.addPage([
            612,
            792,
        ]);
    }

    const bytes = await doc.save();
    writeFileSync(filePath, bytes);

    return filePath;
}

export async function createLinkOnlyFixturePdf(filename: string) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        612,
        792,
    ]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Link-only annotation fixture', {
        font,
        size: 24,
        x: 100,
        y: 650,
    });
    const link = doc.context.register(doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Link'),
        Rect: [
            100,
            580,
            320,
            610,
        ],
        Border: [
            0,
            0,
            1,
        ],
        C: [
            0,
            0,
            1,
        ],
        A: {
            S: PDFName.of('URI'),
            URI: PDFString.of('https://example.com/evb-viewer-link-fixture'),
        },
        P: page.ref,
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([link]));
    writeFileSync(filePath, await doc.save({useObjectStreams: false}));
    return filePath;
}

const ANNOTATION_SURFACE_STAMP_JPEG = Uint8Array.from(Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAoAEADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAcI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Al7UCSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//Z',
    'base64',
));

/**
 * A single-page document containing each canonical annotation kind and one
 * foreign link. The annotations are deliberately hand-authored so the test
 * exercises the native parser and the static PDF.js layer together.
 */
export async function createCanonicalAnnotationSurfaceFixturePdf(filename: string) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const document = await PDFDocument.create();
    const page = document.addPage([
        612,
        792,
    ]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText('Canonical annotation surface fixture', {
        font,
        size: 20,
        x: 72,
        y: 720,
    });
    page.drawText('Foreign link', {
        font,
        size: 14,
        x: 400,
        y: 700,
    });

    const context = document.context;
    const annotation = (fields: Record<string, unknown>) => context.register(context.obj({
        Type: PDFName.of('Annot'),
        P: page.ref,
        F: PDFNumber.of(4),
        M: PDFString.of('D:20260901000000Z'),
        ...fields,
    }));

    const textBox = annotation({
        Subtype: PDFName.of('FreeText'),
        Rect: [
            72,
            610,
            250,
            660,
        ],
        NM: PDFHexString.fromText('surface-text-box'),
        Contents: PDFHexString.fromText('Store-owned text box'),
        DA: PDFString.of('/Helvetica 18 Tf 0 0 1 rg'),
    });
    const note = annotation({
        Subtype: PDFName.of('Text'),
        Rect: [
            280,
            610,
            312,
            642,
        ],
        NM: PDFHexString.fromText('surface-note'),
        Contents: PDFHexString.fromText('Store-owned note'),
        C: [
            1,
            0.75,
            0,
        ],
        Open: false,
        T: PDFHexString.fromText('EVB fixture'),
    });
    const highlight = annotation({
        Subtype: PDFName.of('Highlight'),
        Rect: [
            72,
            510,
            250,
            535,
        ],
        QuadPoints: [
            72,
            535,
            250,
            535,
            72,
            510,
            250,
            510,
        ],
        NM: PDFHexString.fromText('surface-highlight'),
        Contents: PDFHexString.fromText('Store-owned highlight'),
        C: [
            1,
            0.8,
            0,
        ],
        CA: PDFNumber.of(0.45),
    });
    const shape = annotation({
        Subtype: PDFName.of('Square'),
        Rect: [
            350,
            510,
            470,
            570,
        ],
        NM: PDFHexString.fromText('evb-shape:surface-square'),
        EVBShapeKey: PDFHexString.fromText('evb-shape:surface-square'),
        C: [
            0.1,
            0.4,
            0.9,
        ],
        IC: [
            0.8,
            0.9,
            1,
        ],
        CA: PDFNumber.of(0.5),
        Border: [
            0,
            0,
            2,
        ],
    });

    const stampImage = await document.embedJpg(ANNOTATION_SURFACE_STAMP_JPEG);
    const stampImageName = context.addRandomSuffix('SurfaceImage', 10);
    const stampAppearance = context.register(context.formXObject(
        drawImage(stampImageName, {
            x: 0,
            y: 0,
            width: 80,
            height: 70,
            rotate: degrees(0),
            xSkew: degrees(0),
            ySkew: degrees(0),
        }),
        {
            Resources: {XObject: {[stampImageName]: stampImage.ref}},
            BBox: context.obj([
                0,
                0,
                80,
                70,
            ]),
        },
    ));
    const stamp = annotation({
        Subtype: PDFName.of('Stamp'),
        Rect: [
            500,
            510,
            580,
            580,
        ],
        NM: PDFHexString.fromText('surface-stamp'),
        AP: context.obj({N: stampAppearance}),
        Name: PDFName.of('Approved'),
    });
    const link = annotation({
        Subtype: PDFName.of('Link'),
        Rect: [
            390,
            685,
            540,
            715,
        ],
        Border: [
            0,
            0,
            1,
        ],
        A: context.obj({
            S: PDFName.of('URI'),
            URI: PDFString.of('https://example.com/evb-viewer-surface'),
        }),
    });

    page.node.set(PDFName.of('Annots'), context.obj([
        textBox,
        note,
        highlight,
        shape,
        stamp,
        link,
    ]));
    writeFileSync(filePath, await document.save({
        addDefaultPage: false,
        useObjectStreams: false,
    }));
    return filePath;
}

export async function createManagedInkStrokeFixturePdf(filename: string) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        612,
        792,
    ]);
    const ink = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Ink'),
        Rect: [
            122.4,
            491.04,
            397.8,
            554.4,
        ],
        InkList: [[
            122.4,
            554.4,
            214.2,
            522.72,
            306,
            546.48,
            397.8,
            491.04,
        ]],
        C: [
            37 / 255,
            99 / 255,
            235 / 255,
        ],
        CA: 1,
        Border: [
            0,
            0,
            1,
        ],
        EVBShapeKey: PDFHexString.fromText('evb-shape:annotation-stroke-parity'),
    });
    const inkRef = doc.context.register(ink);
    page.node.set(PDFName.of('Annots'), doc.context.obj([inkRef]));
    writeFileSync(filePath, await doc.save());
    return filePath;
}

export async function createScannedTextFixturePdf(filename: string, text: string) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const canvas = createCanvas(1200, 500);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111111';
    context.font = 'bold 72px sans-serif';
    context.fillText(text, 60, 270);

    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        250,
    ]);
    const image = await doc.embedPng(canvas.toBuffer('image/png'));
    page.drawImage(image, {
        x: 0,
        y: 0,
        width: 600,
        height: 250,
    });
    writeFileSync(filePath, await doc.save());
    return filePath;
}

export async function readPdfAnnotationDetails(filePath: string): Promise<IPdfAnnotationDetails[]> {
    const document = await openPdfWithLowVerbosity(filePath);
    const details: IPdfAnnotationDetails[] = [];

    try {
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            const page = await document.getPage(pageNumber);
            const annotations = await page.getAnnotations();
            for (const annotation of annotations) {
                details.push({
                    author: getAnnotationAuthor(annotation),
                    subtype: (annotation.subtype ?? 'Unknown').trim(),
                });
            }
        }
    } finally {
        await document.destroy();
    }

    return details;
}

function getPdfStringValue(value: unknown) {
    if (value instanceof PDFHexString || value instanceof PDFString) {
        return value.decodeText();
    }
    return '';
}

export async function readPdfTextAnnotationRecords(filePath: string): Promise<IPdfTextAnnotationRecord[]> {
    const document = await PDFDocument.load(readFileSync(filePath), { updateMetadata: false });
    const records: IPdfTextAnnotationRecord[] = [];

    for (let pageIndex = 0; pageIndex < document.getPageCount(); pageIndex += 1) {
        const annots = document.getPage(pageIndex).node.Annots();
        if (!(annots instanceof PDFArray)) {
            continue;
        }

        for (let index = 0; index < annots.size(); index += 1) {
            const ref = annots.get(index);
            if (!(ref instanceof PDFRef)) {
                continue;
            }
            const dict = document.context.lookupMaybe(ref, PDFDict);
            if (!dict) {
                continue;
            }
            const subtype = dict.get(PDFName.of('Subtype'))?.toString() ?? '';
            if (subtype !== '/Text' && subtype !== '/FreeText') {
                continue;
            }
            const replyTo = dict.get(PDFName.of('IRT'));
            const popup = dict.get(PDFName.of('Popup'));
            records.push({
                contents: getPdfStringValue(dict.get(PDFName.of('Contents'))),
                name: getPdfStringValue(dict.get(PDFName.of('NM'))),
                popup: popup instanceof PDFRef ? String(popup) : null,
                ref: String(ref),
                replyTo: replyTo instanceof PDFRef ? String(replyTo) : null,
                subtype,
            });
        }
    }

    return records;
}

export async function readPdfAnnotationSummary(filePath: string): Promise<IPdfAnnotationSummary> {
    const details = await readPdfAnnotationDetails(filePath);
    const bySubtype: Record<string, number> = {};
    for (const detail of details) {
        bySubtype[detail.subtype] = (bySubtype[detail.subtype] ?? 0) + 1;
    }
    return {
        total: details.length,
        bySubtype,
    };
}

function resolveQpdfBinary() {
    return resolveNativeToolPath({
        binaryName: process.platform === 'win32' ? 'qpdf.exe' : 'qpdf',
        binaryRelativePath: [
            'bin',
            process.platform === 'win32' ? 'qpdf.exe' : 'qpdf',
        ],
        crateName: 'qpdf',
        currentDir: process.cwd(),
        includeRustTargetCandidates: false,
        isPackaged: false,
        platformArch: resolvePlatformArchTag(),
        projectRoot: process.cwd(),
        resourcesBase: resolve(process.cwd(), 'resources'),
    });
}

async function runQpdf(
    filePath: string,
    args: string[],
    operation: string,
    limits: {
        maxStderrBytes: number;
        maxStdoutBytes: number;
    },
) {
    const qpdf = resolveQpdfBinary();
    if (!qpdf) {
        throw new Error(`qpdf is unavailable for ${operation}: ${filePath}`);
    }
    try {
        return await runNativeCommand(qpdf, args, {
            commandLabel: `qpdf ${operation}`,
            defaultCwdToCommandDir: true,
            maxStderrBytes: limits.maxStderrBytes,
            maxStdoutBytes: limits.maxStdoutBytes,
            prependCommandDirToPath: true,
            timeoutMs: 120_000,
            windowsHide: true,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`qpdf ${operation} failed for ${filePath}: ${message}`, {cause: error});
    }
}

function parseQpdfObjectRefs(value: string): IQpdfObjectRef[] {
    return Array.from(value.matchAll(/(\d+)\s+(\d+)\s+R/gu)).map(match => ({
        objectNumber: Number(match[1]),
        generationNumber: Number(match[2]),
    }));
}

async function readQpdfObject(filePath: string, objectRef: IQpdfObjectRef) {
    const result = await runQpdf(
        filePath,
        [
            `--show-object=${objectRef.objectNumber},${objectRef.generationNumber}`,
            filePath,
        ],
        'object read',
        {
            maxStderrBytes: 32 * 1024,
            maxStdoutBytes: 1024 * 1024,
        },
    );
    return result.stdout;
}

export async function readFreeTextObjectByName(filePath: string, name: string) {
    const pagesResult = await runQpdf(
        filePath,
        [
            '--show-pages',
            filePath,
        ],
        'page listing',
        {
            maxStderrBytes: 32 * 1024,
            maxStdoutBytes: 1024 * 1024,
        },
    );
    const pageRefMatch = pagesResult.stdout.match(/^page 1: (\d+) (\d+) R$/mu);
    if (!pageRefMatch) {
        throw new Error(`qpdf did not report the first page object for ${filePath}`);
    }
    const pageObject = await readQpdfObject(filePath, {
        objectNumber: Number(pageRefMatch[1]),
        generationNumber: Number(pageRefMatch[2]),
    });
    const annotsMatch = pageObject.match(/\/Annots\s+(\[[\s\S]*?\]|\d+\s+\d+\s+R)/u);
    if (!annotsMatch?.[1]) {
        throw new Error(`qpdf did not report page annotations for ${filePath}`);
    }
    let annotsValue = annotsMatch[1];
    if (!annotsValue.startsWith('[')) {
        const annotsRef = parseQpdfObjectRefs(annotsValue)[0];
        if (!annotsRef) {
            throw new Error(`qpdf reported an invalid annotation reference for ${filePath}`);
        }
        annotsValue = await readQpdfObject(filePath, annotsRef);
    }
    for (const objectRef of parseQpdfObjectRefs(annotsValue)) {
        const object = await readQpdfObject(filePath, objectRef);
        if (
            /\/Subtype\s*\/FreeText(?:\s|$)/u.test(object)
            && object.includes(`/NM (${name})`)
        ) {
            return {
                object,
                objectRef,
            };
        }
    }
    throw new Error(`qpdf did not find FreeText annotation ${name} in ${filePath}`);
}

export async function readPdfHasEncryptDictionary(filePath: string) {
    const bytes = await readFile(filePath);
    return bytes.includes(Buffer.from('/Encrypt', 'latin1'));
}

export async function readPdfPageSnapshots(filePath: string): Promise<IPdfPageSnapshot[]> {
    const document = await openPdfWithLowVerbosity(filePath);
    const pages: IPdfPageSnapshot[] = [];

    try {
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            const page = await document.getPage(pageNumber);
            const textContent = await page.getTextContent();
            const snippet = textContent.items
                .map((item) => {
                    if (!('str' in item)) {
                        return '';
                    }
                    return String(item.str).trim();
                })
                .filter(Boolean)
                .slice(0, 8)
                .join(' ')
                .trim();

            pages.push({
                pageNumber,
                rotation: page.rotate ?? 0,
                textSnippet: snippet,
            });
        }
    } finally {
        await document.destroy();
    }

    return pages;
}

export async function readPdfMetadataWithQpdf(filePath: string) {
    const qpdf = resolveQpdfBinary();
    if (!qpdf) {
        throw new Error('qpdf is unavailable for PDF metadata verification');
    }

    await runNativeCommand(qpdf, [
        '--check',
        filePath,
    ], {
        commandLabel: 'qpdf metadata matrix check',
        defaultCwdToCommandDir: true,
        maxStderrBytes: 32 * 1024,
        maxStdoutBytes: 32 * 1024,
        prependCommandDirToPath: true,
        timeoutMs: 30_000,
        windowsHide: true,
    });
    const result = await runNativeCommand(qpdf, [
        '--json',
        filePath,
    ], {
        commandLabel: 'qpdf metadata matrix JSON',
        defaultCwdToCommandDir: true,
        maxStderrBytes: 64 * 1024,
        maxStdoutBytes: 512 * 1024,
        prependCommandDirToPath: true,
        timeoutMs: 30_000,
        windowsHide: true,
    });
    interface IQpdfMetadataOutline {
        title?: string;
        destpageposfrom1?: number;
        kids?: IQpdfMetadataOutline[];
    }
    return JSON.parse(result.stdout) as {
        outlines: IQpdfMetadataOutline[];
        pagelabels: Array<{label?: Record<string, unknown>}>;
    };
}



function getGeneratedDjvuFixturePath() {
    return join(FIXTURE_ROOT_DIR, 'generated', GENERATED_DJVU_FIXTURE_FILENAME);
}

function createGeneratedDjvuPagePbm() {
    const rowBytes = Math.ceil(GENERATED_DJVU_FIXTURE_WIDTH / 8);
    const bitmap = Buffer.alloc(rowBytes * GENERATED_DJVU_FIXTURE_HEIGHT, 0);
    const setPixel = (x: number, y: number) => {
        if (
            x < 0
            || y < 0
            || x >= GENERATED_DJVU_FIXTURE_WIDTH
            || y >= GENERATED_DJVU_FIXTURE_HEIGHT
        ) {
            return;
        }
        const byteIndex = y * rowBytes + (x >> 3);
        bitmap[byteIndex] = (bitmap[byteIndex] ?? 0) | (0x80 >> (x & 7));
    };
    const drawHorizontalLine = (y: number, left: number, right: number) => {
        for (let x = left; x <= right; x += 1) {
            setPixel(x, y);
            setPixel(x, y + 1);
        }
    };
    const drawVerticalLine = (x: number, top: number, bottom: number) => {
        for (let y = top; y <= bottom; y += 1) {
            setPixel(x, y);
            setPixel(x + 1, y);
        }
    };

    drawHorizontalLine(96, 80, 1120);
    drawHorizontalLine(260, 160, 1040);
    drawHorizontalLine(580, 160, 1040);
    drawHorizontalLine(900, 160, 1040);
    drawHorizontalLine(1220, 160, 1040);
    drawVerticalLine(80, 96, 1500);
    drawVerticalLine(1120, 96, 1500);

    return Buffer.concat([
        Buffer.from(`P4\n${GENERATED_DJVU_FIXTURE_WIDTH} ${GENERATED_DJVU_FIXTURE_HEIGHT}\n`, 'ascii'),
        bitmap,
    ]);
}

function generateDjvuFixture(targetPath = getGeneratedDjvuFixturePath()) {
    if (existsSync(targetPath) && statSync(targetPath).isFile()) {
        return targetPath;
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    const workDir = mkdtempSync(join(tmpdir(), 'evb-djvu-fixture-'));
    const pagePbmPath = join(workDir, 'page.pbm');
    const pageDjvuPath = join(workDir, 'page.djvu');
    const outputPath = join(workDir, 'document.djvu');

    try {
        writeFileSync(pagePbmPath, createGeneratedDjvuPagePbm());
        execFileSync('cjb2', [
            '-dpi',
            String(GENERATED_DJVU_FIXTURE_DPI),
            pagePbmPath,
            pageDjvuPath,
        ], { stdio: 'pipe' });
        execFileSync('djvm', [
            '-create',
            outputPath,
            ...Array.from({ length: GENERATED_DJVU_FIXTURE_PAGE_COUNT }, () => pageDjvuPath),
        ], { stdio: 'pipe' });

        const output = statSync(outputPath);
        if (!output.isFile() || output.size <= 0) {
            throw new Error(`Generated DjVu fixture is empty: ${outputPath}`);
        }

        try {
            renameSync(outputPath, targetPath);
        } catch (error) {
            if (existsSync(targetPath) && statSync(targetPath).isFile()) {
                return targetPath;
            }
            throw error;
        }
        return targetPath;
    } finally {
        rmSync(workDir, {
            recursive: true,
            force: true,
        });
    }
}

function describeGeneratedDjvuFixtureFailure(error: unknown) {
    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }
    return String(error);
}

function isDjvuFixtureRequired() {
    return true;
}

export function resolveDjvuFixturePath(options: IDjvuFixtureAvailabilityOptions = {}) {
    const env = options.env ?? process.env;
    const trackedFixtureDir = options.trackedFixtureDir ?? TRACKED_PROJECT_FIXTURE_DIR;
    const devkitFixtureDir = options.devkitFixtureDir ?? PROJECT_ROOT_FIXTURE_DIR;
    const corpusFixturePath = options.corpusFixturePath === undefined
        ? TRACKED_DJVU_CORPUS_FIXTURE
        : options.corpusFixturePath;
    const required = isDjvuFixtureRequired();
    const overridePath = env[DJVU_FIXTURE_ENV_VAR]?.trim();
    if (overridePath) {
        const absoluteOverridePath = resolve(overridePath);
        if (!existsSync(absoluteOverridePath)) {
            return {
                path: null,
                reason: `${DJVU_FIXTURE_ENV_VAR} points to a missing path: ${absoluteOverridePath}`,
                required,
            };
        }
        if (!statSync(absoluteOverridePath).isFile()) {
            return {
                path: null,
                reason: `${DJVU_FIXTURE_ENV_VAR} must point to a file: ${absoluteOverridePath}`,
                required,
            };
        }
        if (!hasDjvuExtension(absoluteOverridePath)) {
            return {
                path: null,
                reason: `${DJVU_FIXTURE_ENV_VAR} must point to a .djvu or .djv file: ${absoluteOverridePath}`,
                required,
            };
        }
        return {
            path: absoluteOverridePath,
            reason: `Using ${DJVU_FIXTURE_ENV_VAR}: ${absoluteOverridePath}`,
            required,
        };
    }

    for (const candidatePath of [
        ...(corpusFixturePath ? [resolve(corpusFixturePath)] : []),
        resolve(trackedFixtureDir, DEFAULT_DJVU_FIXTURE),
        resolve(devkitFixtureDir, DEFAULT_DJVU_FIXTURE),
    ]) {
        if (existsSync(candidatePath) && statSync(candidatePath).isFile()) {
            return {
                path: candidatePath,
                reason: `Using DjVu fixture: ${candidatePath}`,
                required,
            };
        }
    }

    if (options.generate !== false) {
        try {
            const generatedPath = options.generatedFixtureFactory
                ? options.generatedFixtureFactory()
                : generateDjvuFixture();
            if (!existsSync(generatedPath) || !statSync(generatedPath).isFile()) {
                throw new Error(`Generated DjVu fixture was not created: ${generatedPath}`);
            }
            if (!hasDjvuExtension(generatedPath)) {
                throw new Error(`Generated DjVu fixture must be a .djvu or .djv file: ${generatedPath}`);
            }
            return {
                path: generatedPath,
                reason: `Using generated DjVu fixture: ${generatedPath}`,
                required,
            };
        } catch (error) {
            return {
                path: null,
                reason: `Generated DjVu fixture is not available: ${describeGeneratedDjvuFixtureFailure(error)}`,
                required,
            };
        }
    }

    return {
        path: null,
        reason: `DjVu fixture is not available. Set ${DJVU_FIXTURE_ENV_VAR}`
            + ` or place ${DEFAULT_DJVU_FIXTURE} under tests/fixtures/electron or .devkit.`,
        required,
    };
}

function hasDjvuExtension(path: string) {
    const lowerPath = path.toLowerCase();
    return lowerPath.endsWith('.djvu') || lowerPath.endsWith('.djv');
}

async function openPdfWithLowVerbosity(filePath: string) {
    const data = new Uint8Array(readFileSync(filePath));
    return pdfjs.getDocument({
        data,
        ...createPdfjsNodeDocumentOptions(pdfjs),
    }).promise;
}
