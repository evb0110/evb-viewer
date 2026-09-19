import {createHash} from 'node:crypto';
import {
    existsSync,
    realpathSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import {
    basename,
    dirname,
    join,
} from 'node:path';
import {tmpdir} from 'node:os';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import type {IWorkingCopyBackingStatus} from '@contracts/electronApiDocuments';
import type {TLeaseId} from '@contracts/shared';
import {
    requirePageNumber,
    type TPageNumber,
} from '@contracts/pageNumbers';
import {
    readExactPdfFixtureIdentity,
    validateExactPdfFixtureIdentity,
} from '@scripts/ci/stageExactPdfFixture';
import {
    collectDescendantPidsUnix,
    isProcessAlive,
} from '@scripts/electron-run/electronRunProcessTree';
import {inspectProcessIdentity} from '@scripts/electron-run/electronRunProcessIdentity';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import {readPdfAnnotationSummary} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openPdfInApp,
    scrollViewerToPage,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    readWorkspaceStateValues,
    requireWorkspaceCommand,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';

const ISSUE_124_ENABLE_ENV = 'EVB_E2E_ISSUE_124_ACCEPTANCE';
const ISSUE_124_FIXTURE_ENV = 'EVB_E2E_ISSUE_124_FIXTURE';
const ISSUE_124_TEST_TIMEOUT_MS = 15 * 60_000;
const MATERIALIZATION_TIMEOUT_MS = 90_000;
const QPDF_TIMEOUT_MS = 120_000;
const ISSUE_124_EXACT_PAGE_COUNT = 882;
const ISSUE_124_SELECTED_PAGE_COUNT = ISSUE_124_EXACT_PAGE_COUNT - 1;
const ISSUE_124_EXACT_FIXTURE_IDENTITY = {
    bytes: 722_178_517,
    pages: ISSUE_124_EXACT_PAGE_COUNT,
    sha256: '1660bced91f628b9acbb2fc0f9dac29fe783a3f43d26231d8f3b0c73133b21b6',
};
const IMAGE_PLACEMENT_PAGE_NUMBER = 31;
const ACTIVE_IMAGE_PLACEMENT_SELECTOR = '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .pdf-image-placement';
const PLACED_IMAGE_JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAoAEADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAcI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Al7UCSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//Z',
    'base64',
);
const issue124Enabled = process.env[ISSUE_124_ENABLE_ENV] === '1';

interface IIssue124StatusWindow extends IE2EWindow {
    __issue124ClipboardReadCount?: number;
    __issue124ConsoleWarnInstalled?: boolean;
    __issue124DisposeWorkingCopyStatus?: () => void;
    __issue124Warnings?: string[];
    __issue124WorkingCopyStatuses?: IWorkingCopyBackingStatus[];
}

interface ISelectedQpdfProcess {
    argsPath: string;
    command: string;
    qpdfOutputDir: string;
    outputPath: string;
    pid: number;
    tempRoot: string;
}

interface ISelectedQpdfHoldMarker {
    argsPath: string;
    pid: number;
}

const issue124Describe = issue124Enabled ? describe : describe.skip;

function hashFile(path: string) {
    return createHash('sha256')
        .update(readFileSync(path))
        .digest('hex');
}

function listMaterializationTemps(workingCopyPath: string) {
    const directory = dirname(workingCopyPath);
    const prefix = `${workingCopyPath}.materializing-`;
    return readdirSync(directory)
        .filter(entry => join(directory, entry).startsWith(prefix))
        .map(entry => join(directory, entry));
}

async function assertExactIssue124Fixture(path: string) {
    const identity = await readExactPdfFixtureIdentity(path);
    validateExactPdfFixtureIdentity(identity, ISSUE_124_EXACT_FIXTURE_IDENTITY);
    return identity;
}

