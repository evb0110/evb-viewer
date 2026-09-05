import { execFile } from 'child_process';
import { existsSync } from 'fs';
import {
    readFile,
    readdir,
    stat,
} from 'fs/promises';
import {
    basename,
    join,
} from 'path';
import { promisify } from 'util';
import { pathToFileURL } from 'url';
import {
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import { WORKER_BUNDLES } from '@electron-worker-bundles/electronWorkerBundles.js';
import type { TWorkerBundleId } from '@electron-worker-bundles/electronWorkerBundles.js';
import type { Metafile } from 'esbuild';

const execFileAsync = promisify(execFile);

interface IDynamicCodeAnalysis {
    allowedIdioms: string[];
    violations: Array<{
        excerpt: string;
        kind: string;
    }>;
}

interface IWorkerDynamicCodePolicyModule {analyzeDynamicCodeConstruction: (content: string) => IDynamicCodeAnalysis}

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

// Resolved from this file, not the working directory, so the suite behaves the
// same however the runner was launched.
const {analyzeDynamicCodeConstruction} = await import(
    pathToFileURL(join(REPO_ROOT, 'scripts/lib/worker-dynamic-code-policy.mjs')).href
) as IWorkerDynamicCodePolicyModule;

const DIST_DIR = join(REPO_ROOT, 'dist-electron');
const MAIN_METAFILE = 'main.meta.json';
const PRELOAD_METAFILE = 'preload.meta.json';
const SOURCE_ROOTS = [
    join(REPO_ROOT, 'electron'),
    join(REPO_ROOT, 'packages', 'contracts'),
    join(REPO_ROOT, 'packages', 'electron-worker-bundles'),
    join(REPO_ROOT, 'packages', 'i18n-app'),
    join(REPO_ROOT, 'packages', 'i18n-core'),
    join(REPO_ROOT, 'packages', 'pdf-core'),
];

interface IBundleCheck {
    file: string;
    requiredSymbols: string[];
}

interface IElectronBundleMetafileFixture {
    metafile: Metafile;
    outputs: TMetafileOutputMap;
    emittedOutputFiles: string[];
    mainEntryOutput: string;
    initialMainOutputClosure: Set<string>;
}

type TMetafileOutputMap = Metafile['outputs'];
type TMetafileImportKind = Metafile['outputs'][string]['imports'][number]['kind'];

const REQUIRED_SYMBOLS_BY_WORKER: Partial<Record<TWorkerBundleId, string[]>> = {
    'djvu-pdf': [
        'buildOptimizedPdf',
        'embedBookmarksIntoPdfFile',
        'evb-pdf-page-ops(djvu-bookmarks)',
    ],
    'image-export-tiff': ['combinePagesIntoMultiPageTiffLocal'],
    ocr: ['detectSourceDpiDetails'],
    'page-ops-crop': ['cropPagesLocal'],
    'pdf-combine': [
        'tryCreatePdfFromInputPathsNative',
        'tryCreatePdfWithNativeImageCombiner',
    ],
    'pdf-conformance': ['analyzePdfConformanceFileDirect'],
    search: [
        'indexCacheMaxEntries',
        'tryRunNativeSearch',
        'evb-pdf-search(search)',
        'EVBSIDX2',
    ],
};

const MAIN_BUNDLE_CHECK: IBundleCheck = {
    file: 'main.js',
    requiredSymbols: [],
};
const REQUIRED_INITIAL_MAIN_SYMBOLS = [
    'MacUpdater',
    'NsisUpdater',
    'AppImageUpdater',
];

const PRELOAD_BUNDLE_CHECK: IBundleCheck = {
    file: 'preload.cjs',
    requiredSymbols: [],
};

const BUNDLE_CHECKS: IBundleCheck[] = [
    MAIN_BUNDLE_CHECK,
    PRELOAD_BUNDLE_CHECK,
    ...WORKER_BUNDLES.map(bundle => ({
        file: bundle.fileName,
        requiredSymbols: REQUIRED_SYMBOLS_BY_WORKER[bundle.id] ?? [],
    })),
];
const BASE_BUILD_OUTPUT_FILES = [
    ...BUNDLE_CHECKS.map(check => check.file),
    MAIN_METAFILE,
    PRELOAD_METAFILE,
];
const MAIN_FORBIDDEN_EAGER_INPUT_SUBSTRINGS = [
    '/node_modules/@anthropic-ai/claude-agent-sdk/',
    '/node_modules/pdfjs-dist/legacy/',
    '/packages/i18n-app/messages/de.ts',
    '/packages/i18n-app/messages/es.ts',
    '/packages/i18n-app/messages/fr.ts',
    '/packages/i18n-app/messages/it.ts',
    '/packages/i18n-app/messages/nl.ts',
    '/packages/i18n-app/messages/pt.ts',
    '/packages/i18n-app/messages/ptBr.ts',
    '/packages/i18n-app/messages/ru.ts',
];
const PRELOAD_FORBIDDEN_INPUT_SUBSTRINGS = [
    '/node_modules/pdf-lib/',
    '/node_modules/utif/',
    '/node_modules/pako/',
    '/node_modules/@pdf-lib/upng/',
    '/node_modules/@pdf-lib/standard-fonts/',
    '/packages/pdf-core/iterateDecodedTiffFrames.ts',
];

let latestSourceMtimeMs = 0;
let mainBundleFixture: IElectronBundleMetafileFixture;

const WORKER_BUNDLE_FILES = new Set(WORKER_BUNDLES.map(bundle => bundle.fileName));
const ELECTRON_FREE_WORKER_BUNDLE_FILES = new Set(WORKER_BUNDLES
    .filter(bundle => bundle.id === 'search' || bundle.id === 'djvu-pdf' || bundle.id === 'ocr')
    .map(bundle => bundle.fileName));
const STATIC_ELECTRON_IMPORT_PATTERN = /\bimport\s*(?:\{[^}]*\}|\*\s*as\s+\w+|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s*as\s+\w+))?)\s*from\s*["']electron["']|\bimport\s*["']electron["']/;
const CJS_ELECTRON_REQUIRE_PATTERN = /\brequire\(\s*["']electron["']\s*\)/;

function shouldTrackSourceFile(fileName: string) {
    return fileName.endsWith('.ts')
        || fileName.endsWith('.d.ts')
        || fileName.endsWith('.js')
        || fileName.endsWith('.mjs')
        || fileName.endsWith('.cjs');
}

async function collectSourceFiles(dirPath: string): Promise<string[]> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectSourceFiles(entryPath));
            continue;
        }
        if (entry.isFile() && shouldTrackSourceFile(entry.name)) {
            files.push(entryPath);
        }
    }

    return files;
}

