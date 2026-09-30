import {
    copyFileSync,
    rmSync,
} from 'node:fs';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import type { Page } from 'puppeteer-core';
import {
    createFixturePath,
    resolveNativeLargePdfFixtureAvailability,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {getActiveWorkspaceWorkingCopyPath} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {readPdfAnnotationIndex} from '@tests/e2e/electron/helpers/readPdfAnnotationIndex';
import {createCanonicalTextBoxWithPointer} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    activatePaneByTab,
    openNewPane,
    splitActiveTabFromTabMenu,
} from '@tests/e2e/electron/helpers/workspaceTabs';
import {
    getLatestAutomationEventId,
    getWorkspaceToolbarSnapshot,
    waitForAutomationEvent,
    type IWorkspaceExposeProbeWindow,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    qpdfCheck,
    qpdfDictionaryContainsText,
    readQpdfObject,
} from './largePdfAnnotationSaveShared';

// Behavior contract T4. Split Right from a tab shows the same oversized PDF in
// a second view: one working copy, shared edits and one save, and closing one
// view keeps the document. New Pane plus a separate open of the same path stays
// an independent document with its own working copy.

const LIFECYCLE_TIMEOUT_MS = 360_000;
const SPLIT_VIEW_TIMEOUT_MS = 60_000;
const NEW_PANE_COUNT = 4;
const sourceFixture = resolveNativeLargePdfFixtureAvailability(2);
const lifecycleDescribe = selectFixtureDescribe(describe, sourceFixture);

async function waitForActivePdfReady(session: IElectronE2ESession) {
    await waitForPdfLoaded(session.page, LIFECYCLE_TIMEOUT_MS);
    await waitForViewerInteractive(session.page, LIFECYCLE_TIMEOUT_MS);
}

function requireFixturePath() {
    if (!sourceFixture.path) {
        throw new Error(`Large PDF split-pane fixture unavailable: ${sourceFixture.reason}`);
    }
    return sourceFixture.path;
}

async function paneIds(page: Page) {
    return page.$$eval('.editor-pane', panes => panes.map(pane => (pane as HTMLElement).dataset.editorPaneId ?? ''));
}

interface IPaneTab {
    label: string | null;
    dirty: boolean;
    showsStart: boolean;
    renderedTexts: string[];
}

interface IPaneTabExpectation {
    label?: string | null;
    dirty?: boolean;
    showsStart?: boolean;
    rendersText?: string;
}

// Runs in the page: what a person sees in one pane's tab and page layer.
function readPaneTabInPage(paneId: string): IPaneTab | null {
    const pane = document.querySelector<HTMLElement>(`.editor-pane[data-editor-pane-id="${paneId}"]`);
    if (!pane) {
        return null;
    }
    const tab = pane.querySelector<HTMLElement>('.tab.is-active[data-tab-id]');
    return {
        label: tab?.querySelector('.tab-label')?.textContent?.trim() ?? null,
        dirty: tab?.classList.contains('is-dirty') ?? false,
        showsStart: Array.from(pane.querySelectorAll<HTMLElement>('.start-open-panel'))
            .some(panel => panel.getBoundingClientRect().width > 0),
        renderedTexts: Array.from(pane.querySelectorAll('.pdf-annotation-editor-layer [data-annotation-kind="text-box"]'))
            .map(element => element.textContent?.replace(/[\u200B\uFEFF]/gu, '').trim() ?? '')
            .filter(Boolean),
    };
}

/** Waits until the pane shows every expectation, and names what it showed when it does not. */
async function waitForPaneTab(page: Page, paneId: string, label: string, expected: IPaneTabExpectation) {
    try {
        await page.waitForFunction(`(() => {
            const tab = (${readPaneTabInPage.toString()})(${JSON.stringify(paneId)});
            const expected = ${JSON.stringify(expected)};
            return Boolean(tab
                && (expected.label === undefined || tab.label === expected.label)
                && (expected.dirty === undefined || tab.dirty === expected.dirty)
                && (expected.showsStart === undefined || tab.showsStart === expected.showsStart)
                && (expected.rendersText === undefined || tab.renderedTexts.includes(expected.rendersText)));
        })()`, {timeout: SPLIT_VIEW_TIMEOUT_MS});
    } catch (error) {
        throw new Error(`${label}: ${JSON.stringify(await page.evaluate(readPaneTabInPage, paneId))}`, {cause: error});
    }
}

async function clickToolbarSave(page: Page) {
    const target = await page.waitForFunction(() => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('#editor-global-toolbar-host button[aria-label]'))
            .find((candidate) => {
                const label = candidate.getAttribute('aria-label') ?? '';
                const rect = candidate.getBoundingClientRect();
                return (label === 'Save' || label.startsWith('Save ('))
                    && !candidate.disabled && rect.width > 0 && rect.height > 0;
            });
        const rect = button?.getBoundingClientRect();
        return rect
            ? {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            }
            : null;
    }, {timeout: SPLIT_VIEW_TIMEOUT_MS});
    const point = await target.jsonValue();
    await target.dispose();
    if (!point) {
        throw new Error('No enabled Save control');
    }
    await page.mouse.click(point.x, point.y);
}

function countSaveEvents(page: Page, afterEventId: number) {
    return page.evaluate((after: number) => (window as IWorkspaceExposeProbeWindow).__evbTestApi?.getAutomationEvents?.()
        .filter(event => event.type === 'save-committed' && event.id > after).length ?? 0, afterEventId);
}

async function readSavedFreeTextContents(filePath: string, expectedText: string) {
    const index = await readPdfAnnotationIndex(filePath);
    for (const entry of index.entries.filter(candidate => candidate.subtype === 'FreeText' || candidate.subtype === '/FreeText')) {
        if (entry.objectNumber === 0) {
            continue;
        }
        const object = await readQpdfObject(filePath, entry, 'none');
        if (qpdfDictionaryContainsText(object, 'Contents', expectedText)) {
            return true;
        }
    }
    return false;
}

