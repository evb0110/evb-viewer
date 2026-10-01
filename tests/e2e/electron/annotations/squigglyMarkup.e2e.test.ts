import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    copyFileSync,
    readFileSync,
} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {decode} from 'fast-png';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {createPdfjsNodeDocumentOptions} from '@electron/features/search/pdfjsPageTexts';
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
    clickVisibleAnnotationControl,
    readEvbTextMarkupVisuals,
    selectTextFromRenderedSpans,
    setAnnotationColor,
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
    requireWorkspaceCommand,
    type IWorkspaceExposeProbeWindow,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';

function countRedPixels(data: ArrayLike<number>, channels: number) {
    let count = 0;
    for (let offset = 0; offset < data.length; offset += channels) {
        const red = data[offset] ?? 0;
        const green = data[offset + 1] ?? 0;
        const blue = data[offset + 2] ?? 0;
        if (red > 110 && red > green + 20 && red > blue + 20) {
            count += 1;
        }
    }
    return count;
}

function medianRedGreenChannel(data: ArrayLike<number>, channels: number) {
    const greens: number[] = [];
    for (let offset = 0; offset < data.length; offset += channels) {
        const red = data[offset] ?? 0;
        const green = data[offset + 1] ?? 0;
        const blue = data[offset + 2] ?? 0;
        if (red > 110 && red > green + 20 && red > blue + 20) {
            greens.push(green);
        }
    }
    greens.sort((left, right) => left - right);
    return greens[Math.floor(greens.length / 2)] ?? 255;
}

async function countPdfJsRedPixels(filePath: string) {
    const task = pdfjs.getDocument({
        data: new Uint8Array(readFileSync(filePath)),
        ...createPdfjsNodeDocumentOptions(),
    });
    const document = await task.promise;
    try {
        const page = await document.getPage(1);
        const viewport = page.getViewport({scale: 150 / 72});
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        const renderTask = Reflect.apply(page.render, page, [{
            canvas,
            canvasContext: context,
            viewport,
            annotationMode: pdfjs.AnnotationMode.ENABLE,
        }]);
        await renderTask.promise;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        return {
            redPixels: countRedPixels(pixels, 4),
            medianGreen: medianRedGreenChannel(pixels, 4),
        };
    } finally {
        await task.destroy();
    }
}

function countPopplerRedPixels(filePath: string, outputPrefix: string) {
    const {pdftoppm} = getPdfNativeToolPaths();
    execFileSync(pdftoppm, [
        '-f',
        '1',
        '-l',
        '1',
        '-singlefile',
        '-png',
        '-r',
        '150',
        filePath,
        outputPrefix,
    ]);
    const image = decode(readFileSync(`${outputPrefix}.png`));
    return {
        redPixels: countRedPixels(image.data, image.channels),
        medianGreen: medianRedGreenChannel(image.data, image.channels),
    };
}
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

async function expectMarkupPaint(page: Page, subtype: string, lineCount: number) {
    const paint = await page.$$eval(
        '.editor-pane.is-active .pdf-annotation-editor-layer g[data-annotation-kind="text-markup"]',
        groups => groups.map(group => ({
            hitTargets: Array.from(group.querySelectorAll('[data-annotation-hit-target]')).map(element => ({
                fill: getComputedStyle(element).fill,
                painted: Array.from(group.closest('svg')!.querySelectorAll<SVGGeometryElement>('[data-markup-subtype="Highlight"] [data-annotation-visual]')).some(visual => {
                    const x = Number(element.getAttribute('x')) + Number(element.getAttribute('width')) / 2;
                    const y = Number(element.getAttribute('y')) + Number(element.getAttribute('height')) / 2;
                    return Number(getComputedStyle(visual).opacity) > 0 && visual.isPointInFill(new DOMPoint(x, y));
                }),
                geometry: [
                    'x',
                    'y',
                    'width',
                    'height',
                ].map(name => element.getAttribute(name)),
            })),
            visuals: Array.from(group.querySelectorAll('[data-annotation-visual]')).map(element => ({
                tag: element.tagName,
                opacity: Number(getComputedStyle(element).opacity),
                geometry: [
                    'x',
                    'y',
                    'width',
                    'height',
                ].map(name => element.getAttribute(name)),
            })),
        })),
    );
    expect(paint.length).toBeGreaterThan(0);
    for (const group of paint) {
        expect(group.hitTargets).toHaveLength(lineCount);
        expect(group.hitTargets.every(target => target.fill === 'rgba(0, 0, 0, 0)')).toBe(true);
        expect(group.visuals.every(visual => visual.opacity > 0)).toBe(true);
        if (subtype === 'Highlight') {
            expect(group.hitTargets.every(target => target.painted)).toBe(true);
        } else {
            expect(group.visuals).toHaveLength(lineCount);
            expect(group.visuals.every(visual => visual.tag === (subtype === 'Squiggly' ? 'path' : 'line'))).toBe(true);
        }
    }
}

