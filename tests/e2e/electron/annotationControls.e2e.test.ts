import {rmSync} from 'node:fs';
import type {Page} from 'puppeteer-core';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {createBlankFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickAnnotationTool,
    createCanonicalTextBoxWithPointer,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openAnnotationsTab,
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {callWorkspaceCommand} from '@tests/e2e/electron/helpers/workspaceExpose';

const POINTER_READY_TIMEOUT_MS = 30_000;
const STYLE_UPDATE_TIMEOUT_MS = 20_000;
const SIDEBAR_RESIZE_DELTA_PX = 96;

interface IPoint {
    x: number;
    y: number;
}

interface IStyleStepGeometry extends IPoint {
    dx: number;
    dy: number;
}

interface IManagedShape {
    opacity?: number;
    pdfSubtype?: string;
    source?: string;
    strokeWidth?: number;
    strokes?: unknown[][];
}

interface ITextBoxGeometrySnapshot {
    editing: boolean;
    editorClientHeight: number;
    editorClientWidth: number;
    editorScrollHeight: number;
    editorScrollWidth: number;
    focused: boolean;
    fontSize: number;
    id: string;
    page: {
        bottom: number;
        left: number;
        right: number;
        top: number;
    };
    rect: {
        bottom: number;
        height: number;
        left: number;
        right: number;
        top: number;
        width: number;
    };
    text: string;
}

async function waitForAnnotationPointerReady(page: Page, timeoutMs = POINTER_READY_TIMEOUT_MS) {
    await page.waitForFunction(() => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const pageContainer = host?.querySelector<HTMLElement>('.page_container[data-page="1"]');
        const layer = pageContainer?.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
        const rect = layer?.getBoundingClientRect();
        const layerStyle = layer ? window.getComputedStyle(layer) : null;
        return Boolean(
            pageContainer?.classList.contains('page_container--rendered')
            && pageContainer.dataset.pageLayerReadiness !== 'canvas-only'
            && pageContainer.dataset.pageLayerReadiness !== 'hydrating'
            && layer
            && rect
            && rect.width > 0
            && rect.height > 0
            && layer.classList.contains('is-interactive')
            && layerStyle?.pointerEvents === 'auto',
        );
    }, {timeout: timeoutMs});
}

async function waitForSidebarBoundary(page: Page, timeoutMs = POINTER_READY_TIMEOUT_MS) {
    await page.waitForFunction(() => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const wrapper = host?.querySelector<HTMLElement>('.sidebar-wrapper');
        const sash = wrapper?.querySelector<HTMLElement>('.sidebar-resizer');
        const viewer = host?.querySelector<HTMLElement>('.workspace-main__viewer');
        if (!wrapper || !sash || !viewer) {
            return false;
        }

        const wrapperRect = wrapper.getBoundingClientRect();
        const sashRect = sash.getBoundingClientRect();
        const viewerRect = viewer.getBoundingClientRect();
        return Boolean(
            wrapperRect.width > 10
            && sashRect.width > 0
            && viewerRect.width > 10
            && Math.abs(wrapperRect.right - sashRect.right) <= 1
            && Math.abs(viewerRect.left - sashRect.right) <= 1,
        );
    }, {timeout: timeoutMs});
}

async function resizeSidebar(page: Page, deltaX: number) {
    await waitForSidebarBoundary(page);
    const geometry = await page.evaluate(() => {
        const sash = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host .sidebar-resizer',
        );
        const sidebar = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host [data-testid="document-sidebar"]',
        );
        if (!sash || !sidebar) {
            return null;
        }

        const sashRect = sash.getBoundingClientRect();
        return {
            sidebarWidth: sidebar.getBoundingClientRect().width,
            x: sashRect.left + sashRect.width / 2,
            y: sashRect.top + sashRect.height / 2,
        };
    });
    if (!geometry) {
        throw new Error('The document sidebar resize handle was unavailable');
    }

    await page.mouse.move(geometry.x, geometry.y);
    await page.mouse.down();
    await page.mouse.move(geometry.x + deltaX, geometry.y, {steps: 8});
    await page.mouse.up();

    await page.waitForFunction((minimumWidth: number) => {
        const sidebar = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host [data-testid="document-sidebar"]',
        );
        return (sidebar?.getBoundingClientRect().width ?? 0) > minimumWidth;
    }, {timeout: POINTER_READY_TIMEOUT_MS}, geometry.sidebarWidth + (deltaX / 2));
}