async function installWorkingCopyStatusProbe(page: Page) {
    const installed = await page.evaluate(() => {
        const target = window as IIssue124StatusWindow;
        const files = target.electronAPI?.documentFiles;
        if (!files?.onWorkingCopyBackingStatusChanged) {
            return false;
        }

        target.__issue124DisposeWorkingCopyStatus?.();
        const statuses: IWorkingCopyBackingStatus[] = [];
        target.__issue124WorkingCopyStatuses = statuses;
        target.__issue124DisposeWorkingCopyStatus = files.onWorkingCopyBackingStatusChanged((status) => {
            statuses.push(status);
        });
        return true;
    });
    expect(installed).toBe(true);
}

async function waitForMaterializationStart(page: Page, workingCopyPath: TDocumentRef) {
    await expect.poll(async () => page.evaluate(async (path: TDocumentRef) => {
        const target = window as IIssue124StatusWindow;
        const statuses = target.__issue124WorkingCopyStatuses ?? [];
        const latest = statuses.filter(status => status.documentRef === path).at(-1);
        if (latest?.state === 'materializing') {
            return latest.state;
        }

        // The event pump can coalesce the first progress event while the IPC
        // request is crossing the renderer boundary. Query the same backing
        // status directly so the test does not mistake a missed notification
        // for a missing materialization flight.
        const current = await target.electronAPI?.documentFiles.getWorkingCopyBackingStatus?.(path);
        return current?.state ?? latest?.state ?? null;
    }, workingCopyPath), {
        interval: 25,
        timeout: MATERIALIZATION_TIMEOUT_MS,
    }).toBe('materializing');
}

async function crashSessionRenderers(sessionName: string) {
    const rendererPids = sessionProcessPids(sessionName).filter((pid) => {
        const snapshot = inspectProcessIdentity(pid);
        const command = snapshot?.command ?? '';
        return command.includes('Electron Helper (Renderer)') || command.includes('--type=renderer');
    });
    expect(rendererPids.length).toBeGreaterThan(0);
    for (const pid of rendererPids) {
        process.kill(pid, 'SIGKILL');
    }
    await expect.poll(
        () => rendererPids.every(pid => !isProcessAlive(pid)),
        {
            interval: 25,
            timeout: 10_000,
        },
    ).toBe(true);
}

function sessionProcessPids(sessionName: string) {
    const info = getSessionInfo(sessionName);
    if (!info) {
        return [];
    }
    const roots = [
        info.pid,
        ...(info.electronPid ? [info.electronPid] : []),
    ];
    return [...new Set(roots.flatMap(pid => [
        pid,
        ...collectDescendantPidsUnix(pid),
    ]))];
}

