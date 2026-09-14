import {
    mkdtemp,
    open,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    PDFDocument,
    StandardFonts,
} from 'pdf-lib';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { isWindowsTestCaseResult } from '@scripts/windows-test/contracts/windowsTestContracts';
import { formatPageMarker } from '@scripts/windows-test/fixtures/fixtureDocumentBuilders';
import { generateFontsFixture } from '@scripts/windows-test/fixtures/generateFontsFixture';
import { generateMetadataFixture } from '@scripts/windows-test/fixtures/generateMetadataFixture';
import {
    guestLayoutForRoot,
    guestRunPaths,
    joinGuestPath,
    type IGuestRunPaths,
} from '@scripts/windows-test/guest/guestPaths';
import {
    createNodeGuestFileSystem,
    type IGuestCommandResult,
    type IGuestFileSystem,
} from '@scripts/windows-test/guest/guestRuntime';
import type { IGuestPowerShellRunner } from '@scripts/windows-test/guest/guestPowerShell';
import {
    createNativeUiActionLog,
    SelectorNotFoundError,
    type INativeUiAdapter,
    type IUiElementRef,
    type IUiSelector,
    type IUiWindowQuery,
} from '@scripts/windows-test/guest/native-ui/nativeUiAdapter';
import {
    loadSelectorRecords,
    requireControlSelector,
    requireWindowQuery,
} from '@scripts/windows-test/guest/native-ui/selectorRecords';
import {
    viewerDefaultTimeouts,
    type IViewerDriver,
    type IViewerFactory,
    type IViewerOperationOutcome,
} from '@scripts/windows-test/guest/viewer/viewerDriver';
import {
    CaseCanceledError,
    runRegisteredCase,
    type ICaseEnvironment,
} from '@scripts/windows-test/guest/cases/caseContext';
import {
    requireCaseDefinition,
    windowsTestCaseDefinitions,
} from '@scripts/windows-test/guest/cases/caseRegistry';
import {
    fontsFixtureId,
    metadataFixtureId,
    numberedFixtureId,
    numberedFixturePackId,
    revisionSidecarSuffix,
} from '@scripts/windows-test/guest/cases/caseSupport';
import { nativeDialogRecordIds } from '@scripts/windows-test/guest/cases/nativeDialogs';

const runId = '20260904T120000Z-0123456789ab';

const fixturePageCount = 12;

const pngBytes = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
]);

const dialogControlRecordIds: Record<string, readonly string[]> = {
    [nativeDialogRecordIds.viewerWindow]: [],
    [nativeDialogRecordIds.fileDialog]: [
        nativeDialogRecordIds.fileNameEdit,
        nativeDialogRecordIds.commitButton,
        nativeDialogRecordIds.cancelButton,
        nativeDialogRecordIds.fileTypeCombo,
    ],
    [nativeDialogRecordIds.printOutputDialog]: [
        nativeDialogRecordIds.fileNameEdit,
        nativeDialogRecordIds.commitButton,
        nativeDialogRecordIds.cancelButton,
        nativeDialogRecordIds.fileTypeCombo,
    ],
    [nativeDialogRecordIds.overwriteWindow]: [nativeDialogRecordIds.overwriteNoButton],
    [nativeDialogRecordIds.printDialog]: [
        nativeDialogRecordIds.printerList,
        nativeDialogRecordIds.printToPdfEntry,
        nativeDialogRecordIds.printButton,
        nativeDialogRecordIds.cancelPrintButton,
    ],
};

type TFakeWindowMode =
    | 'main'
    | 'open'
    | 'save-as'
    | 'print'
    | 'print-output'
    | 'overwrite';

interface IFakeWindow {
    handle: string;
    recordId: string;
    mode: TFakeWindowMode;
    processId: number;
    sessionId: number;
    pendingPath: string;
    selectedPrinter: string | null;
}

interface IFakeSession {
    id: number;
    processId: number;
    documentPath: string;
    workingCopyPath: string;
    instrumented: boolean;
    pages: number[];
    revision: number;
    annotations: string[];
    preparingPrint: boolean;
}