async function readVisibleCenter(
    page: Page,
    selector: string,
    position: 'first' | 'last' = 'first',
) {
    return page.evaluate((options: {
        position: 'first' | 'last';
        selector: string;
    }) => {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>(options.selector))
            .filter((element) => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                    && rect.width > 0
                    && rect.height > 0;
            });
        const element = options.position === 'last' ? candidates.at(-1) : candidates[0];
        if (!element) {
            return null;
        }
        const rect = element.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    }, {
        position,
        selector,
    });
}

async function readStyleStepGeometry(page: Page): Promise<IStyleStepGeometry[]> {
    return page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(
            '.annotation-style-popover .style-step-button',
        )).filter((button) => {
            const rect = button.getBoundingClientRect();
            const style = window.getComputedStyle(button);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        });

        return buttons.flatMap((button) => {
            const icon = button.querySelector<HTMLElement>(
                'svg, .iconify, [data-icon], [class*="i-ph-"]',
            ) ?? button.firstElementChild as HTMLElement | null;
            if (!icon) {
                return [];
            }
            const buttonRect = button.getBoundingClientRect();
            const iconRect = icon.getBoundingClientRect();
            return [{
                dx: (iconRect.left + iconRect.width / 2)
                    - (buttonRect.left + buttonRect.width / 2),
                dy: (iconRect.top + iconRect.height / 2)
                    - (buttonRect.top + buttonRect.height / 2),
                x: buttonRect.left + buttonRect.width / 2,
                y: buttonRect.top + buttonRect.height / 2,
            }];
        });
    });
}

async function readTextBoxFontSize(page: Page, annotationId: string) {
    return page.evaluate((id: string) => {
        const textBox = Array.from(document.querySelectorAll<HTMLElement>(
            '[data-annotation-kind="text-box"]',
        )).find(candidate => candidate.dataset.annotationId === id);
        if (!textBox) {
            return null;
        }

        const style = window.getComputedStyle(textBox);
        const scaleFactor = Number.parseFloat(style.getPropertyValue('--scale-factor')) || 1;
        const userUnit = Number.parseFloat(style.getPropertyValue('--user-unit')) || 1;
        const fontSizeCssPixels = Number.parseFloat(style.fontSize);
        return Number.isFinite(fontSizeCssPixels)
            ? fontSizeCssPixels / (scaleFactor * userUnit)
            : null;
    }, annotationId);
}

async function readTextBoxCenter(page: Page, annotationId: string) {
    return page.evaluate((id: string) => {
        const textBox = Array.from(document.querySelectorAll<HTMLElement>(
            '[data-annotation-kind="text-box"]',
        )).find(candidate => candidate.dataset.annotationId === id);
        if (!textBox) {
            return null;
        }
        const rect = textBox.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    }, annotationId);
}

async function readTextBoxGeometry(page: Page, annotationId: string) {
    return page.evaluate((id: string): ITextBoxGeometrySnapshot | null => {
        const textBox = Array.from(document.querySelectorAll<HTMLElement>(
            '[data-annotation-kind="text-box"]',
        )).find(candidate => candidate.dataset.annotationId === id);
        const pageContainer = textBox?.closest<HTMLElement>('.page_container');
        if (!textBox || !pageContainer) {
            return null;
        }

        const editor = textBox.querySelector<HTMLElement>('[contenteditable="true"]');
        const rect = textBox.getBoundingClientRect();
        const pageRect = pageContainer.getBoundingClientRect();
        const styles = window.getComputedStyle(textBox);
        return {
            editing: textBox.classList.contains('is-editing'),
            editorClientHeight: editor?.clientHeight ?? 0,
            editorClientWidth: editor?.clientWidth ?? 0,
            editorScrollHeight: editor?.scrollHeight ?? 0,
            editorScrollWidth: editor?.scrollWidth ?? 0,
            focused: editor !== null && document.activeElement === editor,
            fontSize: Number.parseFloat(styles.fontSize),
            id,
            page: {
                bottom: pageRect.bottom,
                left: pageRect.left,
                right: pageRect.right,
                top: pageRect.top,
            },
            rect: {
                bottom: rect.bottom,
                height: rect.height,
                left: rect.left,
                right: rect.right,
                top: rect.top,
                width: rect.width,
            },
            text: (editor?.textContent ?? textBox.textContent ?? '').replace(/[\u200B\uFEFF]/gu, ''),
        };
    }, annotationId);
}