function parseQpdfArgsPath(command: string) {
    const match = /(?:^|\s)@(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(command);
    return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function readSelectedQpdfProcess(
    markerPath: string,
    expectedInputPath: string,
): ISelectedQpdfProcess | null {
    if (!existsSync(markerPath)) {
        return null;
    }
    let marker: ISelectedQpdfHoldMarker;
    try {
        marker = JSON.parse(readFileSync(markerPath, 'utf8')) as ISelectedQpdfHoldMarker;
    } catch {
        return null;
    }
    if (!Number.isInteger(marker.pid) || marker.pid <= 0 || !existsSync(marker.argsPath)) {
        return null;
    }
    let snapshot: ReturnType<typeof inspectProcessIdentity>;
    try {
        snapshot = inspectProcessIdentity(marker.pid);
    } catch {
        return null;
    }
    if (
        !snapshot
        || !/(?:^|[\\/])qpdf(?:\.exe)?(?:\s|$)/iu.test(snapshot.command)
        || parseQpdfArgsPath(snapshot.command) !== marker.argsPath
    ) {
        return null;
    }
    let args: string;
    try {
        args = readFileSync(marker.argsPath, 'utf8');
    } catch {
        return null;
    }
    const argLines = args.split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
    const outputPath = argLines.at(-1);
    const qpdfInputPath = argLines[0];
    if (
        !args.includes('--pages')
        || !qpdfInputPath
        || (() => {
            try {
                return realpathSync(qpdfInputPath) !== realpathSync(expectedInputPath);
            } catch {
                return true;
            }
        })()
        || !outputPath?.toLowerCase().endsWith('.pdf')
        || !basename(dirname(outputPath)).startsWith('qpdfOutput-')
    ) {
        return null;
    }
    return {
        argsPath: marker.argsPath,
        command: snapshot.command,
        qpdfOutputDir: dirname(outputPath),
        outputPath,
        pid: marker.pid,
        tempRoot: dirname(dirname(marker.argsPath)),
    };
}

function listPrintPageArtifacts(tempRoot: string) {
    return readdirSync(tempRoot)
        .filter(entry => entry.startsWith('print-pages-'))
        .sort();
}

function listTransientPrintOutputs(tempRoot: string) {
    return readdirSync(tempRoot)
        .filter(entry => /^(?:print-pages-.*|qpdfOutput-.*|tmp-[a-f0-9-]+\.pdf)$/u.test(entry))
        .sort();
}

async function waitForSelectedQpdfProcess(markerPath: string, expectedInputPath: string) {
    let selected: ISelectedQpdfProcess | undefined;
    await expect.poll(() => {
        const candidate = readSelectedQpdfProcess(markerPath, expectedInputPath);
        selected = candidate ?? undefined;
        return candidate !== null;
    }, {
        interval: 10,
        timeout: QPDF_TIMEOUT_MS,
    }).toBe(true);
    if (selected === undefined) {
        throw new Error('Selected-page qpdf process disappeared before it could be observed');
    }
    return selected;
}

async function installManagedJpegClipboard(page: Page, imagePath: string) {
    const imageRef = requireDocumentRef(imagePath);
    const probe = await page.evaluate(async (path: TDocumentRef) => {
        const target = window as IIssue124StatusWindow;
        const files = target.electronAPI?.documentFiles;
        if (!files?.createManagedTempFileHandle) {
            throw new Error('Managed image handles are unavailable');
        }
        target.__issue124ClipboardReadCount = 0;
        target.__issue124Warnings = [];
        if (!target.__issue124ConsoleWarnInstalled) {
            const originalWarn = console.warn.bind(console);
            console.warn = (...args: unknown[]) => {
                target.__issue124Warnings?.push(args.map(value => (
                    String(value)
                )).join(' '));
                originalWarn(...args);
            };
            target.__issue124ConsoleWarnInstalled = true;
        }
        const handle = await files.createManagedTempFileHandle(path);
        const NativeFile = window.File;
        const ManagedFile = new Proxy(NativeFile, {construct(target, args) {
            return Object.assign(Reflect.construct(target, args), {nativeSourceHandle: handle});
        }});
        Object.defineProperty(window, 'File', {
            configurable: true,
            value: ManagedFile,
        });
        const bytes = await files.readFile(path);
        const blob = new Blob([bytes as BlobPart], {type: 'image/jpeg'});
        const probeFile = new ManagedFile([blob], 'clipboard-probe.jpg', {type: 'image/jpeg'});
        const bitmap = await createImageBitmap(probeFile);
        const dimensions = {
            height: bitmap.height,
            width: bitmap.width,
        };
        bitmap.close();
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {read: async () => {
                target.__issue124ClipboardReadCount = (target.__issue124ClipboardReadCount ?? 0) + 1;
                return [{
                    types: ['image/jpeg'],
                    getType: async () => blob,
                }];
            }},
        });
        return {
            dimensions,
            hasNativeSourceHandle: 'nativeSourceHandle' in probeFile,
            leaseId: handle.leaseId,
        };
    }, imageRef);
    expect(probe.dimensions).toEqual({
        height: 40,
        width: 64,
    });
    expect(probe.hasNativeSourceHandle).toBe(true);
    return probe.leaseId;
}

async function waitForImagePlacementTargetPage(page: Page, pageNumber = 1) {
    await page.waitForFunction((targetPage: number) => {
        const element = document.querySelector<HTMLElement>(
            `.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer .page_container[data-page="${targetPage}"]`,
        );
        const rect = element?.getBoundingClientRect();
        return Boolean(rect && rect.width > 100 && rect.height > 100);
    }, {timeout: 30_000}, pageNumber);
}