interface IFakePrintJob {
    id: number;
    documentName: string;
    printerName: string;
    status: string;
    submittedTime: string | null;
}

interface IFakeWorldOptions {
    root: string;
    saveErrorCode?: string | null;
    suppressDialogs?: boolean;
    cancelAfterCheckpoints?: number | null;
}

interface IFakeWorld {
    environment: ICaseEnvironment;
    paths: IGuestRunPaths;
    fs: IGuestFileSystem;
    printJobsIssued(): number;
    openWindowCount(): number;
}

function sameShape(left: unknown, right: unknown) {
    return JSON.stringify(left) === JSON.stringify(right);
}

async function writeNumberedPdf(fs: IGuestFileSystem, filePath: string, markers: readonly number[]) {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (const marker of markers) {
        const page = document.addPage([
            300,
            400,
        ]);
        page.drawText(formatPageMarker(numberedFixturePackId, marker), {
            x: 20,
            y: 200,
            size: 12,
            font,
        });
    }
    await fs.writeBytes(filePath, await document.save());
}

async function writeSparseMatrixPdf(filePath: string, bytes: number) {
    const handle = await open(filePath, 'w+');
    try {
        await handle.truncate(bytes);
        await handle.write('%PDF-1.7\n', 0, 'ascii');
        await handle.write('%%EOF\n', bytes - 6, 'ascii');
    } finally {
        await handle.close();
    }
}

async function pdfPageCount(fs: IGuestFileSystem, filePath: string) {
    const document = await PDFDocument.load(await fs.readBytes(filePath), { ignoreEncryption: true });
    return document.getPageCount();
}

function namedArgument(args: readonly string[], name: string) {
    const index = args.indexOf(name);
    const value = index < 0 ? undefined : args[index + 1];
    if (value === undefined) {
        throw new Error(`The fake PowerShell runner needs a ${name} argument`);
    }
    return value;
}