async function getLatestSourceMtimeMs() {
    const sourceFiles = (await Promise.all(SOURCE_ROOTS.map(collectSourceFiles))).flat();
    const freshnessReferenceFiles = [
        ...sourceFiles,
        join(REPO_ROOT, 'package.json'),
        join(REPO_ROOT, 'scripts', 'build-electron.mjs'),
    ];

    let newestMtimeMs = 0;
    for (const sourceFile of freshnessReferenceFiles) {
        const sourceStat = await stat(sourceFile);
        newestMtimeMs = Math.max(newestMtimeMs, sourceStat.mtimeMs);
    }

    return newestMtimeMs;
}

function normalizeMetafilePath(filePath: string) {
    return filePath.replaceAll('\\', '/');
}

function getDistOutputFile(outputPath: string) {
    const normalizedPath = normalizeMetafilePath(outputPath);
    const distPrefix = 'dist-electron/';
    if (!normalizedPath.startsWith(distPrefix)) {
        throw new Error(`Main metafile output is outside dist-electron: ${outputPath}`);
    }
    const outputFile = normalizedPath.slice(distPrefix.length);
    if (basename(outputFile) !== outputFile) {
        throw new Error(`Main metafile output must remain in the dist-electron root: ${outputPath}`);
    }
    return outputFile;
}

