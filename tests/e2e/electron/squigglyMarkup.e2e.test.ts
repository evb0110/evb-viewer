import {
    describe,
    expect,
    it,
} from 'vitest';
import { copyFileSync } from 'node:fs';
import { delay } from 'es-toolkit/promise';
import type { Page } from 'puppeteer-core';
import {
    createForeignHighlightNoTextFixturePdf,
    createFixturePath,
    createTextMarkupAcceptanceFixturePdf,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clearTextSelection,
    clickAnnotationTool,
    readEvbTextMarkupVisuals,
    selectTextFromRenderedSpans,
    waitForEvbTextMarkupVisualCount,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openAnnotationsTab,
    openPdfInApp,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    type IWorkspaceExposeProbeWindow,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';

interface ITextMarkupCommentShape {
    color?: string | null;
    markupGeometry?: Array<{
        height: number;
        left: number;
        top: number;
        width: number;
    }> | null;
    opacity?: number | null;
    pageIndex: number;
    previewText?: string | null;
    subtype?: string | null;
}

interface ITextMarkupComment extends Record<string, unknown>, ITextMarkupCommentShape {}

type IInPageTextMarkupComment = ITextMarkupCommentShape & {pageIndex: number;};

const TEXT_MARKUP_SUBTYPES = [
    [
        'Highlight',
        'Highlight',
    ],
    [
        'Underline',
        'Underline',
    ],
    [
        'Strikethrough',
        'StrikeOut',
    ],
    [
        'Squiggly',
        'Squiggly',
    ],
] as const;

async function waitForRenderedTextSpans(page: Page, pageNumbers: readonly number[]) {
    for (const pageNumber of pageNumbers) {
        await page.evaluate((targetPageNumber) => {
            document.querySelector<HTMLElement>(
                `.page_container[data-page="${targetPageNumber}"]`,
            )?.scrollIntoView({block: 'center'});
        }, pageNumber);
        await page.waitForFunction((targetPageNumber: number) => {
            const page = document.querySelector<HTMLElement>(
                `.page_container[data-page="${targetPageNumber}"]`,
            );
            const spans = Array.from(page?.querySelectorAll<HTMLElement>('.text-layer span, .textLayer span') ?? [])
                .filter(span => (span.textContent ?? '').trim().length > 0);
            return spans.length >= 3;
        }, {timeout: 20_000}, pageNumber);
    }
}

async function waitForPageWidthAtZoom(page: Page, baselineWidth: number, zoom: number) {
    await page.waitForFunction((expected: {
        baselineWidth: number;
        zoom: number;
    }) => {
        const pageElement = document.querySelector<HTMLElement>('.page_container[data-page="1"]');
        const width = pageElement?.getBoundingClientRect().width ?? 0;
        const expectedWidth = expected.baselineWidth * expected.zoom;
        return width > 0 && Math.abs(width - expectedWidth) <= Math.max(2, expected.baselineWidth * 0.01);
    }, {timeout: 20_000}, {
        baselineWidth,
        zoom,
    });
}

async function readTextMarkupComments(page: Page): Promise<ITextMarkupComment[]> {
    return page.evaluate((): ITextMarkupComment[] => {
        const api = (window as IWorkspaceExposeProbeWindow).__evbTestApi;
        const values = api?.readActiveWorkspaceStateValues<{annotationComments?: IInPageTextMarkupComment[];}>(['annotationComments']);
        const comments: IInPageTextMarkupComment[] = values?.annotationComments ?? [];
        return comments.flatMap((comment): ITextMarkupComment[] => {
            const subtype = typeof comment.subtype === 'string' ? comment.subtype : null;
            const normalized = subtype?.trim().toLowerCase() === 'strikethrough'
                ? 'strikeout'
                : subtype?.trim().toLowerCase() ?? '';
            if (!subtype || ![
                'highlight',
                'underline',
                'strikeout',
                'squiggly',
            ].includes(normalized)) {
                return [];
            }
            return [{
                color: comment.color ?? null,
                markupGeometry: comment.markupGeometry?.map(rect => ({
                    height: rect.height,
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                })) ?? null,
                opacity: comment.opacity ?? null,
                pageIndex: comment.pageIndex,
                previewText: comment.previewText ?? null,
                subtype,
            } satisfies ITextMarkupComment];
        });
    });
}

async function waitForTextMarkupComments(page: Page, expectedCount: number) {
    const deadline = Date.now() + 20_000;
    let comments = await readTextMarkupComments(page);
    while (comments.length !== expectedCount) {
        if (Date.now() >= deadline) {
            break;
        }
        await delay(100);
        comments = await readTextMarkupComments(page);
    }
    if (comments.length === expectedCount) {
        return comments;
    }
    throw new Error(`Expected ${expectedCount} canonical text markups, got ${comments.length}`);
}

async function waitForTextMarkupProperty(
    page: Page,
    predicate: (comment: ITextMarkupComment) => boolean,
    description: string,
) {
    const deadline = Date.now() + 20_000;
    let comments = await readTextMarkupComments(page);
    while (!(comments.length === 1 && comments[0] && predicate(comments[0]))) {
        if (Date.now() >= deadline) {
            break;
        }
        await delay(100);
        comments = await readTextMarkupComments(page);
    }
    if (comments.length === 1 && comments[0] && predicate(comments[0])) {
        return comments[0];
    }
    throw new Error(`Timed out waiting for ${description}`);
}

async function waitForSidebarMarkupPreview(page: Page, subtype: string, previewText: string) {
    await page.waitForFunction((expected: {
        subtype: string;
        previewText: string
    }) => {
        const normalizedExpectedSubtype = expected.subtype.trim().toLowerCase() === 'strikethrough'
            ? 'strikeout'
            : expected.subtype.trim().toLowerCase();
        return Array.from(document.querySelectorAll<HTMLElement>('.notes-list .note-item')).some((item) => {
            const label = item.querySelector<HTMLElement>('.note-item-type')?.textContent?.trim().toLowerCase() ?? '';
            const normalizedLabel = label.includes('strike')
                ? 'strikeout'
                : label.includes('squiggle')
                    ? 'squiggly'
                    : label;
            const text = item.querySelector<HTMLElement>('.note-item-text')?.textContent ?? '';
            return normalizedLabel === normalizedExpectedSubtype && text.includes(expected.previewText);
        });
    }, {timeout: 20_000}, {
        subtype,
        previewText,
    });
}

async function createTextMarkup(
    page: Page,
    tool: string,
    startPage: number,
    startSpan: number,
    endPage: number,
    endSpan: number,
) {
    await clickAnnotationTool(page, tool);
    const selectedText = await selectTextFromRenderedSpans(page, {
        startPage,
        startSpan,
        endPage,
        endSpan,
    });
    const commandResult = await callWorkspaceCommand<boolean>(page, 'highlightSelection');
    await clearTextSelection(page);
    if (!commandResult.called || commandResult.value !== true) {
        throw new Error(`EVB text-markup creation failed: ${JSON.stringify({
            selectedText,
            commandResult,
        })}`);
    }
    return selectedText;
}

async function waitForPdfAnnotationSubtypeCount(filePath: string, subtype: string, expectedCount: number) {
    const deadline = Date.now() + 20_000;
    let summary = await readPdfAnnotationSummary(filePath);
    while ((summary.bySubtype[subtype] ?? 0) !== expectedCount) {
        if (Date.now() >= deadline) {
            break;
        }
        await delay(150);
        summary = await readPdfAnnotationSummary(filePath);
    }
    if ((summary.bySubtype[subtype] ?? 0) === expectedCount) {
        return summary;
    }
    throw new Error(`Expected ${expectedCount} ${subtype} annotations, got ${summary.bySubtype[subtype] ?? 0}`);
}

async function updateSelectedMarkupProperties(page: Page) {
    const findMarkupPoint = async () => page.evaluate(() => {
        const group = document.querySelector<SVGGElement>(
            '.pdf-annotation-editor-layer g[data-annotation-kind="text-markup"]',
        );
        const rect = group?.getBoundingClientRect();
        return rect && rect.width > 0 && rect.height > 0
            ? {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            }
            : null;
    });

    const openProperties = async () => {
        const point = await findMarkupPoint();
        if (!point) {
            throw new Error('Unable to locate the EVB text-markup surface');
        }
        await page.mouse.click(point.x, point.y);
        const opacityInput = await page.waitForSelector('[data-testid="annotation-properties-opacity"]', {
            timeout: 20_000,
            visible: true,
        });
        if (!opacityInput) {
            throw new Error('Text-markup properties did not open for the selected EVB annotation');
        }
    };

    await openProperties();
    const originalColor = await page.$eval('[data-testid="annotation-properties-color"]', (element) => {
        if (!(element instanceof HTMLInputElement)) {
            throw new Error('Text-markup color control is not an input');
        }
        return element.value;
    });
    await page.$eval('[data-testid="annotation-properties-color"]', (element) => {
        if (!(element instanceof HTMLInputElement)) {
            throw new Error('Text-markup color control is not an input');
        }
        element.value = '#ff0000';
        element.dispatchEvent(new Event('input', {bubbles: true}));
    });
    await waitForTextMarkupProperty(
        page,
        comment => comment.color?.toLowerCase() === '#ff0000',
        'the canonical text-markup color update',
    );
    await page.waitForFunction(() => !document.querySelector('.annotation-properties-color'));

    await openProperties();
    await page.$eval('[data-testid="annotation-properties-opacity"]', (element) => {
        if (!(element instanceof HTMLInputElement)) {
            throw new Error('Text-markup opacity control is not an input');
        }
        element.value = '0.65';
        element.dispatchEvent(new Event('input', {bubbles: true}));
        element.dispatchEvent(new Event('change', {bubbles: true}));
    });
    await waitForTextMarkupProperty(
        page,
        comment => comment.opacity !== null
            && comment.opacity !== undefined
            && Math.abs(comment.opacity - 0.65) < 0.02,
        'the canonical text-markup opacity update',
    );
    await page.waitForFunction(() => !document.querySelector('[data-testid="annotation-properties-opacity"]'));
    return {
        originalColor,
        updatedColor: '#ff0000',
    };
}

describe('Electron E2E - EVB text markup', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        restartBeforeEach: true,
        sessionName: () => `e2e-evb-text-markup-${Date.now()}`,
    });

    it.each(TEXT_MARKUP_SUBTYPES)('authors, saves, and reopens a %s annotation', async (tool, subtype) => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const {page} = session;
        const fixturePath = await createTextMarkupAcceptanceFixturePdf(
            `evb-text-markup-${Date.now()}-${subtype}.pdf`,
            1,
        );

        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);
        await waitForRenderedTextSpans(page, [1]);

        const selectedText = await createTextMarkup(page, tool, 1, 0, 1, 2);
        const comments = await waitForTextMarkupComments(page, 1);
        expect(comments[0]?.subtype).toBe(subtype);
        expect(comments[0]?.previewText).toContain('Markup page 1');
        expect(comments[0]?.previewText).toContain('third line 1');
        expect(comments[0]?.markupGeometry).toHaveLength(3);
        expect(selectedText).toContain('Markup page 1');

        const visuals = await readEvbTextMarkupVisuals(page);
        expect(visuals).toHaveLength(1);
        expect(visuals[0]?.subtype).toBe(subtype);
        expect(visuals[0]?.rects).toHaveLength(3);

        await saveViaWindowHandle(page);
        const savedSummary = await waitForPdfAnnotationSubtypeCount(fixturePath, subtype, 1);
        expect(savedSummary.bySubtype[subtype] ?? 0).toBe(1);

        const reopenedPath = createFixturePath(
            `evb-text-markup-reopen-${Date.now()}-${subtype}.pdf`,
        );
        copyFileSync(fixturePath, reopenedPath);
        await openPdfInApp(page, reopenedPath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);
        await waitForRenderedTextSpans(page, [1]);

        const reopenedComments = await waitForTextMarkupComments(page, 1);
        expect(reopenedComments[0]?.subtype).toBe(subtype);
        expect(reopenedComments[0]?.previewText).toContain('Markup page 1');
        expect(reopenedComments[0]?.markupGeometry).toHaveLength(3);
        await waitForSidebarMarkupPreview(page, subtype, 'Markup page 1');
        const reopenedSummary = await waitForPdfAnnotationSubtypeCount(reopenedPath, subtype, 1);
        expect(reopenedSummary.bySubtype[subtype] ?? 0).toBe(1);
    }, 90_000);

    it('keeps three-line authored geometry unchanged at 50%, 100%, and 200% zoom', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const {page} = session;
        const fixturePath = await createTextMarkupAcceptanceFixturePdf(
            `evb-text-markup-zoom-${Date.now()}.pdf`,
            1,
        );
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);
        await waitForRenderedTextSpans(page, [1]);
        await createTextMarkup(page, 'Highlight', 1, 0, 1, 2);
        await waitForEvbTextMarkupVisualCount(page, 1);
        const basePageWidth = await page.$eval('.page_container[data-page="1"]', (element) => {
            const width = element.getBoundingClientRect().width;
            if (width <= 0) {
                throw new Error('Rendered page has no measurable width');
            }
            const scale = Number.parseFloat(getComputedStyle(element).getPropertyValue('--scale-factor'));
            if (!Number.isFinite(scale) || scale <= 0) {
                throw new Error(`Rendered page has no measurable scale: ${scale}`);
            }
            return width / scale;
        });

        const geometryByZoom = new Map<number, string>();
        for (const zoom of [
            0.5,
            1,
            2,
        ]) {
            const result = await callWorkspaceCommand<boolean>(page, 'setCustomZoomFromDisplay', [zoom]);
            expect(result.called).toBe(true);
            await waitForWorkspaceToolbarSnapshot(page, {effectiveZoom: zoom}, {timeoutMs: 20_000});
            await waitForPageWidthAtZoom(page, basePageWidth, zoom);
            const visuals = await readEvbTextMarkupVisuals(page);
            expect(visuals).toHaveLength(1);
            expect(visuals[0]?.rects).toHaveLength(3);
            geometryByZoom.set(zoom, JSON.stringify(visuals[0]?.rects));
        }
        expect(geometryByZoom.get(0.5)).toBe(geometryByZoom.get(1));
        expect(geometryByZoom.get(1)).toBe(geometryByZoom.get(2));
    }, 90_000);

    it('splits a cross-page selection into one canonical annotation per page', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const {page} = session;
        const fixturePath = await createTextMarkupAcceptanceFixturePdf(
            `evb-text-markup-cross-page-${Date.now()}.pdf`,
            2,
        );
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);
        await waitForRenderedTextSpans(page, [
            1,
            2,
        ]);
        await createTextMarkup(page, 'Highlight', 1, 0, 2, 2);

        const comments = await waitForTextMarkupComments(page, 2);
        expect(comments.map(comment => comment.pageIndex).sort()).toEqual([
            0,
            1,
        ]);
        expect(comments.every(comment => comment.markupGeometry?.length === 3)).toBe(true);
        const visuals = await readEvbTextMarkupVisuals(page);
        expect(visuals).toHaveLength(2);
        expect(visuals.every(visual => visual.rects.length === 3)).toBe(true);
    }, 90_000);

    it('edits EVB markup properties', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const {page} = session;
        const fixturePath = await createTextMarkupAcceptanceFixturePdf(
            `evb-text-markup-properties-${Date.now()}.pdf`,
            1,
        );
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);
        await waitForRenderedTextSpans(page, [1]);
        await createTextMarkup(page, 'Highlight', 1, 0, 1, 2);
        await waitForTextMarkupComments(page, 1);

        const colors = await updateSelectedMarkupProperties(page);
        expect(colors.originalColor).toMatch(/^#/u);
        const updatedComments = await waitForTextMarkupComments(page, 1);
        expect(updatedComments[0]?.color?.toLowerCase()).toBe(colors.updatedColor);
        expect(updatedComments[0]?.opacity).toBeCloseTo(0.65, 2);
    }, 90_000);

    it('tolerates a foreign no-text highlight', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const {page} = session;
        const foreignPath = await createForeignHighlightNoTextFixturePdf(
            `evb-text-markup-foreign-${Date.now()}.pdf`,
        );
        await openPdfInApp(page, foreignPath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);
        const foreignComments = await waitForTextMarkupComments(page, 1);
        expect(foreignComments[0]?.previewText ?? null).toBeNull();
        await page.waitForSelector('.notes-list', {timeout: 20_000});
        const foreignSidebarText = await page.$$eval('.notes-list .note-item-text', elements => (
            elements.map(element => element.textContent ?? '').join(' ')
        ));
        expect(foreignSidebarText).not.toContain('Foreign highlight fixture text is elsewhere');
    }, 90_000);
});