async function waitForImagePlacement(page: Page) {
    try {
        await page.waitForSelector(ACTIVE_IMAGE_PLACEMENT_SELECTOR, {
            timeout: 30_000,
            visible: true,
        });
    } catch (error) {
        const diagnostic = await page.evaluate((selector: string) => {
            const target = window as IIssue124StatusWindow;
            return {
                clipboardReadCount: target.__issue124ClipboardReadCount ?? 0,
                placementCount: document.querySelectorAll(selector).length,
                warnings: target.__issue124Warnings ?? [],
            };
        }, ACTIVE_IMAGE_PLACEMENT_SELECTOR);
        throw new Error(`Image placement did not appear: ${JSON.stringify(diagnostic)}`, {cause: error});
    }
}

async function waitForImagePlacementReady(page: Page) {
    await page.waitForFunction((selector: string) => {
        const button = document.querySelector<HTMLButtonElement>(`${selector} .pdf-image-placement__action--primary`);
        return button !== null && !button.disabled;
    }, {timeout: 60_000}, ACTIVE_IMAGE_PLACEMENT_SELECTOR);
}

async function releaseManagedHandle(page: Page, leaseId: TLeaseId) {
    return page.evaluate(async (id: TLeaseId) => {
        const release = (window as IIssue124StatusWindow).electronAPI?.documentFiles.releaseManagedTempFileHandle;
        return release ? release(id) : false;
    }, leaseId);
}

