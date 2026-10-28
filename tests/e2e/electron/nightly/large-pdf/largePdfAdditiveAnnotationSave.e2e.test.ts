import {
    afterAll, describe, expect, it,
} from 'vitest';
import {
    constants, copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import {
    resolveLargePdfFixtureAvailability, selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openAnnotationsTab, openPdfInApp, saveViaVisibleToolbarWithDeadline, setupScrollToPage, waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    clearTextSelection, clickAnnotationTool, createCanonicalTextBoxWithPointer, createCanonicalTextMarkup,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    LARGE_PDF_SAVE_TIMEOUT_MS,
    LARGE_PDF_TIMEOUT_MS,
    expectCleanAnnotationHydration,
    waitForCrashCheckpointPath,
    waitForRestoredDocument,
} from './largePdfAnnotationSaveShared';
import {
    PLACED_IMAGE_JPEG, finalizeImagePlacement, installManagedJpegClipboard, pasteImageFromVisibleMenu,
} from '@tests/e2e/electron/helpers/placedImageClipboard';
import { electronAppTempDirPath } from '@scripts/electron-run/electronRunSessionPaths';
import { waitForSaveFrontierReady } from '@tests/e2e/electron/helpers/workspaceExpose';

const largePdfFixture = resolveLargePdfFixtureAvailability();
const largePdfDescribe = selectFixtureDescribe(describe, largePdfFixture);
const PAGE_NUMBER = 1;

interface ICanonicalEntity {
    id: string;
    kind: string;
    text: string;
}

function readCanonicalEntities(page: Page) {
    return page.evaluate((pageNumber: number) => Array.from(document.querySelectorAll<HTMLElement>(
        `.editor-pane.is-active .page_container[data-page="${pageNumber}"] .pdf-annotation-editor-layer [data-annotation-id][data-annotation-kind]`,
    )).map(entity => ({
        id: entity.dataset.annotationId ?? '',
        kind: entity.dataset.annotationKind ?? '',
        text: entity.textContent?.replace(/[\u200B\uFEFF]/gu, '').trim() ?? '',
    })), PAGE_NUMBER) as Promise<ICanonicalEntity[]>;
}

async function waitForNewEntity(page: Page, kind: string, before: readonly ICanonicalEntity[]) {
    const beforeIds = before.map(entity => entity.id);
    await page.waitForFunction((input: {
        beforeIds: string[];
        kind: string;
        pageNumber: number;
    }) => Array.from(document.querySelectorAll<HTMLElement>(
        `.editor-pane.is-active .page_container[data-page="${input.pageNumber}"] .pdf-annotation-editor-layer [data-annotation-id][data-annotation-kind]`,
    )).some(entity => entity.dataset.annotationKind === input.kind
        && !input.beforeIds.includes(entity.dataset.annotationId ?? '')), {timeout: 20_000}, {
        beforeIds,
        kind,
        pageNumber: PAGE_NUMBER,
    });
    const created = (await readCanonicalEntities(page))
        .find(entity => entity.kind === kind && !beforeIds.includes(entity.id));
    if (!created) {
        throw new Error(`No new ${kind} appeared on page ${PAGE_NUMBER}`);
    }
    return created;
}

async function drawRectangle(page: Page) {
    const before = await readCanonicalEntities(page);
    await clickAnnotationTool(page, 'Rectangle');
    const box = await page.evaluate(async (pageNumber: number) => {
        const container = document.querySelector<HTMLElement>(
            `.editor-pane.is-active .page_container[data-page="${pageNumber}"]`,
        );
        container?.scrollIntoView({
            block: 'center',
            inline: 'center',
        });
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const rect = container?.querySelector<HTMLElement>('.pdf-annotation-editor-layer')?.getBoundingClientRect();
        return rect && rect.width > 0 && rect.height > 0
            ? {
                height: rect.height,
                left: rect.left,
                top: rect.top,
                width: rect.width,
            }
            : null;
    }, PAGE_NUMBER);
    if (!box) {
        throw new Error(`Page ${PAGE_NUMBER} has no annotation layer to draw on`);
    }
    await page.mouse.move(box.left + box.width * 0.1, box.top + box.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(box.left + box.width * 0.25, box.top + box.height * 0.5, {steps: 6});
    await page.mouse.up();
    return waitForNewEntity(page, 'shape', before);
}

/** The count the annotations panel shows for the active document. */
function readPanelAnnotationCount(page: Page) {
    return page.evaluate(() => {
        const text = document.querySelector('.editor-pane.is-active .notes-count')?.textContent ?? '';
        const match = /\d+/u.exec(text);
        return match ? Number(match[0]) : null;
    });
}

async function saveWithinBudget(page: Page, label: string) {
    const startedAt = Date.now();
    await saveViaVisibleToolbarWithDeadline(page, LARGE_PDF_TIMEOUT_MS, undefined, {label});
    await expectCleanAnnotationHydration(page);
    return Date.now() - startedAt;
}

function copyLargeFixture(directories: string[], name: string) {
    const fixtureSourcePath = largePdfFixture.path;
    if (!fixtureSourcePath) {
        throw new Error(`Required large PDF fixture is unavailable: ${largePdfFixture.reason}`);
    }
    const directory = mkdtempSync(join(tmpdir(), 'evb-large-pdf-additive-'));
    directories.push(directory);
    const documentPath = join(directory, name);
    try {
        copyFileSync(fixtureSourcePath, documentPath, constants.COPYFILE_FICLONE);
    } catch {
        copyFileSync(fixtureSourcePath, documentPath);
    }
    return documentPath;
}

/** Where the page's placed images sit, as fractions of the page box. */
function readPlacedImagePositions(page: Page) {
    return page.evaluate((pageNumber: number) => {
        const container = document.querySelector<HTMLElement>(
            `.editor-pane.is-active .page_container[data-page="${pageNumber}"]`,
        );
        const box = container?.getBoundingClientRect();
        if (!container || !box || box.width <= 0 || box.height <= 0) return [];
        return Array.from(container.querySelectorAll<HTMLElement>(
            '.pdf-annotation-editor-layer [data-annotation-kind="placed-image"]',
        )).map((entity) => {
            const rect = entity.getBoundingClientRect();
            return {
                left: (rect.left - box.left) / box.width,
                top: (rect.top - box.top) / box.height,
            };
        });
    }, PAGE_NUMBER);
}

function isNear(position: {
    left: number;
    top: number
}, expected: {
    left: number;
    top: number
}) {
    return Math.abs(position.left - expected.left) < 0.01 && Math.abs(position.top - expected.top) < 0.01;
}

/** Drags an entity with the Select tool and waits until it has moved. */
async function dragEntity(page: Page, id: string) {
    await clickAnnotationTool(page, 'Select');
    const readRect = () => page.evaluate((annotationId: string) => {
        const rect = document.querySelector(
            `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${annotationId}"]`,
        )?.getBoundingClientRect();
        return rect ? {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
        } : null;
    }, id);
    const before = await readRect();
    if (!before) {
        throw new Error(`Entity ${id} is not on screen to drag`);
    }
    const x = before.left + before.width / 2;
    const y = before.top + before.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 48, y + 32, {steps: 8});
    await page.mouse.up();
    await expect.poll(async () => {
        const after = await readRect();
        return after !== null && Math.abs(after.left - before.left) > 4 && Math.abs(after.top - before.top) > 4;
    }, {timeout: 10_000}).toBe(true);
}

largePdfDescribe('Electron E2E - Large PDF additive annotation saves', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-large-pdf-additive-${Date.now()}`,
        timeoutMs: LARGE_PDF_TIMEOUT_MS,
    });
    const directories: string[] = [];
    afterAll(async () => {
        await sessionFixture.stop();
        for (const directory of directories) {
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
    });

    it('saves a new highlight, rectangle and text box separately and reopens them', async () => {
        const documentPath = copyLargeFixture(directories, 'additive.pdf');

        const session = sessionFixture.getSession();
        const {page} = session;
        await openPdfInApp(page, documentPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);
        await openAnnotationsTab(page, 30_000);
        await setupScrollToPage(page, PAGE_NUMBER);
        // The selection helper indexes non-empty spans in document order; a
        // marked-content wrapper is one of them but holds no text node itself.
        const textSpan = await page.waitForFunction((pageNumber: number) => {
            const index = Array.from(document.querySelectorAll<HTMLElement>(
                `.page_container[data-page="${pageNumber}"] .text-layer span`,
            )).filter(span => (span.textContent ?? '').trim().length > 0)
                .findIndex(span => span.firstChild instanceof Text);
            return index >= 0 ? index : null;
        }, {timeout: 30_000}, PAGE_NUMBER).then(handle => handle.jsonValue() as Promise<number>);

        const beforeHighlight = await readCanonicalEntities(page);
        await createCanonicalTextMarkup(page, 'Highlight', {
            startPage: PAGE_NUMBER,
            startSpan: textSpan,
            endPage: PAGE_NUMBER,
            endSpan: textSpan,
        });
        await clearTextSelection(page);
        const highlight = await waitForNewEntity(page, 'text-markup', beforeHighlight);
        const highlightSaveMs = await saveWithinBudget(page, 'Highlight save');

        const rectangle = await drawRectangle(page);
        const rectangleSaveMs = await saveWithinBudget(page, 'Rectangle save');

        const text = `large pdf additive text box ${Date.now()}`;
        const textBoxId = await createCanonicalTextBoxWithPointer(page, text, {
            x: 0.6,
            y: 0.7,
        }, PAGE_NUMBER);
        const textBoxSaveMs = await saveWithinBudget(page, 'Text box save');

        // A save that lands before the open-time read of the whole document
        // finishes must still leave every annotation of the document listed.
        const savedCount = await readPanelAnnotationCount(page);
        expect(savedCount, 'The annotations panel shows a count after the saves').not.toBeNull();

        const timings = {
            highlightSaveMs,
            rectangleSaveMs,
            textBoxSaveMs,
        };
        console.info(`[large-pdf additive saves] ${JSON.stringify(timings)}`);
        // The first save lands while the document's opening read is still
        // running. The edit stops that read, so this save reads the whole
        // document back once without waiting on it; later saves read back
        // only their own pages.
        expect(highlightSaveMs, JSON.stringify(timings)).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);
        expect(rectangleSaveMs, JSON.stringify(timings)).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);
        expect(textBoxSaveMs, JSON.stringify(timings)).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);

        await waitForCrashCheckpointPath(session.name, realpathSync(documentPath));
        const restarted = await sessionFixture.restart({
            clean: false,
            hard: true,
        });
        expect(restarted).not.toBeNull();
        const restartedPage = restarted!.page;
        await waitForRestoredDocument(restartedPage, documentPath);
        await expectCleanAnnotationHydration(restartedPage);
        await openAnnotationsTab(restartedPage, 30_000);
        await expect.poll(() => readPanelAnnotationCount(restartedPage), {timeout: 60_000}).toBe(savedCount);
        await expect.poll(async () => {
            const entities = await readCanonicalEntities(restartedPage);
            return {
                highlight: entities.some(entity => entity.id === highlight.id && entity.kind === 'text-markup'),
                // A shape is saved under its stable key, which a reopened document names it by.
                rectangle: entities.some(entity => entity.kind === 'shape'
                    && [
                        rectangle.id,
                        `evb-shape:${rectangle.id}`,
                    ].includes(entity.id)),
                textBox: entities.some(entity => entity.id === textBoxId && entity.text === text),
            };
        }, {timeout: 60_000}).toEqual({
            highlight: true,
            rectangle: true,
            textBox: true,
        });
    }, LARGE_PDF_TIMEOUT_MS * 2);
    it('places an image, moves it, saves each step and reopens it', async () => {
        const documentPath = copyLargeFixture(directories, 'image.pdf');
        const session = await sessionFixture.restart({clean: true});
        const {page} = session!;
        await openPdfInApp(page, documentPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);
        await openAnnotationsTab(page, 30_000);
        await setupScrollToPage(page, PAGE_NUMBER);
        const imagePath = join(electronAppTempDirPath(session!.name), `large-pdf-placed-image-${process.pid}.jpg`);
        writeFileSync(imagePath, PLACED_IMAGE_JPEG);
        await installManagedJpegClipboard(page, imagePath);

        const beforeImage = await readCanonicalEntities(page);
        await pasteImageFromVisibleMenu(page, PAGE_NUMBER);
        await finalizeImagePlacement(page);
        const image = await waitForNewEntity(page, 'placed-image', beforeImage);
        const placeSaveMs = await saveWithinBudget(page, 'Placed image save');
        const [placedAt] = await readPlacedImagePositions(page);
        expect(placedAt).toBeDefined();

        await dragEntity(page, image.id);
        await waitForSaveFrontierReady(page, 30_000);
        const moveSaveMs = await saveWithinBudget(page, 'Placed image move save');
        const [movedTo] = await readPlacedImagePositions(page);
        expect(movedTo).toBeDefined();
        expect(isNear(movedTo!, placedAt!), JSON.stringify({
            placedAt,
            movedTo,
        })).toBe(false);
        const savedCount = await readPanelAnnotationCount(page);
        expect(savedCount, 'The annotations panel shows a count after the saves').not.toBeNull();

        const timings = {
            placeSaveMs,
            moveSaveMs,
        };
        console.info(`[large-pdf placed image saves] ${JSON.stringify(timings)}`);
        expect(placeSaveMs, JSON.stringify(timings)).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);
        expect(moveSaveMs, JSON.stringify(timings)).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);

        await waitForCrashCheckpointPath(session!.name, realpathSync(documentPath));
        const restarted = await sessionFixture.restart({
            clean: false,
            hard: true,
        });
        const restartedPage = restarted!.page;
        await waitForRestoredDocument(restartedPage, documentPath);
        await expectCleanAnnotationHydration(restartedPage);
        await openAnnotationsTab(restartedPage, 30_000);
        await expect.poll(() => readPanelAnnotationCount(restartedPage), {timeout: 60_000}).toBe(savedCount);
        // The reopened file must hold the image where the move left it.
        await setupScrollToPage(restartedPage, PAGE_NUMBER);
        await expect.poll(async () => {
            const positions = await readPlacedImagePositions(restartedPage);
            return positions.length === 1 && isNear(positions[0]!, movedTo!);
        }, {timeout: 60_000}).toBe(true);
    }, LARGE_PDF_TIMEOUT_MS * 2);
});
