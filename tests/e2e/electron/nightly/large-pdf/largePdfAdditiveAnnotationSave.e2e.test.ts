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
    clickAsUser, clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    resolveLargePdfFixtureAvailability, selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openAnnotationsTab, openDocumentSidebarTab, openPdfInApp, saveViaVisibleToolbarWithDeadline, setupScrollToPage, waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    clearTextSelection, clickAnnotationTool, createCanonicalTextBoxWithPointer, createCanonicalTextMarkup, createStickyNoteWithPointer, selectAllFocusedAnnotationText,
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
// A save that also reads every page's annotations back takes about 8.5 s on
// the 21,601-page fixture; reading back only the saved page takes about 1.5 s.
const PAGE_LOCAL_READBACK_SAVE_MS = 5_000;

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

/** Deletes the annotation whose sidebar card shows `text`, from that card. */
async function deleteFromSidebar(page: Page, text: string) {
    const before = await readPanelAnnotationCount(page);
    expect(before, 'The annotations panel shows a count before the delete').not.toBeNull();
    await clickFoundAsUser(page, (expected: string) => Array.from(
        globalThis.__evbE2E.getActiveWorkspaceHost()?.querySelectorAll<HTMLElement>('.notes-list .note-item') ?? [],
    ).find(item => (item.querySelector('.note-item-text')?.textContent ?? '').includes(expected))
        ?.querySelector<HTMLButtonElement>('.note-item-delete'), text, {description: `sidebar delete for ${JSON.stringify(text)}`});
    await expect.poll(() => readPanelAnnotationCount(page), {timeout: 10_000}).toBe(before! - 1);
}

function waitForBookmarkRow(page: Page, title: string) {
    return page.waitForFunction((expected: string) => Array.from(document.querySelectorAll(
        '.editor-pane.is-active .document-bookmark-item__row',
    )).some(row => row.textContent?.trim() === expected), {timeout: 60_000}, title);
}

