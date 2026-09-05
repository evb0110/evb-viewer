import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { delay } from 'es-toolkit/promise';
import type { Page } from 'puppeteer-core';
import {
    createLargeScannedFixturePdf,
    createMultiPageTextFixturePdf,
    cleanupRunFixtures,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    openAnnotationsTab,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    createFreeTextAnnotation,
    createFreeTextAnnotationWithPointer,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import { startElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    getLatestAutomationEventId,
    getWorkspaceToolbarSnapshot,
    readWorkspaceStateValues,
    waitForAutomationEvent,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const BLOCKING_SMOKE_TIMEOUT_MS = 120_000;
const SAVE_TIMEOUT_MS = 45_000;

function hashFile(filePath: string) {
    return createHash('sha256')
        .update(readFileSync(filePath))
        .digest('hex');
}

async function waitForToolbarCanSave(page: Page) {
    const startedAt = Date.now();
    let snapshot = await getWorkspaceToolbarSnapshot(page);

    while (Date.now() - startedAt < 15_000) {
        if (snapshot?.canSave === true && snapshot.isAnySaving !== true) {
            return;
        }
        await delay(150);
        snapshot = await getWorkspaceToolbarSnapshot(page);
    }

    throw new Error(`Save did not become available: ${JSON.stringify(snapshot)}`);
}

async function waitForAnnotationChange(page: Page) {
    const startedAt = Date.now();
    let dirtyState = (await readWorkspaceStateValues<{dirtyState?: {hasAnnotationChanges?: boolean;};}>(page, ['dirtyState'])).dirtyState;

    while (Date.now() - startedAt < 15_000) {
        if (dirtyState?.hasAnnotationChanges === true) {
            return;
        }
        await delay(150);
        dirtyState = (await readWorkspaceStateValues<{dirtyState?: {hasAnnotationChanges?: boolean;};}>(page, ['dirtyState'])).dirtyState;
    }

    throw new Error(`FreeText editor did not enter PDF.js annotation storage: ${JSON.stringify(dirtyState)}`);
}

async function clickVisibleSaveToolbarButton(page: Page) {
    const clicked = await page.evaluate(() => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0
            );
        };

        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
            .find(candidate => (
                candidate.getAttribute('aria-label')?.trim() === 'Save'
                && !candidate.disabled
                && candidate.getAttribute('aria-disabled') !== 'true'
                && isVisible(candidate)
            ));
        button?.click();
        return Boolean(button);
    });

    if (!clicked) {
        throw new Error(`Visible enabled Save toolbar button not found: ${JSON.stringify(await getWorkspaceToolbarSnapshot(page))}`);
    }
}

async function clickVisibleToolbarButton(page: Page, label: string) {
    const clicked = await page.evaluate((buttonLabel) => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
            .find(candidate => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return candidate.getAttribute('aria-label')?.trim() === buttonLabel
                    && !candidate.disabled
                    && candidate.getAttribute('aria-disabled') !== 'true'
                    && rect.width > 0
                    && rect.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
        button?.click();
        return Boolean(button);
    }, label);
    if (!clicked) {
        throw new Error(`Visible enabled ${label} toolbar button not found`);
    }
}

async function readOpenSurfaceState(page: Page) {
    return page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>('[data-open-surface-generation]');
        return surface ? {
            generation: Number(surface.dataset.openSurfaceGeneration),
            documentRevision: surface.dataset.openSurfaceDocumentRevision ?? null,
            lifecycle: surface.dataset.viewportLifecycle ?? null,
            requestedPage: Number(surface.dataset.viewportRequestedPage),
            committedPage: Number(surface.dataset.viewportCommittedPage),
            visualPresentation: surface.dataset.viewportVisualPresentation ?? null,
        } : null;
    });
}

async function waitForFreeTextAnnotationOnDisk(filePath: string) {
    const startedAt = Date.now();
    let summary = await readPdfAnnotationSummary(filePath);

    while (Date.now() - startedAt < 20_000) {
        if ((summary.bySubtype.FreeText ?? 0) > 0) {
            return summary;
        }
        await delay(150);
        summary = await readPdfAnnotationSummary(filePath);
    }

    throw new Error(`Expected saved FreeText annotation on disk: ${JSON.stringify(summary)}`);
}

