import {decodeManifest} from '@document-store/documentDirectory';
import {spawn} from 'node:child_process';
import {PDFDocument} from 'pdf-lib';
import {delay} from 'es-toolkit/promise';
import {clickAsUser, clickFoundAsUser} from '@tests/e2e/electron/helpers/userInput';
import {createHash} from 'node:crypto';
import {chmodSync, createReadStream, existsSync, rmSync, writeFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {appendFile, readFile, rename, stat} from 'node:fs/promises';
import {afterEach, describe, expect, it, onTestFinished} from 'vitest';
import {
    createFixturePath,
    createLargeScannedFixturePdf,
    createMultiPageTextFixturePdf,
    createScannedTextFixturePdf,
    readPdfPageSnapshots,
    readPdfTextAnnotationRecords,
} from '@tests/e2e/electron/helpers/fixtures';
import {createCanonicalTextBoxWithPointer} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {moveTabToNewWindow} from '@tests/e2e/electron/helpers/moveTabToNewWindow';
import {installPageEvaluationShims} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    assertOcrPdfSemanticOutput,
    getActiveWorkspaceWorkingCopyPath,
    readDocumentBytes,
    runOcrSearchablePdf,
} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {startElectronE2ESession, type IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    clickVisibleToolbarButton,
    openDocumentSidebarTab,
    waitForPdfLoaded,
    waitForViewerInteractive,
    openPdfInApp,
} from '@tests/e2e/electron/helpers/viewerCore';
import {activateWorkspaceTab, createNewWorkspaceTab} from '@tests/e2e/electron/helpers/workspaceTabs';
import {
    callWorkspaceCommand,
    getWorkspaceToolbarSnapshot,
    readWorkspaceStateValues,
    requireWorkspaceCommand,
    waitForSaveFrontierReady,
    waitForWorkspaceToolbarIdle,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {hasWorkspaceCrashCheckpoint, readWorkspaceRecoveryRecords} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {stopSingleSession} from '@scripts/electron-run/stopSession';
import {projectRoot} from '@scripts/electron-run/projectRoot';
import {createE2ERunScopedSessionName} from '@scripts/electron-run/electronRunRunId';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import {isProcessAlive} from '@scripts/electron-run/electronRunProcessTree';
import {runElectronE2ETeardown} from '@tests/e2e/electron/helpers/electronE2ESessionFailure';
import type * as Pdfjs from 'pdfjs-dist';
import type {Page} from 'puppeteer-core';

const E2E_TIMEOUT_MS = 240_000;

interface IRecoveredSession {
    pdfPath: string;
    workingCopyPath: string;
    session: IElectronE2ESession;
}

interface ICreateRecoveredSessionOptions {
    replacementSourcePath?: string;
    largeHistory?: boolean;
}

interface IRecoveryDirtyState {
    [key: string]: unknown;
    fileDirty?: boolean;
    recoveryDirtyBaseline?: boolean;
}

interface IRecoveryAutomationState {
    [key: string]: unknown;
    dirtyState?: IRecoveryDirtyState;
}

const RECOVERED_ANNOTATION_TEXT = 'Project 8 recovered annotation';

async function createRecoveredSession(label: string, options: ICreateRecoveredSessionOptions = {}): Promise<IRecoveredSession> {
    const fileName = `project8-close-${label}-${Date.now()}.pdf`;
    const pdfPath = options.largeHistory
        ? await createLargeScannedFixturePdf(fileName, 2, 9 * 1024 * 1024)
        : await createMultiPageTextFixturePdf(fileName, 2);
    const sessionName = `e2e-project8-close-${label}-${Date.now()}`;
    let session = await startElectronE2ESession(sessionName, {
        clean: true,
        initialOpenPaths: [pdfPath],
    });
    // Callers own the session only after this returns, so a failed setup
    // stops it here.
    try {
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await createCanonicalTextBoxWithPointer(session.page, RECOVERED_ANNOTATION_TEXT, {
            x: 0.4,
            y: 0.3,
        });
        const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        await requireWorkspaceCommand(session.page, 'handleRotateCw', [[1]]);
        await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
        const checkpointSession = session.name;
        await expect
            .poll(
                async () => {
                    if (!hasWorkspaceCrashCheckpoint(checkpointSession)) {
                        return null;
                    }
                    const stored = (readWorkspaceRecoveryRecords(checkpointSession)[0] ?? {}) as {
                        checkpoint?: {
                            tabs?: Array<{
                                isDirty?: boolean;
                                workingCopyRef?: string | null;
                            }>;
                        };
                    };
                    return stored.checkpoint?.tabs?.[0] ?? null;
                },
                {timeout: 60_000},
            )
            .toMatchObject({
                isDirty: true,
                workingCopyRef: expect.any(String),
            });
        expect((await readPdfPageSnapshots(await readDocumentBytes(session!.page, workingCopyPath)))[0]?.rotation).toBe(90);

        const crashed = session;
        await crashed.browser.disconnect();
        await stopSingleSession(crashed.name, {
            preserveWorkspaceCheckpoint: true,
            crashElectronBeforeStop: true,
        });
        if (options.replacementSourcePath) {
            await rename(options.replacementSourcePath, pdfPath);
        }
        session = await startElectronE2ESession(sessionName, {clean: false});
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await session.page.waitForFunction(
            (expectedText: string) =>
                Array.from(
                    document.querySelectorAll<HTMLElement>(
                        '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
                    ),
                ).some((entity) => entity.textContent?.replace(/[\u200B\uFEFF]/gu, '').trim() === expectedText),
            {timeout: 60_000},
            RECOVERED_ANNOTATION_TEXT,
        );
        const state = await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState']);
        expect(state.dirtyState?.fileDirty).toBe(true);
        const recoveredWorkingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
        expect((await readPdfPageSnapshots(await readDocumentBytes(session!.page, recoveredWorkingCopyPath)))[0]?.rotation).toBe(90);
        return {
            pdfPath,
            workingCopyPath: recoveredWorkingCopyPath,
            session,
        };
    } catch (error) {
        await runElectronE2ETeardown(error, [
            {
                label: `stop session '${session.name}'`,
                run: () => session.stop(),
            },
        ]);
        throw error;
    }
}

async function clickWindowDecision(session: IElectronE2ESession, label: string, options: {waitForClose?: boolean} = {}) {
    const waitForClose = options.waitForClose ?? label !== 'Cancel';
    const closed = waitForClose ? new Promise<void>((resolve) => session.page.once('close', () => resolve())) : null;
    await session.page.evaluate(() => window.electronAPI?.windowTabs.closeCurrentWindow());
    try {
        await clickFoundAsUser(
            session.page,
            (expectedLabel: string) =>
                Array.from(document.querySelectorAll('[role="dialog"] button')).find((candidate) =>
                    (candidate.textContent ?? '').trim().includes(expectedLabel),
                ),
            label,
            {description: `window close action ${label}`},
        );
    } catch (error) {
        // The action closes the window, which can end the page before the
        // release of the click is acknowledged.
        if (!closed) {
            throw error;
        }
        await Promise.race([
            closed,
            delay(5_000).then(() => {
                throw error;
            }),
        ]);
    }
    if (label === 'Cancel') {
        await session.page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    }
    if (closed) {
        await closed;
        expect(session.page.isClosed()).toBe(true);
    }
}

async function getFileSha256(filePath: string) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

/**
 * Clicks the active tab's close button where it is when the pointer goes down.
 * A point measured beforehand can be stale: a Save As renames the tab, and a
 * renamed tab may move its button.
 */
async function clickActiveTabClose(session: IElectronE2ESession) {
    await clickAsUser(session.page, '.editor-pane.is-active .tab-list .tab.is-active .tab-close:not(:disabled)');
}

async function clickActiveTabCloseIfEnabled(session: IElectronE2ESession) {
    const target = await session.page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>('.editor-pane.is-active .tab-list .tab.is-active .tab-close');
        if (!button || button.disabled) {
            return null;
        }
        const bounds = button.getBoundingClientRect();
        return {
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
        };
    });
    if (target) {
        await session.page.mouse.click(target.x, target.y);
    }
}

async function waitForActiveTabCloseEnabled(session: IElectronE2ESession) {
    await session.page.waitForFunction(
        () => {
            const button = document.querySelector<HTMLButtonElement>('.editor-pane.is-active .tab-list .tab.is-active .tab-close');
            return Boolean(button && !button.disabled);
        },
        {timeout: 30_000},
    );
}