lifecycleDescribe('Electron E2E - Large PDF split-pane lifecycle', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-native-pdf-split-lifecycle-${Date.now()}`,
        timeoutMs: LIFECYCLE_TIMEOUT_MS,
    });

    it('shows a Split Right view of an oversized PDF as the same document', async () => {
        const session = sessionFixture.getSession();
        const {page} = session;
        // The case saves, so it works on its own copy of the shared fixture.
        const documentPath = createFixturePath(`native-pdf-linked-split-${Date.now()}.pdf`);
        copyFileSync(requireFixturePath(), documentPath);
        onTestFinished(() => rmSync(documentPath, {force: true}));

        await openPdfInApp(page, documentPath, LIFECYCLE_TIMEOUT_MS);
        await waitForActivePdfReady(session);
        const [sourcePane] = await paneIds(page);
        const source = await page.evaluate(readPaneTabInPage, sourcePane!);
        if (!source) {
            throw new Error('The source pane is not rendered');
        }
        const sourceWorkingCopy = await getActiveWorkspaceWorkingCopyPath(page);

        await splitActiveTabFromTabMenu(page, 'right');
        const [
            leftPane,
            rightPane,
        ] = await paneIds(page);
        expect(leftPane).toBe(sourcePane);
        await waitForPaneTab(page, rightPane!, 'Split Right must show the source document in the new pane', {
            showsStart: false,
            label: source.label,
        });
        await waitForActivePdfReady(session);
        expect(await getActiveWorkspaceWorkingCopyPath(page), 'a linked view uses the source working copy').toBe(sourceWorkingCopy);
        expect(await getWorkspaceToolbarSnapshot(page)).toMatchObject({totalPages: 2});

        // An edit made in the left view renders in the right view, and both are dirty.
        const text = `LINKED-SPLIT-${Date.now()}`;
        await activatePaneByTab(page, leftPane!);
        await createCanonicalTextBoxWithPointer(page, text, {
            x: 0.4,
            y: 0.3,
        }, 1);
        await waitForPaneTab(page, rightPane!, 'the left edit renders in the right view', {
            dirty: true,
            rendersText: text,
        });

        // Save from the right view writes the one document once.
        await activatePaneByTab(page, rightPane!);
        const saveBaseline = await getLatestAutomationEventId(page);
        await clickToolbarSave(page);
        await waitForAutomationEvent(page, 'save-committed', {
            afterEventId: saveBaseline,
            path: documentPath,
            timeoutMs: LIFECYCLE_TIMEOUT_MS,
        });
        for (const paneId of [
            leftPane!,
            rightPane!,
        ]) {
            await waitForPaneTab(page, paneId, 'both views are saved', {dirty: false});
        }
        expect(await countSaveEvents(page, saveBaseline), 'one Save writes the file once').toBe(1);
        await qpdfCheck(documentPath);
        expect(await readSavedFreeTextContents(documentPath, text)).toBe(true);

        // Closing the right view keeps the document open in the left one.
        const closeTarget = await page.$eval(
            `.editor-pane[data-editor-pane-id="${rightPane!}"] .tab.is-active[data-tab-id] .tab-close`,
            (button) => {
                const rect = button.getBoundingClientRect();
                return {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                };
            },
        );
        await page.mouse.click(closeTarget.x, closeTarget.y);
        await page.waitForFunction(() => document.querySelectorAll('.editor-pane').length === 1, {timeout: SPLIT_VIEW_TIMEOUT_MS});
        await waitForPaneTab(page, leftPane!, 'the remaining view keeps the document', {
            showsStart: false,
            label: source.label,
            rendersText: text,
        });
        await waitForActivePdfReady(session);
        expect(await getActiveWorkspaceWorkingCopyPath(page)).toBe(sourceWorkingCopy);
    }, LIFECYCLE_TIMEOUT_MS);

    it('keeps New Pane reopenings of an oversized PDF independent', async () => {
        const session = sessionFixture.getSession();
        const {page} = session;
        const fixturePath = requireFixturePath();

        await session.page.setViewport({
            deviceScaleFactor: 2,
            height: 1_200,
            width: 4_000,
        });
        await openPdfInApp(page, fixturePath, LIFECYCLE_TIMEOUT_MS);
        await waitForActivePdfReady(session);

        for (let paneIndex = 1; paneIndex < NEW_PANE_COUNT; paneIndex += 1) {
            await openNewPane(page, 'right');
            await openPdfInApp(page, fixturePath, LIFECYCLE_TIMEOUT_MS);
            await waitForActivePdfReady(session);
        }

        const ids = await paneIds(page);
        expect(ids).toHaveLength(NEW_PANE_COUNT);
        expect(ids.every(Boolean)).toBe(true);

        const workingCopyPaths: string[] = [];
        for (const paneId of ids) {
            await activatePaneByTab(page, paneId);
            await waitForActivePdfReady(session);
            workingCopyPaths.push(await getActiveWorkspaceWorkingCopyPath(page));
            expect(await getWorkspaceToolbarSnapshot(page)).toMatchObject({
                currentPage: 1,
                totalPages: 2,
            });
        }
        expect(new Set(workingCopyPaths).size).toBe(NEW_PANE_COUNT);

        for (const paneId of ids) {
            await activatePaneByTab(page, paneId);
            await waitForActivePdfReady(session);
            expect(await getWorkspaceToolbarSnapshot(page)).toMatchObject({
                currentPage: 1,
                totalPages: 2,
            });
        }
    }, LIFECYCLE_TIMEOUT_MS);
});