describe('Electron E2E - Blocking PDF Save Smoke', () => {
    let session: IElectronE2ESession | null = null;

    afterEach(async () => {
        await session?.stop();
        session = null;
    });

    // These smoke cases still create annotations through the retired PDF.js
    // editor. #187 and #186 will re-enable the same save coverage through the
    // canonical EVB surface and Rust writer.
    it.skip('opens a startup PDF path, creates a visible annotation, and saves it to disk', async () => {
        const pdfPath = await createMultiPageTextFixturePdf(`blocking-save-smoke-${Date.now()}.pdf`, 3);
        const beforeHash = hashFile(pdfPath);

        session = await startElectronE2ESession(`e2e-blocking-save-smoke-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        const { page } = session;

        await Promise.all([
            waitForAutomationEvent(page, 'document-opened', {
                path: pdfPath,
                timeoutMs: 45_000,
            }),
            waitForAutomationEvent(page, 'first-page-rendered', {
                path: pdfPath,
                timeoutMs: 45_000,
            }),
        ]);

        await page.waitForFunction(
            () => document.querySelector('#evb-startup-overlay') === null,
            {timeout: BLOCKING_SMOKE_TIMEOUT_MS / 2},
        );

        const startupState = await readWorkspaceStateValues<{originalPath?: string | null;}>(page, ['originalPath']);
        const readinessState = await page.evaluate(() => ({
            appReady: (window as Window & {__appReady?: boolean}).__appReady ?? false,
            appReadyAt: (window as Window & {__appReadyAt?: number}).__appReadyAt ?? null,
            firstPagePaintedAt: performance
                .getEntriesByName('evb:first-page-painted', 'mark')
                .at(-1)?.startTime ?? null,
            navigationStartedAt: performance.timeOrigin,
            overlayPresent: document.querySelector('#evb-startup-overlay') !== null,
        }));
        expect(startupState.originalPath).toBe(pdfPath);
        expect(readinessState.overlayPresent).toBe(false);
        expect(readinessState.appReady).toBe(true);
        expect(readinessState.appReadyAt).not.toBeNull();
        expect(readinessState.firstPagePaintedAt).not.toBeNull();
        await waitForPdfLoaded(page, 30_000);
        await waitForViewerInteractive(page, 30_000);

        await openAnnotationsTab(page, 30_000);
        const annotationText = `Blocking smoke FreeText ${Date.now()}`;
        const createdCount = await createFreeTextAnnotation(page, annotationText);
        expect(createdCount).toBeGreaterThan(0);
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await waitForAnnotationChange(page);
        await waitForToolbarCanSave(page);

        const saveBaselineEventId = await getLatestAutomationEventId(page);
        const saveCommitted = waitForAutomationEvent(page, 'save-committed', {
            afterEventId: saveBaselineEventId,
            path: pdfPath,
            timeoutMs: SAVE_TIMEOUT_MS,
        });
        await clickVisibleSaveToolbarButton(page);
        await saveCommitted;

        const afterHash = hashFile(pdfPath);
        expect(afterHash).not.toBe(beforeHash);

        const summary = await waitForFreeTextAnnotationOnDisk(pdfPath);
        expect(summary.bySubtype.FreeText ?? 0).toBeGreaterThan(0);

        const initialSurface = await readOpenSurfaceState(page);
        expect(initialSurface).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 1,
            committedPage: 1,
            visualPresentation: 'canvas',
        });
        await clickVisibleToolbarButton(page, 'Next Page');
        await page.waitForFunction(
            (generation) => {
                const surface = document.querySelector<HTMLElement>('[data-open-surface-generation]');
                return Number(surface?.dataset.openSurfaceGeneration) === generation
                    && surface?.dataset.viewportLifecycle === 'ready'
                    && surface.dataset.viewportRequestedPage === '2'
                    && surface.dataset.viewportCommittedPage === '2'
                    && surface.dataset.viewportVisualPresentation === 'canvas';
            },
            {timeout: 30_000},
            initialSurface!.generation,
        );
        const navigatedSurface = await readOpenSurfaceState(page);
        expect(navigatedSurface).toMatchObject({
            generation: initialSurface!.generation,
            documentRevision: initialSurface!.documentRevision,
            lifecycle: 'ready',
            requestedPage: 2,
            committedPage: 2,
            visualPresentation: 'canvas',
        });
    }, BLOCKING_SMOKE_TIMEOUT_MS);

    it.skip('saves one bounded pressure annotation and reopens it in a fresh Electron process', async () => {
        const runOwner = `blocking-pressure-save-${Date.now()}`;
        const pdfPath = await createLargeScannedFixturePdf(
            'blocking-pressure-annotation.pdf',
            431,
            28 * 1024 * 1024,
            1,
            {runOwner},
        );
        onTestFinished(() => cleanupRunFixtures(runOwner));
        const annotationText = `blocking pressure annotation ${Date.now()}`;

        session = await startElectronE2ESession(`e2e-blocking-pressure-save-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await Promise.all([
            waitForAutomationEvent(session.page, 'document-opened', {
                path: pdfPath,
                timeoutMs: 60_000,
            }),
            waitForAutomationEvent(session.page, 'first-page-rendered', {
                path: pdfPath,
                timeoutMs: 60_000,
            }),
        ]);
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await openAnnotationsTab(session.page, 30_000);
        expect(await createFreeTextAnnotationWithPointer(session.page, annotationText, {
            x: 0.5,
            y: 0.5,
        })).toBeGreaterThan(0);
        await expect.poll(async () => (
            await readWorkspaceStateValues<{dirtyState?: {hasAnnotationChanges?: boolean;}}>(
                session!.page,
                ['dirtyState'],
            )
        ).dirtyState?.hasAnnotationChanges ?? false, {timeout: 20_000}).toBe(true);

        const saveBaselineEventId = await getLatestAutomationEventId(session.page);
        await saveViaWindowHandle(session.page, 60_000);
        await waitForAutomationEvent(session.page, 'save-committed', {
            afterEventId: saveBaselineEventId,
            path: pdfPath,
            timeoutMs: 60_000,
        });
        await expect.poll(async () => (
            await readWorkspaceStateValues<{dirtyState?: {
                fileDirty?: boolean;
                hasPendingUnsavedChanges?: boolean;
            };}>(session!.page, ['dirtyState'])
        ).dirtyState, {timeout: 20_000}).toMatchObject({
            fileDirty: false,
            hasPendingUnsavedChanges: false,
        });
        const savedSummary = await readPdfAnnotationSummary(pdfPath);
        expect(savedSummary.bySubtype.FreeText ?? 0).toBeGreaterThan(0);

        const savedSession = session;
        session = null;
        await savedSession.stop();
        session = await startElectronE2ESession(`e2e-blocking-pressure-reopen-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await Promise.all([
            waitForAutomationEvent(session.page, 'document-opened', {
                path: pdfPath,
                timeoutMs: 60_000,
            }),
            waitForAutomationEvent(session.page, 'first-page-rendered', {
                path: pdfPath,
                timeoutMs: 60_000,
            }),
        ]);
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.FreeText ?? 0)
            .toBe(savedSummary.bySubtype.FreeText);
    }, BLOCKING_SMOKE_TIMEOUT_MS * 2);
});