function waitForSidebarNoteText(page: Page, text: string) {
    return page.waitForFunction((expected: string) => Array.from(document.querySelectorAll(
        '.editor-pane.is-active .notes-list .note-item-text',
    )).some(item => item.textContent?.includes(expected)), {timeout: 60_000}, text);
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

    it('edits saved annotations and deletes a saved rectangle, retaining each change after restart', async () => {
        const documentPath = copyLargeFixture(directories, 'existing-edits.pdf');
        const session = await sessionFixture.restart({clean: true});
        const {page} = session!;
        await openPdfInApp(page, documentPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);
        await openAnnotationsTab(page, 30_000);
        await setupScrollToPage(page, PAGE_NUMBER);
        const textSpan = await page.waitForFunction((pageNumber: number) => {
            const index = Array.from(document.querySelectorAll<HTMLElement>(
                `.page_container[data-page="${pageNumber}"] .text-layer span`,
            )).filter(span => (span.textContent ?? '').trim().length > 0)
                .findIndex(span => span.firstChild instanceof Text);
            return index >= 0 ? index : null;
        }, {timeout: 30_000}, PAGE_NUMBER).then(handle => handle.jsonValue() as Promise<number>);
        const before = await readCanonicalEntities(page);
        await createCanonicalTextMarkup(page, 'Highlight', {
            startPage: PAGE_NUMBER,
            startSpan: textSpan,
            endPage: PAGE_NUMBER,
            endSpan: textSpan,
        });
        await clearTextSelection(page);
        const highlight = await waitForNewEntity(page, 'text-markup', before);
        const rectangle = await drawRectangle(page);
        const originalText = `large pdf existing text box ${Date.now()}`;
        const textBox = await createCanonicalTextBoxWithPointer(page, originalText, {
            x: 0.6,
            y: 0.7,
        }, PAGE_NUMBER);
        await saveWithinBudget(page, 'Save before existing edits');
        const entitySelector = (id: string) => [
            id,
            `evb-shape:${id}`,
        ]
            .map(key => `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${key}"]`).join(', ');
        const readAppearance = (targetPage: Page, id: string) => targetPage.$eval(entitySelector(id), (element) => {
            const rect = element.getBoundingClientRect();
            const container = element.closest('.page_container')!;
            const box = container.getBoundingClientRect();
            const canvas = container.querySelector<HTMLCanvasElement>('.page_canvas canvas');
            const canvasBox = canvas?.getBoundingClientRect();
            let greenPixels = 0;
            if (canvas && canvasBox?.width && canvasBox.height) {
                const x = Math.max(0, Math.floor((rect.left - canvasBox.left) * canvas.width / canvasBox.width));
                const y = Math.max(0, Math.floor((rect.top - canvasBox.top) * canvas.height / canvasBox.height));
                const width = Math.min(canvas.width - x, Math.ceil(rect.width * canvas.width / canvasBox.width));
                const height = Math.min(canvas.height - y, Math.ceil(rect.height * canvas.height / canvasBox.height));
                if (width > 0 && height > 0) {
                    const pixels = canvas.getContext('2d')?.getImageData(x, y, width, height).data ?? [];
                    for (let i = 0; i < pixels.length; i += 4) {
                        if (pixels[i + 1]! > pixels[i]! + 20 && pixels[i + 1]! > pixels[i + 2]! + 20) greenPixels++;
                    }
                }
            }
            return {
                left: (rect.left - box.left) / box.width,
                top: (rect.top - box.top) / box.height,
                greenPixels,
                color: getComputedStyle(Array.from(element.closest('.page_container')!.querySelectorAll('.pdf-annotation-editor-text-markup [data-annotation-visual]')).find(paint => getComputedStyle(paint).getPropertyValue('--annotation-color') === getComputedStyle(element).getPropertyValue('--annotation-color')) ?? element).fill,
            };
        });
        await clickAnnotationTool(page, 'Select');
        await clickAsUser(page, entitySelector(highlight.id));
        await clickAsUser(page, '.editor-pane.is-active .annotation-properties-inline[data-target="selection"] .swatch[aria-label="#22c55e"]');
        await expect.poll(async () => (await readAppearance(page, highlight.id)).color).toBe('rgb(34, 197, 94)');
        const recolorSaveMs = await saveWithinBudget(page, 'Existing highlight recolor');

        // Stable shape identity can gain its PDF name prefix after the first save.
        const shape = (await readCanonicalEntities(page)).find(entity => entity.kind === 'shape'
            && [
                rectangle.id,
                `evb-shape:${rectangle.id}`,
            ].includes(entity.id));
        expect(shape).toBeDefined();
        const shapeId = shape!.id;
        const originalPosition = await readAppearance(page, shapeId);
        await dragEntity(page, shapeId);
        await waitForSaveFrontierReady(page, 30_000);
        const moved = await readAppearance(page, shapeId);
        expect(isNear(moved, originalPosition)).toBe(false);
        const moveSaveMs = await saveWithinBudget(page, 'Existing rectangle move');

        await clickAsUser(page, entitySelector(textBox), {count: 2});
        await page.waitForSelector(`.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${textBox}"] [contenteditable="true"]`, {visible: true});
        await selectAllFocusedAnnotationText(page);
        const editedText = `${originalText} edited`;
        await page.keyboard.type(editedText);
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.down(modifier);
        await page.keyboard.press('Enter');
        await page.keyboard.up(modifier);
        await waitForSaveFrontierReady(page, 30_000);
        const textSaveMs = await saveWithinBudget(page, 'Existing text box edit');

        const deleted = await drawRectangle(page);
        await saveWithinBudget(page, 'Save rectangle before deletion');
        const deleteId = (await readCanonicalEntities(page)).find(entity => entity.kind === 'shape'
            && [
                deleted.id,
                `evb-shape:${deleted.id}`,
            ].includes(entity.id))!.id;
        await clickAnnotationTool(page, 'Select');
        await clickAsUser(page, entitySelector(deleteId));
        await page.keyboard.press('Delete');
        await expect.poll(async () => (await readCanonicalEntities(page)).some(entity => entity.id === deleteId)).toBe(false);
        const deleteSaveMs = await saveWithinBudget(page, 'Existing rectangle delete');
        const timings = {
            recolorSaveMs,
            moveSaveMs,
            textSaveMs,
            deleteSaveMs,
        };
        console.info(`[large-pdf existing edits] ${JSON.stringify(timings)}`);
        for (const duration of Object.values(timings)) expect(duration, JSON.stringify(timings)).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);
        const savedCount = await readPanelAnnotationCount(page);
        expect(savedCount).not.toBeNull();
        await waitForCrashCheckpointPath(session!.name, realpathSync(documentPath));
        const restarted = await sessionFixture.restart({
            clean: false,
            hard: true,
        });
        const restored = restarted!.page;
        await waitForRestoredDocument(restored, documentPath);
        await expectCleanAnnotationHydration(restored);
        await openAnnotationsTab(restored, 30_000);
        await setupScrollToPage(restored, PAGE_NUMBER);
        await expect.poll(() => readPanelAnnotationCount(restored), {timeout: 60_000}).toBe(savedCount);
        // Reopened original appearances are painted into the PDF canvas.
        await expect.poll(async () => (await readAppearance(restored, highlight.id)).greenPixels).toBeGreaterThan(10);
        await expect.poll(async () => isNear(await readAppearance(restored, shapeId), moved)).toBe(true);
        await expect.poll(async () => {
            const entities = await readCanonicalEntities(restored);
            return {
                text: entities.find(entity => entity.id === textBox)?.text,
                deleted: entities.some(entity => [
                    deleteId,
                    `evb-shape:${deleteId}`,
                ].includes(entity.id)),
            };
        }).toEqual({
            text: editedText,
            deleted: false,
        });
    }, LARGE_PDF_TIMEOUT_MS * 2);
    it('deletes a saved highlight and text box and keeps them deleted after restart', async () => {
        const documentPath = copyLargeFixture(directories, 'delete.pdf');
        const session = await sessionFixture.restart({clean: true});
        const {page} = session!;
        await openPdfInApp(page, documentPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);
        await openAnnotationsTab(page, 30_000);
        await setupScrollToPage(page, PAGE_NUMBER);
        const textSpan = await page.waitForFunction((pageNumber: number) => {
            const index = Array.from(document.querySelectorAll<HTMLElement>(
                `.page_container[data-page="${pageNumber}"] .text-layer span`,
            )).filter(span => (span.textContent ?? '').trim().length > 0)
                .findIndex(span => span.firstChild instanceof Text);
            return index >= 0 ? index : null;
        }, {timeout: 30_000}, PAGE_NUMBER).then(handle => handle.jsonValue() as Promise<number>);

        const highlightText = (await createCanonicalTextMarkup(page, 'Highlight', {
            startPage: PAGE_NUMBER,
            startSpan: textSpan,
            endPage: PAGE_NUMBER,
            endSpan: textSpan,
        })).trim();
        await clearTextSelection(page);
        const boxText = `large pdf deleted text box ${Date.now()}`;
        await createCanonicalTextBoxWithPointer(page, boxText, {
            x: 0.6,
            y: 0.7,
        }, PAGE_NUMBER);
        await saveWithinBudget(page, 'Save before delete');
        const countWithBoth = await readPanelAnnotationCount(page);
        expect(countWithBoth, 'The annotations panel shows a count after the first save').not.toBeNull();

        await deleteFromSidebar(page, boxText);
        await deleteFromSidebar(page, highlightText);
        const deleteSaveMs = await saveWithinBudget(page, 'Delete save');
        console.info(`[large-pdf delete save] ${JSON.stringify({deleteSaveMs})}`);
        expect(deleteSaveMs).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);
        expect(await readPanelAnnotationCount(page)).toBe(countWithBoth! - 2);

        await waitForCrashCheckpointPath(session!.name, realpathSync(documentPath));
        const restarted = await sessionFixture.restart({
            clean: false,
            hard: true,
        });
        const restartedPage = restarted!.page;
        await waitForRestoredDocument(restartedPage, documentPath);
        await expectCleanAnnotationHydration(restartedPage);
        await openAnnotationsTab(restartedPage, 30_000);
        await expect.poll(() => readPanelAnnotationCount(restartedPage), {timeout: 60_000}).toBe(countWithBoth! - 2);
        await setupScrollToPage(restartedPage, PAGE_NUMBER);
        await expect.poll(async () => (await readCanonicalEntities(restartedPage))
            .filter(entity => entity.kind === 'text-markup' || entity.text === boxText).length, {timeout: 30_000}).toBe(0);
    }, LARGE_PDF_TIMEOUT_MS * 2);
    it('saves a note edit and a new bookmark, keeping both after restart', async () => {
        const documentPath = copyLargeFixture(directories, 'bookmark.pdf');
        const session = await sessionFixture.restart({clean: true});
        const {page} = session!;
        await openPdfInApp(page, documentPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);

        const noteText = `large pdf note ${Date.now()}`;
        await createStickyNoteWithPointer(page, noteText, {
            x: 0.6,
            y: 0.3,
        }, PAGE_NUMBER);
        await saveWithinBudget(page, 'Note save');
        const textarea = await page.waitForSelector('textarea.note-window__textarea', {
            visible: true,
            timeout: 10_000,
        });
        await clickAsUser(page, textarea!);
        await page.keyboard.press('End');
        await page.keyboard.type(' edited', {delay: 10});
        await page.keyboard.press('Tab');
        const noteEditSaveMs = await saveWithinBudget(page, 'Note edit save');

        const bookmarkTitle = `large pdf bookmark ${Date.now()}`;
        await openDocumentSidebarTab(page, 'Bookmarks');
        await clickAsUser(page, '.editor-pane.is-active .document-bookmarks-toolbar__actions button');
        await clickFoundAsUser(page, (title: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('.editor-pane.is-active button'))
            .find(button => button.textContent?.trim() === title), 'Add first bookmark', {description: 'Add first bookmark'});
        await page.waitForSelector('.pdf-bookmark-item-input', {visible: true});
        await page.keyboard.type(bookmarkTitle);
        await page.keyboard.press('Enter');
        await waitForBookmarkRow(page, bookmarkTitle);
        const bookmarkSaveMs = await saveWithinBudget(page, 'Bookmark save');
        const timings = {
            noteEditSaveMs,
            bookmarkSaveMs,
        };
        console.info(`[large-pdf note edit and bookmark saves] ${JSON.stringify(timings)}`);
        expect(noteEditSaveMs, JSON.stringify(timings)).toBeLessThan(PAGE_LOCAL_READBACK_SAVE_MS);
        expect(bookmarkSaveMs, JSON.stringify(timings)).toBeLessThan(PAGE_LOCAL_READBACK_SAVE_MS);

        await waitForCrashCheckpointPath(session!.name, realpathSync(documentPath));
        const restarted = await sessionFixture.restart({
            clean: false,
            hard: true,
        });
        const restartedPage = restarted!.page;
        await waitForRestoredDocument(restartedPage, documentPath);
        await openDocumentSidebarTab(restartedPage, 'Bookmarks');
        await waitForBookmarkRow(restartedPage, bookmarkTitle);
        await openAnnotationsTab(restartedPage, 30_000);
        await waitForSidebarNoteText(restartedPage, `${noteText} edited`);
    }, LARGE_PDF_TIMEOUT_MS * 2);
});