async function expectMarkupHitTesting(page: Page) {
    await clickAnnotationTool(page, 'Select');
    const selector = '.editor-pane.is-active .pdf-annotation-editor-layer g[data-annotation-kind="text-markup"]';
    await page.$eval(selector, group => {
        group.querySelector<SVGRectElement>('[data-annotation-hit-target]')?.scrollIntoView({block: 'center'});
    });
    const hits = await page.$eval(selector, group => {
        const targets = Array.from(group.querySelectorAll('[data-annotation-hit-target]'));
        const bounds = targets.map(target => target.getBoundingClientRect());
        const first = bounds[0]!;
        const second = bounds[1]!;
        const centerX = first.left + first.width / 2;
        return {
            lines: targets.map((target, index) => {
                const rect = bounds[index]!;
                return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === target;
            }),
            gap: group.contains(document.elementFromPoint(centerX, (first.bottom + second.top) / 2)),
            outside: group.contains(document.elementFromPoint(Math.max(...bounds.map(rect => rect.right)) + 12, first.top + first.height / 2)),
        };
    });
    expect(hits.lines).toEqual([
        true,
        true,
        true,
    ]);
    expect(hits.gap).toBe(false);
    expect(hits.outside).toBe(false);
}

async function updateSelectedMarkupProperties(page: Page, opacityPercent = 65) {
    await clickAnnotationTool(page, 'Select');
    const markupTarget = '.editor-pane.is-active .pdf-annotation-editor-layer g[data-annotation-kind="text-markup"] [data-annotation-hit-target]';
    await page.$eval(markupTarget, target => target.scrollIntoView({block: 'center'}));
    await clickVisibleAnnotationControl(page, markupTarget);
    const inspector = '.editor-pane.is-active [data-annotation-inspector][data-target="selection"]';
    await page.waitForSelector(inspector, {visible: true});
    const originalColor = (await readTextMarkupComments(page))[0]?.color;
    await clickVisibleAnnotationControl(page, `${inspector} .swatch[aria-label="#ef4444"]`);
    await waitForTextMarkupProperty(page, comment => comment.color?.toLowerCase() === '#ef4444',
        'the canonical text-markup color update');
    await clickVisibleAnnotationControl(page, `${inspector} input[type="number"][aria-label="Opacity, %"]`);
    const initialOpacity = await page.$eval(`${inspector} input[type="number"][aria-label="Opacity, %"]`, input => Number((input as HTMLInputElement).value));
    expect(initialOpacity % 5).toBe(0);
    for (let value = initialOpacity; value !== opacityPercent; value += value < opacityPercent ? 5 : -5) {
        await page.keyboard.press(value < opacityPercent ? 'ArrowUp' : 'ArrowDown');
    }
    await page.keyboard.press('Tab');
    await waitForTextMarkupProperty(page, comment => comment.opacity !== null
        && comment.opacity !== undefined && Math.abs(comment.opacity - opacityPercent / 100) < 0.02,
    'the canonical text-markup opacity update');
    expect(await page.$$(inspector)).toHaveLength(1);
    return {
        originalColor,
        updatedColor: '#ef4444',
    };
}