async function clickDirtyTabDecision(session: IElectronE2ESession, labelFragment: string) {
    const rect = await session.page.evaluate((label) => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        const button = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((candidate) =>
            candidate.textContent?.toLowerCase().includes(label.toLowerCase()),
        );
        if (!button || button.disabled) {
            return null;
        }
        const bounds = button.getBoundingClientRect();
        return {
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
        };
    }, labelFragment);
    expect(rect, `dirty-close ${labelFragment} button should be available`).not.toBeNull();
    if (!rect) {
        throw new Error(`Dirty-close ${labelFragment} button was not available`);
    }
    await session.page.mouse.click(rect.x, rect.y);
    await session.page.waitForFunction(() => !document.querySelector('[role="dialog"]'), {timeout: 30_000});
}

async function rotateFirstPageCounterclockwise(session: IElectronE2ESession) {
    await openDocumentSidebarTab(session.page, 'Pages');

    await session.page.waitForFunction(
        () => {
            const item = document.querySelector<HTMLElement>('.editor-pane.is-active [data-thumbnail-page="1"]');
            const bounds = item?.getBoundingClientRect();
            return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
        },
        {timeout: 30_000},
    );
    const thumbnail = await session.page.evaluate(() => {
        const item = document.querySelector<HTMLElement>('.editor-pane.is-active [data-thumbnail-page="1"]');
        if (!item) {
            return null;
        }
        item.scrollIntoView({block: 'center'});
        const bounds = item.getBoundingClientRect();
        return {
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
        };
    });
    expect(thumbnail, 'first page thumbnail should be visible').not.toBeNull();
    if (!thumbnail) {
        throw new Error('First page thumbnail was not visible');
    }
    await session.page.mouse.click(thumbnail.x, thumbnail.y, {button: 'right'});
    await session.page.waitForFunction(
        () =>
            Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).some((item) => {
                const label = item.textContent?.toLowerCase() ?? '';
                return label.includes('rotate counterclockwise') || label.includes('повернуть против часовой');
            }),
        {timeout: 15_000},
    );
    const menuItem = await session.page.evaluate(() => {
        const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((candidate) => {
            const label = candidate.textContent?.toLowerCase() ?? '';
            return label.includes('rotate counterclockwise') || label.includes('повернуть против часовой');
        });
        if (!item) {
            return null;
        }
        const bounds = item.getBoundingClientRect();
        return {
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
        };
    });
    expect(menuItem, 'rotate counterclockwise menu item should be visible').not.toBeNull();
    if (!menuItem) {
        throw new Error('Rotate counterclockwise menu item was not visible');
    }
    await session.page.mouse.click(menuItem.x, menuItem.y);
}

const ROTATE_FAILURE_TEXT = 'Failed to rotate pages';
const PAGE_OPS_WASM_CLI_PATH = join(process.cwd(), 'scripts', 'runPdfPageOpsWasmCli.ts');

/**
 * Stands in for the page-ops tool so a rotation stays in its native write
 * while the test holds it: canceling kills the held call, releasing lets it
 * run the real WASM engine. Every other call goes straight to the real WASM engine.
 */
function createHeldPageOpsTool(name: string) {
    const toolPath = createFixturePath(`${name}-page-ops.sh`);
    const armPath = createFixturePath(`${name}-page-ops.arm`);
    const heldPath = createFixturePath(`${name}-page-ops.held`);
    writeFileSync(
        toolPath,
        [
            '#!/usr/bin/env bash',
            `if [ "$1" = "save-mutations" ] && [ -e ${JSON.stringify(armPath)} ]; then`,
            `    : > ${JSON.stringify(heldPath)}`,
            `    while [ -e ${JSON.stringify(armPath)} ]; do sleep 0.05; done`,
            'fi',
            `cd ${JSON.stringify(process.cwd())} && exec ${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(PAGE_OPS_WASM_CLI_PATH)} "$@"`,
            '',
        ].join('\n'),
    );
    chmodSync(toolPath, 0o755);
    onTestFinished(() => {
        rmSync(toolPath, {force: true});
        rmSync(armPath, {force: true});
        rmSync(heldPath, {force: true});
    });
    return {
        toolPath,
        hold: () => writeFileSync(armPath, ''),
        waitUntilHeld: () => expect.poll(() => existsSync(heldPath), {timeout: 30_000}).toBe(true),
        release: () => rmSync(armPath, {force: true}),
    };
}

async function clickPageOperationCancel(session: IElectronE2ESession) {
    const button = await session.page.waitForFunction(
        () => {
            const candidate = Array.from(document.querySelectorAll<HTMLButtonElement>('.workspace-page-op-progress-overlay button')).find(
                (element) => element.textContent?.trim() === 'Cancel' && !element.disabled,
            );
            if (!candidate) {
                return null;
            }
            const bounds = candidate.getBoundingClientRect();
            return bounds.width > 0 && bounds.height > 0
                ? {
                      x: bounds.left + bounds.width / 2,
                      y: bounds.top + bounds.height / 2,
                  }
                : null;
        },
        {timeout: 30_000},
    );
    const point = await button.jsonValue();
    if (!point) {
        throw new Error('Page operation Cancel button was not visible');
    }
    await session.page.mouse.click(point.x, point.y);
}

async function startBusyCloseAndWaitForDecision(session: IElectronE2ESession, heldTool: ReturnType<typeof createHeldPageOpsTool>) {
    await waitForActiveTabCloseEnabled(session);
    heldTool.hold();
    await rotateFirstPageCounterclockwise(session);
    await heldTool.waitUntilHeld();
    await expect
        .poll(
            async () =>
                (await readWorkspaceStateValues<{isPageOperationInProgress?: boolean}>(session.page, ['isPageOperationInProgress']))
                    .isPageOperationInProgress,
            {timeout: 30_000},
        )
        .toBe(true);

    const toolbarAtClick = await getWorkspaceToolbarSnapshot(session.page);
    const workspaceStateAtClick = await readWorkspaceStateValues<{
        dirtyState?: {fileDirty?: boolean};
        isPageOperationInProgress?: boolean;
    }>(session.page, ['dirtyState', 'isPageOperationInProgress']);
    expect(toolbarAtClick).toMatchObject({
        hasPdf: true,
        isPageOperationInProgress: true,
    });
    expect(workspaceStateAtClick).toMatchObject({
        dirtyState: {fileDirty: false},
        isPageOperationInProgress: true,
    });

    await clickActiveTabClose(session);
    // A duplicate close may be unavailable once the close transition commits;
    // if it is still actionable, send a second real click while the request is pending.
    await clickActiveTabCloseIfEnabled(session);

    expect((await getWorkspaceToolbarSnapshot(session.page))?.hasPdf).toBe(true);
    expect(
        await session.page.evaluate(() => {
            const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const bounds = host?.getBoundingClientRect();
            return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
        }),
    ).toBe(true);
    await expect
        .poll(
            async () =>
                session!.page.evaluate(() => {
                    const bodyText = document.body.innerText;
                    return (
                        bodyText.includes('Closing after page processing finishes.') ||
                        bodyText.includes('Закрытие продолжится после завершения обработки страниц.')
                    );
                }),
            {timeout: 2_000},
        )
        .toBe(true);

    heldTool.release();
    await session.page.waitForFunction(
        () => {
            const snapshot = window.__evbTestApi?.getActiveToolbarSnapshot?.();
            return Boolean(document.querySelector('[role="dialog"]')) || snapshot?.hasPdf === false;
        },
        {timeout: 120_000},
    );
    const dialogCount = await session.page.$$eval('[role="dialog"]', (dialogs) => dialogs.length);
    expect(dialogCount).toBe(1);
    await expect
        .poll(
            async () =>
                session!.page.evaluate(() => {
                    const bodyText = document.body.innerText;
                    return (
                        bodyText.includes('Closing after page processing finishes.') ||
                        bodyText.includes('Закрытие продолжится после завершения обработки страниц.')
                    );
                }),
            {timeout: 2_000},
        )
        .toBe(false);
}

const HELD_PDF_READ_KEY = '__c1HeldPdfRead';

interface IHeldPdfRead {
    isHeld: () => boolean;
    release: () => void;
}

/** Holds the next document read the viewer gives PDF.js, as a slow disk would, until the test releases it. */
async function holdNextPdfRead(page: Page) {
    await page.evaluate(async (key: string) => {
        const pdfjs = (window as Window & {pdfjsLib?: typeof Pdfjs}).pdfjsLib;
        if (!pdfjs) {
            throw new Error('PDF.js is not loaded in the renderer');
        }
        pdfjs.GlobalWorkerOptions.workerSrc ||= new URL('/pdf/pdf.worker.min.mjs', document.baseURI).href;
        const probe = pdfjs.getDocument({
            data: new TextEncoder().encode(
                '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
            ),
        });
        await probe.promise;
        const prototype = Object.getPrototypeOf(probe) as object;
        await probe.destroy();
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'promise');
        if (!descriptor?.get || !descriptor.configurable) {
            throw new Error('PDF.js read cannot be held');
        }
        const released = Promise.withResolvers<void>();
        let heldTask: object | null = null;
        Object.defineProperty(prototype, 'promise', {
            ...descriptor,
            get(this: object) {
                const read = descriptor.get!.call(this) as Promise<unknown>;
                heldTask ??= this;
                if (heldTask !== this) {
                    return read;
                }
                void read.catch(() => undefined);
                return released.promise.then(() => read);
            },
        });
        Reflect.set(window, key, {
            isHeld: () => heldTask !== null,
            release: () => {
                Object.defineProperty(prototype, 'promise', descriptor);
                released.resolve();
            },
        } satisfies IHeldPdfRead);
    }, HELD_PDF_READ_KEY);
    onTestFinished(() => releaseHeldPdfRead(page).catch(() => undefined));
}

