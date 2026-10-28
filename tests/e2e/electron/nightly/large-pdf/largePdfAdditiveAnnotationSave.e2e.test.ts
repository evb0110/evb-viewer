import {
    afterAll, describe, expect, it,
} from 'vitest';
import {
    constants, copyFileSync, mkdtempSync, realpathSync, rmSync,
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

async function saveWithinBudget(page: Page, label: string) {
    const startedAt = Date.now();
    await saveViaVisibleToolbarWithDeadline(page, LARGE_PDF_TIMEOUT_MS, undefined, {label});
    await expectCleanAnnotationHydration(page);
    return Date.now() - startedAt;
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
        const fixtureSourcePath = largePdfFixture.path;
        if (!fixtureSourcePath) {
            throw new Error(`Required large PDF fixture is unavailable: ${largePdfFixture.reason}`);
        }
        const directory = mkdtempSync(join(tmpdir(), 'evb-large-pdf-additive-'));
        directories.push(directory);
        const documentPath = join(directory, 'additive.pdf');
        try {
            copyFileSync(fixtureSourcePath, documentPath, constants.COPYFILE_FICLONE);
        } catch {
            copyFileSync(fixtureSourcePath, documentPath);
        }

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

        const timings = {
            highlightSaveMs,
            rectangleSaveMs,
            textBoxSaveMs,
        };
        console.info(`[large-pdf additive saves] ${JSON.stringify(timings)}`);
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
});
