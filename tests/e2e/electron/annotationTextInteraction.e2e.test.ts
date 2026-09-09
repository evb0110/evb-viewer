import {
    copyFileSync,
    mkdtempSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'puppeteer-core';
import {
    createCanvas,
    loadImage,
} from '@napi-rs/canvas';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {
    createBlankFixturePdf,
    createMultiPageTextFixturePdf,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import {countWarmHighlightPixels} from '@tests/e2e/electron/helpers/searchHighlightPaint';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickAnnotationTool,
    clickVisibleAnnotationControl,
    selectAllFocusedAnnotationText,
    setAnnotationKeepActiveWithPointer,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openPdfInApp,
    openDocumentSidebarTab,
    openAnnotationsTab,
    waitForPdfLoaded,
    waitForViewerInteractive,
    saveViaWindowHandle,
    scrollViewerToPage,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const BOX = '.editor-pane.is-active .pdf-annotation-editor-text-box[data-annotation-kind="text-box"]';
const PREVIEW = '.editor-pane.is-active .pdf-annotation-editor-text-box-preview';

const MARKUP = '.editor-pane.is-active .workspace-host[data-workspace-active="true"] g[data-annotation-kind="text-markup"]';

interface ISelectionRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

async function markupSelectionPoints(page: Page) {
    await waitForViewerInteractive(page);
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    return page.evaluate(() => {
        const spans = [...document.querySelectorAll<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"] .text-layer span')]
            .filter(candidate => {
                const rect = candidate.getBoundingClientRect();
                return candidate.firstChild instanceof Text && (candidate.textContent?.length ?? 0) > 10
                    && rect.top > 150 && rect.bottom < innerHeight - 200 && rect.right < innerWidth;
            });
        const first = spans[0]?.firstChild;
        const last = spans[1]?.firstChild;
        if (!(first instanceof Text) || !(last instanceof Text)) {
            throw new Error('Two visible text lines are required');
        }
        if (spans[0]?.closest('.page_container') !== spans[1]?.closest('.page_container')) {
            throw new Error('Markup selection needs two visible lines on the same page');
        }
        const range = document.createRange();
        // A partial heading followed by a differently sized line matches the
        // reported recording and catches geometry built from unselected text.
        const offset = Math.floor(first.length * 0.35);
        range.setStart(first, offset);
        range.setEnd(first, offset + 1);
        const start = range.getBoundingClientRect();
        range.setStart(last, last.length - 1);
        range.setEnd(last, last.length);
        const end = range.getBoundingClientRect();
        range.setStart(first, 0);
        range.setEnd(first, 1);
        const expandedStart = range.getBoundingClientRect();
        return {
            expandedStart: {
                x: expandedStart.left + 0.5,
                y: expandedStart.top + expandedStart.height / 2,
            },
            start: {
                x: start.left + 0.5,
                y: start.top + start.height / 2,
            },
            end: {
                x: end.right - 0.5,
                y: end.top + end.height / 2,
            },
        };
    });
}

async function dragMarkupSelection(page: Page, points: Pick<Awaited<ReturnType<typeof markupSelectionPoints>>, 'start' | 'end'>, captureBeforeRelease: boolean) {
    await page.mouse.move(points.start.x, points.start.y);
    const hit = await page.evaluate(point => {
        const target = document.elementFromPoint(point.x, point.y);
        const container = target?.closest('.page_container');
        return {
            textLayer: Boolean(target?.closest('.text-layer')),
            pageNumber: container?.getAttribute('data-page'),
            top: container?.getBoundingClientRect().top,
        };
    }, points.start);
    expect(hit.textLayer, 'Markup drag must start on the rendered text layer').toBe(true);
    await page.mouse.down();
    const topAfterPress = await page.$eval(`.page_container[data-page="${hit.pageNumber}"]`, element => element.getBoundingClientRect().top);
    expect(topAfterPress, 'Starting text selection must not move the page under the pointer').toBeCloseTo(hit.top!, 0);
    await page.mouse.move(points.end.x, points.end.y, {steps: 16});
    if (!captureBeforeRelease) await page.mouse.up();
    const selected = await page.evaluate(() => {
        const selection = document.getSelection();
        if (!selection?.rangeCount) throw new Error(`Mouse drag did not select text: ${document.querySelector('.editor-pane.is-active .workspace-host[data-workspace-active="true"] .pdfViewer')?.className}`);
        const range = selection.getRangeAt(0);
        const rects = [...document.querySelectorAll<HTMLElement>('.editor-pane.is-active .workspace-host[data-workspace-active="true"] .text-layer span')].flatMap(span => {
            const node = span.firstChild;
            if (!(node instanceof Text) || !range.intersectsNode(node)) {
                return [];
            }
            const start = range.startContainer === node ? range.startOffset : 0;
            const end = range.endContainer === node ? range.endOffset : node.length;
            if (end <= start) {
                return [];
            }
            const part = document.createRange();
            part.setStart(node, start);
            part.setEnd(node, end);
            const pageRect = span.closest('.page_container')!.getBoundingClientRect();
            return [...part.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => ({
                left: (rect.left - pageRect.left) / pageRect.width,
                top: (rect.top - pageRect.top) / pageRect.height,
                width: rect.width / pageRect.width,
                height: rect.height / pageRect.height,
            }));
        });
        return {
            text: selection.toString(),
            rects,
        };
    });
    if (captureBeforeRelease) await page.mouse.up();
    return selected;
}

async function expectMarkupGeometry(page: Page, expected: ISelectionRect[], compareUnion = false) {
    const actual = await page.$$eval(`${MARKUP} [data-annotation-hit-target]`, elements => elements.map(element => ({
        left: Number(element.getAttribute('x')),
        top: Number(element.getAttribute('y')),
        width: Number(element.getAttribute('width')),
        height: Number(element.getAttribute('height')),
    })));
    if (compareUnion) {
        // Compare covered area, allowing the saved union to partition overlapping
        // line boxes without requiring the original rectangle representation.
        const rectangles = [
            ...actual,
            ...expected,
        ];
        const xs = [...new Set(rectangles.flatMap(rect => [
            rect.left,
            rect.left + rect.width,
        ]))].sort((a, b) => a - b);
        const ys = [...new Set(rectangles.flatMap(rect => [
            rect.top,
            rect.top + rect.height,
        ]))].sort((a, b) => a - b);
        const contains = (rects: ISelectionRect[], x: number, y: number) => rects.some(rect => (
            x > rect.left && x < rect.left + rect.width && y > rect.top && y < rect.top + rect.height
        ));
        let changedArea = 0;
        let coveredArea = 0;
        for (let column = 1; column < xs.length; column += 1) {
            for (let row = 1; row < ys.length; row += 1) {
                const x = (xs[column - 1]! + xs[column]!) / 2;
                const y = (ys[row - 1]! + ys[row]!) / 2;
                const area = (xs[column]! - xs[column - 1]!) * (ys[row]! - ys[row - 1]!);
                const expectedContains = contains(expected, x, y);
                if (expectedContains) coveredArea += area;
                if (contains(actual, x, y) !== expectedContains) changedArea += area;
            }
        }
        expect(changedArea, 'Merged geometry must cover exactly the selected text area').toBeLessThan(0.00001);
        const paintedArea = actual.reduce((area, rect) => area + rect.width * rect.height, 0);
        expect(paintedArea - coveredArea, 'Saved highlight rectangles must not paint the same area twice').toBeLessThan(0.00001);
        return;
    }
    const byPosition = (left: ISelectionRect, right: ISelectionRect) => left.top - right.top || left.left - right.left;
    actual.sort(byPosition);
    const expectedByPosition = [...expected].sort(byPosition);
    expect(actual).toHaveLength(expected.length);
    for (const [
        index,
        rect,
    ] of actual.entries()) {
        for (const key of [
            'left',
            'top',
            'width',
            'height',
        ] as const) {
            expect(rect[key], `quad ${index} ${key}`).toBeCloseTo(expectedByPosition[index]![key], 4);
        }
    }
}

async function highlightPaintColor(page: Page) {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const bounds = await page.$$eval(`${MARKUP} [data-annotation-hit-target]`, elements => {
        const visible = elements.map(element => element.getBoundingClientRect()).map(rect => ({
            left: Math.max(0, Math.ceil(rect.left + 2)),
            top: Math.max(92, Math.ceil(rect.top + 2)),
            right: Math.min(innerWidth, Math.floor(rect.right - 2)),
            bottom: Math.min(innerHeight - 30, Math.floor(rect.bottom - 2)),
        })).find(rect => rect.right > rect.left && rect.bottom > rect.top);
        if (!visible) throw new Error('Highlight must have a visible hit area');
        return {
            left: visible.left,
            top: visible.top,
            width: visible.right - visible.left,
            height: visible.bottom - visible.top,
        };
    });
    const image = await loadImage(Buffer.from(await page.screenshot()));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(bounds.left, bounds.top, bounds.width, bounds.height).data;
    const colors = new Map<string, number>();
    for (let index = 0; index < pixels.length; index += 4) {
        const r = pixels[index]!;
        const g = pixels[index + 1]!;
        const b = pixels[index + 2]!;
        if (r > 175 && g > 95 && r - b > 45 && g - b > 20) {
            const key = `${r},${g},${b}`;
            colors.set(key, (colors.get(key) ?? 0) + 1);
        }
    }
    const color = [...colors].sort((a, b) => b[1] - a[1])[0]?.[0];
    expect(color, 'A visible yellow highlight is required for the overlap comparison').toBeTruthy();
    return color;
}

async function expectHighlightPaint(page: Page) {
    let lastMeasurement = '';
    await expect.poll(async () => {
        const measurement = await page.$eval(`${MARKUP} [data-annotation-hit-target]`, element => {
            const rect = element.getBoundingClientRect();
            return {
                rect: {
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                },
                viewport: {
                    width: innerWidth,
                    height: innerHeight,
                },
                area: rect.width * rect.height,
                pageRect: element.closest('.page_container')?.getBoundingClientRect().toJSON(),
            };
        });
        lastMeasurement = JSON.stringify(measurement);
        const paintedPixels = await countWarmHighlightPixels(await page.screenshot(), measurement.rect, measurement.viewport);
        return measurement.area > 0 ? paintedPixels / measurement.area : 0;
    }, {
        timeout: 10_000,
        message: 'Committed highlight must paint after the reopened page renders',
    }).toBeGreaterThan(0.2).catch((error: unknown) => {
        console.error(`Highlight paint geometry: ${lastMeasurement}`);
        throw error;
    });
}

async function frame(page: Page, selector = BOX) {
    return page.$eval(selector, element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            fontSize: Number.parseFloat(style.fontSize),
            border: style.borderTopStyle,
            focused: element.contains(document.activeElement),
            text: element.textContent?.trim(),
        };
    });
}

async function modifiedKey(page: Page, key: 'Enter' | 'KeyZ' | 'KeyS') {
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(modifier);
    await page.keyboard.press(key);
    await page.keyboard.up(modifier);
}

async function placementPoint(page: Page) {
    return page.$eval('.editor-pane.is-active .workspace-host[data-workspace-active="true"] .page_container[data-page="1"]', element => {
        const rect = element.getBoundingClientRect();
        const left = Math.max(rect.left, 340);
        const top = Math.max(rect.top, 150);
        const right = Math.min(rect.right, innerWidth - 30);
        const bottom = Math.min(rect.bottom, innerHeight - 50);
        const point = {
            x: left + (right - left) * 0.2,
            y: top + (bottom - top) * 0.35,
        };
        if (!element.contains(document.elementFromPoint(point.x, point.y))) throw new Error('Text placement point is obstructed');
        return point;
    });
}

async function startText(page: Page) {
    await clickAnnotationTool(page, 'Text');
    const point = await placementPoint(page);
    await page.mouse.click(point.x, point.y);
    await page.waitForSelector(`${BOX} [contenteditable="true"]`, {visible: true});
    expect((await frame(page)).focused).toBe(true);
}

async function waitForTextControlsLayout(page: Page) {
    // A late font swap changes the measured text width and moves its handles.
    // Aim only after the same font used by the rendered text is ready.
    await page.evaluate(async () => {
        await document.fonts.load('22px "EVB Annotation Sans"');
        await document.fonts.ready;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
}

async function resize(page: Page, handle: string, dx: number, dy: number) {
    await waitForTextControlsLayout(page);
    const selector = `.editor-pane.is-active .workspace-host[data-workspace-active="true"] [data-pdf-annotation-resize-handle="${handle}"]`;
    await page.waitForSelector(selector, {visible: true});
    const point = await page.$eval(selector, element => {
        const rect = element.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Text resize handle is obstructed');
        return {
            x,
            y,
        };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + dx, point.y + dy, {steps: 8});
    const preview = await frame(page);
    await page.mouse.up();
    return {
        preview,
        committed: await frame(page),
    };
}

describe('Electron E2E - text interaction contract', () => {
    const sessions = createElectronE2ESessionFixture({
        restartBeforeEach: true,
        extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
        sessionName: () => `e2e-text-interaction-${Date.now()}`,
    });

    async function openFixture(keepActive = false, zoom = 2.62, source?: string) {
        const session = sessions.getSession();
        if (!session) throw new Error('Text interaction session did not start');
        await session.page.setViewport({
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
        });
        const generated = await createBlankFixturePdf(`text-interaction-${Date.now()}.pdf`);
        const directory = mkdtempSync(join(tmpdir(), 'evb-text-interaction-'));
        const path = join(directory, 'document.pdf');
        copyFileSync(source ?? process.env.EVB_TEXT_INTERACTION_FIXTURE ?? generated, path);
        onTestFinished(() => {rmSync(generated, {force: true}); rmSync(directory, {
            recursive: true,
            force: true,
        });});
        await openPdfInApp(session.page, path);
        await waitForPdfLoaded(session.page);
        await waitForViewerInteractive(session.page);
        await openAnnotationsTab(session.page);
        await setAnnotationKeepActiveWithPointer(session.page, keepActive);
        await callWorkspaceCommand(session.page, 'setViewRotation', [0]);
        await callWorkspaceCommand(session.page, 'setCustomZoomFromDisplay', [zoom]);
        await session.page.waitForFunction(percent => document.querySelector('.zoom-controls-display-value')?.textContent?.trim() === percent, {}, `${Math.round(zoom * 100)}%`);
        if (source && process.env.EVB_MARKUP_FIXTURE_PAGE) {
            const pageNumber = Number(process.env.EVB_MARKUP_FIXTURE_PAGE);
            await scrollViewerToPage(session.page, pageNumber);
            await session.page.waitForSelector(`.editor-pane.is-active .workspace-host[data-workspace-active="true"] .page_container[data-page="${pageNumber}"] .text-layer span`);
        }
        await waitForViewerInteractive(session.page);
        return {
            session,
            page: session.page,
            path,
        };
    }

    it('merges overlapping highlights through undo, save, and reopen', async () => {
        const textFixture = await createMultiPageTextFixturePdf(`markup-overlap-${Date.now()}.pdf`, 1);
        onTestFinished(() => rmSync(textFixture, {force: true}));
        const zoom = process.env.EVB_TEXT_INTERACTION_FIXTURE ? 3.8 : 2.92;
        const {
            page, path,
        } = await openFixture(false, zoom, process.env.EVB_TEXT_INTERACTION_FIXTURE ?? textFixture);
        const initialAnnotations = await readPdfAnnotationSummary(path);
        const points = await markupSelectionPoints(page);
        await clickAnnotationTool(page, 'Highlight');
        const initialSelection = await dragMarkupSelection(page, points, true);
        await page.waitForSelector(MARKUP);
        await expectMarkupGeometry(page, initialSelection.rects, true);
        const before = await highlightPaintColor(page);
        // Merge into an already saved annotation to exercise its stable PDF
        // identity and the native geometry rewrite, not only draft creation.
        await saveViaWindowHandle(page, 30_000);
        if (process.env.EVB_MARKUP_EVIDENCE_DIR) copyFileSync(path, join(process.env.EVB_MARKUP_EVIDENCE_DIR, 'first-saved.pdf'));

        await clickAnnotationTool(page, 'Highlight');
        const expandedSelection = await dragMarkupSelection(page, {
            ...points,
            start: points.expandedStart,
        }, true);
        await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1 && getSelection()?.rangeCount === 0, {}, MARKUP);
        await expectMarkupGeometry(page, expandedSelection.rects, true);
        expect(await highlightPaintColor(page), 'Re-highlighting text must not make it darker').toBe(before);
        if (process.env.EVB_MARKUP_EVIDENCE_DIR) {
            await page.screenshot({path: join(process.env.EVB_MARKUP_EVIDENCE_DIR, 'overlap-selected.png')});
        }
        const cards = '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .note-item[data-annotation-kind="text-markup"] .note-item-text';
        await expect.poll(() => page.$eval(cards, row => row.textContent?.replace(/\s+/gu, ''))).toBe(expandedSelection.text.replace(/\s+/gu, ''));
        const texts = await page.$$eval(cards, rows => rows.map(row => row.textContent?.trim()));
        expect(texts).toHaveLength(1);
        expect(texts.every(text => text && !text.toLowerCase().includes('no text'))).toBe(true);
        await page.mouse.click(points.start.x, points.start.y - 120);
        expect(await page.$$eval(cards, rows => rows.map(row => row.textContent?.trim()))).toEqual(texts);
        expect(await highlightPaintColor(page), 'Blurring the selection must keep the highlight visible').toBe(before);
        if (process.env.EVB_MARKUP_EVIDENCE_DIR) {
            await page.screenshot({path: join(process.env.EVB_MARKUP_EVIDENCE_DIR, 'overlap.png')});
        }
        await clickVisibleAnnotationControl(page, '.toolbar-action--undo button:not(:disabled)');
        await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1, {}, MARKUP);
        await expectMarkupGeometry(page, initialSelection.rects, true);
        await expect.poll(() => page.$eval(cards, row => row.textContent?.replace(/\s+/gu, ''))).toBe(initialSelection.text.replace(/\s+/gu, ''));
        expect(await highlightPaintColor(page)).toBe(before);
        await clickVisibleAnnotationControl(page, '.toolbar-action--redo button:not(:disabled)');
        await page.waitForFunction(selector => document.querySelectorAll(selector).length === 1, {}, MARKUP);
        await expectMarkupGeometry(page, expandedSelection.rects, true);
        expect(await highlightPaintColor(page)).toBe(before);
        await saveViaWindowHandle(page, 30_000);
        if (process.env.EVB_MARKUP_EVIDENCE_DIR) copyFileSync(path, join(process.env.EVB_MARKUP_EVIDENCE_DIR, 'merged-saved.pdf'));

        expect(await readPdfAnnotationSummary(path)).toEqual({
            total: initialAnnotations.total + 1,
            bySubtype: {
                ...initialAnnotations.bySubtype,
                Highlight: (initialAnnotations.bySubtype.Highlight ?? 0) + 1,
            },
        });
        const restarted = await sessions.restart({hard: true});
        if (!restarted) throw new Error('Highlight overlap save/reopen did not start');
        const reopened = restarted.page;
        await reopened.setViewport({
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
        });
        await openPdfInApp(reopened, path);
        await waitForPdfLoaded(reopened);
        await waitForViewerInteractive(reopened);
        await openAnnotationsTab(reopened);
        await callWorkspaceCommand(reopened, 'setCustomZoomFromDisplay', [zoom]);
        await reopened.waitForFunction(percent => document.querySelector('.zoom-controls-display-value')?.textContent?.trim() === percent, {}, `${Math.round(zoom * 100)}%`);
        await waitForViewerInteractive(reopened);
        await reopened.evaluate(async () => { await document.fonts.ready; });
        if (process.env.EVB_MARKUP_FIXTURE_PAGE) {
            await scrollViewerToPage(reopened, Number(process.env.EVB_MARKUP_FIXTURE_PAGE));
        }
        await waitForViewerInteractive(reopened);
        await reopened.waitForSelector(MARKUP);
        expect(await reopened.$$(MARKUP)).toHaveLength(1);
        await expectMarkupGeometry(reopened, expandedSelection.rects, true);
        if (process.env.EVB_MARKUP_EVIDENCE_DIR) {
            await reopened.screenshot({path: join(process.env.EVB_MARKUP_EVIDENCE_DIR, 'overlap-reopened.png')});
        }
        await expect.poll(() => highlightPaintColor(reopened)).toBe(before);
        await expect.poll(() => reopened.$$eval(cards, rows => rows.map(row => row.textContent?.trim()))).toEqual(texts);
    });

    it.each([
        [
            'highlight',
            'Highlight',
        ],
        [
            'underline',
            'Underline',
        ],
        [
            'strikethrough',
            'StrikeOut',
        ],
        [
            'squiggly',
            'Squiggly',
        ],
    ] as const)('commits %s after selecting text, consumes the selection, and saves matching geometry', async (tool, subtype) => {
        const textFixture = await createMultiPageTextFixturePdf(`markup-selection-${Date.now()}.pdf`, 1);
        onTestFinished(() => rmSync(textFixture, {force: true}));
        const {
            page,
            path,
        } = await openFixture(false, 2.92, process.env.EVB_TEXT_INTERACTION_FIXTURE ?? textFixture);
        const initialAnnotations = await readPdfAnnotationSummary(path);
        await clickAnnotationTool(page, 'Select');
        const points = await markupSelectionPoints(page);
        const expected = await dragMarkupSelection(page, points, false);
        expect(expected.text.length).toBeGreaterThan(10);
        expect(expected.rects).toHaveLength(2);
        await clickVisibleAnnotationControl(page, `.editor-pane.is-active .workspace-host[data-workspace-active="true"] .tool-button[data-tool="${tool}"]`);
        await page.waitForSelector(`${MARKUP}[data-markup-subtype="${subtype}"]`, {timeout: 3_000});
        expect(await page.evaluate(() => window.getSelection()?.rangeCount)).toBe(0);
        await expectMarkupGeometry(page, expected.rects, tool === 'highlight');
        // PDF.js positions lines absolutely, so native Selection.toString can
        // omit their separating spaces. The sidebar adds readable line gaps.
        await expect.poll(() => page.$eval('.editor-pane.is-active .workspace-host[data-workspace-active="true"] .note-item[data-annotation-kind="text-markup"] .note-item-text', element => element.textContent?.replace(/\s+/gu, ''))).toBe(expected.text.replace(/\s+/gu, ''));
        expect(await page.$eval('.editor-pane.is-active .workspace-host[data-workspace-active="true"] .tool-button[data-tool="select"]', element => element.getAttribute('aria-pressed'))).toBe('true');
        await page.mouse.click(points.end.x, points.end.y + 150);
        if (tool === 'highlight') await expectHighlightPaint(page);
        if (process.env.EVB_MARKUP_EVIDENCE_DIR) {
            await page.screenshot({path: join(process.env.EVB_MARKUP_EVIDENCE_DIR, `${tool}-committed.png`)});
        }
        await expectMarkupGeometry(page, expected.rects, tool === 'highlight');
        // Activating another markup tool after clicking blank space must not
        // turn the consumed cached range into another annotation.
        await clickVisibleAnnotationControl(page, '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .tool-button[data-tool="underline"]');
        await page.mouse.click(points.end.x, points.end.y + 150);
        expect(await page.$$eval(MARKUP, elements => elements.length)).toBe(1);
        await saveViaWindowHandle(page, 30_000);
        expect(await readPdfAnnotationSummary(path)).toEqual({
            total: initialAnnotations.total + 1,
            bySubtype: {
                ...initialAnnotations.bySubtype,
                [subtype]: (initialAnnotations.bySubtype[subtype] ?? 0) + 1,
            },
        });
        if (process.env.EVB_MARKUP_EVIDENCE_DIR) {
            copyFileSync(path, join(process.env.EVB_MARKUP_EVIDENCE_DIR, `${tool}-saved.pdf`));
        }
        const restarted = await sessions.restart({hard: true});
        if (!restarted) throw new Error('Markup save reopen did not start');
        const reopened = restarted.page;
        await reopened.setViewport({
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
        });
        await openPdfInApp(reopened, path);
        await waitForPdfLoaded(reopened);
        await waitForViewerInteractive(reopened);
        await openAnnotationsTab(reopened);
        await callWorkspaceCommand(reopened, 'setCustomZoomFromDisplay', [2.92]);
        await reopened.waitForFunction(() => document.querySelector('.zoom-controls-display-value')?.textContent?.trim() === '292%');
        await waitForViewerInteractive(reopened);
        await reopened.evaluate(async () => {
            await document.fonts.ready;
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
        if (process.env.EVB_MARKUP_FIXTURE_PAGE) {
            await scrollViewerToPage(reopened, Number(process.env.EVB_MARKUP_FIXTURE_PAGE));
        }
        await waitForViewerInteractive(reopened);
        await reopened.waitForSelector(`${MARKUP}[data-markup-subtype="${subtype}"]`);
        await expectMarkupGeometry(reopened, expected.rects, tool === 'highlight');
        if (tool === 'highlight') await expectHighlightPaint(reopened);
        if (process.env.EVB_MARKUP_EVIDENCE_DIR) {
            await reopened.screenshot({path: join(process.env.EVB_MARKUP_EVIDENCE_DIR, `${tool}-reopened.png`)});
        }
        await expect.poll(() => reopened.$eval('.editor-pane.is-active .workspace-host[data-workspace-active="true"] .note-item[data-annotation-kind="text-markup"] .note-item-text', element => element.textContent?.trim())).toContain(expected.text.trim().slice(-20));
    });

    it.each([
        [
            'highlight',
            'Highlight',
        ],
        [
            'underline',
            'Underline',
        ],
        [
            'strikethrough',
            'StrikeOut',
        ],
        [
            'squiggly',
            'Squiggly',
        ],
    ] as const)('commits each real drag once while %s stays active', async (tool, subtype) => {
        const textFixture = await createMultiPageTextFixturePdf(`markup-drag-${Date.now()}.pdf`, 1);
        onTestFinished(() => rmSync(textFixture, {force: true}));
        const {page} = await openFixture(true, 2.92, process.env.EVB_TEXT_INTERACTION_FIXTURE ?? textFixture);
        await clickVisibleAnnotationControl(page, `.editor-pane.is-active .workspace-host[data-workspace-active="true"] .tool-button[data-tool="${tool}"]`);
        const points = await markupSelectionPoints(page);
        const expected = await dragMarkupSelection(page, points, true);
        await page.waitForSelector(`${MARKUP}[data-markup-subtype="${subtype}"]`, {timeout: 3_000});
        expect(await page.evaluate(() => window.getSelection()?.rangeCount)).toBe(0);
        await expectMarkupGeometry(page, expected.rects, tool === 'highlight');
        expect(await page.$eval(`.editor-pane.is-active .workspace-host[data-workspace-active="true"] .tool-button[data-tool="${tool}"]`, element => element.getAttribute('aria-pressed'))).toBe('true');
        await page.mouse.click(points.end.x, points.end.y + 150);
        expect(await page.$$eval(MARKUP, elements => elements.length)).toBe(1);
        await dragMarkupSelection(page, points, true);
        // A merged highlight keeps the count unchanged. Selection consumption
        // is the completion signal for the second asynchronous drag commit.
        await page.waitForFunction((selector, count) => document.querySelectorAll(selector).length === count && window.getSelection()?.rangeCount === 0, {timeout: 3_000}, MARKUP, tool === 'highlight' ? 1 : 2);
        expect(await page.evaluate(() => window.getSelection()?.rangeCount)).toBe(0);
        // The active instrument must still be possible to switch off.
        await clickVisibleAnnotationControl(page, `.editor-pane.is-active .workspace-host[data-workspace-active="true"] .tool-button[data-tool="${tool}"]`);
        expect(await page.$eval('.editor-pane.is-active .workspace-host[data-workspace-active="true"] .tool-button[data-tool="select"]', element => element.getAttribute('aria-pressed'))).toBe('true');
    });

    it('annotates text inside a search result without dropping the decorated text nodes', async () => {
        const textFixture = await createMultiPageTextFixturePdf(`markup-search-${Date.now()}.pdf`, 1);
        onTestFinished(() => rmSync(textFixture, {force: true}));
        const {page} = await openFixture(true, 2, textFixture);
        await openDocumentSidebarTab(page, 'Search');
        await page.type('.editor-pane.is-active .workspace-host[data-workspace-active="true"] .document-search-bar input', 'sample');
        await clickVisibleAnnotationControl(page, '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .search-run-button');
        const matchSelector = '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .text-layer .pdf-search-highlight';
        await page.waitForSelector(matchSelector, {visible: true});
        await openAnnotationsTab(page);
        await clickAnnotationTool(page, 'Highlight');
        await page.waitForSelector(matchSelector, {visible: true});
        await waitForViewerInteractive(page);
        const points = await page.$eval(matchSelector, element => {
            const node = element.firstChild;
            if (!(node instanceof Text)) throw new Error('Search result has no text node');
            const range = document.createRange();
            range.setStart(node, 0);
            range.setEnd(node, node.length);
            const rect = range.getBoundingClientRect();
            return {
                start: {
                    x: rect.left + 0.5,
                    y: rect.top + rect.height / 2,
                },
                end: {
                    x: rect.right - 0.5,
                    y: rect.top + rect.height / 2,
                },
            };
        });
        const expected = await dragMarkupSelection(page, points, true);
        expect(expected.text).toBe('sample');
        await page.waitForSelector(MARKUP, {timeout: 3_000});
        expect(await page.evaluate(() => document.getSelection()?.rangeCount)).toBe(0);
        await expectMarkupGeometry(page, expected.rects);
        await openAnnotationsTab(page);
        await expect.poll(() => page.$eval('.editor-pane.is-active .workspace-host[data-workspace-active="true"] .note-item[data-annotation-kind="text-markup"] .note-item-text', element => element.textContent?.trim())).toBe('sample');
    });

    it.each([
        0,
        90,
        180,
        270,
    ])('keeps the same usable text frame from press through typing at view rotation %i', async rotation => {
        const {page} = await openFixture();
        await callWorkspaceCommand(page, 'setViewRotation', [rotation]);
        await waitForViewerInteractive(page);
        await page.waitForFunction(value => document.querySelector('.editor-pane.is-active [data-pdf-annotation-editor-surface]')?.getAttribute('data-view-rotation') === String(value), {}, rotation);
        await clickAnnotationTool(page, 'Text');
        const point = await placementPoint(page);
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.waitForSelector(PREVIEW, {visible: true});
        const pressed = await frame(page, PREVIEW);
        await page.mouse.up();
        await page.waitForSelector(`${BOX} [contenteditable="true"]`, {visible: true});
        const released = await frame(page);
        if (process.env.EVB_TEXT_INTERACTION_EVIDENCE === '1') {
            await page.screenshot({path: `.devkit/annotation-reaudit/text-frame-${rotation}.png`});
        }
        expect.soft(pressed.border).toBe('solid');
        for (const key of [
            'x',
            'y',
            'width',
            'height',
        ] as const) {
            expect.soft(Math.abs(pressed[key] - released[key]), `Frame ${key} must not jump on release`).toBeLessThanOrEqual(1);
        }
        expect(released.focused).toBe(true);
        expect(released.height).toBeLessThan(released.fontSize * 2);
        await page.keyboard.type('Readable text');
        expect((await frame(page)).text).toBe('Readable text');
        await expect.poll(() => page.$eval(
            '.editor-pane.is-active .note-item[data-annotation-kind="text-box"] .note-item-text',
            element => element.textContent?.trim(),
        )).toBe('Readable text');
    });

    it('keeps dragged text creation at a usable width and lets content determine height', async () => {
        const {page} = await openFixture();
        await clickAnnotationTool(page, 'Text');
        const point = await placementPoint(page);
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.mouse.move(point.x + 2, point.y + 100, {steps: 10});
        const preview = await frame(page, PREVIEW);
        await page.mouse.up();
        await page.waitForSelector(`${BOX} [contenteditable="true"]`, {visible: true});
        const released = await frame(page);
        expect(released.width).toBeGreaterThanOrEqual(released.fontSize * 1.9);
        expect(released.height).toBeLessThan(released.fontSize * 2);
        expect(Math.abs(preview.width - released.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(preview.height - released.height)).toBeLessThanOrEqual(1);
        expect(released.focused).toBe(true);
        await page.keyboard.type('Hi');
        expect((await frame(page)).text).toBe('Hi');
    });

    it.each([
        false,
        true,
    ])('selects and moves a text box after clicking away from typing with keep-active %s', async keepActive => {
        const {page} = await openFixture(keepActive, 2.92);
        await startText(page);
        await page.keyboard.type('Move this text');
        const typed = await frame(page);
        const away = {
            x: typed.x + 20,
            y: typed.y - 140,
        };
        expect(await page.evaluate(({
            x,
            y,
        }) => document.elementFromPoint(x, y)?.closest('[data-annotation-id]')?.getAttribute('data-annotation-id') ?? null, away)).toBeNull();
        await page.mouse.click(away.x, away.y);
        await expect.poll(async () => (await frame(page)).focused).toBe(false);
        expect(await page.$$(BOX)).toHaveLength(1);
        const before = await frame(page);
        const x = before.x + before.width / 2;
        const y = before.y + before.height / 2;
        const target = await page.evaluate(({
            x,
            y,
        }) => {
            const element = document.elementFromPoint(x, y);
            return {
                className: element?.getAttribute('class'),
                cursor: element ? getComputedStyle(element).cursor : null,
                kind: element?.closest('[data-annotation-kind]')?.getAttribute('data-annotation-kind'),
            };
        }, {
            x,
            y,
        });
        expect(target.kind).toBe('text-box');
        await page.mouse.click(x, y);
        expect(await page.$(`${BOX} [contenteditable="true"]`), JSON.stringify(target)).toBeNull();
        await page.waitForSelector('.editor-pane.is-active [data-pdf-annotation-resize-handle="se"]', {
            visible: true,
            timeout: 3000,
        });
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 70, y + 40, {steps: 8});
        await page.mouse.up();
        const moved = await frame(page);
        expect(moved.x - before.x, JSON.stringify(target)).toBeCloseTo(70, 0);
        expect(moved.y - before.y).toBeCloseTo(40, 0);
        expect(moved.text).toBe('Move this text');
        expect(await page.$$(BOX)).toHaveLength(1);
    });

    it('offers usable resize controls while typing without a keyboard shortcut', async () => {
        const {page} = await openFixture(false, 2.92);
        await startText(page);
        await page.keyboard.type('Resize directly');
        const before = await frame(page);
        const handle = '.editor-pane.is-active [data-pdf-annotation-resize-handle="se"]';
        await page.waitForSelector(handle, {
            visible: true,
            timeout: 3000,
        });
        const enlarged = await resize(page, 'se', before.width * 0.3, before.height * 0.3);
        expect(enlarged.committed.fontSize).toBeGreaterThan(before.fontSize * 1.15);
        expect(enlarged.committed.text).toBe('Resize directly');
    });

    it('moves from the visible grip while typing and reenters editing with a double-click', async () => {
        const {page} = await openFixture(true, 2.92);
        await startText(page);
        await page.keyboard.type('Visible grip');
        await waitForTextControlsLayout(page);
        const before = await frame(page);
        const grip = '.editor-pane.is-active [data-pdf-annotation-move-handle]';
        const point = await page.$eval(grip, element => {
            const rect = element.getBoundingClientRect();
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height / 2;
            if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Text move grip is obstructed');
            return {
                x,
                y,
            };
        });
        if (process.env.EVB_TEXT_INTERACTION_EVIDENCE === '1') {
            await page.screenshot({path: '.devkit/annotation-selection-repair/text-edit-controls.png'});
        }
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.mouse.move(point.x + 70, point.y + 40, {steps: 8});
        await page.mouse.up();
        const moved = await frame(page);
        expect(moved.x - before.x).toBeCloseTo(70, 0);
        expect(moved.y - before.y).toBeCloseTo(40, 0);
        expect(moved.text).toBe('Visible grip');
        expect(moved.focused).toBe(false);
        await modifiedKey(page, 'KeyZ');
        expect((await frame(page)).x).toBeCloseTo(before.x, 0);
        expect((await frame(page)).text).toBe('Visible grip');
        await page.mouse.click(before.x + before.width / 2, before.y + before.height / 2, {count: 2});
        await page.waitForSelector(`${BOX} [contenteditable="true"]`, {visible: true});
        await expect.poll(async () => (await frame(page)).focused).toBe(true);
        await selectAllFocusedAnnotationText(page);
        expect(await page.evaluate(() => getSelection()?.toString())).toBe('Visible grip');
        await page.keyboard.type('Edited text');
        expect((await frame(page)).text).toBe('Edited text');
        await clickVisibleAnnotationControl(page, '.editor-pane.is-active .tool-button[data-tool="text"]');
        await expect.poll(() => page.$eval('.editor-pane.is-active .tool-button.is-active', element => element.getAttribute('data-tool'))).toBe('select');
        expect((await frame(page)).text).toBe('Edited text');
    });

    it('commits a mouse drag when capture is lost immediately before pointerup', async () => {
        const {page} = await openFixture(false, 2.92);
        await startText(page);
        await page.keyboard.type('Released mouse');
        await waitForTextControlsLayout(page);
        const before = await frame(page);
        const grip = '.editor-pane.is-active [data-pdf-annotation-move-handle]';
        const start = await page.$eval(grip, element => {
            const rect = element.getBoundingClientRect();
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height / 2;
            if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Text move grip is obstructed');
            return {
                x,
                y,
            };
        });
        const end = {
            x: start.x - 180,
            y: start.y + 30,
        };
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, {steps: 8});
        const preview = await frame(page);
        expect(preview.x - before.x).toBeCloseTo(-180, 0);
        const cdp = await page.createCDPSession();
        // macOS can report released buttons on the final move before pointerup.
        // Chromium then drops capture before delivering that move and release.
        await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: end.x,
            y: end.y,
            button: 'none',
            buttons: 0,
        });
        await page.mouse.up();
        await cdp.detach();
        const released = await frame(page);
        expect(released.x).toBeCloseTo(preview.x, 0);
        expect(released.y).toBeCloseTo(preview.y, 0);
        await modifiedKey(page, 'KeyZ');
        const undone = await frame(page);
        expect(undone.x).toBeCloseTo(before.x, 0);
        expect(undone.text).toBe('Released mouse');
    });

    it('deactivates every annotation instrument by clicking its active button again', async () => {
        const {page} = await openFixture(true);
        for (const tool of [
            'draw',
            'text',
            'note',
            'highlight',
            'underline',
            'strikethrough',
            'squiggly',
            'rectangle',
            'circle',
            'line',
            'arrow',
        ]) {
            const selector = `.editor-pane.is-active .tool-button[data-tool="${tool}"]`;
            await clickVisibleAnnotationControl(page, selector);
            expect(await page.$eval(selector, element => element.classList.contains('is-active')), tool).toBe(true);
            await clickVisibleAnnotationControl(page, selector);
            await expect.poll(() => page.$eval('.editor-pane.is-active .tool-button.is-active', element => element.getAttribute('data-tool')), {message: tool}).toBe('select');
        }
        const topNote = 'header.toolbar .toolbar-group-item--quick-note button';
        await clickVisibleAnnotationControl(page, topNote);
        await expect.poll(() => page.$eval('.editor-pane.is-active .tool-button.is-active', element => element.getAttribute('data-tool'))).toBe('note');
        await clickVisibleAnnotationControl(page, topNote);
        await expect.poll(() => page.$eval('.editor-pane.is-active .tool-button.is-active', element => element.getAttribute('data-tool'))).toBe('select');
    });

    it('keeps an empty text draft alive when resizing before typing', async () => {
        const {page} = await openFixture(false, 2.92);
        await startText(page);
        const before = await frame(page);
        const enlarged = await resize(page, 'se', before.width * 0.3, before.height * 0.3);
        expect(enlarged.committed.width).toBeGreaterThan(before.width * 1.15);
        expect(enlarged.committed.focused).toBe(true);
        await page.keyboard.type('Adjusted');
        expect((await frame(page)).text).toBe('Adjusted');
        await page.mouse.click(before.x + 20, before.y - 140);
        expect((await frame(page)).text).toBe('Adjusted');
        expect(await page.$$(BOX)).toHaveLength(1);
    });

    it.each([
        0,
        90,
        180,
        270,
    ])('keeps the move grip reachable at the viewport edge at view rotation %i', async rotation => {
        const {page} = await openFixture(false, 2.92);
        await callWorkspaceCommand(page, 'setViewRotation', [rotation]);
        await waitForViewerInteractive(page);
        await clickAnnotationTool(page, 'Text');
        const point = await placementPoint(page);
        const y = await page.$eval('.editor-pane.is-active .page_container[data-page="1"]', element => {
            const viewport = element.closest('.pdfViewer')!.getBoundingClientRect();
            return Math.max(viewport.top, element.getBoundingClientRect().top) + 4;
        });
        await page.mouse.click(point.x, y);
        await page.waitForSelector(`${BOX} [contenteditable="true"]`, {visible: true});
        await page.keyboard.type('Edge');
        const typed = await frame(page);
        const viewportTop = await page.$eval('.editor-pane.is-active .pdfViewer', element => element.getBoundingClientRect().top);
        await page.mouse.move(typed.x + typed.width / 2, typed.y + typed.height / 2);
        await page.mouse.wheel({deltaY: typed.y - viewportTop - 4});
        await expect.poll(async () => Math.abs((await frame(page)).y - (viewportTop + 4))).toBeLessThanOrEqual(3);
        const grip = '.editor-pane.is-active [data-pdf-annotation-move-handle]';
        await expect.poll(() => page.$eval(grip, element => {
            const rect = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        })).toBe(true);
        const before = await frame(page);
        const start = await page.$eval(grip, element => {
            const rect = element.getBoundingClientRect();
            return {
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
            };
        });
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 30, start.y + 60, {steps: 8});
        await page.mouse.up();
        const moved = await frame(page);
        expect(moved.x - before.x).toBeCloseTo(30, 0);
        expect(moved.y - before.y).toBeCloseTo(60, 0);
        expect(moved.text).toBe('Edge');
    });

    it('rotates text at the page edge with pointer buttons, wraps, undoes, and saves its orientation', async () => {
        const {
            page,
            path,
        } = await openFixture(false, 0.9);
        const rotationValue = '.editor-pane.is-active [data-annotation-rotation-value]';
        if (process.env.EVB_TEXT_INTERACTION_EVIDENCE === '1') {
            await page.screenshot({path: '.devkit/annotation-rotation-controls/empty-list.png'});
        }
        async function expectRotation(targetPage: Page, expected: number) {
            await expect.poll(() => targetPage.$eval(rotationValue, element => Number.parseFloat(element.textContent ?? ''))).toBe(expected);
            await expect.poll(() => targetPage.$eval(BOX, element => {
                const matrix = new DOMMatrix(getComputedStyle(element).transform);
                return (Math.round(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI) + 360) % 360;
            })).toBe(expected);
            const bounds = await targetPage.$eval(BOX, element => {
                const box = element.getBoundingClientRect();
                const pageRect = element.closest('.page_container')!.getBoundingClientRect();
                return [
                    box.left - pageRect.left,
                    box.top - pageRect.top,
                    pageRect.right - box.right,
                    pageRect.bottom - box.bottom,
                ];
            });
            for (const distance of bounds) expect(distance).toBeGreaterThanOrEqual(-1);
        }
        async function dragGrip(dx: number, dy: number) {
            const start = await page.$eval('.editor-pane.is-active [data-pdf-annotation-move-handle]', element => {
                const rect = element.getBoundingClientRect();
                const x = rect.x + rect.width / 2;
                const y = rect.y + rect.height / 2;
                if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Rotated text move grip is obstructed');
                return {
                    x,
                    y,
                };
            });
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(start.x + dx, start.y + dy, {steps: 8});
            const preview = await frame(page);
            await page.mouse.up();
            // Pointerup commits synchronously. Let Vue remove the preview
            // before polling the rendered canonical geometry.
            await page.evaluate(async () => {
                await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            });
            await expect.poll(async () => {
                const current = await frame(page);
                return Math.max(Math.abs(current.x - preview.x), Math.abs(current.y - preview.y));
            }).toBeLessThan(0.5);
            const committed = await frame(page);
            expect(committed.x).toBeCloseTo(preview.x, 0);
            expect(committed.y).toBeCloseTo(preview.y, 0);
            return committed;
        }
        await startText(page);
        await page.keyboard.type('Поворот текста');
        await modifiedKey(page, 'Enter');
        await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
        const pageRect = await page.$eval('.editor-pane.is-active .page_container[data-page="1"]', element => {
            const rect = element.getBoundingClientRect();
            return {
                left: rect.left,
                top: rect.top,
                right: rect.right,
            };
        });
        const original = await frame(page);
        const edge = await dragGrip(pageRect.right - original.x - original.width - 2, pageRect.top - original.y + 2);
        expect(edge.y - pageRect.top).toBeCloseTo(2, 0);
        expect(pageRect.right - edge.x - edge.width).toBeCloseTo(2, 0);
        await expectRotation(page, 0);
        for (const rotation of [
            90,
            180,
            270,
            0,
        ]) {
            await clickVisibleAnnotationControl(page, '.editor-pane.is-active [data-annotation-rotate="cw"]');
            await expectRotation(page, rotation);
            if (rotation === 90 && process.env.EVB_TEXT_INTERACTION_EVIDENCE === '1') {
                await page.screenshot({path: '.devkit/annotation-rotation-controls/rotation-controls.png'});
            }
        }
        // CDP key events do not invoke Electron's native menu accelerators
        // while focus is in the sidebar. Exercise the real Undo control.
        await clickVisibleAnnotationControl(page, '.toolbar button[aria-label="Undo"]');
        await expectRotation(page, 270);
        await clickVisibleAnnotationControl(page, '.editor-pane.is-active [data-annotation-rotate="ccw"]');
        await expectRotation(page, 180);
        await clickVisibleAnnotationControl(page, '.editor-pane.is-active [data-annotation-rotate="cw"]');
        await expectRotation(page, 270);
        await page.mouse.click(pageRect.left + 40, pageRect.top + 200);
        await page.waitForFunction(selector => !document.querySelector(selector)?.classList.contains('is-selected'), {}, BOX);
        await clickVisibleAnnotationControl(page, BOX);
        await expectRotation(page, 270);
        const beforeMove = await frame(page);
        const moved = await dragGrip(-50, 50);
        expect(moved.x - beforeMove.x).toBeCloseTo(-50, 0);
        expect(moved.y - beforeMove.y).toBeCloseTo(50, 0);
        await expectRotation(page, 270);
        await saveViaWindowHandle(page, 30_000);
        const restarted = await sessions.restart({hard: true});
        if (!restarted) throw new Error('Rotated text save reopen did not start');
        await restarted.page.setViewport({
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
        });
        await openPdfInApp(restarted.page, path);
        await waitForPdfLoaded(restarted.page);
        await waitForViewerInteractive(restarted.page);
        await openAnnotationsTab(restarted.page);
        await callWorkspaceCommand(restarted.page, 'setCustomZoomFromDisplay', [0.9]);
        await restarted.page.waitForFunction(() => document.querySelector('.zoom-controls-display-value')?.textContent?.trim() === '90%');
        await clickVisibleAnnotationControl(restarted.page, BOX);
        await expectRotation(restarted.page, 270);
        expect((await frame(restarted.page)).text).toBe('Поворот текста');
    }, 120_000);

    it('scales glyphs with corner handles, reflows with side handles, and saves that appearance', async () => {
        const {
            page,
            path,
        } = await openFixture();
        await startText(page);
        await page.keyboard.type('Resize');
        await modifiedKey(page, 'Enter');
        const before = await frame(page);
        const enlarged = await resize(page, 'se', before.width * 0.5, before.height * 0.5);
        expect.soft(enlarged.preview.fontSize).toBeGreaterThan(before.fontSize * 1.2);
        expect.soft(enlarged.committed.fontSize).toBeGreaterThan(before.fontSize * 1.2);
        expect.soft(enlarged.preview.fontSize).toBeCloseTo(enlarged.committed.fontSize, 1);
        expect.soft(enlarged.committed.width / before.width).toBeCloseTo(enlarged.committed.fontSize / before.fontSize, 1);
        const narrowed = await resize(page, 'e', -enlarged.committed.width * 0.4, 0);
        expect(narrowed.committed.fontSize).toBeCloseTo(enlarged.committed.fontSize, 1);
        expect(narrowed.committed.height).toBeGreaterThan(enlarged.committed.height);
        const widened = await resize(page, 'e', enlarged.committed.width - narrowed.committed.width, 0);
        expect(widened.committed.fontSize).toBeCloseTo(enlarged.committed.fontSize, 1);
        expect(widened.committed.height).toBeLessThan(narrowed.committed.height);
        expect(widened.preview.height).toBeCloseTo(widened.committed.height, 1);
        if (process.env.EVB_TEXT_INTERACTION_EVIDENCE === '1') {
            await page.screenshot({path: '.devkit/annotation-reaudit/text-resized.png'});
        }
        await saveViaWindowHandle(page, 30_000);
        const restarted = await sessions.restart({hard: true});
        if (!restarted) throw new Error('Text save reopen did not start');
        await openPdfInApp(restarted.page, path);
        await waitForPdfLoaded(restarted.page);
        await waitForViewerInteractive(restarted.page);
        await callWorkspaceCommand(restarted.page, 'setCustomZoomFromDisplay', [2.62]);
        await restarted.page.waitForSelector(BOX, {visible: true});
        const reopened = await frame(restarted.page);
        if (process.env.EVB_TEXT_INTERACTION_EVIDENCE === '1') {
            await restarted.page.screenshot({path: '.devkit/annotation-reaudit/text-reopened.png'});
        }
        expect(reopened.text).toBe('Resize');
        expect(reopened.fontSize).toBeCloseTo(narrowed.committed.fontSize, 1);
    }, 120_000);

    it('saves after every new text box was discarded and can still undo the deletion', async () => {
        const {
            page,
            path,
        } = await openFixture();
        const original = readFileSync(path);
        const summary = await readPdfAnnotationSummary(path);
        for (const text of [
            'First discarded text',
            'Second discarded text',
        ]) {
            await startText(page);
            await page.keyboard.type(text);
            await modifiedKey(page, 'Enter');
            await page.keyboard.press('Backspace');
            await page.waitForFunction(selector => !document.querySelector(selector), {}, BOX);
        }
        await saveViaWindowHandle(page, 30_000);
        expect(readFileSync(path)).toEqual(original);
        const state = await readWorkspaceStateValues<{dirtyState: {hasPendingUnsavedChanges: boolean}}>(page, ['dirtyState']);
        expect(state.dirtyState.hasPendingUnsavedChanges).toBe(false);
        await modifiedKey(page, 'KeyZ');
        await page.waitForSelector(BOX, {visible: true});
        expect((await frame(page)).text).toBe('Second discarded text');
        await saveViaWindowHandle(page, 30_000);
        expect((await readPdfAnnotationSummary(path)).bySubtype.FreeText ?? 0).toBe((summary.bySubtype.FreeText ?? 0) + 1);
    }, 120_000);
});
