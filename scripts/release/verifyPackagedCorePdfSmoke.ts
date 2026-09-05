import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
    mkdtemp,
    readFile,
    readdir,
    realpath,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {PDFDocument} from 'pdf-lib';
import puppeteer from 'puppeteer-core';
import type {Page} from 'puppeteer-core';
import type {IPageOpsMetadataSnapshot} from '@contracts/electronApiPageOps';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import {
    applyCombinedPdfPageLabels,
    inspectPdfCombineCatalog,
} from '@pdf-core/pdfCombineCatalog';
import {writePdfBookmarkOutlines} from '@pdf-core/writePdfBookmarkOutlines';
import {assertNoPackagedRendererFailures} from '@scripts/release/assertNoPackagedRendererFailures';
import {waitForPackagedCdpEndpoint} from '@scripts/release/waitForPackagedCdpEndpoint';
import {
    findFreePort,
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import {capturePackagedCorePdfFailureArtifacts} from '@tests/e2e/electron/helpers/capturePackagedCorePdfFailureArtifacts';
import {
    getActiveWorkspaceWorkingCopyPath,
    rotatePages,
} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    openAnnotationsTab,
    openPdfInApp,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {createCanonicalTextBoxWithPointer} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {installPageEvaluationShims} from '@tests/e2e/electron/helpers/pageRuntime';
import {getWorkspaceToolbarSnapshot} from '@tests/e2e/electron/helpers/workspaceExpose';
import {readPdfAnnotationSummary} from '@tests/e2e/electron/helpers/fixtures';

const STARTUP_TIMEOUT_MS = 75_000;
const OPERATION_TIMEOUT_MS = 45_000;
const SHUTDOWN_TIMEOUT_MS = 8_000;
type TConnectedBrowser = Awaited<ReturnType<typeof puppeteer.connect>>;

const PACKAGED_SMOKE_BOOKMARKS: IPdfBookmarkEntry[] = [
    {
        title: 'First page',
        pageIndex: 0,
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
    },
    {
        title: 'Second page',
        pageIndex: 1,
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
    },
];

const PACKAGED_SMOKE_METADATA: IPageOpsMetadataSnapshot = {
    pageLabels: null,
    pageLabelRanges: [
        {
            startPage: 1,
            style: 'r',
            prefix: 'front-',
            startNumber: 1,
        },
        {
            startPage: 2,
            style: 'D',
            prefix: 'body-',
            startNumber: 1,
        },
    ],
    bookmarks: PACKAGED_SMOKE_BOOKMARKS.map(bookmark => ({...bookmark})),
    untitledBookmarkLabel: 'Untitled',
};

function sha256(bytes: Uint8Array) {
    return createHash('sha256').update(bytes).digest('hex');
}

async function assertNoPageOperationResidue(workingCopyPath: string) {
    const directoryPath = path.dirname(workingCopyPath);
    const fileName = path.basename(workingCopyPath);
    const residue = (await readdir(directoryPath)).filter(name => (
        name.startsWith(`.${fileName}.evb-tmp-`)
        || name.startsWith(`.${fileName}.bak-`)
        || name.startsWith(`.${fileName}.`) && name.endsWith('.tmp')
        || name.startsWith(`${fileName}.evb-content-`) && name.endsWith('.bak')
        || name.startsWith(`${fileName}.evb-sidecar-`) && name.endsWith('.bak')
        || name === `${fileName}.evb-content-transition.json`
    ));
    if (residue.length > 0) {
        throw new Error(`Packaged smoke page operation left transaction residue: ${residue.join(', ')}`);
    }
}

function parseExecutablePath(args: string[]) {
    const index = args.indexOf('--executable');
    const executablePath = index >= 0 ? args[index + 1] : undefined;
    if (!executablePath) {
        throw new Error('Usage: verifyPackagedCorePdfSmoke.ts --executable <packaged-executable>');
    }
    return path.resolve(executablePath);
}

async function createFixturePdf(filePath: string) {
    const document = await PDFDocument.create();
    for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
        const page = document.addPage([
            612,
            792,
        ]);
        page.drawText(`Packaged smoke searchable text page ${pageNumber}`, {
            x: 72,
            y: 700,
            size: 18,
        });
    }
    applyCombinedPdfPageLabels(document, [
        {
            pageIndex: 0,
            style: 'r',
            prefix: 'front-',
            start: 1,
        },
        {
            pageIndex: 1,
            style: 'D',
            prefix: 'body-',
            start: 1,
        },
    ]);
    writePdfBookmarkOutlines(document, PACKAGED_SMOKE_BOOKMARKS.map(bookmark => ({...bookmark})));
    await writeFile(filePath, await document.save());
}