async function createFakeWorld({
    root,
    saveErrorCode = null,
    suppressDialogs = false,
    cancelAfterCheckpoints = null,
}: IFakeWorldOptions): Promise<IFakeWorld> {
    const fs = createNodeGuestFileSystem();
    const layout = guestLayoutForRoot(root, '/');
    const paths = guestRunPaths(layout, runId);
    const selectors = loadSelectorRecords();
    const installDirectory = joinGuestPath('/', root, 'app');
    const fixtureDirectory = joinGuestPath('/', paths.stagingDir, 'fixtures');
    const fixtureFile = joinGuestPath('/', fixtureDirectory, `${numberedFixtureId}.pdf`);
    const metadataFixtureFile = joinGuestPath('/', fixtureDirectory, `${metadataFixtureId}.pdf`);
    const fontsFixtureFile = joinGuestPath('/', fixtureDirectory, `${fontsFixtureId}.pdf`);
    const documentMarkers = new Map<string, number[]>();
    const windows: IFakeWindow[] = [];
    const sessions = new Map<number, IFakeSession>();
    const blockedPaths = new Set<string>();
    const holdReleases = new Map<string, (result: IGuestCommandResult) => void>();
    const printJobs: IFakePrintJob[] = [];
    let currentTime = 1_700_000_000_000;
    let nextProcessId = 4_100;
    let nextSessionId = 1;
    let nextWindowId = 1;
    let issuedPrintJobs = 0;
    let checkpointCount = 0;

    await fs.makeDirectory(fixtureDirectory);
    await fs.makeDirectory(paths.evidenceDir);
    await fs.makeDirectory(joinGuestPath('/', installDirectory, 'resources', 'bin'));
    await writeNumberedPdf(
        fs,
        fixtureFile,
        Array.from({ length: fixturePageCount }, (unused, index) => index + 1),
    );
    await fs.writeBytes(metadataFixtureFile, await generateMetadataFixture());
    await fs.writeBytes(fontsFixtureFile, await generateFontsFixture());
    await writeSparseMatrixPdf(
        joinGuestPath('/', fixtureDirectory, 'F10-save-witness-small.pdf'),
        9_214,
    );
    await writeSparseMatrixPdf(
        joinGuestPath('/', fixtureDirectory, 'F10-save-witness-65mib.pdf'),
        65 * 1024 * 1024,
    );
    await writeSparseMatrixPdf(
        joinGuestPath('/', fixtureDirectory, 'F10-save-witness-513mib.pdf'),
        513 * 1024 * 1024,
    );
    await fs.writeText(joinGuestPath('/', installDirectory, 'resources', 'bin', 'pdftool.exe'), 'MZ fake image');
    await fs.writeText(joinGuestPath('/', installDirectory, 'resources', 'helper.exe'), 'MZ fake image');
    await fs.writeText(joinGuestPath('/', installDirectory, 'resources', 'notes.txt'), 'not an executable');

    const markersOf = async (filePath: string) => {
        const known = documentMarkers.get(filePath);
        if (known !== undefined) {
            return known;
        }
        const derived = Array.from(
            { length: await pdfPageCount(fs, filePath) },
            (unused, index) => index + 1,
        );
        documentMarkers.set(filePath, derived);
        return derived;
    };

    const persist = async (filePath: string, markers: readonly number[]) => {
        await writeNumberedPdf(fs, filePath, markers);
        documentMarkers.set(filePath, [...markers]);
    };

    const requireSession = (sessionId: number) => {
        const session = sessions.get(sessionId);
        if (session === undefined) {
            throw new Error(`The fake world lost session ${sessionId}`);
        }
        return session;
    };

    const currentMarkers = async (session: IFakeSession) => (session.instrumented
        ? [...session.pages]
        : [...await markersOf(session.documentPath)]);

    const openWindow = (recordId: string, mode: TFakeWindowMode, session: IFakeSession) => {
        if (suppressDialogs && mode !== 'main') {
            return null;
        }
        const window: IFakeWindow = {
            handle: `window-${nextWindowId}`,
            recordId,
            mode,
            processId: session.processId,
            sessionId: session.id,
            pendingPath: '',
            selectedPrinter: null,
        };
        nextWindowId += 1;
        windows.push(window);
        return window;
    };

    const closeWindow = (window: IFakeWindow) => {
        const index = windows.indexOf(window);
        if (index >= 0) {
            windows.splice(index, 1);
        }
    };

    const windowByHandle = (handle: string) => {
        const window = windows.find(candidate => candidate.handle === handle);
        if (window === undefined) {
            throw new Error(`The fake world has no window ${handle}`);
        }
        return window;
    };

    const windowRef = (window: IFakeWindow): IUiElementRef => ({
        handle: window.handle,
        controlType: 'Window',
        name: window.recordId,
        automationId: null,
        processId: window.processId,
    });

    const controlRef = (window: IFakeWindow, recordId: string): IUiElementRef => ({
        handle: `${window.handle}::${recordId}`,
        controlType: requireControlSelector(selectors, recordId).controlType,
        name: recordId,
        automationId: requireControlSelector(selectors, recordId).automationId ?? null,
        processId: window.processId,
    });

    const commitDialog = async (window: IFakeWindow) => {
        const session = requireSession(window.sessionId);
        const target = window.pendingPath;
        if (target.length === 0) {
            throw new Error(`The fake dialog ${window.recordId} was committed without a path`);
        }
        if (window.mode === 'open') {
            session.documentPath = target;
            session.pages = [...await markersOf(target)];
            closeWindow(window);
            return;
        }
        if (window.mode === 'print-output' && await fs.exists(target)) {
            openWindow(nativeDialogRecordIds.overwriteWindow, 'overwrite', session);
            return;
        }
        await persist(target, await currentMarkers(session));
        if (window.mode === 'print-output') {
            issuedPrintJobs += 1;
            printJobs.push({
                id: issuedPrintJobs,
                documentName: target,
                printerName: window.selectedPrinter ?? 'Microsoft Print to PDF',
                status: 'Spooling',
                submittedTime: new Date(currentTime).toISOString(),
            });
        }
        session.preparingPrint = false;
        closeWindow(window);
    };

    const invokeControl = async (ref: IUiElementRef) => {
        const [
            handle,
            recordId,
        ] = ref.handle.split('::');
        const window = windowByHandle(handle ?? '');
        const session = requireSession(window.sessionId);
        if (recordId === nativeDialogRecordIds.commitButton) {
            await commitDialog(window);
            return;
        }
        if (recordId === nativeDialogRecordIds.cancelButton
            || recordId === nativeDialogRecordIds.cancelPrintButton
            || recordId === nativeDialogRecordIds.overwriteNoButton) {
            session.preparingPrint = false;
            closeWindow(window);
            return;
        }
        if (recordId === nativeDialogRecordIds.printButton) {
            closeWindow(window);
            const output = openWindow(nativeDialogRecordIds.printOutputDialog, 'print-output', session);
            if (output !== null) {
                output.selectedPrinter = window.selectedPrinter;
            }
            return;
        }
        if (recordId !== nativeDialogRecordIds.printToPdfEntry) {
            throw new Error(`The fake world cannot invoke ${String(recordId)}`);
        }
    };

    const nativeUi: INativeUiAdapter = {
        driver: 'uia3',
        actionLog: createNativeUiActionLog(),
        findWindow: (query: IUiWindowQuery) => {
            const byProcess = Object.keys(query).length === 1 && query.processId !== undefined;
            const found = windows.find(window => (byProcess
                ? window.processId === query.processId
                : sameShape(requireWindowQuery(selectors, window.recordId), query)));
            return Promise.resolve(found === undefined ? null : windowRef(found));
        },
        findControl: (target: IUiElementRef, selector: IUiSelector) => {
            const window = windowByHandle(target.handle);
            const matches = (dialogControlRecordIds[window.recordId] ?? [])
                .filter(recordId => sameShape(requireControlSelector(selectors, recordId), selector))
                .map(recordId => controlRef(window, recordId));
            return Promise.resolve(matches);
        },
        invoke: invokeControl,
        setValue: (ref: IUiElementRef, text: string) => {
            const [handle] = ref.handle.split('::');
            windowByHandle(handle ?? '').pendingPath = text;
            return Promise.resolve();
        },
        select: (ref: IUiElementRef, item: string) => {
            const [handle] = ref.handle.split('::');
            windowByHandle(handle ?? '').selectedPrinter = item;
            return Promise.resolve();
        },
        sendKeys: async (target: IUiElementRef, keys: string) => {
            const window = windowByHandle(target.handle);
            const session = requireSession(window.sessionId);
            if (window.mode === 'main') {
                if (keys === '^o') {
                    openWindow(nativeDialogRecordIds.fileDialog, 'open', session);
                }
                if (keys === '^+s') {
                    openWindow(nativeDialogRecordIds.fileDialog, 'save-as', session);
                }
                return;
            }
            if (keys === '{ENTER}') {
                await commitDialog(window);
                return;
            }
            window.pendingPath = keys;
        },
        waitFor: (selector: IUiSelector) => {
            for (const window of windows) {
                const match = (dialogControlRecordIds[window.recordId] ?? [])
                    .find(recordId => sameShape(requireControlSelector(selectors, recordId), selector));
                if (match !== undefined) {
                    return Promise.resolve(controlRef(window, match));
                }
            }
            return Promise.reject(new SelectorNotFoundError(selector));
        },
        captureTree: (target: IUiElementRef) => Promise.resolve({
            handle: target.handle,
            children: [],
        }),
        screenshot: filePath => fs.writeBytes(filePath, pngBytes),
    };

    const createDriver = (session: IFakeSession): IViewerDriver => {
        const failure = (errorCode: string): IViewerOperationOutcome => ({
            success: false,
            errorCode,
            pageCount: null,
        });
        return {
            openDocument: (filePath: string) => {
                session.documentPath = filePath;
                return Promise.resolve();
            },
            waitUntilReady: () => Promise.resolve(),
            workingCopyPath: () => Promise.resolve(session.workingCopyPath),
            totalPages: () => Promise.resolve(session.pages.length),
            deletePage: (pageNumber: number) => {
                if (pageNumber < 1 || pageNumber > session.pages.length) {
                    return Promise.resolve(failure('page-out-of-range'));
                }
                session.pages.splice(pageNumber - 1, 1);
                session.revision += 1;
                return Promise.resolve({
                    success: true,
                    errorCode: null,
                    pageCount: session.pages.length,
                });
            },
            save: async () => {
                if (saveErrorCode !== null) {
                    return failure(saveErrorCode);
                }
                if (blockedPaths.has(session.documentPath)) {
                    blockedPaths.delete(session.documentPath);
                    holdReleases.get(session.documentPath)?.({
                        exitCode: 0,
                        stdout: 'released',
                        stderr: '',
                    });
                    return failure('EBUSY');
                }
                await persist(session.documentPath, session.pages);
                await fs.writeText(
                    `${session.workingCopyPath}${revisionSidecarSuffix}`,
                    JSON.stringify({
                        sidecarVersion: 1,
                        revision: session.revision,
                    }),
                );
                return {
                    success: true,
                    errorCode: null,
                    pageCount: session.pages.length,
                };
            },
            documentRevisionToken: () => Promise.resolve(`revision-${session.revision}`),
            deletePageUsingRevisionToken: (pageNumber: number, revisionToken: string) => {
                if (revisionToken !== `revision-${session.revision}`) {
                    return Promise.resolve(failure('stale-revision-token'));
                }
                session.pages.splice(pageNumber - 1, 1);
                session.revision += 1;
                return Promise.resolve({
                    success: true,
                    errorCode: null,
                    pageCount: session.pages.length,
                });
            },
            requestSaveAs: () => {
                openWindow(nativeDialogRecordIds.fileDialog, 'save-as', session);
                return Promise.resolve();
            },
            requestSaveAsCommand: () => {
                openWindow(nativeDialogRecordIds.fileDialog, 'save-as', session);
                return Promise.resolve();
            },
            requestPrint: () => {
                session.preparingPrint = true;
                openWindow(nativeDialogRecordIds.printDialog, 'print', session);
                return Promise.resolve();
            },
            printDocumentCommand: () => {
                session.preparingPrint = true;
                openWindow(nativeDialogRecordIds.printDialog, 'print', session);
                return Promise.resolve();
            },
            isPreparingPrint: () => Promise.resolve(session.preparingPrint),
            createAnnotation: (text: string) => {
                session.annotations.push(text);
                return Promise.resolve(session.annotations.length);
            },
            countTextMatches: async (filePath: string, query: string) => {
                const markers = await markersOf(filePath);
                return markers.filter(marker => formatPageMarker(numberedFixturePackId, marker) === query).length;
            },
            pressKeys: (keys) => {
                if (!keys.includes('Escape')) {
                    return Promise.resolve();
                }
                session.preparingPrint = false;
                for (const window of [...windows]) {
                    if (window.sessionId === session.id && window.mode !== 'main') {
                        closeWindow(window);
                    }
                }
                return Promise.resolve();
            },
            captureScreenshot: filePath => fs.writeBytes(filePath, pngBytes),
            rendererFailures: () => [],
        };
    };

    const startSession = async (documentPath: string, instrumented: boolean) => {
        const session: IFakeSession = {
            id: nextSessionId,
            processId: nextProcessId,
            documentPath,
            workingCopyPath: joinGuestPath('/', paths.runRoot, 'working', `copy-${nextSessionId}.pdf`),
            instrumented,
            pages: documentPath.length === 0 ? [] : [...await markersOf(documentPath)],
            revision: 1,
            annotations: [],
            preparingPrint: false,
        };
        nextSessionId += 1;
        nextProcessId += 1;
        sessions.set(session.id, session);
        await fs.makeDirectory(joinGuestPath('/', paths.runRoot, 'working'));
        openWindow(nativeDialogRecordIds.viewerWindow, 'main', session);
        return session;
    };

    const closeSession = (session: IFakeSession) => {
        for (const window of [...windows]) {
            if (window.sessionId === session.id) {
                closeWindow(window);
            }
        }
        sessions.delete(session.id);
        return Promise.resolve();
    };

    const viewer: IViewerFactory = {
        openInstrumented: async (documentPath: string) => {
            const session = await startSession(documentPath, true);
            return {
                driver: createDriver(session),
                process: {
                    pid: session.processId,
                    startTime: '2026-09-04T12:00:00.0000000Z',
                    executable: joinGuestPath('/', installDirectory, 'EVB Viewer.exe'),
                },
                close: () => closeSession(session),
            };
        },
        launchAcceptance: async (documentPath?: string) => {
            const session = await startSession(documentPath ?? '', false);
            return {
                process: {
                    pid: session.processId,
                    startTime: '2026-09-04T12:00:00.0000000Z',
                    executable: joinGuestPath('/', installDirectory, 'EVB Viewer.exe'),
                },
                close: () => closeSession(session),
            };
        },
    };

    const powerShell: IGuestPowerShellRunner = {
        scriptPath: scriptName => joinGuestPath('/', root, 'powershell', scriptName),
        run: (scriptName, args = []) => {
            if (scriptName !== 'hold-file-handle.ps1') {
                return Promise.reject(new Error(`The fake world does not run ${scriptName}`));
            }
            const heldPath = namedArgument(args, '-Path');
            const readyFile = namedArgument(args, '-ReadyFile');
            blockedPaths.add(heldPath);
            return new Promise<IGuestCommandResult>((resolve) => {
                holdReleases.set(heldPath, resolve);
                void fs.writeText(readyFile, 'the fake helper holds an exclusive handle\n');
            });
        },
        runJson: (scriptName) => {
            if (scriptName !== 'get-print-jobs.ps1') {
                return Promise.reject(new Error(`The fake world does not run ${scriptName}`));
            }
            const snapshot = [...printJobs];
            printJobs.shift();
            return Promise.resolve(snapshot);
        },
    };

    const environment: ICaseEnvironment = {
        clock: {
            now: () => currentTime,
            nowIso: () => new Date(currentTime).toISOString(),
            sleep: (milliseconds) => {
                currentTime += milliseconds;
                return Promise.resolve();
            },
        },
        fs,
        exec: { run: (command, args) => Promise.resolve(command.toLowerCase().endsWith('.exe')
            && command.startsWith(installDirectory)
            ? {
                exitCode: 0,
                stdout: `fake bundled tool ${args.join(' ')}\n`,
                stderr: '',
            }
            : {
                exitCode: 1,
                stdout: '',
                stderr: `'${command}' is not recognized as an internal or external command\n`,
            }) },
        powerShell,
        nativeUi,
        viewer,
        selectors,
        paths,
        separator: '/',
        installDirectory,
        fixturePath: fixtureId => joinGuestPath('/', fixtureDirectory, `${fixtureId}.pdf`),
        log: () => undefined,
        throwIfCanceled: () => {
            checkpointCount += 1;
            return cancelAfterCheckpoints !== null && checkpointCount > cancelAfterCheckpoints
                ? Promise.reject(new CaseCanceledError())
                : Promise.resolve();
        },
        remainingMs: () => viewerDefaultTimeouts.printReadinessMs * 20,
    };

    return {
        environment,
        paths,
        fs,
        printJobsIssued: () => issuedPrintJobs,
        openWindowCount: () => windows.length,
    };
}

