import {
    copyFileSync, mkdtempSync, rmSync,
} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
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
    clickVisibleAnnotationControl,
    selectAllFocusedAnnotationText,
    setAnnotationKeepActiveWithPointer,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openAnnotationsTab,
    openPdfInApp,
    saveViaVisibleToolbar,
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

async function readStyleStepGeometry(page: Page): Promise<IStyleStepGeometry[]> {
    return page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(
            '[data-annotation-inspector] .style-step-button',
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

async function expectUsableStyleSlider(page: Page) {
    const geometry = await page.$eval('.editor-pane.is-active [data-annotation-inspector] .style-row-width', row => {
        const control = row.querySelector<HTMLElement>('.style-width-control');
        const track = row.querySelector<HTMLElement>('.style-range-track');
        return {
            rowWidth: row.getBoundingClientRect().width,
            controlWidth: control?.getBoundingClientRect().width ?? 0,
            trackWidth: track?.getBoundingClientRect().width ?? 0,
        };
    });
    expect(geometry.controlWidth, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.rowWidth - 2);
    expect(geometry.trackWidth, JSON.stringify(geometry)).toBeGreaterThan(60);
}

async function recordPointerDiagnostics(page: Page) {
    const navigation: string[] = [];
    const recordNavigation = () => navigation.push(page.url());
    page.on('load', recordNavigation);
    const handle = await page.evaluateHandle(() => {
        const events: object[] = [];
        const record = (event: Event) => {
            const target = event.target instanceof Element ? event.target : null;
            events.push({
                type: event.type,
                target: target?.tagName,
                className: target?.getAttribute('class'),
                active: document.activeElement?.getAttribute('class'),
                editing: document.querySelectorAll('.pdf-annotation-editor-text-box.is-editing').length,
                boxes: document.querySelectorAll('.pdf-annotation-editor-layer [data-annotation-kind="text-box"]').length,
            });
        };
        const names = [
            'pointerdown',
            'pointerup',
            'mousedown',
            'mouseup',
            'click',
            'focusin',
            'focusout',
            'pagehide',
        ];
        names.forEach(name => window.addEventListener(name, record, true));
        return {finish() {
            names.forEach(name => window.removeEventListener(name, record, true));
            return {
                events,
                rootPresent: document.querySelector('#__nuxt') !== null,
                loading: Array.from(document.querySelectorAll('[class*="loading"]')).filter(element => element.getBoundingClientRect().width > 0).map(element => element.getAttribute('class')),
                readyState: document.readyState,
            };
        }};
    });
    const collect = async () => {
        page.off('load', recordNavigation);
        try {
            return {
                navigation,
                document: await handle.evaluate(recorder => recorder.finish()),
            };
        } catch (error) {
            return {
                navigation,
                error: String(error),
            };
        } finally {
            await handle.dispose().catch(() => undefined);
        }
    };
    let completion: ReturnType<typeof collect> | undefined;
    const finish = () => completion ??= collect();
    onTestFinished(async () => { await finish(); });
    return finish;
}

async function readTextBoxFontSize(page: Page, annotationId: string) {
    return page.evaluate((id: string) => {
        const textBox = Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
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

async function readTextBoxGeometry(page: Page, annotationId: string) {
    return page.evaluate((id: string): ITextBoxGeometrySnapshot | null => {
        const textBox = Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
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

async function expectMatchingTextCardColor(page: Page, id: string, expected: string) {
    await expect.poll(() => page.evaluate((annotationId: string) => {
        const entity = document.querySelector<HTMLElement>(`.pdf-annotation-editor-layer [data-annotation-id="${annotationId}"]`);
        const chip = document.querySelector<HTMLElement>(`.note-item[data-annotation-id="${annotationId}"] .note-item-color-chip`);
        return {
            text: entity ? getComputedStyle(entity).color : null,
            card: chip ? getComputedStyle(chip).backgroundColor : null,
            chipWidth: chip?.getBoundingClientRect().width ?? 0,
        };
    }, id)).toEqual({
        text: expected,
        card: expected,
        chipWidth: expect.any(Number),
    });
    expect(await page.$eval(`.note-item[data-annotation-id="${id}"] .note-item-color-chip`, chip => chip.getBoundingClientRect().width)).toBeGreaterThan(0);
}

async function expectVisibleTypingFrame(page: Page, selector: string) {
    const frame = await page.evaluate((editorSelector: string) => {
        const editor = document.querySelector<HTMLElement>(editorSelector);
        const root = editor?.closest<HTMLElement>('[data-annotation-kind="text-box"]');
        if (!editor || !root) {
            return null;
        }
        const styles = getComputedStyle(root);
        const editorStyles = getComputedStyle(editor);
        const visibleColor = (color: string) => color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)';
        const selection = window.getSelection();
        return {
            focused: document.activeElement === editor,
            visibleFrame: (Number.parseFloat(styles.borderTopWidth) >= 1 && styles.borderTopStyle !== 'none' && visibleColor(styles.borderTopColor))
                || (Number.parseFloat(styles.outlineWidth) >= 1 && styles.outlineStyle !== 'none' && visibleColor(styles.outlineColor)),
            caretVisible: visibleColor(editorStyles.caretColor),
            selectionInside: selection?.anchorNode === editor || (selection?.anchorNode !== null && editor.contains(selection?.anchorNode ?? null)),
            selectionCollapsed: selection?.isCollapsed,
            editableWidth: editor.getBoundingClientRect().width,
            editableHeight: editor.getBoundingClientRect().height,
        };
    }, selector);
    expect(frame).toMatchObject({
        focused: true,
        visibleFrame: true,
        caretVisible: true,
        selectionInside: true,
        selectionCollapsed: true,
    });
    expect(frame?.editableWidth).toBeGreaterThan(0);
    expect(frame?.editableHeight).toBeGreaterThan(0);
}

describe('Electron E2E - annotation controls', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        restartBeforeEach: true,
        extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
        sessionName: () => `e2e-annotation-controls-${Date.now()}`,
    });

    it('keeps one inline inspector stable and separates selected properties from tool defaults', async () => {
        const session = sessionFixture.getSession();
        if (!session) throw new Error('Annotation controls session did not start');
        const {page} = session;
        const fixturePath = await createBlankFixturePdf(`annotation-controls-${Date.now()}.pdf`);
        onTestFinished(() => rmSync(fixturePath, {force: true}));
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);
        await setAnnotationKeepActiveWithPointer(page, false);
        await clickAnnotationTool(page, 'Text');
        await expectUsableStyleSlider(page);
        await resizeSidebar(page, SIDEBAR_RESIZE_DELTA_PX);
        await expectUsableStyleSlider(page);
        await waitForAnnotationPointerReady(page);

        const inspector = '.editor-pane.is-active [data-annotation-inspector]';
        await page.waitForSelector(`${inspector}[data-target="defaults"]`, {visible: true});
        const steps = await readStyleStepGeometry(page);
        expect(steps).toHaveLength(2);
        for (const step of steps) {
            expect(Math.abs(step.dx)).toBeLessThanOrEqual(0.5);
            expect(Math.abs(step.dy)).toBeLessThanOrEqual(0.5);
        }
        const beforeBounds = await page.$eval(inspector, element => element.getBoundingClientRect().toJSON());
        const textBoxId = await createCanonicalTextBoxWithPointer(page, 'Selected text style', {
            x: 0.42,
            y: 0.34,
        });
        await expect.poll(() => readActiveAnnotationTool(page)).toBe('select');
        await page.waitForSelector(`${inspector}[data-target="selection"]`, {visible: true});
        const initialSize = await readTextBoxFontSize(page, textBoxId);
        expect(initialSize).not.toBeNull();
        await clickVisibleAnnotationControl(page, `${inspector} input[type="number"]`);
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('Tab');
        await expect.poll(() => readTextBoxFontSize(page, textBoxId)).toBeGreaterThan(initialSize!);
        const selectedSize = await readTextBoxFontSize(page, textBoxId);
        await clickVisibleAnnotationControl(page, `${inspector} .swatch[aria-label="#22c55e"]`);
        await expectMatchingTextCardColor(page, textBoxId, 'rgb(34, 197, 94)');

        await clickAnnotationTool(page, 'Draw');
        await page.waitForSelector(`${inspector}[data-target="defaults"]`, {visible: true});
        await clickVisibleAnnotationControl(page, `${inspector} .swatch[aria-label="#ef4444"]`);
        await expectMatchingTextCardColor(page, textBoxId, 'rgb(34, 197, 94)');
        expect(await readTextBoxFontSize(page, textBoxId)).toBe(selectedSize);
        await clickVisibleAnnotationControl(page, `${inspector} .draw-style-button:last-child`);
        await drawInkStroke(page);
        await expect.poll(() => readActiveAnnotationTool(page)).toBe('select');
        const shapes = ((await callWorkspaceCommand<IManagedShape[]>(page, 'getAllShapes')).value ?? []);
        expect(shapes.filter(shape => shape.pdfSubtype === 'Ink')).toEqual([expect.objectContaining({
            strokeWidth: 6,
            opacity: 0.42,
        })]);
        const afterBounds = await page.$eval(inspector, element => element.getBoundingClientRect().toJSON());
        expect(Math.abs(afterBounds.left - beforeBounds.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(afterBounds.width - beforeBounds.width)).toBeLessThanOrEqual(1);
        expect(await page.$$('.annotation-style-popover')).toHaveLength(0);
        expect(await page.$$(inspector)).toHaveLength(1);
        await setAnnotationKeepActiveWithPointer(page, true);
        await clickAnnotationTool(page, 'Draw');
        await drawInkStroke(page);
        expect(await readActiveAnnotationTool(page)).toBe('draw');
        await clickAnnotationTool(page, 'Text');
        await createCanonicalTextBoxWithPointer(page, 'Keep the text tool active', {
            x: 0.62,
            y: 0.72,
        });
        expect(await readActiveAnnotationTool(page)).toBe('text');
        await setAnnotationKeepActiveWithPointer(page, false);
    });

    it('places one text box through sequential keyboard activation and reopens it', async () => {
        const session = sessionFixture.getSession();
        if (!session) throw new Error('Annotation controls session did not start');
        const {page} = session;
        const fixturePath = await createBlankFixturePdf(`annotation-controls-${Date.now()}-keyboard-text.pdf`);
        onTestFinished(() => rmSync(fixturePath, {force: true}));

        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);

        let textToolFocused = false;
        for (let attempt = 0; attempt < 32; attempt += 1) {
            const active = await page.evaluate(() => {
                const element = document.activeElement;
                return element instanceof HTMLButtonElement && element.getAttribute('aria-label') === 'Text';
            });
            if (active) {
                textToolFocused = true;
                break;
            }
            await page.keyboard.press('Tab');
        }
        expect(textToolFocused).toBe(true);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector(
            '.editor-pane.is-active .notes-panel .tool-button[data-tool="text"].is-active',
        ) !== null, {timeout: STYLE_UPDATE_TIMEOUT_MS});

        let layerFocused = false;
        for (let attempt = 0; attempt < 48; attempt += 1) {
            const active = await page.evaluate(() => document.activeElement?.matches(
                '.editor-pane.is-active .pdf-annotation-editor-layer',
            ) ?? false);
            if (active) {
                layerFocused = true;
                break;
            }
            await page.keyboard.press('Tab');
        }
        expect(layerFocused).toBe(true);
        await page.keyboard.press('Enter');

        const editorSelector = '.editor-pane.is-active .pdf-annotation-editor-text-box.is-editing [contenteditable="true"]';
        await page.waitForSelector(editorSelector, {
            visible: true,
            timeout: STYLE_UPDATE_TIMEOUT_MS,
        });
        await page.keyboard.type('Keyboard text box', {delay: 4});
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.down(modifier);
        try {
            await page.keyboard.press('Enter');
        } finally {
            await page.keyboard.up(modifier);
        }
        await page.waitForFunction(() => document.querySelector(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
        ) !== null, {timeout: STYLE_UPDATE_TIMEOUT_MS});
        await saveViaVisibleToolbar(page, 30_000);

        const reopenDirectory = mkdtempSync(join(tmpdir(), 'evb-annotation-keyboard-reopen-'));
        const reopenPath = join(reopenDirectory, 'saved.pdf');
        onTestFinished(() => rmSync(reopenDirectory, {
            recursive: true,
            force: true,
        }));
        copyFileSync(fixturePath, reopenPath);
        const restarted = await sessionFixture.restart({hard: true});
        if (!restarted) throw new Error('Keyboard text-box reopen did not start');
        await openPdfInApp(restarted.page, reopenPath);
        await waitForPdfLoaded(restarted.page);
        await waitForViewerInteractive(restarted.page);
        await openAnnotationsTab(restarted.page);
        await restarted.page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
        )).some(element => element.textContent?.replace(/[\u200B\uFEFF]/gu, '').trim() === 'Keyboard text box'), {timeout: STYLE_UPDATE_TIMEOUT_MS});
    });

    it('retains a visible typing box and places the caret through delayed pointer input', async () => {
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
        await setAnnotationKeepActiveWithPointer(page, false);
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

            await page.waitForSelector('[data-annotation-inspector][data-target="defaults"]', {
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

            const finishDiagnostics = await recordPointerDiagnostics(page);
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
            const diagnostics = await finishDiagnostics();
            expect(focusSnapshot, `Text editor focus was lost on delayed attempt ${attempt}: ${JSON.stringify({
                focusSnapshot,
                diagnostics,
            })}`)
                .toMatchObject({
                    editorPresent: true,
                    focused: true,
                });

            // Deliberately do not call page.focus here. The keystrokes must use
            // the focus produced by the real pointer sequence.
            await expectVisibleTypingFrame(page, editorSelector);
            const text = `Delayed text ${attempt}`;
            await page.keyboard.type(text, {delay: 5});
            const editorText = await page.evaluate((selector: string) => (
                document.querySelector<HTMLElement>(selector)?.textContent
                    ?.replace(/[\u200B\uFEFF]/gu, '')
                    .trim()
                ?? null
            ), editorSelector);
            expect(editorText, `Text editor did not receive delayed input on attempt ${attempt}`).toBe(text);
            await expectVisibleTypingFrame(page, editorSelector);
            const caretPoint = await page.$eval(editorSelector, editor => {
                const node = editor.firstChild;
                if (!(node instanceof Text)) throw new Error('Typed annotation has no text node');
                const range = document.createRange();
                range.setStart(node, 5);
                range.collapse(true);
                const rect = range.getBoundingClientRect();
                return {
                    x: rect.left,
                    y: rect.top + rect.height / 2,
                };
            });
            await page.mouse.click(caretPoint.x, caretPoint.y);
            await page.keyboard.type('#');
            const pointerEditedText = `${text.slice(0, 5)}#${text.slice(5)}`;
            await expect.poll(() => page.$eval(editorSelector, editor => editor.textContent)).toBe(pointerEditedText);
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.type('!');
            await expect.poll(() => page.$eval(editorSelector, editor => editor.textContent)).toBe(`${text.slice(0, 5)}!#${text.slice(5)}`);
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
        await setAnnotationKeepActiveWithPointer(page, false);
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
        await expectVisibleTypingFrame(page, editorSelector);
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
                `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"][data-annotation-id="${options.id}"]`,
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
                `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"][data-annotation-id="${options.id}"]`,
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
        await selectAllFocusedAnnotationText(page);
        await page.keyboard.type(replacementText, {delay: 4});
        await page.waitForFunction((options: {
            id: string;
            text: string;
        }) => {
            const entity = document.querySelector<HTMLElement>(
                `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"][data-annotation-id="${options.id}"]`,
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
                `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"][data-annotation-id="${id}"]`,
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