async function waitForSaveEnabled(page: Page) {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const snapshot = await getWorkspaceToolbarSnapshot(page);
        if (snapshot?.canSave === true && snapshot.isAnySaving !== true) {
            return;
        }
        await delay(100);
    }
    throw new Error('Packaged smoke Save action did not become enabled');
}

async function waitForSavedAnnotation(filePath: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    let summary = await readPdfAnnotationSummary(filePath);

    while (Date.now() < deadline) {
        if ((summary.bySubtype.FreeText ?? 0) > 0) {
            return summary;
        }
        await delay(150);
        summary = await readPdfAnnotationSummary(filePath);
    }

    throw new Error(`Packaged smoke annotation was not persisted to the source PDF: ${JSON.stringify(summary)}`);
}

async function waitForProcessExit(pid: number, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) {
            return true;
        }
        await delay(100);
    }
    return !isProcessAlive(pid);
}

async function closeBrowserGracefully(browser: TConnectedBrowser | null) {
    if (!browser) {
        return;
    }
    await Promise.race([
        browser.close().catch(() => {}),
        delay(SHUTDOWN_TIMEOUT_MS),
    ]);
}

async function run() {
    const executablePath = parseExecutablePath(process.argv.slice(2));
    const workDirectory = await mkdtemp(path.join(tmpdir(), 'evb-packaged-core-smoke-'));
    const fixturePath = path.join(workDirectory, 'packaged-core-smoke.pdf');
    const userDataPath = path.join(workDirectory, 'user-data');
    const cdpPort = await findFreePort();
    await createFixturePdf(fixturePath);

    const child = spawn(executablePath, [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataPath}`,
    ], {
        env: {
            ...process.env,
            EVB_ALLOW_MULTI_AUTOMATION_SESSIONS: '1',
            EVB_AUTOMATION_HIDE_WINDOW: '0',
            EVB_AUTOMATION_NO_FOCUS: '0',
            EVB_AUTOMATION_SESSION_NAME: 'packaged-core-pdf-smoke',
            EVB_AUTOMATION_USER_DATA_DIR: userDataPath,
            EVB_ENABLE_RENDERER_FILE_OPEN_HELPER: '1',
        },
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);

    let browser: TConnectedBrowser | null = null;
    try {
        const browserWSEndpoint = await waitForPackagedCdpEndpoint(
            cdpPort,
            STARTUP_TIMEOUT_MS,
            'Packaged Electron',
        );
        browser = await puppeteer.connect({
            browserWSEndpoint,
            defaultViewport: null,
            protocolTimeout: 420_000,
        });
        const pages = await browser.pages();
        const page = pages.find(candidate => candidate.url().startsWith('evb-viewer://app/'))
            ?? pages.find(candidate => !candidate.isClosed());
        if (!page) {
            throw new Error('Packaged Electron exposed no renderer page');
        }
        const rendererFailures: string[] = [];
        page.on('console', (message) => {
            const renderedMessage = `[packaged-renderer:${message.type()}] ${message.text()}`;
            if (message.type() === 'error') {
                rendererFailures.push(renderedMessage);
                console.error(renderedMessage);
            } else if (message.type() === 'warn') {
                console.warn(renderedMessage);
            }
        });
        page.on('pageerror', (error) => {
            const errorDetails = error instanceof Error
                ? error.stack ?? error.message
                : String(error);
            const renderedError = `[packaged-renderer:pageerror] ${errorDetails}`;
            rendererFailures.push(renderedError);
            console.error(renderedError);
        });

        await installPageEvaluationShims(page);
        await openPdfInApp(page, fixturePath, STARTUP_TIMEOUT_MS);
        await waitForPdfLoaded(page, STARTUP_TIMEOUT_MS);
        await waitForViewerInteractive(page, STARTUP_TIMEOUT_MS);

        await openAnnotationsTab(page, OPERATION_TIMEOUT_MS);
        const annotationText = `Packaged smoke annotation ${Date.now()}`;
        await createCanonicalTextBoxWithPointer(page, annotationText, {
            x: 0.4,
            y: 0.3,
        });
        await page.keyboard.press('Escape');
        await waitForSaveEnabled(page);
        await saveViaWindowHandle(page, OPERATION_TIMEOUT_MS);
        await waitForSavedAnnotation(fixturePath, OPERATION_TIMEOUT_MS);
        const originalHashBeforeRotation = sha256(await readFile(fixturePath));

        const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(page);
        const rotateResult = await rotatePages(
            page,
            workingCopyPath,
            [1],
            2,
            90,
            PACKAGED_SMOKE_METADATA,
        );
        if (!rotateResult.success) {
            throw new Error('Packaged smoke page rotation failed');
        }
        const rotatedDocument = await PDFDocument.load(await readFile(workingCopyPath), {updateMetadata: false});
        if (rotatedDocument.getPage(0).getRotation().angle !== 90) {
            throw new Error('Packaged smoke page rotation was not persisted to PDF bytes');
        }
        const rotatedCatalog = inspectPdfCombineCatalog(rotatedDocument);
        const expectedPageLabels = [
            {
                pageIndex: 0,
                style: 'r',
                prefix: 'front-',
            },
            {
                pageIndex: 1,
                style: 'D',
                prefix: 'body-',
            },
        ];
        if (JSON.stringify(rotatedCatalog.pageLabels) !== JSON.stringify(expectedPageLabels)) {
            throw new Error(`Packaged smoke page labels changed during rotation: ${JSON.stringify(rotatedCatalog.pageLabels)}`);
        }
        if (JSON.stringify(rotatedCatalog.bookmarks) !== JSON.stringify(PACKAGED_SMOKE_BOOKMARKS)) {
            throw new Error(`Packaged smoke bookmarks changed during rotation: ${JSON.stringify(rotatedCatalog.bookmarks)}`);
        }
        if (sha256(await readFile(fixturePath)) !== originalHashBeforeRotation) {
            throw new Error('Packaged smoke rotation changed the original PDF before Save');
        }
        await assertNoPageOperationResidue(workingCopyPath);

        const searchResult = await page.evaluate(async ({pdfPath}) => {
            const api = (window as Window & {electronAPI?: {search?: {run?: (
                pdfPath: string,
                query: string,
            ) => Promise<{results: unknown[]}>;};};}).electronAPI;
            if (!api?.search?.run) {
                throw new Error('electronAPI.search.run is unavailable');
            }
            return api.search.run(pdfPath, 'searchable text');
        }, {pdfPath: workingCopyPath});
        if (searchResult.results.length < 1) {
            throw new Error('Packaged smoke search returned no fixture matches');
        }

        // Give errors queued by the final renderer operation a chance to reach
        // CDP before deciding that the packaged journey passed.
        await delay(250);
        assertNoPackagedRendererFailures(rendererFailures);

        console.log('Packaged core-PDF smoke passed: open, annotation save, metadata-preserving rotate, source isolation, and search.');
    } catch (error) {
        await capturePackagedCorePdfFailureArtifacts(browser, error);
        throw error;
    } finally {
        await closeBrowserGracefully(browser);
        if (typeof child.pid === 'number') {
            await waitForProcessExit(child.pid, 5_000);
        }
        await browser?.disconnect().catch(() => {});
        if (typeof child.pid === 'number') {
            if (isProcessAlive(child.pid)) {
                await killProcessTree(child.pid, 3_000);
            }
        } else if (child.exitCode === null) {
            child.kill('SIGKILL');
        }
        try {
            await rm(workDirectory, {
                force: true,
                maxRetries: 10,
                recursive: true,
                retryDelay: 200,
            });
        } catch (error) {
            console.warn(`Packaged smoke cleanup left temporary files at ${workDirectory}:`, error);
        }
    }
}

const canonicalEntryPath = process.argv[1] === undefined
    ? null
    : await realpath(path.resolve(process.argv[1])).catch(() => null);
const canonicalModulePath = await realpath(fileURLToPath(import.meta.url));
const isDirectInvocation = canonicalEntryPath !== null
    && canonicalEntryPath === canonicalModulePath;

if (isDirectInvocation) {
    await run();
}
