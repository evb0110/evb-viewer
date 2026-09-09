import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {compile} from 'sass-embedded';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type {Page} from 'playwright';
import {compileAppStylesheet} from '@tests/helpers/compileAppStylesheet';

const PDF_VIEWER_STYLESHEET = fileURLToPath(new URL(
    '../../../app/assets/css/pdf-viewer.scss',
    import.meta.url,
));
const BROWSER_TEST_TIMEOUT_MS = 120_000;
const VIEW_SCALE = 2.92;

function compilePdfViewerStylesheet() {
    return compile(PDF_VIEWER_STYLESHEET, {style: 'expanded'}).css;
}

function buildPageMarkup(appStylesheet: string, pdfViewerStylesheet: string, mode = '') {
    return `<!doctype html>
<html>
<head>
<style>${appStylesheet}</style>
<style>${pdfViewerStylesheet}</style>
<style>
    #viewer {
        width: 900px;
        height: 600px;
    }

    #page {
        width: 900px;
        height: 600px;
        --scale-factor: ${String(VIEW_SCALE)};
        --total-scale-factor: ${String(VIEW_SCALE)};
    }

    #text-layer {
        --scale-factor: ${String(VIEW_SCALE)};
        --total-scale-factor: ${String(VIEW_SCALE)};
        --min-font-size: 1;
    }

    #text-span {
        top: 180px;
        left: 70px;
        --font-height: 8px;
    }

    #annotation {
        top: 220px;
        left: 700px;
        width: 48px;
        height: 48px;
    }
</style>
</head>
<body>
<main id="viewer" class="pdfViewer ${mode}">
    <div id="page" class="page_container page_container--rendered" data-page="1">
        <div id="text-layer" class="text-layer">
            <span id="text-span">Understanding pointer ownership</span>
        </div>
        <div id="editor-layer" class="pdf-annotation-editor-layer is-interactive">
            <div id="background" class="pdf-annotation-editor-surface__background" data-pointer-down="0"></div>
            <svg class="pdf-annotation-editor-surface__svg" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                <g class="pdf-annotation-editor-text-markup" data-annotation-kind="text-markup">
                    <rect id="svg-annotation" x="0.08" y="0.7" width="0.55" height="0.05" data-annotation-hit-target="true" data-pointer-down="0"></rect>
                </g>
            </svg>
            <div class="pdf-annotation-editor-surface__html">
                <button
                    id="annotation"
                    class="pdf-annotation-editor-entity pdf-annotation-editor-note"
                    data-pointer-down="0"
                    type="button"
                >A</button>
            </div>
        </div>
    </div>
</main>
</body>
</html>`;
}

async function readTextDragPoints(page: Page) {
    return page.locator('#text-span').evaluate(element => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            throw new Error(`Text fixture has no measurable geometry: ${JSON.stringify(rect.toJSON())}`);
        }
        return {
            end: {
                x: rect.right - 2,
                y: rect.top + rect.height / 2,
            },
            start: {
                x: rect.left + 2,
                y: rect.top + rect.height / 2,
            },
        };
    });
}