describe('Electron E2E - EVB text markup', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        restartBeforeEach: true,
        sessionName: () => `e2e-evb-text-markup-${Date.now()}`,
    });

    it.each(TEXT_MARKUP_SUBTYPES)('authors, saves, and reopens a %s annotation', async (tool, subtype) => {
        const session = sessionFixture.getSession();
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

        await clickAnnotationTool(page, tool);
        await setAnnotationColor(page, '#ef4444');
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
        await expectMarkupPaint(page, subtype, 3);
        await expectMarkupHitTesting(page);

        let editorMedianGreen: number | undefined;
        if (subtype === 'Squiggly' || subtype === 'Highlight') {
            await updateSelectedMarkupProperties(page, 35);
            const pageElement = await page.$('.editor-pane.is-active .page_container[data-page="1"]');
            if (!pageElement) {
                throw new Error('Active PDF page element is missing');
            }
            const editorImage = decode(await pageElement.screenshot());
            editorMedianGreen = medianRedGreenChannel(editorImage.data, editorImage.channels);
            expect(editorMedianGreen, `the EVB screenshot shows the 35% red ${subtype}`).toBeGreaterThan(160);
            expect(editorMedianGreen).toBeLessThan(215);
        }

        await saveViaWindowHandle(page);
        if (subtype === 'Squiggly' || subtype === 'Highlight') {
            const savedEvidencePath = join(tmpdir(), `evb-${subtype.toLowerCase()}-opacity-${Date.now()}.pdf`);
            copyFileSync(fixturePath, savedEvidencePath);
            console.log(`TEXT_MARKUP_OPACITY_PDF ${savedEvidencePath}`);
            console.log(`TEXT_MARKUP_EDITOR_MEDIAN_GREEN ${subtype} ${String(editorMedianGreen)}`);
        }
        const savedSummary = await waitForPdfAnnotationSubtypeCount(fixturePath, subtype, 1);
        expect(savedSummary.bySubtype[subtype] ?? 0).toBe(1);

        const popplerRedPixels = countPopplerRedPixels(
            fixturePath,
            createFixturePath(`evb-text-markup-poppler-${Date.now()}-${subtype}`),
        );
        console.log(`TEXT_MARKUP_POPPLER_PIXELS ${JSON.stringify({
            subtype,
            ...popplerRedPixels,
        })}`);
        expect(popplerRedPixels.redPixels, `Poppler renders the saved ${subtype} in red`).toBeGreaterThan(10);
        const pdfJsRedPixels = await countPdfJsRedPixels(fixturePath);
        console.log(`TEXT_MARKUP_PDFJS_PIXELS ${JSON.stringify({
            subtype,
            ...pdfJsRedPixels,
        })}`);
        expect(pdfJsRedPixels.redPixels, `restricted PDF.js renders the saved ${subtype} in red`).toBeGreaterThan(10);
        if (editorMedianGreen !== undefined) {
            expect(popplerRedPixels.medianGreen, 'Poppler preserves 35% opacity instead of applying it twice').toBeGreaterThan(160);
            expect(popplerRedPixels.medianGreen).toBeLessThan(215);
            expect(pdfJsRedPixels.medianGreen, 'restricted PDF.js preserves 35% opacity instead of applying it twice').toBeGreaterThan(160);
            expect(pdfJsRedPixels.medianGreen).toBeLessThan(215);
            expect(Math.abs(popplerRedPixels.medianGreen - editorMedianGreen), 'Poppler and EVB render opacity at the same intensity').toBeLessThan(30);
            expect(Math.abs(pdfJsRedPixels.medianGreen - editorMedianGreen), 'restricted PDF.js and EVB render opacity at the same intensity').toBeLessThan(30);

            await updateSelectedMarkupProperties(page, 100);
            const opaquePageElement = await page.$('.editor-pane.is-active .page_container[data-page="1"]');
            if (!opaquePageElement) {
                throw new Error('Active PDF page element is missing');
            }
            const opaqueEditorImage = decode(await opaquePageElement.screenshot());
            const opaqueEditorMedianGreen = medianRedGreenChannel(opaqueEditorImage.data, opaqueEditorImage.channels);
            console.log(`TEXT_MARKUP_OPAQUE_EDITOR_MEDIAN_GREEN ${subtype} ${opaqueEditorMedianGreen}`);
            await saveViaWindowHandle(page);
            const opaquePoppler = countPopplerRedPixels(
                fixturePath,
                createFixturePath(`evb-text-markup-opaque-poppler-${Date.now()}-${subtype}`),
            );
            const opaquePdfJs = await countPdfJsRedPixels(fixturePath);
            console.log(`TEXT_MARKUP_OPAQUE_RENDERERS ${JSON.stringify({
                subtype,
                poppler: opaquePoppler,
                pdfjs: opaquePdfJs,
            })}`);
            expect(Math.abs(opaquePoppler.medianGreen - 68), 'Poppler opacity 1 matches the fully opaque red mark').toBeLessThan(15);
            const expectedPdfJsOpaqueGreen = subtype === 'Highlight' ? 68 : 84;
            expect(Math.abs(opaquePdfJs.medianGreen - expectedPdfJsOpaqueGreen), 'restricted PDF.js opacity 1 matches its fully opaque red mark').toBeLessThan(20);
        }

        const reopenedPath = createFixturePath(
            `evb-text-markup-reopen-${Date.now()}-${subtype}.pdf`,
        );
        copyFileSync(fixturePath, reopenedPath);
        await openPdfInApp(page, reopenedPath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);
        await waitForRenderedTextSpans(page, [1]);

        // Saved markup reaches the canonical layer through the writer parse,
        // which can finish after the text layer has rendered.
        await waitForEvbTextMarkupVisualCount(page, 1);
        const reopenedVisuals = await readEvbTextMarkupVisuals(page);
        expect(reopenedVisuals.map(({
            pageNumber, subtype: kind, rects,
        }) => ({
            pageNumber,
            subtype: kind,
            rects: rects.map(({
                left, top, width, height,
            }) => [
                left,
                top,
                width,
                height,
            ].map(value => Math.round(value * 10_000) / 10_000)),
        }))).toEqual(visuals.map(({
            pageNumber, subtype: kind, rects,
        }) => ({
            pageNumber,
            subtype: kind,
            rects: rects.map(({
                left, top, width, height,
            }) => [
                left,
                top,
                width,
                height,
            ].map(value => Math.round(value * 10_000) / 10_000)),
        })));
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
            await requireWorkspaceCommand<boolean>(page, 'setCustomZoomFromDisplay', [zoom]);
            await waitForWorkspaceToolbarSnapshot(page, {effectiveZoom: zoom}, {timeoutMs: 20_000});
            await waitForPageWidthAtZoom(page, basePageWidth, zoom);
            await waitForViewerInteractive(page);
            const visuals = await readEvbTextMarkupVisuals(page);
            expect(visuals).toHaveLength(1);
            expect(visuals[0]?.rects).toHaveLength(3);
            await expectMarkupPaint(page, 'Highlight', 3);
            await expectMarkupHitTesting(page);
            geometryByZoom.set(zoom, JSON.stringify(visuals[0]?.rects));
        }
        expect(geometryByZoom.get(0.5)).toBe(geometryByZoom.get(1));
        expect(geometryByZoom.get(1)).toBe(geometryByZoom.get(2));
    }, 90_000);

    it('splits a cross-page selection into one canonical annotation per page', async () => {
        const session = sessionFixture.getSession();
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
        await expectMarkupPaint(page, 'Highlight', 3);
    }, 90_000);

    it('edits EVB markup properties', async () => {
        const session = sessionFixture.getSession();
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