async function clickSaveAs(page: Page) {
    await clickAsUser(page, 'button[aria-label="Save options"]');
    await clickFoundAsUser(
        page,
        () =>
            Array.from(document.querySelectorAll<HTMLButtonElement>('.save-split-item')).find((button) =>
                button.textContent?.trim().startsWith('Save As'),
            ),
        null,
        {description: 'Save As'},
    );
}

function waitForHeldPdfRead(page: Page) {
    return page.waitForFunction(
        (key: string) => (Reflect.get(window, key) as IHeldPdfRead | undefined)?.isHeld() === true,
        {timeout: 30_000},
        HELD_PDF_READ_KEY,
    );
}

async function releaseHeldPdfRead(page: Page) {
    await page.evaluate((key: string) => (Reflect.get(window, key) as IHeldPdfRead | undefined)?.release(), HELD_PDF_READ_KEY);
}

function readFirstPageShape(page: Page) {
    return page.$eval('.editor-pane.is-active .page_container[data-page="1"]', (element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.width > bounds.height ? 'landscape' : 'portrait';
    });
}

/** Records every failure toast the app shows from now on. */
async function recordFailureNotices(page: Page) {
    await page.evaluate(() => {
        const shown: string[] = [];
        Reflect.set(window, '__c1FailureNotices', shown);
        new MutationObserver(() => {
            for (const toast of document.querySelectorAll('.app-toast-failure')) {
                const text = toast.textContent?.replace(/\s+/gu, ' ').trim() ?? '';
                if (text && !shown.includes(text)) {
                    shown.push(text);
                }
            }
        }).observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
        });
    });
    return () => page.evaluate(() => Reflect.get(window, '__c1FailureNotices') as string[]);
}