async function resolveInkStrokePoints(page: Page): Promise<IPoint[]> {
    await page.evaluate(() => {
        document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host .page_container[data-page="1"]',
        )?.scrollIntoView({
            block: 'center',
            inline: 'center',
        });
    });
    await page.evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });

    return page.evaluate(() => {
        const layer = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host .page_container[data-page="1"] .pdf-annotation-editor-layer',
        );
        const rect = layer?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
            return [];
        }

        return [
            {
                x: rect.left + rect.width * 0.22,
                y: rect.top + rect.height * 0.54,
            },
            {
                x: rect.left + rect.width * 0.30,
                y: rect.top + rect.height * 0.58,
            },
            {
                x: rect.left + rect.width * 0.40,
                y: rect.top + rect.height * 0.55,
            },
        ];
    });
}

async function drawInkStroke(page: Page) {
    const points = await resolveInkStrokePoints(page);
    if (points.length < 2) {
        throw new Error('The annotation layer did not expose drawable client points');
    }

    const start = points[0]!;
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const point of points.slice(1)) {
        await page.mouse.move(point.x, point.y, {steps: 8});
    }
    await page.mouse.up();
}

async function readActiveAnnotationTool(page: Page) {
    return page.evaluate(() => document.querySelector<HTMLElement>(
        '.editor-pane.is-active .workspace-host .notes-panel .tool-button.is-active',
    )?.dataset.tool ?? null);
}