issue124Describe('Electron E2E - issue 124 lifecycle acceptance', () => {
    describe('SAV-015 lazy materialization owner teardown', () => {
        const configuredFixture = process.env[ISSUE_124_FIXTURE_ENV]?.trim() ?? '';
        const sessionFixture = createElectronE2ESessionFixture({
            sessionName: () => `e2e-issue-124-lazy-materialization-${Date.now()}`,
            timeoutMs: ISSUE_124_TEST_TIMEOUT_MS,
            extraEnv: {
                EVB_PDF_PAGE_OPS_ENABLE: '1',
                EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT: 'unsupported',
                EVB_WORKING_COPY_MATERIALIZATION_MODE: 'lazy',
            },
        });

        it('cancels lazy materialization when the renderer crashes during the copy', async () => {
            if (!configuredFixture || !existsSync(configuredFixture)) {
                throw new Error(`Set ${ISSUE_124_FIXTURE_ENV} to the exact large PDF fixture for SAV-015`);
            }
            const sourceIdentity = await assertExactIssue124Fixture(configuredFixture);
            const session = sessionFixture.getSession();
            const sourcePath = configuredFixture;
            const sourceBefore = statSync(sourcePath);
            await openPdfInApp(session.page, sourcePath, ISSUE_124_TEST_TIMEOUT_MS);
            await waitForPdfLoaded(session.page, ISSUE_124_TEST_TIMEOUT_MS);
            await waitForViewerInteractive(session.page, ISSUE_124_TEST_TIMEOUT_MS);
            const state = await readWorkspaceStateValues<{workingCopyPath?: string | null}>(session.page, ['workingCopyPath']);
            if (typeof state.workingCopyPath !== 'string') {
                throw new Error(`Issue 124 lazy materialization has no working copy: ${JSON.stringify(state)}`);
            }
            const workingCopyPath = requireDocumentRef(state.workingCopyPath);
            expect(existsSync(workingCopyPath)).toBe(false);
            const initialStatus = await session.page.evaluate((path: TDocumentRef) => (
                (window as IE2EWindow).electronAPI?.documentFiles.getWorkingCopyBackingStatus?.(path) ?? null
            ), workingCopyPath);
            expect(initialStatus?.state).toBe('lazy-original');
            await installWorkingCopyStatusProbe(session.page);

            const pageNumbers: TPageNumber[] = [requirePageNumber(1)];
            const pendingPrint = session.page.evaluate(async ({
                path,
                pageNumbers,
            }: {
                path: TDocumentRef;
                pageNumbers: TPageNumber[];
            }) => {
                const printPdfPath = (window as IE2EWindow).electronAPI?.documentPdf.printPdfPath;
                if (!printPdfPath) {
                    throw new Error('Issue 124 lazy-materialization print bridge is unavailable');
                }
                return printPdfPath(path, 'issue-124-lazy.pdf', {
                    pageNumbers,
                    viewMode: 'single',
                    orientation: 'auto',
                });
            }, {
                path: workingCopyPath,
                pageNumbers,
            });
            // Puppeteer cannot deliver a result from a renderer after that
            // renderer has been killed. Main-operation unit coverage asserts
            // the typed settlement; this journey observes the externally
            // durable cleanup instead.
            void pendingPrint.catch(() => undefined);
            await waitForMaterializationStart(session.page, workingCopyPath);
            await crashSessionRenderers(session.name);
            await expect.poll(() => listMaterializationTemps(workingCopyPath), {timeout: MATERIALIZATION_TIMEOUT_MS}).toHaveLength(0);
            expect(existsSync(workingCopyPath)).toBe(false);
            const sourceAfter = statSync(sourcePath);
            expect({
                mtimeMs: sourceAfter.mtimeMs,
                size: sourceAfter.size,
            }).toEqual({
                mtimeMs: sourceBefore.mtimeMs,
                size: sourceIdentity.bytes,
            });
            expect(hashFile(sourcePath)).toBe(sourceIdentity.sha256);
        }, ISSUE_124_TEST_TIMEOUT_MS);
    });

    describe('SAV-017 native image placement failure and retry', () => {
        const configuredFixture = process.env[ISSUE_124_FIXTURE_ENV]?.trim() ?? '';
        const sessionFixture = createElectronE2ESessionFixture({
            sessionName: () => `e2e-issue-124-image-placement-${Date.now()}`,
            timeoutMs: ISSUE_124_TEST_TIMEOUT_MS,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
        });

        it('releases canceled and failed native placements before a fresh retry', async () => {
            if (!configuredFixture || !existsSync(configuredFixture)) {
                throw new Error(`Set ${ISSUE_124_FIXTURE_ENV} to the exact large PDF fixture for SAV-017`);
            }
            await assertExactIssue124Fixture(configuredFixture);
            const session = sessionFixture.getSession();
            await openPdfInApp(session.page, configuredFixture, ISSUE_124_TEST_TIMEOUT_MS);
            await waitForPdfLoaded(session.page, ISSUE_124_TEST_TIMEOUT_MS);
            await waitForViewerInteractive(session.page, ISSUE_124_TEST_TIMEOUT_MS);
            const state = await readWorkspaceStateValues<{workingCopyPath?: string | null}>(session.page, ['workingCopyPath']);
            if (typeof state.workingCopyPath !== 'string') {
                throw new Error('Issue 124 image-placement working copy is unavailable');
            }
            const workingCopyPath = state.workingCopyPath;
            const imagePath = join(dirname(workingCopyPath), `issue-124-image-${process.pid}.jpg`);
            writeFileSync(imagePath, PLACED_IMAGE_JPEG);
            onTestFinished(() => rmSync(imagePath, {force: true}));

            await scrollViewerToPage(session.page, IMAGE_PLACEMENT_PAGE_NUMBER);
            await waitForImagePlacementTargetPage(session.page, IMAGE_PLACEMENT_PAGE_NUMBER);
            const before = await readPdfAnnotationSummary(workingCopyPath);
            const firstLeaseId = await installManagedJpegClipboard(session.page, imagePath);
            await requireWorkspaceCommand(session.page, 'handlePasteImageFromClipboard');
            await waitForImagePlacement(session.page);
            await session.page.click(`${ACTIVE_IMAGE_PLACEMENT_SELECTOR} .pdf-image-placement__action--secondary`);
            await session.page.waitForSelector(ACTIVE_IMAGE_PLACEMENT_SELECTOR, {
                hidden: true,
                timeout: 30_000,
            });
            expect(await releaseManagedHandle(session.page, firstLeaseId)).toBe(false);
            const afterCancel = await readPdfAnnotationSummary(workingCopyPath);
            expect(afterCancel).toEqual(before);

            await scrollViewerToPage(session.page, IMAGE_PLACEMENT_PAGE_NUMBER);
            await waitForImagePlacementTargetPage(session.page, IMAGE_PLACEMENT_PAGE_NUMBER);
            const secondLeaseId = await installManagedJpegClipboard(session.page, imagePath);
            await requireWorkspaceCommand(session.page, 'handlePasteImageFromClipboard');
            await waitForImagePlacement(session.page);
            rmSync(imagePath);
            await waitForImagePlacementReady(session.page);
            const placementBusy = session.page.waitForFunction((selector: string) => (
                document.querySelector<HTMLButtonElement>(`${selector} .pdf-image-placement__action--primary`)?.disabled === true
            ), {timeout: 30_000}, ACTIVE_IMAGE_PLACEMENT_SELECTOR);
            await session.page.click(`${ACTIVE_IMAGE_PLACEMENT_SELECTOR} .pdf-image-placement__action--primary`);
            await placementBusy;
            await waitForImagePlacementReady(session.page);
            const afterFailure = await readPdfAnnotationSummary(workingCopyPath);
            expect(afterFailure).toEqual(afterCancel);
            expect(await releaseManagedHandle(session.page, secondLeaseId)).toBe(false);

            writeFileSync(imagePath, PLACED_IMAGE_JPEG);
            await scrollViewerToPage(session.page, IMAGE_PLACEMENT_PAGE_NUMBER);
            await waitForImagePlacementTargetPage(session.page, IMAGE_PLACEMENT_PAGE_NUMBER);
            const thirdLeaseId = await installManagedJpegClipboard(session.page, imagePath);
            await requireWorkspaceCommand(session.page, 'handlePasteImageFromClipboard');
            await waitForImagePlacement(session.page);
            await waitForImagePlacementReady(session.page);
            await session.page.click(`${ACTIVE_IMAGE_PLACEMENT_SELECTOR} .pdf-image-placement__action--primary`);
            await session.page.waitForSelector(ACTIVE_IMAGE_PLACEMENT_SELECTOR, {
                hidden: true,
                timeout: 60_000,
            });
            const afterRetry = await readPdfAnnotationSummary(workingCopyPath);
            expect(afterRetry.bySubtype.Stamp ?? 0).toBe((before.bySubtype.Stamp ?? 0) + 1);
            expect(await releaseManagedHandle(session.page, thirdLeaseId)).toBe(false);
        }, ISSUE_124_TEST_TIMEOUT_MS);
    });

    describe('SAV-018 selected-page qpdf cancellation', () => {
        const configuredFixture = process.env[ISSUE_124_FIXTURE_ENV]?.trim() ?? '';
        const qpdfHoldMarkerPath = join(
            tmpdir(),
            `evb-issue-124-qpdf-hold-${String(process.pid)}-${String(Date.now())}.json`,
        );
        const sessionFixture = createElectronE2ESessionFixture({
            sessionName: () => `e2e-issue-124-qpdf-cancel-${Date.now()}`,
            timeoutMs: ISSUE_124_TEST_TIMEOUT_MS,
            extraEnv: {
                EVB_E2E_HOLD_SELECTED_PAGE_QPDF_MARKER: qpdfHoldMarkerPath,
                EVB_PDF_PAGE_OPS_ENABLE: '1',
            },
        });

        it('stops the real selected-page qpdf child and removes its temporary output', async () => {
            if (!configuredFixture || !existsSync(configuredFixture)) {
                throw new Error(`Set ${ISSUE_124_FIXTURE_ENV} to the exact large PDF fixture for SAV-018`);
            }
            const session = sessionFixture.getSession();
            rmSync(qpdfHoldMarkerPath, {force: true});
            onTestFinished(() => rmSync(qpdfHoldMarkerPath, {force: true}));
            const sourceIdentity = await assertExactIssue124Fixture(configuredFixture);
            const sourceBeforeHash = sourceIdentity.sha256;
            await openPdfInApp(session.page, configuredFixture, ISSUE_124_TEST_TIMEOUT_MS);
            await waitForPdfLoaded(session.page, ISSUE_124_TEST_TIMEOUT_MS);
            await waitForViewerInteractive(session.page, ISSUE_124_TEST_TIMEOUT_MS);
            const state = await readWorkspaceStateValues<{workingCopyPath?: string | null}>(session.page, ['workingCopyPath']);
            if (typeof state.workingCopyPath !== 'string') {
                throw new Error('Issue 124 qpdf-cancellation working copy is unavailable');
            }
            const workingCopyPath = requireDocumentRef(state.workingCopyPath);
            const pendingPrint = session.page.evaluate(async ({
                pageNumbers,
                path,
            }: {
                pageNumbers: Array<ReturnType<typeof requirePageNumber>>;
                path: TDocumentRef
            }) => {
                const printPdfPath = (window as IE2EWindow).electronAPI?.documentPdf.printPdfPath;
                if (!printPdfPath) {
                    throw new Error('Issue 124 qpdf-cancellation print bridge is unavailable');
                }
                return printPdfPath(path, 'issue-124-selected.pdf', {
                    pageNumbers,
                    viewMode: 'single',
                    orientation: 'auto',
                });
            }, {
                pageNumbers: Array.from({length: ISSUE_124_SELECTED_PAGE_COUNT}, (_, index) => requirePageNumber(index + 1)),
                path: workingCopyPath,
            });
            // The sender is intentionally destroyed below, so its Puppeteer
            // evaluation promise cannot report the main-side cancellation.
            void pendingPrint.catch(() => undefined);
            const qpdf = await waitForSelectedQpdfProcess(qpdfHoldMarkerPath, workingCopyPath);
            onTestFinished(() => {
                if (!isProcessAlive(qpdf.pid)) {
                    return;
                }
                try {
                    process.kill(qpdf.pid, 'SIGKILL');
                } catch {
                    // The cancellation path may have reaped the child already.
                }
            });
            const printArtifactsBefore = listPrintPageArtifacts(qpdf.tempRoot);
            const transientOutputsBefore = listTransientPrintOutputs(qpdf.tempRoot);
            await crashSessionRenderers(session.name);
            await expect.poll(() => isProcessAlive(qpdf.pid), {timeout: MATERIALIZATION_TIMEOUT_MS}).toBe(false);
            await expect.poll(() => existsSync(qpdf.argsPath), {timeout: MATERIALIZATION_TIMEOUT_MS}).toBe(false);
            await expect.poll(() => {
                if (existsSync(qpdf.outputPath) || existsSync(qpdf.qpdfOutputDir)) {
                    return false;
                }
                if (listPrintPageArtifacts(qpdf.tempRoot).length !== printArtifactsBefore.length) {
                    return false;
                }
                return JSON.stringify(listTransientPrintOutputs(qpdf.tempRoot)) === JSON.stringify(
                    transientOutputsBefore.filter(entry => join(qpdf.tempRoot, entry) !== qpdf.qpdfOutputDir),
                );
            }, {timeout: MATERIALIZATION_TIMEOUT_MS}).toBe(true);
            expect(existsSync(qpdf.outputPath)).toBe(false);
            expect(existsSync(qpdf.qpdfOutputDir)).toBe(false);
            expect(listPrintPageArtifacts(qpdf.tempRoot)).toEqual(printArtifactsBefore);
            expect(listTransientPrintOutputs(qpdf.tempRoot)).toEqual(
                transientOutputsBefore.filter(entry => join(qpdf.tempRoot, entry) !== qpdf.qpdfOutputDir),
            );
            expect(hashFile(configuredFixture)).toBe(sourceBeforeHash);
            expect(existsSync(workingCopyPath)).toBe(true);
            expect(hashFile(workingCopyPath)).toBe(sourceIdentity.sha256);
        }, ISSUE_124_TEST_TIMEOUT_MS);
    });
});