async function activateTabWithWorkingCopy(session: IElectronE2ESession, expectedPath: string, expectedOriginalPath = expectedPath) {
    for (const tabIndex of [0, 1]) {
        const tabId = await session.page.$$eval(
            '.tab-list .tab[data-tab-id]',
            (tabs, index) => tabs[index as number]?.getAttribute('data-tab-id'),
            tabIndex,
        );
        if (!tabId) {
            continue;
        }
        await activateWorkspaceTab(session, tabIndex);
        await session.page.waitForFunction(
            (expectedTabId: string) => window.__evbTestApi?.getActiveTabId() === expectedTabId,
            {timeout: 10_000},
            tabId,
        );
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const state = await readWorkspaceStateValues<{
                originalPath?: string | null;
                workingCopyPath?: string | null;
            }>(session.page, ['originalPath', 'workingCopyPath']);
            if (state.workingCopyPath === expectedPath || state.originalPath === expectedOriginalPath) {
                return state;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    throw new Error(`Could not activate tab with working copy ${expectedPath}`);
}

describe('Project 8 recovered close decisions', () => {
    let session: IElectronE2ESession | null = null;

    afterEach(async () => {
        await session?.stop().catch(() => undefined);
        session = null;
    });

    it(
        'crops fractional margins and closes only after a save or discard decision',
        async () => {
            const pdfPath = await createMultiPageTextFixturePdf(`fractional-crop-close-${Date.now()}.pdf`, 2);
            const originalBytes = await readFile(pdfPath);
            const originalPdf = await PDFDocument.load(originalBytes);
            const originalBox = originalPdf.getPages()[0]!.getMediaBox();
            let expectedBox = originalBox;
            session = await startElectronE2ESession(`e2e-fractional-crop-close-${Date.now()}`, {clean: true});
            const activeSession = session;
            await session.page.setViewport({
                width: 1280,
                height: 800,
            });

            for (const decision of ['Discard', 'Save']) {
                await openPdfInApp(session.page, pdfPath, 60_000);
                await waitForPdfLoaded(session.page, 60_000);
                await waitForViewerInteractive(session.page, 60_000);
                await session.page.evaluate(() => {
                    const probe = window as Window & {
                        __cropAspectProbe?: {
                            frame: number;
                            stretched: number[][];
                        };
                    };
                    const state = {
                        frame: 0,
                        stretched: new Array<number[]>(),
                    };
                    probe.__cropAspectProbe = state;
                    const sample = () => {
                        for (const canvas of document.querySelectorAll<HTMLCanvasElement>(
                            '.page_container--rendered .page_canvas__render-layer > canvas',
                        )) {
                            const box = canvas.getBoundingClientRect();
                            if (
                                canvas.width &&
                                canvas.height &&
                                box.width &&
                                box.height &&
                                getComputedStyle(canvas).visibility === 'visible' &&
                                Math.abs(box.width / box.height - canvas.width / canvas.height) > 0.005
                            ) {
                                state.stretched.push([canvas.width, canvas.height, box.width, box.height]);
                            }
                        }
                        state.frame = requestAnimationFrame(sample);
                    };
                    sample();
                });
                const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
                for (const inset of [80, 95]) {
                    await clickVisibleToolbarButton(session.page, 'Crop Pages');
                    await session.page.waitForSelector('.crop-overlay.is-active');
                    const pointHandle = await session.page.waitForFunction(
                        (inset) => {
                            const overlay = document.querySelector<HTMLElement>('.crop-overlay.is-active');
                            const page = document.querySelector<HTMLElement>('.editor-pane.is-active .page_container[data-page="1"]');
                            if (!overlay || !page || getComputedStyle(overlay).pointerEvents !== 'auto') {
                                return false;
                            }

                            const pageRect = page.getBoundingClientRect();
                            const overlayRect = overlay.getBoundingClientRect();
                            const point = {
                                x: pageRect.left + inset,
                                y: Math.max(pageRect.top, 120) + inset,
                            };
                            const pointIsOnPage =
                                point.x >= pageRect.left &&
                                point.x <= pageRect.right &&
                                point.y >= pageRect.top &&
                                point.y <= pageRect.bottom;
                            const pointIsOnOverlay =
                                point.x >= overlayRect.left &&
                                point.x <= overlayRect.right &&
                                point.y >= overlayRect.top &&
                                point.y <= overlayRect.bottom;

                            return pointIsOnPage && pointIsOnOverlay && overlay.contains(document.elementFromPoint(point.x, point.y))
                                ? point
                                : false;
                        },
                        {},
                        inset,
                    );
                    const point = (await pointHandle.jsonValue()) as {
                        x: number;
                        y: number;
                    };
                    await pointHandle.dispose();
                    await session.page.mouse.move(point.x, point.y);
                    await session.page.mouse.down();
                    await session.page.mouse.move(point.x + 220, point.y + 250, {steps: 10});
                    await session.page.mouse.up();
                    await session.page.waitForSelector('[role="dialog"] input[role="spinbutton"]');
                    // Compare the document's bytes across the crop, whether its
                    // baseline is still external or a revision already exists.
                    const previousWorkingCopyDigest = await readDocumentBytes(session!.page, workingCopyPath).then((bytes) =>
                        createHash('sha256').update(bytes).digest('hex'),
                    );
                    await clickDirtyTabDecision(session, 'Apply Crop');
                    await expect
                        .poll(
                            () =>
                                readDocumentBytes(session!.page, workingCopyPath).then((bytes) =>
                                    createHash('sha256').update(bytes).digest('hex'),
                                ),
                            {timeout: 30_000},
                        )
                        .not.toBe(previousWorkingCopyDigest);
                    await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
                    await waitForPdfLoaded(session.page, 60_000);
                    const croppedPage = await PDFDocument.load(await readDocumentBytes(session!.page, workingCopyPath));
                    const visibleCropBox = croppedPage.getPages()[0]!.getCropBox();
                    await expect
                        .poll(
                            () =>
                                activeSession.page.$eval('.editor-pane.is-active .page_container[data-page="1"]', (element) => {
                                    const rect = element.getBoundingClientRect();
                                    return rect.width / rect.height;
                                }),
                            {timeout: 30_000},
                        )
                        .toBeCloseTo(visibleCropBox.width / visibleCropBox.height, 2);
                }
                const stretched = await session.page.evaluate(() => {
                    const probe = window as Window & {
                        __cropAspectProbe?: {
                            frame: number;
                            stretched: number[][];
                        };
                    };
                    const state = probe.__cropAspectProbe!;
                    cancelAnimationFrame(state.frame);
                    delete probe.__cropAspectProbe;
                    return state.stretched;
                });
                expect(stretched).toEqual([]);
                const croppedPdf = await PDFDocument.load(await readDocumentBytes(session!.page, workingCopyPath));
                expectedBox = croppedPdf.getPages()[0]!.getCropBox();
                expect(expectedBox.width).toBeGreaterThan(0);
                expect(expectedBox.width).toBeLessThan(originalBox.width);
                expect(expectedBox.height).toBeLessThan(originalBox.height);
                await waitForViewerInteractive(session.page, 60_000);
                await expect
                    .poll(
                        () =>
                            activeSession.page.$eval('.editor-pane.is-active .page_container[data-page="1"]', (element) => {
                                const rect = element.getBoundingClientRect();
                                return rect.width / rect.height;
                            }),
                        {timeout: 30_000},
                    )
                    .toBeCloseTo(expectedBox.width / expectedBox.height, 2);
                expect((await readFile(pdfPath)).equals(originalBytes)).toBe(true);

                await clickActiveTabClose(session);
                await session.page.waitForSelector('[role="dialog"]');
                expect(await session.page.$eval('[role="dialog"]', (element) => element.textContent)).toContain('Save changes');
                expect((await readFile(pdfPath)).equals(originalBytes)).toBe(true);
                await clickDirtyTabDecision(session, 'Cancel');
                expect(await session.page.$('.editor-pane.is-active .page_container[data-page="1"]')).not.toBeNull();
                await clickActiveTabClose(session);
                await session.page.waitForSelector('[role="dialog"]');
                await clickDirtyTabDecision(session, decision);
                await expect.poll(() => activeSession.page.$('.editor-pane.is-active .page_container'), {timeout: 30_000}).toBeNull();
                if (decision === 'Discard') {
                    expect((await readFile(pdfPath)).equals(originalBytes)).toBe(true);
                } else {
                    const savedPdf = await PDFDocument.load(await readFile(pdfPath));
                    expect(savedPdf.getPages()[0]!.getCropBox()).toEqual(expectedBox);
                    expect(savedPdf.getPages()[1]!.getCropBox()).toEqual(originalBox);
                }
            }
        },
        E2E_TIMEOUT_MS,
    );

    it.skipIf(process.platform === 'win32')(
        'waits for page work before showing the tab decision and only saves after explicit Save',
        async () => {
            const heldTool = createHeldPageOpsTool(`project8-busy-tab-close-${Date.now()}`);
            const pdfPath = await createLargeScannedFixturePdf(
                `project8-busy-tab-close-${Date.now()}.pdf`,
                882,
                // With the 882 pages the file lands just above the 64 MiB
                // eager-conformance limit, on the same open and save paths as the
                // real scan.
                64 * 1024 * 1024,
                1,
                {runOwner: 'w3-busy-close'},
            );
            const originalDigest = await getFileSha256(pdfPath);
            const originalMtime = (await stat(pdfPath)).mtimeMs;
            session = await startElectronE2ESession(`e2e-project8-busy-tab-close-${Date.now()}`, {
                clean: true,
                extraEnv: {EVB_PDF_PAGE_OPS_PATH: heldTool.toolPath},
            });
            await openPdfInApp(session.page, pdfPath, 60_000);
            await waitForPdfLoaded(session.page, 60_000);
            await waitForViewerInteractive(session.page, 60_000);

            await startBusyCloseAndWaitForDecision(session, heldTool);
            await clickDirtyTabDecision(session, 'Cancel');
            const afterCancel = await getWorkspaceToolbarSnapshot(session.page);
            expect(afterCancel).toMatchObject({
                hasPdf: true,
                canSave: true,
            });
            expect(
                (await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState'])).dirtyState?.fileDirty,
            ).toBe(true);
            expect(await getFileSha256(pdfPath)).toBe(originalDigest);
            expect((await stat(pdfPath)).mtimeMs).toBe(originalMtime);

            await clickActiveTabClose(session);
            await session.page.waitForSelector('[role="dialog"]', {
                visible: true,
                timeout: 30_000,
            });
            await clickDirtyTabDecision(session, 'Save');
            await expect.poll(async () => (await getWorkspaceToolbarSnapshot(session!.page))?.hasPdf, {timeout: 30_000}).toBe(false);
            await expect.poll(async () => (await readPdfPageSnapshots(pdfPath))[0]?.rotation, {timeout: 60_000}).toBe(270);
            expect(await getFileSha256(pdfPath)).not.toBe(originalDigest);

            await openPdfInApp(session.page, pdfPath, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            const cleanSnapshot = await getWorkspaceToolbarSnapshot(session.page);
            expect(cleanSnapshot).toMatchObject({
                hasPdf: true,
                canSave: false,
            });
            await clickActiveTabClose(session);
            await expect.poll(async () => (await getWorkspaceToolbarSnapshot(session!.page))?.hasPdf, {timeout: 10_000}).toBe(false);
            expect(await session.page.$$('[role="dialog"]')).toHaveLength(0);
        },
        E2E_TIMEOUT_MS,
    );

    it.skipIf(process.platform === 'win32')(
        'cancels a running page operation and leaves the document unchanged',
        async () => {
            const heldTool = createHeldPageOpsTool(`project8-cancel-page-op-${Date.now()}`);
            const pdfPath = await createMultiPageTextFixturePdf(`project8-cancel-page-op-${Date.now()}.pdf`, 3);
            session = await startElectronE2ESession(`e2e-project8-cancel-page-op-${Date.now()}`, {
                clean: true,
                extraEnv: {EVB_PDF_PAGE_OPS_PATH: heldTool.toolPath},
            });
            await openPdfInApp(session.page, pdfPath, 60_000);
            await waitForPdfLoaded(session.page, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
            const workingCopyDigest = await readDocumentBytes(session!.page, workingCopyPath).then((bytes) =>
                createHash('sha256').update(bytes).digest('hex'),
            );

            heldTool.hold();
            await rotateFirstPageCounterclockwise(session);
            await heldTool.waitUntilHeld();
            // A write with no measurable count keeps visibly moving (contract I4).
            await expect
                .poll(
                    () =>
                        session!.page.evaluate(
                            () => document.querySelector('.workspace-page-op-progress-overlay')?.textContent?.replace(/\s+/gu, ' ') ?? '',
                        ),
                    {timeout: 5_000},
                )
                .toMatch(/\d+:\d{2} elapsed/u);
            await clickPageOperationCancel(session);

            await expect
                .poll(
                    async () =>
                        (
                            await readWorkspaceStateValues<{isPageOperationInProgress?: boolean}>(session!.page, [
                                'isPageOperationInProgress',
                            ])
                        ).isPageOperationInProgress,
                    {timeout: 30_000},
                )
                .toBe(false);
            await expect
                .poll(() => session!.page.evaluate(() => document.body.innerText), {timeout: 10_000})
                .toContain('Page operation canceled. The document is unchanged.');
            expect(await session.page.evaluate(() => document.body.innerText)).not.toContain(ROTATE_FAILURE_TEXT);
            expect(
                await readDocumentBytes(session!.page, workingCopyPath).then((bytes) => createHash('sha256').update(bytes).digest('hex')),
            ).toBe(workingCopyDigest);
            expect((await readPdfPageSnapshots(await readDocumentBytes(session!.page, workingCopyPath)))[0]?.rotation).toBe(0);
            expect(
                (await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState'])).dirtyState?.fileDirty,
            ).toBe(false);

            heldTool.release();
            await rotateFirstPageCounterclockwise(session);
            await expect
                .poll(async () => (await readPdfPageSnapshots(await readDocumentBytes(session!.page, workingCopyPath)))[0]?.rotation, {
                    timeout: 30_000,
                })
                .toBe(270);
        },
        E2E_TIMEOUT_MS,
    );

    // #1598 A (C1 finding 15 kept): Close ends a page operation's read-back that has not returned and asks
    // at once. Cancel and Save keep the document and publish its revision again; Save writes the rotation.
    it.each(['Cancel', 'Discard', 'Save'] as const)(
        'asks at once about a rotation whose read-back has not returned, then answers %s',
        async (decision) => {
            const stamp = Date.now();
            const slug = decision.toLowerCase();
            const pdfPath = await createMultiPageTextFixturePdf(`a-held-read-${slug}-${stamp}.pdf`, 2);
            const originalDigest = await getFileSha256(pdfPath);
            session = await startElectronE2ESession(`e2e-a-held-read-${slug}-${stamp}`, {
                clean: true,
                initialOpenPaths: [pdfPath],
            });
            const page = session.page;
            await waitForPdfLoaded(page, 60_000);
            await waitForViewerInteractive(page, 60_000);
            expect(await readFirstPageShape(page)).toBe('portrait');
            const readFailureNotices = await recordFailureNotices(page);

            await holdNextPdfRead(page);
            await rotateFirstPageCounterclockwise(session);
            await waitForHeldPdfRead(page);
            await clickActiveTabClose(session);
            // The read-back stays held: the question does not wait for it.
            await page.waitForSelector('[role="dialog"]', {
                visible: true,
                timeout: 20_000,
            });
            expect(await page.$$('[role="dialog"]')).toHaveLength(1);
            await clickDirtyTabDecision(session, decision);
            if (decision === 'Cancel') {
                await page.waitForSelector('.editor-pane.is-active .tab.is-active.is-dirty');
                await expect.poll(() => readFirstPageShape(page), {timeout: 30_000}).toBe('landscape');
                expect((await getWorkspaceToolbarSnapshot(page))?.hasPdf).toBe(true);
            } else {
                await expect.poll(async () => (await getWorkspaceToolbarSnapshot(page))?.hasPdf, {timeout: 30_000}).toBe(false);
            }
            if (decision === 'Save') {
                expect((await readPdfPageSnapshots(pdfPath))[0]?.rotation).toBe(270);
            } else {
                expect(await getFileSha256(pdfPath)).toBe(originalDigest);
            }
            expect(await readFailureNotices(), 'no failure is reported').toEqual([]);
        },
        E2E_TIMEOUT_MS,
    );

    // #1598 A (finding 2): Close ends the read-back of a saved revision, so the saved document closes at once.
    it(
        'closes at once after a Save As whose saved revision is still being read back',
        async () => {
            const stamp = Date.now();
            const text = `A held adoption ${stamp}`;
            const pdfPath = await createMultiPageTextFixturePdf(`a-held-adoption-${stamp}.pdf`, 2);
            const destination = join(dirname(pdfPath), `a-held-adoption-${stamp}-saved.pdf`);
            session = await startElectronE2ESession(`e2e-a-held-adoption-${stamp}`, {
                clean: true,
                initialOpenPaths: [pdfPath],
                extraEnv: {EVB_E2E_SAVE_DIALOG_PATH: destination},
            });
            const page = session.page;
            await waitForPdfLoaded(page, 60_000);
            await waitForViewerInteractive(page, 60_000);
            await createCanonicalTextBoxWithPointer(page, text, {
                x: 0.4,
                y: 0.3,
            });
            await waitForSaveFrontierReady(page);
            const readFailureNotices = await recordFailureNotices(page);

            await holdNextPdfRead(page);
            await clickSaveAs(page);
            await waitForHeldPdfRead(page);
            await clickActiveTabClose(session);
            await expect.poll(async () => (await getWorkspaceToolbarSnapshot(page))?.hasPdf, {timeout: 20_000}).toBe(false);
            expect(await page.$$('[role="dialog"]')).toHaveLength(0);
            expect((await readPdfTextAnnotationRecords(destination)).map((record) => record.contents)).toContain(text);
            expect(await readFailureNotices(), 'no failure is reported').toEqual([]);
        },
        E2E_TIMEOUT_MS,
    );

    // #1598 A (window route): the window's question does not wait for a page operation's read-back either.
    it(
        'asks to close the window during a rotation whose read-back has not returned, then saves it',
        async () => {
            const stamp = Date.now();
            const pdfPath = await createMultiPageTextFixturePdf(`a-window-held-read-${stamp}.pdf`, 2);
            session = await startElectronE2ESession(`e2e-a-window-held-read-${stamp}`, {
                clean: true,
                initialOpenPaths: [pdfPath],
            });
            const page = session.page;
            await waitForPdfLoaded(page, 60_000);
            await waitForViewerInteractive(page, 60_000);

            await holdNextPdfRead(page);
            await rotateFirstPageCounterclockwise(session);
            await waitForHeldPdfRead(page);
            await clickWindowDecision(session, 'Save changes', {waitForClose: true});
            expect((await readPdfPageSnapshots(pdfPath))[0]?.rotation).toBe(270);
        },
        E2E_TIMEOUT_MS,
    );

    // #1598 A (window route, N7): an OCR result applied over a pending text box reloads the document, and the window
    // close ends that held read. Its Save shows the revision again before it plans from the PDF, so both are saved.
    it(
        'saves a text box pending under an OCR reload whose read has not returned, then closes the window',
        async () => {
            const stamp = Date.now();
            const recognized = 'Searchable window close';
            const note = `A window OCR note ${stamp}`;
            const pdfPath = await createScannedTextFixturePdf(`a-window-ocr-held-read-${stamp}.pdf`, recognized);
            session = await startElectronE2ESession(`e2e-a-window-ocr-held-read-${stamp}`, {
                clean: true,
                initialOpenPaths: [pdfPath],
            });
            const page = session.page;
            await waitForPdfLoaded(page, 60_000);
            await waitForViewerInteractive(page, 60_000);
            await createCanonicalTextBoxWithPointer(page, note, {
                x: 0.4,
                y: 0.85,
            });
            await waitForSaveFrontierReady(page);
            const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(page);
            const requestId = `a-window-ocr-${stamp}`;
            const ocr = await runOcrSearchablePdf(page, workingCopyPath, requestId, recognized);
            expect(ocr.success).toBe(true);

            await holdNextPdfRead(page);
            // The result is applied as the app applies a finished recognition; it settles only after its held read.
            void callWorkspaceCommand(page, 'handleOcrComplete', [
                {
                    requestId,
                    pdfPath: ocr.pdfPath,
                    sourceDocumentRevisionToken: ocr.sourceDocumentRevisionToken,
                    requiresCleanupAck: true,
                    sourceWorkingCopyPath: workingCopyPath,
                },
            ]).catch(() => undefined);
            await waitForHeldPdfRead(page);
            await clickWindowDecision(session, 'Save changes', {waitForClose: true});
            expect((await readPdfTextAnnotationRecords(pdfPath)).map((record) => record.contents)).toContain(note);
            expect(await assertOcrPdfSemanticOutput(pdfPath, recognized)).toContain(recognized);
        },
        E2E_TIMEOUT_MS,
    );

    // #1598 A (CR-4): a Save after a Save As whose revision was held plans from that revision once it has
    // loaded, and writes the newer edit.
    it(
        'saves the next edit once a held Save As revision has loaded',
        async () => {
            const stamp = Date.now();
            const first = `A first save ${stamp}`;
            const second = `A second save ${stamp}`;
            const pdfPath = await createMultiPageTextFixturePdf(`a-second-save-${stamp}.pdf`, 2);
            const destination = join(dirname(pdfPath), `a-second-save-${stamp}-saved.pdf`);
            session = await startElectronE2ESession(`e2e-a-second-save-${stamp}`, {
                clean: true,
                initialOpenPaths: [pdfPath],
                extraEnv: {EVB_E2E_SAVE_DIALOG_PATH: destination},
            });
            const page = session.page;
            await waitForPdfLoaded(page, 60_000);
            await waitForViewerInteractive(page, 60_000);
            await createCanonicalTextBoxWithPointer(page, first, {
                x: 0.4,
                y: 0.3,
            });
            await waitForSaveFrontierReady(page);
            const readFailureNotices = await recordFailureNotices(page);

            await holdNextPdfRead(page);
            await clickSaveAs(page);
            await waitForHeldPdfRead(page);
            await releaseHeldPdfRead(page);
            await waitForViewerInteractive(page, 60_000);
            await createCanonicalTextBoxWithPointer(page, second, {
                x: 0.4,
                y: 0.6,
            });
            await waitForSaveFrontierReady(page);
            await clickVisibleToolbarButton(page, 'Save');
            await waitForWorkspaceToolbarIdle(page, {timeoutMs: 60_000});
            await expect
                .poll(async () => (await readPdfTextAnnotationRecords(destination)).map((record) => record.contents), {timeout: 30_000})
                .toEqual(expect.arrayContaining([first, second]));
            expect(await readFailureNotices(), 'no failure is reported').toEqual([]);
        },
        E2E_TIMEOUT_MS,
    );

    // #1598 C1 (required row 1): an Undo asked for while the Close question is
    // open takes effect after Cancel, and Save from the question saves and closes.
    it.each(['Cancel', 'Save'] as const)(
        'keeps Undo and Save whole around the Close question: %s',
        async (decision) => {
            const stamp = Date.now();
            const slug = decision.toLowerCase();
            const pdfPath = await createMultiPageTextFixturePdf(`c1-close-question-${slug}-${stamp}.pdf`, 2);
            const originalDigest = await getFileSha256(pdfPath);
            session = await startElectronE2ESession(`e2e-c1-close-question-${slug}-${stamp}`, {
                clean: true,
                initialOpenPaths: [pdfPath],
            });
            const page = session.page;
            await waitForPdfLoaded(page, 60_000);
            await waitForViewerInteractive(page, 60_000);
            await rotateFirstPageCounterclockwise(session);
            await page.waitForSelector('.editor-pane.is-active .tab.is-active.is-dirty');
            await expect.poll(() => readFirstPageShape(page), {timeout: 30_000}).toBe('landscape');
            await waitForWorkspaceToolbarIdle(page, {timeoutMs: 60_000});
            const readFailureNotices = await recordFailureNotices(page);

            await clickActiveTabClose(session);
            await page.waitForSelector('[role="dialog"]', {visible: true});
            if (decision === 'Cancel') {
                await requireWorkspaceCommand(page, 'handleUndo');
                await clickDirtyTabDecision(session, 'Cancel');
                await expect.poll(() => readFirstPageShape(page), {timeout: 30_000}).toBe('portrait');
                await expect.poll(async () => (await getWorkspaceToolbarSnapshot(page))?.canRedo, {timeout: 30_000}).toBe(true);
                expect((await getWorkspaceToolbarSnapshot(page))?.hasPdf).toBe(true);
                expect(await getFileSha256(pdfPath)).toBe(originalDigest);
            } else {
                await clickDirtyTabDecision(session, 'Save');
                await expect.poll(async () => (await getWorkspaceToolbarSnapshot(page))?.hasPdf, {timeout: 60_000}).toBe(false);
                expect((await readPdfPageSnapshots(pdfPath))[0]?.rotation).toBe(270);
            }
            expect(await readFailureNotices(), 'no failure is reported').toEqual([]);
        },
        E2E_TIMEOUT_MS,
    );

    it(
        'Cancel keeps recovered dirty bytes open',
        async () => {
            const recovered = await createRecoveredSession('cancel');
            session = recovered.session;
            await clickWindowDecision(session, 'Cancel');
            expect(session.page.isClosed()).toBe(false);
            const state = await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState']);
            expect(state.dirtyState?.fileDirty).toBe(true);
            expect((await readPdfPageSnapshots(await readDocumentBytes(session.page)))[0]?.rotation).toBe(90);
        },
        E2E_TIMEOUT_MS,
    );

    it.each(['Discard changes', 'Save changes'] as const)(
        'retires only an approved window while another stays open: %s',
        async (decision) => {
            const recovered = await createRecoveredSession(`owner-retirement-${decision.startsWith('Save') ? 'save' : 'discard'}`, {
                largeHistory: true,
            });
            session = recovered.session;
            const active = session;
            // Give the recovered document another edit before closing its window.
            await requireWorkspaceCommand(active.page, 'handleRotateCw', [[1]]);
            await waitForWorkspaceToolbarIdle(active.page);
            const siblingPath = await createMultiPageTextFixturePdf(`retirement-sibling-${Date.now()}.pdf`, 3);
            await createNewWorkspaceTab(active);
            await openPdfInApp(active.page, siblingPath);
            const sibling = await moveTabToNewWindow(active.page, {tabTitle: basename(siblingPath)});
            await installPageEvaluationShims(sibling);
            await waitForViewerInteractive(sibling);
            const siblingCopy = await getActiveWorkspaceWorkingCopyPath(sibling);
            const siblingBytes = await readDocumentBytes(sibling, siblingCopy);
            await activateWorkspaceTab(active, 0);
            await waitForViewerInteractive(active.page);
            await expect
                .poll(
                    () =>
                        readWorkspaceRecoveryRecords<{
                            checkpoint?: {
                                capturedAt?: number;
                                tabs?: Array<{
                                    sourceRef?: string;
                                    isDirty?: boolean;
                                }>;
                            };
                        }>(active.name).some((record) =>
                            record.checkpoint?.tabs?.some((tab) => tab.sourceRef === recovered.pdfPath && tab.isDirty),
                        ),
                    {timeout: 60_000},
                )
                .toBe(true);

            await clickWindowDecision(active, decision, {waitForClose: true});
            expect(sibling.isClosed()).toBe(false);
            await expect(readDocumentBytes(sibling, siblingCopy)).resolves.toEqual(siblingBytes);
            await sibling.waitForFunction(() => document.querySelector('.text-layer')?.textContent?.includes('Fixture 1/3'));
            if (decision.startsWith('Save')) {
                expect((await readPdfPageSnapshots(recovered.pdfPath))[0]?.rotation).toBe(180);
                expect(await readPdfTextAnnotationRecords(recovered.pdfPath)).toEqual(
                    expect.arrayContaining([expect.objectContaining({contents: RECOVERED_ANNOTATION_TEXT})]),
                );
            } else {
                expect((await readPdfPageSnapshots(recovered.pdfPath))[0]?.rotation).toBe(0);
            }
            await expect
                .poll(
                    () =>
                        readWorkspaceRecoveryRecords<{
                            checkpoint?: {
                                capturedAt?: number;
                                tabs?: Array<{sourceRef?: string}>;
                            };
                        }>(active.name).some((record) => record.checkpoint?.tabs?.some((tab) => tab.sourceRef === recovered.pdfPath)),
                    {timeout: 30_000},
                )
                .toBe(false);
            // Starting C exercises startup recovery in the same main process. A's
            // explicit close must never be interpreted as an interrupted renderer.
            const thirdPath = await createMultiPageTextFixturePdf(`retirement-third-${Date.now()}.pdf`, 1);
            await clickAsUser(sibling, '.tab-new');
            await openPdfInApp(sibling, thirdPath);
            const third = await moveTabToNewWindow(sibling, {tabTitle: basename(thirdPath)});
            await installPageEvaluationShims(third);
            await waitForViewerInteractive(third);
            const tabs = await third.$$eval('.tab-list [role="tab"]', (elements) => elements.map((element) => element.textContent));
            expect(tabs.some((text) => text?.includes(basename(recovered.pdfPath)))).toBe(false);
            // B may remount after C and the empty tab displace its clean viewer.
            await waitForViewerInteractive(sibling);
            await sibling.waitForFunction(() => document.querySelector('.text-layer')?.textContent?.includes('Fixture 1/3'));
            await expect(readDocumentBytes(sibling)).resolves.toEqual(siblingBytes);
        },
        E2E_TIMEOUT_MS,
    );

    it(
        'Save commits recovered bytes and permits close without Save As',
        async () => {
            const recovered = await createRecoveredSession('save');
            session = recovered.session;
            await clickWindowDecision(session, 'Save changes', {waitForClose: true});
            await expect.poll(async () => (await readPdfPageSnapshots(recovered.pdfPath))[0]?.rotation, {timeout: 60_000}).toBe(90);
        },
        E2E_TIMEOUT_MS,
    );

    it(
        'rejects Save after the source changes while EVB is stopped',
        async () => {
            // A same-generator 2-page file made in the same second is byte-identical to the
            // source, and recovery accepts a byte-identical replacement (#1359 EC-06). Another
            // page count makes the other program's version really differ.
            const replacementSourcePath = await createMultiPageTextFixturePdf(`project8-close-external-${Date.now()}.pdf`, 3);
            const externalBytes = await readFile(replacementSourcePath);
            const recovered = await createRecoveredSession('external-replacement', {replacementSourcePath});
            session = recovered.session;
            const recoveredWorkingBytes = await readDocumentBytes(session!.page, recovered.workingCopyPath);

            await expect(callWorkspaceCommand<boolean>(session.page, 'handleSave')).resolves.toEqual({
                called: true,
                value: false,
            });
            await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
            const state = await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState']);
            expect(state.dirtyState?.fileDirty).toBe(true);
            await expect(readFile(recovered.pdfPath)).resolves.toEqual(externalBytes);
            await expect(readDocumentBytes(session!.page, recovered.workingCopyPath)).resolves.toEqual(recoveredWorkingBytes);
            expect((await readPdfPageSnapshots(recovered.pdfPath))[0]?.rotation).toBe(0);
            expect((await readPdfPageSnapshots(await readDocumentBytes(session!.page, recovered.workingCopyPath)))[0]?.rotation).toBe(90);
        },
        E2E_TIMEOUT_MS,
    );

    it(
        'Discard closes without committing recovered bytes',
        async () => {
            const recovered = await createRecoveredSession('discard');
            session = recovered.session;
            await clickWindowDecision(session, 'Discard changes', {waitForClose: true});
            await expect.poll(async () => (await readPdfPageSnapshots(recovered.pdfPath))[0]?.rotation, {timeout: 60_000}).toBe(0);
        },
        E2E_TIMEOUT_MS,
    );

    it(
        'failed Save leaves the recovered document dirty and checkpointable',
        async () => {
            const recovered = await createRecoveredSession('failed-save');
            session = recovered.session;
            await appendFile(recovered.pdfPath, Buffer.from('\n% external edit\n'));
            const externalBytes = await readFile(recovered.pdfPath);
            await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
            const saveButtonPoint = await session.page.evaluate(() => {
                const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.save-split-primary')).find((candidate) => {
                    const rect = candidate.getBoundingClientRect();
                    const style = window.getComputedStyle(candidate);
                    return (
                        !candidate.disabled &&
                        style.display !== 'none' &&
                        style.visibility !== 'hidden' &&
                        rect.width > 8 &&
                        rect.height > 8
                    );
                });
                if (!button) {
                    return null;
                }
                const rect = button.getBoundingClientRect();
                return {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                };
            });
            if (!saveButtonPoint) {
                throw new Error('The visible Save button is not enabled');
            }
            await session.page.mouse.click(saveButtonPoint.x, saveButtonPoint.y);
            await session.page.waitForSelector('[aria-label="Last save failed"]', {
                timeout: 60_000,
                visible: true,
            });
            await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
            await clickWindowDecision(session, 'Save changes', {waitForClose: false});
            await session.page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
            await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
            expect(session.page.isClosed()).toBe(false);
            await expect(readFile(recovered.pdfPath)).resolves.toEqual(externalBytes);
            const state = await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session.page, ['dirtyState']);
            expect(state.dirtyState?.fileDirty).toBe(true);
            expect((await readPdfPageSnapshots(await readDocumentBytes(session!.page, recovered.workingCopyPath)))[0]?.rotation).toBe(90);
            await expect
                .poll(
                    async () => {
                        const checkpointSession = session!.name;
                        if (!hasWorkspaceCrashCheckpoint(checkpointSession)) {
                            return null;
                        }
                        const stored = (readWorkspaceRecoveryRecords(checkpointSession)[0] ?? {}) as {
                            checkpoint?: {
                                tabs?: Array<{
                                    isDirty?: boolean;
                                    workingCopyRef?: string | null;
                                }>;
                            };
                        };
                        return stored.checkpoint?.tabs?.[0] ?? null;
                    },
                    {timeout: 60_000},
                )
                .toMatchObject({
                    isDirty: true,
                    workingCopyRef: expect.any(String),
                });
        },
        E2E_TIMEOUT_MS,
    );

    it(
        'retains a failed dirty tab while a sibling tab restores across a crash',
        async () => {
            const firstPdfPath = await createMultiPageTextFixturePdf(`project8-two-tab-failed-${Date.now()}.pdf`, 2);
            const secondPdfPath = await createMultiPageTextFixturePdf(`project8-two-tab-success-${Date.now()}.pdf`, 2);
            const sessionName = `e2e-project8-two-tab-${Date.now()}`;
            session = await startElectronE2ESession(sessionName, {
                clean: true,
                initialOpenPaths: [firstPdfPath],
            });
            await waitForPdfLoaded(session.page, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            const firstWorkingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
            expect(await callWorkspaceCommand(session.page, 'handleRotateCw', [[1]])).toMatchObject({called: true});
            await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});
            const checkpointSession = session.name;
            await expect
                .poll(
                    async () => {
                        if (!hasWorkspaceCrashCheckpoint(checkpointSession)) {
                            return null;
                        }
                        const stored = (readWorkspaceRecoveryRecords(checkpointSession)[0] ?? {}) as {
                            checkpoint?: {
                                tabs?: Array<{
                                    sourceRef?: string | null;
                                    workingCopyRef?: string | null;
                                    isDirty?: boolean;
                                }>;
                            };
                        };
                        return stored.checkpoint?.tabs?.find((tab) => tab.sourceRef === firstPdfPath) ?? null;
                    },
                    {timeout: 60_000},
                )
                .toMatchObject({
                    sourceRef: firstPdfPath,
                    workingCopyRef: firstWorkingCopyPath,
                    isDirty: true,
                });

            await createNewWorkspaceTab(session);
            await openPdfInApp(session.page, secondPdfPath, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            const secondWorkingCopyPath = await getActiveWorkspaceWorkingCopyPath(session.page);
            expect(await callWorkspaceCommand(session.page, 'handleRotateCw', [[1]])).toMatchObject({called: true});
            await waitForWorkspaceToolbarIdle(session.page, {timeoutMs: 60_000});

            await expect
                .poll(
                    async () => {
                        if (!hasWorkspaceCrashCheckpoint(checkpointSession)) {
                            return null;
                        }
                        const stored = (readWorkspaceRecoveryRecords(checkpointSession)[0] ?? {}) as {
                            checkpoint?: {
                                tabs?: Array<{
                                    sourceRef?: string | null;
                                    workingCopyRef?: string | null;
                                    isDirty?: boolean;
                                }>;
                            };
                        };
                        return stored.checkpoint?.tabs ?? null;
                    },
                    {timeout: 60_000},
                )
                .toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            sourceRef: firstPdfPath,
                            isDirty: true,
                        }),
                        expect.objectContaining({
                            sourceRef: secondPdfPath,
                            isDirty: true,
                        }),
                    ]),
                );
            expect((await readPdfPageSnapshots(await readDocumentBytes(session!.page, firstWorkingCopyPath)))[0]?.rotation).toBe(90);
            expect((await readPdfPageSnapshots(await readDocumentBytes(session!.page, secondWorkingCopyPath)))[0]?.rotation).toBe(90);
            const firstRecoverySidecarPaths = [join(dirname(firstWorkingCopyPath), 'manifest.json')];
            expect(firstRecoverySidecarPaths.every((path) => existsSync(path))).toBe(true);

            const initialCheckpoint = (readWorkspaceRecoveryRecords(checkpointSession)[0] ?? {}) as {
                checkpoint?: {
                    tabs?: Array<{
                        sourceRef?: string | null;
                        workingCopyRef?: string | null;
                        isDirty?: boolean;
                    }>;
                };
            };
            const initialTabs = initialCheckpoint.checkpoint?.tabs ?? [];
            const failedTab = initialTabs.find((tab) => tab.sourceRef === firstPdfPath);
            const successfulTab = initialTabs.find((tab) => tab.sourceRef === secondPdfPath);
            expect(failedTab?.workingCopyRef).toBe(firstWorkingCopyPath);
            expect(successfulTab?.workingCopyRef).toBe(secondWorkingCopyPath);

            const firstDocumentDirectory = dirname(firstWorkingCopyPath);
            const revision = decodeManifest(await readFile(join(firstDocumentDirectory, 'manifest.json'))).current;
            if (!revision) {
                throw new Error('Rotation did not create a document revision');
            }
            const revisionPath = join(firstDocumentDirectory, revision.file);
            const unavailableWorkingCopyPath = `${revisionPath}.project8-open-failure`;
            const crashed = session;
            await crashed.browser.disconnect();
            await stopSingleSession(crashed.name, {
                preserveWorkspaceCheckpoint: true,
                crashElectronBeforeStop: true,
            });

            await rename(revisionPath, unavailableWorkingCopyPath);
            session = await startElectronE2ESession(sessionName, {clean: false});

            await activateTabWithWorkingCopy(session, secondWorkingCopyPath, secondPdfPath);
            await waitForPdfLoaded(session.page, 60_000);
            await expect
                .poll(
                    async () => {
                        if (!hasWorkspaceCrashCheckpoint(checkpointSession)) {
                            return null;
                        }
                        const stored = (readWorkspaceRecoveryRecords(checkpointSession)[0] ?? {}) as {
                            checkpoint?: {
                                tabs?: Array<{
                                    sourceRef?: string | null;
                                    workingCopyRef?: string | null;
                                    isDirty?: boolean;
                                }>;
                            };
                        };
                        return stored.checkpoint?.tabs?.find((tab) => tab.sourceRef === firstPdfPath) ?? null;
                    },
                    {timeout: 60_000},
                )
                .toMatchObject({
                    sourceRef: firstPdfPath,
                    workingCopyRef: firstWorkingCopyPath,
                    isDirty: true,
                });
            expect(firstRecoverySidecarPaths.every((path) => existsSync(path))).toBe(true);
            await rename(unavailableWorkingCopyPath, revisionPath);

            expect((await readPdfPageSnapshots(revisionPath))[0]?.rotation).toBe(90);
            expect((await readPdfPageSnapshots(await readDocumentBytes(session!.page, secondWorkingCopyPath)))[0]?.rotation).toBe(90);

            const failedRestart = session;
            await failedRestart.browser.disconnect();
            await stopSingleSession(failedRestart.name, {
                preserveWorkspaceCheckpoint: true,
                crashElectronBeforeStop: true,
            });
            session = await startElectronE2ESession(sessionName, {clean: false});
            const finalFailedState = await activateTabWithWorkingCopy(session, firstWorkingCopyPath, firstPdfPath);
            await waitForPdfLoaded(session.page, 60_000);
            const recoveryPage = session.page;
            const settledFailedState = await readWorkspaceStateValues<
                IRecoveryAutomationState & {
                    originalPath?: string | null;
                    workingCopyPath?: string | null;
                }
            >(session.page, ['dirtyState', 'originalPath', 'workingCopyPath']);
            expect(finalFailedState?.workingCopyPath).toEqual(expect.any(String));
            expect(settledFailedState.workingCopyPath).toEqual(expect.any(String));
            expect(settledFailedState.originalPath).toBe(firstPdfPath);
            await expect
                .poll(async () => (await readWorkspaceStateValues<IRecoveryAutomationState>(recoveryPage, ['dirtyState'])).dirtyState, {
                    timeout: 60_000,
                })
                .toMatchObject({
                    fileDirty: true,
                    recoveryDirtyBaseline: true,
                });
            expect((await readPdfPageSnapshots(await readDocumentBytes(session!.page, firstWorkingCopyPath)))[0]?.rotation).toBe(90);
            await expect
                .poll(
                    async () => {
                        if (!hasWorkspaceCrashCheckpoint(checkpointSession)) {
                            return null;
                        }
                        const stored = (readWorkspaceRecoveryRecords(checkpointSession)[0] ?? {}) as {
                            checkpoint?: {
                                tabs?: Array<{
                                    sourceRef?: string | null;
                                    workingCopyRef?: string | null;
                                    isDirty?: boolean;
                                }>;
                            };
                        };
                        return stored.checkpoint?.tabs?.find((tab) => tab.sourceRef === firstPdfPath) ?? null;
                    },
                    {timeout: 60_000},
                )
                .toMatchObject({
                    sourceRef: firstPdfPath,
                    workingCopyRef: firstWorkingCopyPath,
                    isDirty: true,
                });
            const finalSuccessfulState = await activateTabWithWorkingCopy(session, secondWorkingCopyPath, secondPdfPath);
            await waitForPdfLoaded(session.page, 60_000);
            const settledSuccessfulState = await readWorkspaceStateValues<{workingCopyPath?: string | null}>(session.page, [
                'workingCopyPath',
            ]);
            expect(finalSuccessfulState?.workingCopyPath).toEqual(expect.any(String));
            expect(settledSuccessfulState.workingCopyPath).toEqual(expect.any(String));
            expect(
                (await readPdfPageSnapshots(await readDocumentBytes(session!.page, settledSuccessfulState.workingCopyPath!)))[0]?.rotation,
            ).toBe(90);
            expect((await readPdfPageSnapshots(await readDocumentBytes(session!.page, secondWorkingCopyPath)))[0]?.rotation).toBe(90);
        },
        E2E_TIMEOUT_MS,
    );

    it(
        'keeps dirty checkpoints separate across two windows and a restart',
        async () => {
            const firstPdfPath = await createMultiPageTextFixturePdf(`project8-owner-a-${Date.now()}.pdf`, 1);
            const secondPdfPath = await createMultiPageTextFixturePdf(`project8-owner-b-${Date.now()}.pdf`, 1);
            const sessionName = `e2e-project8-owner-isolation-${Date.now()}`;
            session = await startElectronE2ESession(sessionName, {
                clean: true,
                initialOpenPaths: [firstPdfPath],
            });
            await waitForPdfLoaded(session.page, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            await expect(callWorkspaceCommand(session.page, 'handleRotateCw', [[1]])).resolves.toMatchObject({called: true});

            await createNewWorkspaceTab(session);
            await openPdfInApp(session.page, secondPdfPath, 60_000);
            await expect(callWorkspaceCommand(session.page, 'handleRotateCw', [[1]])).resolves.toMatchObject({called: true});
            await clickAsUser(session.page, '.tab-list .tab[data-tab-id]:last-child', {button: 'right'});
            await session.page.waitForSelector('.tab-context-menu');
            await clickFoundAsUser(
                session.page,
                () =>
                    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((candidate) =>
                        (candidate.textContent ?? '').toLowerCase().includes('move tab to new window'),
                    ),
                null,
                {description: 'Move Tab to New Window'},
            );

            const appPages = async () =>
                (await session!.browser.pages()).filter(
                    (page) =>
                        !page.isClosed() &&
                        (page.url().startsWith('evb-viewer://app/') ||
                            page.url().includes('localhost:') ||
                            page.url().includes('127.0.0.1:')),
                );
            await expect.poll(async () => (await appPages()).length, {timeout: 60_000}).toBe(2);
            const livePages = await appPages();
            await Promise.all(livePages.map((page) => waitForViewerInteractive(page, 60_000)));

            const checkpointSession = session.name;
            // Each window debounces its own record, so the journal reaches two
            // records while the source window still lists the moved tab and the new
            // window lists an empty tab. Crash only once each record holds exactly
            // its own dirty document.
            await expect
                .poll(
                    async () => {
                        try {
                            const stored = {records: readWorkspaceRecoveryRecords(checkpointSession)} as {
                                records?: Array<{
                                    checkpoint: {
                                        tabs: Array<{
                                            sourceRef?: string | null;
                                            workingCopyRef?: string | null;
                                            isDirty?: boolean;
                                        }>;
                                    };
                                }>;
                            };
                            return (stored.records ?? [])
                                .map((record) =>
                                    record.checkpoint.tabs.map((tab) => (tab.isDirty && tab.workingCopyRef ? tab.sourceRef : null)),
                                )
                                .sort((left, right) => String(left).localeCompare(String(right)));
                        } catch {
                            return [];
                        }
                    },
                    {timeout: 60_000},
                )
                .toEqual([[firstPdfPath], [secondPdfPath]]);

            await session.browser.disconnect();
            await stopSingleSession(session.name, {
                preserveWorkspaceCheckpoint: true,
                crashElectronBeforeStop: true,
            });
            session = await startElectronE2ESession(sessionName, {clean: false});
            await waitForPdfLoaded(session.page, 60_000);
            await waitForViewerInteractive(session.page, 60_000);
            await expect.poll(async () => (await appPages()).length, {timeout: 60_000}).toBe(2);

            const recoveredPages = await appPages();
            await expect
                .poll(
                    async () => {
                        const recoveredFileNames = await Promise.all(
                            recoveredPages.map((page) =>
                                page.evaluate(() => document.querySelector('.tab-list .tab[data-tab-id]')?.textContent?.trim() ?? ''),
                            ),
                        );
                        return ['project8-owner-a-', 'project8-owner-b-'].every((owner) =>
                            recoveredFileNames.some((name) => name.includes(owner)),
                        );
                    },
                    {timeout: 60_000},
                )
                .toBe(true);
            await expect
                .poll(
                    async () => {
                        const recoveredDirtyStates = await Promise.all(
                            recoveredPages.map((page) =>
                                readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(page, ['dirtyState']),
                            ),
                        );
                        return recoveredDirtyStates.every((state) => state.dirtyState?.fileDirty === true);
                    },
                    {timeout: 60_000},
                )
                .toBe(true);
        },
        E2E_TIMEOUT_MS,
    );
});