describe('Electron E2E - annotation controls', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        restartBeforeEach: true,
        extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
        sessionName: () => `e2e-annotation-controls-${Date.now()}`,
    });

    it('keeps text style controls centered and draw presets pointer-active', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const {page} = session;
        const fixturePath = await createBlankFixturePdf(`annotation-controls-${Date.now()}.pdf`);
        onTestFinished(() => rmSync(fixturePath, {force: true}));

        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);

        const sidebarBefore = await page.evaluate(() => document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host [data-testid="document-sidebar"]',
        )?.getBoundingClientRect().width ?? 0);
        await resizeSidebar(page, SIDEBAR_RESIZE_DELTA_PX);
        const sidebarAfter = await page.evaluate(() => document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host [data-testid="document-sidebar"]',
        )?.getBoundingClientRect().width ?? 0);
        expect(sidebarAfter).toBeGreaterThan(sidebarBefore + (SIDEBAR_RESIZE_DELTA_PX / 2));
        await waitForViewerInteractive(page);
        await waitForAnnotationPointerReady(page);

        const textBoxId = await createCanonicalTextBoxWithPointer(
            page,
            `Annotation controls ${Date.now()}`,
            {
                x: 0.42,
                y: 0.34,
            },
        );
        await clickAnnotationTool(page, 'Select');
        await waitForAnnotationPointerReady(page);
        await page.waitForFunction((id: string) => Boolean(Array.from(
            document.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]'),
        ).find(candidate => candidate.dataset.annotationId === id)), {timeout: POINTER_READY_TIMEOUT_MS}, textBoxId);

        const textBoxCenter = await readTextBoxCenter(page, textBoxId);
        if (!textBoxCenter) {
            throw new Error('The created text box did not expose a visible selection target');
        }
        await page.mouse.click(textBoxCenter.x, textBoxCenter.y);
        await page.waitForFunction((id: string) => Boolean(Array.from(
            document.querySelectorAll<HTMLElement>('[data-annotation-kind="text-box"]'),
        ).find(candidate => candidate.dataset.annotationId === id && candidate.classList.contains('is-selected'))), {timeout: STYLE_UPDATE_TIMEOUT_MS}, textBoxId);
        await page.waitForSelector('.annotation-style-popover .style-step-button', {
            visible: true,
            timeout: STYLE_UPDATE_TIMEOUT_MS,
        });

        const stepGeometry = await readStyleStepGeometry(page);
        expect(stepGeometry).toHaveLength(2);
        for (const geometry of stepGeometry) {
            expect(Math.abs(geometry.dx), JSON.stringify({geometry})).toBeLessThanOrEqual(0.5);
            expect(Math.abs(geometry.dy), JSON.stringify({geometry})).toBeLessThanOrEqual(0.5);
        }

        const initialFontSize = await readTextBoxFontSize(page, textBoxId);
        expect(initialFontSize).not.toBeNull();
        const increaseButton = stepGeometry.at(-1);
        if (!increaseButton || initialFontSize === null) {
            throw new Error('The text style increase control was not measurable');
        }
        await page.mouse.click(increaseButton.x, increaseButton.y);
        await expect.poll(async () => readTextBoxFontSize(page, textBoxId), {timeout: STYLE_UPDATE_TIMEOUT_MS})
            .toBeGreaterThan(initialFontSize);
        const increasedFontSize = await readTextBoxFontSize(page, textBoxId);
        expect(increasedFontSize).not.toBeNull();
        const decreaseButton = stepGeometry[0];
        if (!decreaseButton || increasedFontSize === null) {
            throw new Error('The text style decrease control was not measurable');
        }
        await page.mouse.click(decreaseButton.x, decreaseButton.y);
        await expect.poll(async () => readTextBoxFontSize(page, textBoxId), {timeout: STYLE_UPDATE_TIMEOUT_MS})
            .toBeLessThan(increasedFontSize);

        await clickAnnotationTool(page, 'Draw');
        await waitForAnnotationPointerReady(page);
        await page.waitForSelector('.annotation-style-popover .draw-style-button:last-child', {
            visible: true,
            timeout: STYLE_UPDATE_TIMEOUT_MS,
        });
        const markerButton = await readVisibleCenter(
            page,
            '.annotation-style-popover .draw-style-button:last-child',
        );
        if (!markerButton) {
            throw new Error('The Marker draw-style button was not visible');
        }
        await page.mouse.click(markerButton.x, markerButton.y);
        await page.waitForFunction(() => (
            document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host .notes-panel .tool-button.is-active',
            )?.dataset.tool === 'draw'
        ), {timeout: STYLE_UPDATE_TIMEOUT_MS});
        await page.waitForFunction(() => (
            document.querySelector<HTMLElement>(
                '.annotation-style-popover .draw-style-button:last-child',
            )?.classList.contains('is-active') ?? false
        ), {timeout: STYLE_UPDATE_TIMEOUT_MS});
        await waitForAnnotationPointerReady(page);

        await drawInkStroke(page);
        let inkShapes: IManagedShape[] = [];
        await expect.poll(async () => {
            inkShapes = ((await callWorkspaceCommand<IManagedShape[]>(page, 'getAllShapes')).value ?? [])
                .filter(shape => shape.pdfSubtype === 'Ink');
            return inkShapes;
        }, {timeout: STYLE_UPDATE_TIMEOUT_MS}).toHaveLength(1);
        const inkShape = inkShapes[0];
        expect(inkShape?.source).toBe('local');
        expect(inkShape?.strokeWidth).toBe(6);
        expect(inkShape?.opacity).toBeCloseTo(0.42, 2);
        expect(inkShape?.strokes?.[0]?.length ?? 0).toBeGreaterThan(1);
        expect(await readActiveAnnotationTool(page)).toBe('draw');
    });

    it('keeps delayed text creation focused while the style popover reopens', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const {page} = session;
        const fixturePath = await createBlankFixturePdf(`annotation-controls-${Date.now()}-delayed-text.pdf`);
        onTestFinished(() => rmSync(fixturePath, {force: true}));

        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);
        await clickAnnotationTool(page, 'Text');

        const editorSelector = '.editor-pane.is-active .page_container[data-page="1"] '
            + '.pdf-annotation-editor-text-box.is-editing [contenteditable="true"]';

        for (let attempt = 0; attempt < 8; attempt += 1) {
            if (attempt > 0) {
                await page.keyboard.press('Escape');
                await clickAnnotationTool(page, 'Select');
                await page.waitForFunction((selector: string) => (
                    document.querySelector(selector) === null
                ), {timeout: STYLE_UPDATE_TIMEOUT_MS}, editorSelector);
                await clickAnnotationTool(page, 'Text');
            }

            await page.waitForSelector('.annotation-style-popover', {
                visible: true,
                timeout: STYLE_UPDATE_TIMEOUT_MS,
            });
            const point = await page.evaluate(() => {
                const layer = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .page_container[data-page="1"] .pdf-annotation-editor-layer',
                );
                const rect = layer?.getBoundingClientRect();
                if (!rect || rect.width <= 0 || rect.height <= 0) {
                    return null;
                }
                return {
                    x: rect.left + rect.width * 0.42,
                    y: rect.top + rect.height * 0.34,
                };
            });
            if (!point) {
                throw new Error('The text annotation layer did not expose a drawable point');
            }

            await page.mouse.click(point.x, point.y, {delay: 100});
            await page.evaluate(() => new Promise<void>(resolve => {
                setTimeout(resolve, 300);
            }));
            const focusSnapshot = await page.evaluate((selector: string) => {
                const editor = document.querySelector<HTMLElement>(selector);
                const activeElement = document.activeElement as HTMLElement | null;
                return {
                    activeClass: activeElement?.className ?? '',
                    activeTag: activeElement?.tagName ?? '',
                    editorPresent: editor !== null,
                    focused: editor !== null && activeElement === editor,
                };
            }, editorSelector);
            expect(focusSnapshot, `Text editor focus was lost on delayed attempt ${attempt}: ${JSON.stringify(focusSnapshot)}`)
                .toMatchObject({
                    editorPresent: true,
                    focused: true,
                });

            // Deliberately do not call page.focus here. The keystrokes must use
            // the focus produced by the real pointer sequence.
            const text = `Delayed text ${attempt}`;
            await page.keyboard.type(text, {delay: 5});
            const editorText = await page.evaluate((selector: string) => (
                document.querySelector<HTMLElement>(selector)?.textContent
                    ?.replace(/[\u200B\uFEFF]/gu, '')
                    .trim()
                ?? null
            ), editorSelector);
            expect(editorText, `Text editor did not receive delayed input on attempt ${attempt}`).toBe(text);
            await page.keyboard.press('Escape');
            await clickAnnotationTool(page, 'Select');
            await page.waitForFunction((selector: string) => (
                document.querySelector(selector) === null
            ), {timeout: STYLE_UPDATE_TIMEOUT_MS}, editorSelector);
        }
    });

    it('creates a compact text box that grows and commits its text geometry at the page edge', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const {page} = session;
        const fixturePath = await createBlankFixturePdf(`annotation-controls-${Date.now()}-text-geometry.pdf`);
        onTestFinished(() => rmSync(fixturePath, {force: true}));

        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);
        await clickAnnotationTool(page, 'Text');
        await waitForAnnotationPointerReady(page);

        await page.evaluate(() => {
            document.querySelector<HTMLElement>(
                '.editor-pane.is-active .page_container[data-page="1"]',
            )?.scrollIntoView({
                block: 'end',
                inline: 'center',
            });
        });
        await page.evaluate(async () => {
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
        const clickPoint = await page.evaluate(() => {
            const layer = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .page_container[data-page="1"] .pdf-annotation-editor-layer',
            );
            const rect = layer?.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0) {
                return null;
            }
            const margin = 24;
            const clamp = (value: number, minimum: number, maximum: number) => (
                Math.min(Math.max(value, minimum), maximum)
            );
            return {
                x: clamp(rect.left + rect.width * 0.82, margin, window.innerWidth - margin),
                y: clamp(rect.top + rect.height * 0.9, margin, window.innerHeight - margin),
            };
        });
        if (!clickPoint) {
            throw new Error('The text annotation layer did not expose a page-edge point');
        }

        await page.mouse.click(clickPoint.x, clickPoint.y, {delay: 100});
        const editorSelector = '.editor-pane.is-active .page_container[data-page="1"] '
            + '.pdf-annotation-editor-text-box.is-editing [contenteditable="true"]';
        await page.waitForSelector(editorSelector, {
            visible: true,
            timeout: STYLE_UPDATE_TIMEOUT_MS,
        });
        const textBoxId = await page.evaluate(() => document.querySelector<HTMLElement>(
            '.editor-pane.is-active .page_container[data-page="1"] '
                + '.pdf-annotation-editor-text-box.is-editing',
        )?.dataset.annotationId ?? null);
        if (!textBoxId) {
            throw new Error('The click-created text box did not expose an annotation id');
        }
        await page.waitForFunction((selector: string) => (
            document.querySelector(selector) !== null
            && document.activeElement === document.querySelector(selector)
        ), {timeout: STYLE_UPDATE_TIMEOUT_MS}, editorSelector);

        const initial = await readTextBoxGeometry(page, textBoxId);
        if (!initial) {
            throw new Error('The click-created text box geometry was unavailable');
        }
        expect(initial.editing).toBe(true);
        expect(initial.focused).toBe(true);
        expect(initial.fontSize).toBeGreaterThan(0);
        expect(initial.rect.width / initial.fontSize).toBeGreaterThan(1.8);
        expect(initial.rect.width / initial.fontSize).toBeLessThan(2.3);
        expect(initial.rect.height / initial.fontSize).toBeGreaterThan(1.4);
        expect(initial.rect.height / initial.fontSize).toBeLessThan(1.95);
        expect(Math.abs(initial.rect.left - clickPoint.x)).toBeLessThanOrEqual(3);
        expect(Math.abs(initial.rect.top - clickPoint.y)).toBeLessThanOrEqual(3);
        expect(initial.rect.width).toBeLessThan((initial.page.right - initial.page.left) * 0.25);
        expect(initial.rect.height).toBeLessThan((initial.page.bottom - initial.page.top) * 0.1);

        // The editor must receive input through the focus from the pointer path.
        // Calling page.focus here would hide the creation and autofocus regression.
        const firstLine = 'A wider first line';
        await page.keyboard.type(firstLine, {delay: 4});
        await page.waitForFunction((options: {
            id: string;
            text: string;
        }) => {
            const entity = document.querySelector<HTMLElement>(
                `[data-annotation-kind="text-box"][data-annotation-id="${options.id}"]`,
            );
            return entity?.textContent?.replace(/[\u200B\uFEFF]/gu, '') === options.text;
        }, {timeout: STYLE_UPDATE_TIMEOUT_MS}, {
            id: textBoxId,
            text: firstLine,
        });
        const afterFirstLine = await readTextBoxGeometry(page, textBoxId);
        if (!afterFirstLine) {
            throw new Error('The text box disappeared after its first input');
        }
        expect(afterFirstLine.rect.width).toBeGreaterThan(initial.rect.width + 1);

        const continuation = ' near the lower right corner, this sentence wraps onto several lines while staying inside the PDF page.';
        await page.keyboard.press('End');
        await page.keyboard.type(continuation, {delay: 2});
        const multilineText = firstLine + continuation;
        await page.waitForFunction((options: {
            id: string;
            text: string;
        }) => {
            const entity = document.querySelector<HTMLElement>(
                `[data-annotation-kind="text-box"][data-annotation-id="${options.id}"]`,
            );
            return entity?.textContent?.replace(/[\u200B\uFEFF]/gu, '') === options.text;
        }, {timeout: STYLE_UPDATE_TIMEOUT_MS}, {
            id: textBoxId,
            text: multilineText,
        });
        const multiline = await readTextBoxGeometry(page, textBoxId);
        if (!multiline) {
            throw new Error('The text box geometry was unavailable before commit');
        }
        expect(multiline.rect.height).toBeGreaterThan(afterFirstLine.rect.height + 2);
        expect(multiline.rect.left).toBeGreaterThanOrEqual(multiline.page.left - 2);
        expect(multiline.rect.top).toBeGreaterThanOrEqual(multiline.page.top - 2);
        expect(multiline.rect.right).toBeLessThanOrEqual(multiline.page.right + 2);
        expect(multiline.rect.bottom).toBeLessThanOrEqual(multiline.page.bottom + 2);
        expect(multiline.editorScrollWidth).toBeLessThanOrEqual(multiline.editorClientWidth + 2);
        expect(multiline.editorScrollHeight).toBeLessThanOrEqual(multiline.editorClientHeight + 2);

        const replacementText = 'Text';
        await page.evaluate((id: string) => {
            const editor = document.querySelector<HTMLElement>(
                `[data-annotation-kind="text-box"][data-annotation-id="${id}"] [contenteditable="true"]`,
            );
            if (!editor) {
                throw new Error('The active text editor was unavailable for replacement');
            }
            editor.focus();
            const selection = window.getSelection();
            if (!selection) {
                throw new Error('The active text editor selection was unavailable for replacement');
            }
            const range = document.createRange();
            range.selectNodeContents(editor);
            selection.removeAllRanges();
            selection.addRange(range);
        }, textBoxId);
        await page.keyboard.type(replacementText, {delay: 4});
        await page.waitForFunction((options: {
            id: string;
            text: string;
        }) => {
            const entity = document.querySelector<HTMLElement>(
                `[data-annotation-kind="text-box"][data-annotation-id="${options.id}"]`,
            );
            return entity?.textContent?.replace(/[\u200B\uFEFF]/gu, '') === options.text;
        }, {timeout: STYLE_UPDATE_TIMEOUT_MS}, {
            id: textBoxId,
            text: replacementText,
        });
        const beforeCommit = await readTextBoxGeometry(page, textBoxId);
        if (!beforeCommit) {
            throw new Error('The text box geometry was unavailable after single-line replacement');
        }
        expect(beforeCommit.rect.height).toBeLessThanOrEqual(initial.rect.height + 2);
        expect(beforeCommit.rect.left).toBeGreaterThanOrEqual(beforeCommit.page.left - 2);
        expect(beforeCommit.rect.top).toBeGreaterThanOrEqual(beforeCommit.page.top - 2);
        expect(beforeCommit.rect.right).toBeLessThanOrEqual(beforeCommit.page.right + 2);
        expect(beforeCommit.rect.bottom).toBeLessThanOrEqual(beforeCommit.page.bottom + 2);
        expect(beforeCommit.editorScrollWidth).toBeLessThanOrEqual(beforeCommit.editorClientWidth + 2);
        expect(beforeCommit.editorScrollHeight).toBeLessThanOrEqual(beforeCommit.editorClientHeight + 2);

        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.down(modifier);
        try {
            await page.keyboard.press('Enter');
        } finally {
            await page.keyboard.up(modifier);
        }
        await page.waitForFunction((id: string) => {
            const entity = document.querySelector<HTMLElement>(
                `[data-annotation-kind="text-box"][data-annotation-id="${id}"]`,
            );
            return entity !== null && !entity.classList.contains('is-editing');
        }, {timeout: STYLE_UPDATE_TIMEOUT_MS}, textBoxId);
        const committed = await readTextBoxGeometry(page, textBoxId);
        if (!committed) {
            throw new Error('The committed text box geometry was unavailable');
        }
        expect(committed.editing).toBe(false);
        expect(committed.text).toBe(replacementText);
        expect(Math.abs(committed.rect.left - beforeCommit.rect.left)).toBeLessThanOrEqual(2);
        expect(Math.abs(committed.rect.top - beforeCommit.rect.top)).toBeLessThanOrEqual(2);
        expect(Math.abs(committed.rect.width - beforeCommit.rect.width)).toBeLessThanOrEqual(2);
        expect(Math.abs(committed.rect.height - beforeCommit.rect.height)).toBeLessThanOrEqual(2);
    });
});