async function dragAcrossText(page: Page) {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const points = await readTextDragPoints(page);
    await page.mouse.move(points.start.x, points.start.y);
    await page.mouse.down();
    await page.mouse.move(points.end.x, points.end.y, {steps: 20});
    await page.mouse.up();
    await page.waitForFunction(() => (window.getSelection()?.toString() ?? '').trim().length > 0);
    return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

describe('PDF text selection in Chromium', () => {
    it('selects rendered text through the annotation editor layer in text and markup modes', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1200,
                height: 800,
            }});
            const [
                appStylesheet,
                pdfViewerStylesheet,
            ] = await Promise.all([
                compileAppStylesheet([]),
                Promise.resolve(compilePdfViewerStylesheet()),
            ]);

            for (const mode of [
                'is-text-selection-mode',
                'is-selection-markup-tool',
            ]) {
                await page.setContent(buildPageMarkup(appStylesheet, pdfViewerStylesheet, mode));
                await page.evaluate(() => {
                    for (const id of [
                        'annotation',
                        'svg-annotation',
                    ]) {
                        const annotation = document.querySelector<HTMLElement>(`#${id}`);
                        annotation?.addEventListener('pointerdown', () => {
                            annotation.dataset.pointerDown = String(Number(annotation.dataset.pointerDown ?? '0') + 1);
                        });
                    }
                });
                await page.locator('#annotation').click();
                const markupTarget = await page.locator('#svg-annotation').boundingBox();
                if (!markupTarget) throw new Error('Markup target is missing');
                await page.mouse.click(markupTarget.x + markupTarget.width / 2, markupTarget.y + markupTarget.height / 2);
                expect(await page.locator('#annotation').getAttribute('data-pointer-down')).toBe('1');
                expect(await page.locator('#svg-annotation').getAttribute('data-pointer-down')).toBe(mode === 'is-selection-markup-tool' ? '0' : '1');
                const hit = await page.locator('#text-span').evaluate(element => {
                    const rect = element.getBoundingClientRect();
                    const x = rect.left + 2;
                    const y = rect.top + rect.height / 2;
                    return document.elementFromPoint(x, y)?.id ?? null;
                });
                expect(hit, `${mode} must hit the rendered text span`).toBe('text-span');
                expect(await dragAcrossText(page)).toBe('Understanding pointer ownership');
            }
        } finally {
            await browser.close();
        }
    }, BROWSER_TEST_TIMEOUT_MS);

    it('selects text through an existing markup while a markup tool is active', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1200,
                height: 800,
            }});
            await page.setContent(buildPageMarkup(await compileAppStylesheet([]), compilePdfViewerStylesheet(), 'is-selection-markup-tool'));
            await page.locator('#svg-annotation').evaluate(element => {
                const rect = document.querySelector('#text-span')!.getBoundingClientRect();
                const pageRect = document.querySelector('#page')!.getBoundingClientRect();
                element.setAttribute('x', String((rect.left - pageRect.left) / pageRect.width));
                element.setAttribute('y', String((rect.top - pageRect.top) / pageRect.height));
                element.setAttribute('width', String(rect.width / pageRect.width));
                element.setAttribute('height', String(rect.height / pageRect.height));
            });
            const points = await readTextDragPoints(page);
            expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.id, points.start)).toBe('text-span');
            expect(await dragAcrossText(page)).toBe('Understanding pointer ownership');
        } finally {
            await browser.close();
        }
    }, BROWSER_TEST_TIMEOUT_MS);

    it('keeps annotation and drawing background pointer targets active in normal tool mode', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1200,
                height: 800,
            }});
            const [
                appStylesheet,
                pdfViewerStylesheet,
            ] = await Promise.all([
                compileAppStylesheet([]),
                Promise.resolve(compilePdfViewerStylesheet()),
            ]);
            await page.setContent(buildPageMarkup(appStylesheet, pdfViewerStylesheet));
            await page.evaluate(() => {
                for (const id of [
                    'annotation',
                    'svg-annotation',
                    'background',
                ]) {
                    const target = document.querySelector<HTMLElement>(`#${id}`);
                    target?.addEventListener('pointerdown', () => {
                        target.dataset.pointerDown = String(Number(target.dataset.pointerDown ?? '0') + 1);
                    });
                }
            });

            await page.locator('#annotation').click();
            await page.locator('#svg-annotation').click();
            await page.mouse.click(300, 500);

            expect(await page.locator('#annotation').getAttribute('data-pointer-down')).toBe('1');
            expect(await page.locator('#svg-annotation').getAttribute('data-pointer-down')).toBe('1');
            expect(await page.locator('#background').getAttribute('data-pointer-down')).toBe('1');
        } finally {
            await browser.close();
        }
    }, BROWSER_TEST_TIMEOUT_MS);
});