async function runCase(testId: string, overrides: Omit<Partial<IFakeWorldOptions>, 'root'> = {}) {
    const world = await createFakeWorld({
        root: await mkdtemp(path.join(tmpdir(), 'evb-guest-e2e-')),
        ...overrides,
    });
    const result = await runRegisteredCase(requireCaseDefinition(testId), world.environment);
    return {
        world,
        result,
    };
}

describe('windows guest cases under a fake guest world', () => {
    for (const caseDefinition of windowsTestCaseDefinitions) {
        it(`runs ${caseDefinition.id} to a passed result with every assertion executed`, async () => {
            const {
                world,
                result,
            } = await runCase(caseDefinition.id);

            expect(isWindowsTestCaseResult(result)).toBe(true);
            expect({
                id: result.testId,
                outcome: result.outcome,
                failureReason: result.failureReason,
            }).toEqual({
                id: caseDefinition.id,
                outcome: 'passed',
                failureReason: null,
            });
            expect(result.assertions.length).toBeGreaterThanOrEqual(3);
            expect(result.assertions.filter(assertion => !assertion.passed)).toEqual([]);
            expect(new Set(result.assertions.map(assertion => assertion.id)).size)
                .toBe(result.assertions.length);
            expect(result.evidenceFiles.length).toBeGreaterThan(0);
            for (const fileName of result.evidenceFiles) {
                const evidenceFile = joinGuestPath('/', world.paths.evidenceDir, fileName);
                expect(await world.fs.exists(evidenceFile), evidenceFile).toBe(true);
            }
            expect(world.openWindowCount(), 'the case left a window open').toBe(0);
        }, 120_000);
    }

    it('prints through the native dialogs and drains the spooler queue', async () => {
        const {
            world,
            result,
        } = await runCase('WIN-PRINT-01');

        expect(result.outcome).toBe('passed');
        expect(world.printJobsIssued()).toBe(2);
        const coldOutput = joinGuestPath('/', world.paths.outputsDir, 'win-print-01-cold.pdf');
        expect(await pdfPageCount(world.fs, coldOutput)).toBe(fixturePageCount);
    });

    it('leaves the saved document short of the deleted pages', async () => {
        const {
            world,
            result,
        } = await runCase('WIN-SAVE-01');

        expect(result.outcome).toBe('passed');
        const source = joinGuestPath('/', world.paths.inputsDir, 'win-save-01-source.pdf');
        expect(await pdfPageCount(world.fs, source)).toBe(fixturePageCount - 2);
        expect(result.assertions.map(assertion => assertion.id)).toEqual(expect.arrayContaining([
            'save01.stale-revision-rejected',
            'save01.on-disk-page-count',
            'save01.deleted-marker-absent.EVB-F01-PAGE-06',
            'save01.survivor-marker-present',
        ]));
    });

    it('reports product-failed with a recorded failing assertion when saving is refused', async () => {
        const { result } = await runCase('WIN-SAVE-01', { saveErrorCode: 'save-refused' });

        expect(result.outcome).toBe('product-failed');
        expect(result.assertions.some(assertion => !assertion.passed)).toBe(true);
        expect(result.failureReason).toContain('save01.first-save');
    });

    it('reports infrastructure-failed when a native dialog never appears', async () => {
        const { result } = await runCase('WIN-SAVE-02', { suppressDialogs: true });

        expect(result.outcome).toBe('infrastructure-failed');
        expect(result.failureReason).toContain('did not appear');
        expect(result.assertions.every(assertion => assertion.passed)).toBe(true);
    });

    it('waits for the Save 04 handle helper when viewer startup rejects', async () => {
        const world = await createFakeWorld({root: await mkdtemp(path.join(tmpdir(), 'evb-guest-save04-startup-'))});
        let holdSettled = false;
        world.environment.powerShell = {
            ...world.environment.powerShell,
            run: () => new Promise<IGuestCommandResult>(resolve => {
                setTimeout(() => {
                    holdSettled = true;
                    resolve({
                        exitCode: 0,
                        stdout: 'released',
                        stderr: '',
                    });
                }, 10);
            }),
        };
        world.environment.viewer = {
            ...world.environment.viewer,
            openInstrumented: () => Promise.reject(new Error('viewer startup failed')),
        };

        const result = await runRegisteredCase(requireCaseDefinition('WIN-SAVE-04'), world.environment);

        expect(result.outcome).toBe('infrastructure-failed');
        expect(result.failureReason).toContain('viewer startup failed');
        expect(holdSettled).toBe(true);
    });

    it('reports canceled when the run is canceled between case steps', async () => {
        const { result } = await runCase('WIN-PRINT-01', { cancelAfterCheckpoints: 1 });

        expect(result.outcome).toBe('canceled');
        expect(result.failureReason).toContain('canceled');
    });
});