function collectOutputClosure(
    outputs: TMetafileOutputMap,
    entryOutput: string,
    includeImport: (kind: TMetafileImportKind) => boolean,
) {
    const closure = new Set<string>();
    const pending = [entryOutput];
    while (pending.length > 0) {
        const outputPath = pending.pop()!;
        if (closure.has(outputPath)) {
            continue;
        }
        closure.add(outputPath);
        const output = outputs[outputPath];
        if (!output) {
            throw new Error(`Main metafile references missing output: ${outputPath}`);
        }
        for (const imported of output.imports) {
            if (!imported.external && includeImport(imported.kind)) {
                pending.push(imported.path);
            }
        }
    }
    return closure;
}

async function loadMainBundleFixture(): Promise<IElectronBundleMetafileFixture> {
    const metafile = JSON.parse(
        await readFile(join(DIST_DIR, MAIN_METAFILE), 'utf8'),
    ) as Metafile;
    const outputs = metafile.outputs;
    const emittedOutputPaths = Object.keys(outputs)
        .filter(outputPath => outputPath.endsWith('.js'));
    const emittedOutputFiles = emittedOutputPaths.map(getDistOutputFile);
    const mainEntryOutput = emittedOutputPaths.find((outputPath) => {
        const entryPoint = outputs[outputPath]?.entryPoint;
        return entryPoint && normalizeMetafilePath(entryPoint) === 'electron/main.ts';
    });
    if (!mainEntryOutput) {
        throw new Error('main.meta.json does not identify the electron/main.ts entry output');
    }
    const initialMainOutputClosure = collectOutputClosure(
        outputs,
        mainEntryOutput,
        kind => kind !== 'dynamic-import',
    );
    return {
        metafile,
        outputs,
        emittedOutputFiles,
        mainEntryOutput,
        initialMainOutputClosure,
    };
}

async function getBuildOutputFiles() {
    if (!existsSync(join(DIST_DIR, MAIN_METAFILE))) {
        return BASE_BUILD_OUTPUT_FILES;
    }
    const fixture = await loadMainBundleFixture();
    return [
        ...BASE_BUILD_OUTPUT_FILES,
        ...fixture.emittedOutputFiles,
    ];
}

function collectOutputInputs(outputs: TMetafileOutputMap, outputPaths: Iterable<string>) {
    const inputPaths = new Set<string>();
    for (const outputPath of outputPaths) {
        const output = outputs[outputPath];
        if (!output) {
            throw new Error(`Missing output while collecting inputs: ${outputPath}`);
        }
        for (const inputPath of Object.keys(output.inputs)) {
            inputPaths.add(`/${normalizeMetafilePath(inputPath)}`);
        }
    }
    return inputPaths;
}

async function rebuildElectronBundlesIfStale() {
    latestSourceMtimeMs = await getLatestSourceMtimeMs();

    const staleBundleFiles: string[] = [];
    for (const outputFile of await getBuildOutputFiles()) {
        const outputPath = join(DIST_DIR, outputFile);
        if (!existsSync(outputPath)) {
            staleBundleFiles.push(outputFile);
            continue;
        }

        const outputStat = await stat(outputPath);
        if (outputStat.mtimeMs < latestSourceMtimeMs) {
            staleBundleFiles.push(outputFile);
        }
    }

    if (staleBundleFiles.length === 0) {
        return;
    }

    const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    await execFileAsync(
        pnpmCommand,
        [
            'run',
            'build:electron',
        ],
        {
            cwd: REPO_ROOT,
            env: process.env,
        },
    );

    for (const outputFile of await getBuildOutputFiles()) {
        const outputPath = join(DIST_DIR, outputFile);
        if (!existsSync(outputPath)) {
            throw new Error(`${outputFile} not found after "pnpm run build:electron"`);
        }

        const outputStat = await stat(outputPath);
        if (outputStat.mtimeMs < latestSourceMtimeMs) {
            throw new Error(`${outputFile} is still stale after "pnpm run build:electron"`);
        }
    }
}