describe('Project 8 session owner lifetime', () => {
    it(
        'stops the session and its Electron when the owning process dies without stopping it',
        async () => {
            const sessionName = createE2ERunScopedSessionName(`e2e-project8-owner-lost-${Date.now()}`);
            const owner = spawn(
                process.execPath,
                ['--import', 'tsx', join(projectRoot, 'tests', 'e2e', 'electron', 'helpers', 'holdE2ESessionOwner.ts'), sessionName],
                {
                    cwd: projectRoot,
                    stdio: ['ignore', 'pipe', 'inherit'],
                },
            );
            onTestFinished(async () => {
                owner.kill('SIGKILL');
                await stopSingleSession(sessionName);
            });
            await new Promise<void>((resolve, reject) => {
                let output = '';
                owner.stdout.on('data', (chunk: Buffer) => {
                    output += chunk.toString();
                    if (/^ready$/mu.test(output)) {
                        resolve();
                    }
                });
                owner.once('exit', (code, signal) =>
                    reject(new Error(`Session owner exited before readiness (code ${String(code)}, signal ${String(signal)})`)),
                );
            });
            const info = getSessionInfo(sessionName);
            const sessionPids = [info?.pid, info?.electronPid];
            expect(sessionPids).toEqual([expect.any(Number), expect.any(Number)]);
            expect(sessionPids.every((pid) => isProcessAlive(pid!))).toBe(true);

            // SIGKILL stands in for a cancelled or crashed Vitest worker: the
            // owner gets no chance to stop the session.
            owner.kill('SIGKILL');
            await expect.poll(() => sessionPids.filter((pid) => isProcessAlive(pid!)), {timeout: 30_000}).toEqual([]);
            expect(getSessionInfo(sessionName)).toBeNull();
        },
        E2E_TIMEOUT_MS,
    );
});