describe('Electron bundle static integrity', () => {
    beforeAll(async () => {
        await rebuildElectronBundlesIfStale();
        mainBundleFixture = await loadMainBundleFixture();
    }, 180_000);

    it('copies the installed PDF.js legacy worker byte-for-byte', async () => {
        const copiedWorker = await readFile(join(DIST_DIR, 'pdf.worker.mjs'));
        const installedWorker = await readFile(join(REPO_ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'));
        expect(copiedWorker.equals(installedWorker)).toBe(true);
    });

    for (const check of BUNDLE_CHECKS) {
        describe(check.file, () => {
            const bundlePath = join(DIST_DIR, check.file);

            it('exists in dist-electron', () => {
                expect(existsSync(bundlePath), `${check.file} not found — run "pnpm run build:electron"`).toBe(true);
            });

            it('is not stale relative to electron sources', async () => {
                if (!existsSync(bundlePath)) {
                    throw new Error(`${check.file} not found — run "pnpm run build:electron"`);
                }

                const bundleStat = await stat(bundlePath);
                expect(
                    bundleStat.mtimeMs,
                    `${check.file} appears stale compared to electron sources — run "pnpm run build:electron"`,
                ).toBeGreaterThanOrEqual(latestSourceMtimeMs);
            });

            for (const symbol of check.requiredSymbols) {
                it(`contains "${symbol}"`, async () => {
                    if (!existsSync(bundlePath)) {
                        throw new Error(`${check.file} not found — run "pnpm run build:electron"`);
                    }
                    const content = await readFile(bundlePath, 'utf-8');
                    expect(
                        content.includes(symbol),
                        `${check.file} is missing "${symbol}" — rebuild with "pnpm run build:electron"`,
                    ).toBe(true);
                });
            }

            if (WORKER_BUNDLE_FILES.has(check.file)) {
                it('has no bare eval or Function construction call site outside the vendored allowlist', async () => {
                    if (!existsSync(bundlePath)) {
                        throw new Error(`${check.file} not found — run "pnpm run build:electron"`);
                    }
                    const content = await readFile(bundlePath, 'utf-8');
                    const {violations} = analyzeDynamicCodeConstruction(content);

                    expect(
                        violations.map(({
                            excerpt,
                            kind,
                        }) => `${kind} — ${excerpt}`),
                        `${check.file} contains a bare or explicitly prefixed eval/Function call site `
                        + 'outside the vendored allowlist. This is a textual tripwire over this bundle '
                        + 'only, not a proof that the bundle constructs no code at runtime.',
                    ).toEqual([]);
                });
            }

            if (ELECTRON_FREE_WORKER_BUNDLE_FILES.has(check.file)) {
                it('does not statically import Electron runtime APIs', async () => {
                    if (!existsSync(bundlePath)) {
                        throw new Error(`${check.file} not found — run "pnpm run build:electron"`);
                    }
                    const content = await readFile(bundlePath, 'utf-8');
                    expect(
                        STATIC_ELECTRON_IMPORT_PATTERN.test(content)
                        || CJS_ELECTRON_REQUIRE_PATTERN.test(content),
                        `${check.file} must not statically import "electron"; workers cannot rely on Electron main-process exports`,
                    ).toBe(false);
                });
            }
        });
    }

    // The allowlist exists only for idioms the dependencies actually ship. If a
    // dependency upgrade drops one, shrink the allowlist instead of leaving
    // standing permission behind.
    it('keeps every vendored runtime-code allowance load-bearing', async () => {
        const justifications = new Set<string>();

        for (const fileName of WORKER_BUNDLE_FILES) {
            const bundlePath = join(DIST_DIR, fileName);
            if (!existsSync(bundlePath)) {
                throw new Error(`${fileName} not found — run "pnpm run build:electron"`);
            }
            for (const justification of analyzeDynamicCodeConstruction(
                await readFile(bundlePath, 'utf-8'),
            ).allowedIdioms) {
                justifications.add(justification);
            }
        }

        expect([...justifications].sort()).toEqual([
            'core-js Node built-in module fallback',
            'core-js/whatwg globalThis polyfill',
        ]);
    });

    describe('split ESM main graph', () => {
        it('emits the main entry and every chunk in the dist-electron root', () => {
            expect(getDistOutputFile(mainBundleFixture.mainEntryOutput)).toBe('main.js');
            expect(mainBundleFixture.emittedOutputFiles).toContain('main.js');
            expect(
                mainBundleFixture.emittedOutputFiles.some(file => file.startsWith('main-chunk-')),
            ).toBe(true);
            expect(
                mainBundleFixture.emittedOutputFiles.every(file =>
                    file === 'main.js' || /^main-chunk-.+\.js$/u.test(file),
                ),
            ).toBe(true);
        });

        it('keeps every emitted main file present and fresh', async () => {
            for (const outputFile of mainBundleFixture.emittedOutputFiles) {
                const outputPath = join(DIST_DIR, outputFile);
                expect(existsSync(outputPath), `${outputFile} is missing`).toBe(true);
                expect(
                    (await stat(outputPath)).mtimeMs,
                    `${outputFile} appears stale compared to Electron sources`,
                ).toBeGreaterThanOrEqual(latestSourceMtimeMs);
            }
        });

        it('resolves every relative static and dynamic chunk import', () => {
            const chunkImportKinds = new Set<TMetafileImportKind>([
                'dynamic-import',
                'import-statement',
            ]);
            for (const [
                outputPath,
                output,
            ] of Object.entries(mainBundleFixture.outputs)) {
                for (const imported of output.imports) {
                    if (imported.external || !chunkImportKinds.has(imported.kind)) {
                        continue;
                    }
                    expect(
                        mainBundleFixture.outputs[imported.path],
                        `${outputPath} has an unresolved ${imported.kind} of ${imported.path}`,
                    ).toBeDefined();
                    expect(
                        existsSync(join(REPO_ROOT, imported.path)),
                        `${outputPath} imports a missing emitted file ${imported.path}`,
                    ).toBe(true);
                }
            }
        });

        it('retains updater implementations in the initial main closure', async () => {
            const initialBundleText = (await Promise.all(
                [...mainBundleFixture.initialMainOutputClosure]
                    .map(outputPath => readFile(join(REPO_ROOT, outputPath), 'utf8')),
            )).join('\n');
            for (const symbol of REQUIRED_INITIAL_MAIN_SYMBOLS) {
                expect(initialBundleText, `initial main closure is missing "${symbol}"`)
                    .toContain(symbol);
            }
        });

        it('defers assistant SDK, non-English locales, and legacy PDF.js', () => {
            const initialInputs = collectOutputInputs(
                mainBundleFixture.outputs,
                mainBundleFixture.initialMainOutputClosure,
            );
            const deferredOutputPaths = Object.keys(mainBundleFixture.outputs)
                .filter(outputPath => !mainBundleFixture.initialMainOutputClosure.has(outputPath));
            const deferredInputs = collectOutputInputs(
                mainBundleFixture.outputs,
                deferredOutputPaths,
            );

            for (const forbiddenInput of MAIN_FORBIDDEN_EAGER_INPUT_SUBSTRINGS) {
                expect(
                    [...initialInputs].some(inputPath => inputPath.includes(forbiddenInput)),
                    `initial main closure must not contain ${forbiddenInput}`,
                ).toBe(false);
                expect(
                    [...deferredInputs].some(inputPath => inputPath.includes(forbiddenInput)),
                    `deferred main outputs must retain ${forbiddenInput}`,
                ).toBe(true);
            }
        });
    });

    it('keeps heavyweight PDF and TIFF implementations out of preload', async () => {
        const metafilePath = join(DIST_DIR, PRELOAD_METAFILE);
        const metafile = JSON.parse(await readFile(metafilePath, 'utf8')) as {inputs?: Record<string, unknown>};
        const inputPaths = Object.keys(metafile.inputs ?? {})
            .map(inputPath => `/${inputPath.replaceAll('\\', '/')}`);

        for (const forbiddenInput of PRELOAD_FORBIDDEN_INPUT_SUBSTRINGS) {
            expect(
                inputPaths.some(inputPath => inputPath.includes(forbiddenInput)),
                `preload metafile must not contain ${forbiddenInput}`,
            ).toBe(false);
        }
    });
});
