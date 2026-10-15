import {
    copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import {
    join, resolve,
} from 'node:path';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {
    createCanvas, loadImage,
} from '@napi-rs/canvas';
import type {Page} from 'puppeteer-core';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
    decodePDFRawStream, PageSizes, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, rgb,
} from 'pdf-lib';
import type {
    PDFNumber, PDFRef,
} from 'pdf-lib';
import {createPdfjsNodeDocumentOptions} from '@electron/features/search/pdfjsPageTexts';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/public/nativePageOpsPath';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {
    createBlankFixturePdf, createAnnotationSidebarFixturePdf,
} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickAnnotationTool,
    createCanonicalTextBoxWithPointer,
    clickVisibleAnnotationControl,
    revealAnnotationControl,
    selectAllFocusedAnnotationText,
    setAnnotationKeepActiveWithPointer,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openAnnotationsTab,
    openDocumentSidebarTab,
    openPdfInApp,
    saveViaVisibleToolbar,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    clickAsUser, revealForPointer,
} from '@tests/e2e/electron/helpers/userInput';
import {callWorkspaceCommand} from '@tests/e2e/electron/helpers/workspaceExpose';

const POINTER_READY_TIMEOUT_MS = 30_000;
const STYLE_UPDATE_TIMEOUT_MS = 20_000;
const SIDEBAR_RESIZE_DELTA_PX = 96;
// Spaces, punctuation and tatweel are shared by scripts; the screen and the saved
// page both draw them with DejaVu Sans, whatever script surrounds them.
const SHARED_CHARACTER = /\p{Script=Common}/u;

// Counts PDF.js ink inside and outside the saved text box. With `unclipped`, the
// appearance loses its clip and grows with its Rect at unit scale, so any glyph the
// saved layout placed outside the box shows up as ink outside it.
async function renderedTextBoxInk(bytes: Uint8Array, unclipped: boolean) {
    const pdf = await PDFDocument.load(bytes);
    const annotation = (pdf.getPage(0).node.Annots()?.asArray() ?? []).map(ref => pdf.context.lookup(ref, PDFDict)).find(object => (
        object.get(PDFName.of('Subtype'))?.toString() === '/FreeText'
    ))!;
    const numbers = (dict: PDFDict, key: string) => dict.lookup(PDFName.of(key), PDFArray).asArray().map(value => (value as PDFNumber).asNumber());
    const rect = numbers(annotation, 'Rect');
    if (unclipped) {
        const reference = annotation.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')) as PDFRef;
        const stream = pdf.context.lookup(reference) as PDFRawStream;
        const grow = (box: number[]) => pdf.context.obj([
            box[0]! - 200,
            box[1]! - 200,
            box[2]! + 200,
            box[3]! + 200,
        ]);
        const dict = stream.dict.clone(pdf.context);
        dict.delete(PDFName.of('Filter'));
        dict.set(PDFName.of('BBox'), grow(numbers(stream.dict, 'BBox')));
        annotation.set(PDFName.of('Rect'), grow(rect));
        const content = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
        expect(content).toContain(' re W n');
        pdf.context.assign(reference, PDFRawStream.of(dict, Buffer.from(content.replace(' re W n', ' re n'), 'latin1')));
    }
    const task = pdfjs.getDocument({
        data: await pdf.save(),
        ...createPdfjsNodeDocumentOptions(),
    });
    try {
        const page = await (await task.promise).getPage(1);
        const viewport = page.getViewport({scale: 2});
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        await Reflect.apply(page.render, page, [{
            canvas,
            canvasContext: context,
            viewport,
            annotationMode: pdfjs.AnnotationMode.ENABLE,
        }]).promise;
        const [
            left,
            top,
        ] = viewport.convertToViewportPoint(rect[0]!, rect[1]!);
        const [
            right,
            bottom,
        ] = viewport.convertToViewportPoint(rect[2]!, rect[3]!);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const ink = {
            inside: 0,
            outside: 0,
        };
        for (let y = 0; y < canvas.height; y += 1) {
            for (let x = 0; x < canvas.width; x += 1) {
                const offset = (y * canvas.width + x) * 4;
                if (Math.min(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!) >= 160) continue;
                const within = x >= Math.min(left!, right!) && x <= Math.max(left!, right!) && y >= Math.min(top!, bottom!) && y <= Math.max(top!, bottom!);
                ink[within ? 'inside' : 'outside'] += 1;
            }
        }
        return ink;
    } finally {
        await task.destroy();
    }
}

async function expectTwoLinePreviewPaint(page: Page) {
    // Selection and root scaling update the clamped preview asynchronously.
    // Observe its visible line boxes before sampling pixels; a click returning
    // only proves that input was dispatched, not that this layout was painted.
    await page.waitForFunction(() => {
        const row = document.querySelector('.note-item.is-active[data-annotation-id="sidebar-distant"]');
        const preview = row?.querySelector('.note-item-text');
        const mark = preview?.querySelector('.note-item-text-mark--squiggly');
        if (!preview || !mark || getComputedStyle(mark).textDecorationStyle !== 'wavy') return false;
        const bounds = preview.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(mark);
        const visibleLines = new Set([...range.getClientRects()]
            .filter(rect => rect.width > 0 && rect.height > 0 && rect.top >= bounds.top && rect.bottom <= bounds.bottom)
            .map(rect => rect.top));
        return visibleLines.size === 2;
    });
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const preview = await page.$('.note-item[data-annotation-id="sidebar-distant"] .note-item-text');
    expect(preview).not.toBeNull();
    const image = await loadImage(Buffer.from(await preview!.screenshot()));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    function paintedBands(matches: (r: number, g: number, b: number) => boolean) {
        const bands: number[][] = [];
        for (let y = 0; y < image.height; y += 1) {
            let count = 0;
            for (let x = 0; x < image.width; x += 1) {
                const index = (y * image.width + x) * 4;
                if (matches(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!)) count += 1;
            }
            if (count < 3) continue;
            const last = bands.at(-1);
            if (last && y - last.at(-1)! <= 2) last.push(y);
            else bands.push([y]);
        }
        return bands;
    }
    // Underlines delimit the two painted text lines. Glyphs can have detached
    // dots and descenders, so gaps between dark pixel rows are not line breaks.
    const text = paintedBands((r, g, b) => Math.max(r, g, b) < 170 && Math.max(r, g, b) - Math.min(r, g, b) < 50);
    // The fixture underline has a full blue channel. Linux LCD glyph edges
    // can also be blue-dominant, but their blue channel is darkened by the ink.
    const waves = paintedBands((r, g, b) => b >= 240 && b - r > 65 && b - g > 35);
    expect(waves, 'Both blue squiggly underlines remain visible').toHaveLength(2);
    const textRows = text.flat();
    const firstWaveEnd = waves[0]!.at(-1)!;
    const lastWaveEnd = waves[1]!.at(-1)!;
    expect(textRows.some(y => y <= firstWaveEnd), 'The first text line is painted').toBe(true);
    expect(textRows.some(y => y > firstWaveEnd && y <= lastWaveEnd), 'The second text line is painted').toBe(true);
    expect(textRows.filter(y => y > lastWaveEnd), 'No third-line fragments below the final underline').toEqual([]);
    const waveHeights = waves.map(band => band.at(-1)! - band[0]! + 1);
    expect(Math.abs(waveHeights[0]! - waveHeights[1]!), 'The last wave must not be clipped').toBeLessThanOrEqual(2);
}

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
        sessionName: () => `e2e-annotation-controls-${Date.now()}`,
    });


    it('preserves the original normal appearance until a supported semantic edit', async () => {
        // Core61, A1/A5/T4: original r12 857-byte input, not the distinct repository fixture.
        const original = Buffer.from('JVBERi0xLjcKJYGBgYEKCjUgMCBvYmoKPDwKL1R5cGUgL1hPYmplY3QKL1N1YnR5cGUgL0Zvcm0KL0JCb3ggWyAwIDAgMzAwIDQwIF0KL1Jlc291cmNlcyA8PAovRm9udCA8PAovSGVsdiA0IDAgUgo+Pgo+PgovRmlsdGVyIC9GbGF0ZURlY29kZQovTGVuZ3RoIDEwMwo+PgpzdHJlYW0KeJwlyr0OgjAYheFeyjvK1BYcmFv+uql8iTsKRlOjMHj9tDFvcs7yrFTGkDv+7/bGBfQVix7yuJOnRvsRfekdoUEpRRs44ySZOf6wJbIknNseidsKuXPonjHy3T7TXCAvWtkBE9YZMgplbmRzdHJlYW0KZW5kb2JqCgo3IDAgb2JqCjw8Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9UeXBlIC9PYmpTdG0KL04gNQovRmlyc3QgMjYKL0xlbmd0aCAyNzkKPj4Kc3RyZWFtCnicVVDLasMwELzrK+aYnlZynMchBJy0plBaQmzIIfTg2KoRGCnYSkn/vis5oQ0rIbQzuzuzChIJ0hRTLJZIoRYKcySzKVYrQeXPWYN2VasHQW+mGXBkosQen4K27mI9lFivxR93W/mqc60Yi6AC+ZERgAD3OlRHnPZ6cJe+5gLmMZvedWOqjbvyPMkxlxJLvjw1s9b5oGN+0/HQPHfWCyouJx+/IakEbapBBwT0qrtv7U1dCXqxtWuMbUEHYzM7mHvisWOc969l3mtd6qsPomvPOpQc9aXhTeW4GevZ3YBJbroO596d9JOg5wyTqAAqQfnF5kP0LUObIu77gIRHgYq4hO3NfeyZI2Xzu0j7wOy+Vz6/FP12egplbmRzdHJlYW0KZW5kb2JqCgo4IDAgb2JqCjw8Ci9TaXplIDkKL1Jvb3QgMiAwIFIKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL1R5cGUgL1hSZWYKL0xlbmd0aCA0MQovVyBbIDEgMiAyIF0KL0luZGV4IFsgMCA5IF0KPj4Kc3RyZWFtCnicY2Bg+P+fiYGdgQFEMIIIJhDBzMggABFjYWSUYQDKzGRgAABcagMBCmVuZHN0cmVhbQplbmRvYmoKCnN0YXJ0eHJlZgo2NjUKJSVFT0Y=', 'base64');
        const evidence = mkdtempSync(join(tmpdir(), 'evb-core61-'));
        const saved = join(evidence, 'original.pdf');
        writeFileSync(saved, original);
        let {page} = sessionFixture.getSession();
        await openPdfInApp(page, saved);
        await waitForViewerInteractive(page);
        const selector = '.editor-pane.is-active .pdf-annotation-editor-text-box';
        await page.waitForSelector(selector);

        async function originalPaint(label: string, bytes = original, blank = false) {
            const box = await page.waitForSelector(selector);
            await revealForPointer(page, box!);
            // Selection grips are app chrome; keep selection mounted while comparing PDF paint.
            const gripPaint = await page.addStyleTag({content: '.editor-pane.is-active .pdf-annotation-selection-handle[data-pdf-annotation-resize-handle] { opacity: 0 !important; }'});
            try {
                await page.evaluate(async () => {
                    await document.fonts.ready;
                    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
                });
                const layout = await box!.evaluate(element => {
                    const container = element.closest('.page_container')!;
                    const viewer = container.closest<HTMLElement>('[data-document-viewer-chassis-viewport]')!;
                    const bounds = viewer.getBoundingClientRect();
                    const selection = window.getSelection();
                    const caret = element.classList.contains('is-editing') && selection?.isCollapsed && selection.rangeCount
                        ? selection.getRangeAt(0).getBoundingClientRect().toJSON() : null;
                    const textColor = getComputedStyle(element).color;
                    return {
                        caret,
                        textColor,
                        referenceAlpha: textColor === 'rgba(0, 0, 0, 0)',
                        box: element.getBoundingClientRect().toJSON(),
                        page: container.getBoundingClientRect().toJSON(),
                        viewport: new DOMRect(bounds.left + viewer.clientLeft, bounds.top + viewer.clientTop, viewer.clientWidth, viewer.clientHeight).toJSON(),
                        dpr: devicePixelRatio,
                    };
                });
                expect(layout.box.left >= layout.viewport.left && layout.box.right <= layout.viewport.right
                && layout.box.top >= layout.viewport.top && layout.box.bottom <= layout.viewport.bottom, 'Whole glyph ROI is visible').toBe(true);
                const screenshot = Buffer.from(await page.screenshot());
                writeFileSync(join(evidence, `${label}-viewport.png`), screenshot);
                const full = await loadImage(screenshot);
                const browserReference = await page.evaluate(async ({
                    data, pageWidth, dpr, expectedVersion, expectedBuild, alpha,
                }) => {
                // The existing vendored public API opens independent bytes, not the live document or raster.
                    const browserPdfjs = Object.getOwnPropertyDescriptor(globalThis, 'pdfjsLib')?.value as typeof pdfjs | undefined;
                    if (!browserPdfjs || browserPdfjs.version !== expectedVersion || browserPdfjs.build !== expectedBuild
                    || typeof browserPdfjs.getDocument !== 'function') throw new Error('Independent Browser PDF.js reference runtime is unavailable or mismatched');
                    if (browserPdfjs.GlobalWorkerOptions.workerPort !== null) throw new Error('Independent reference cannot own a shared explicit worker port');
                    const workerSrc = browserPdfjs.GlobalWorkerOptions.workerSrc;
                    const options = {
                        verbosity: browserPdfjs.VerbosityLevel.ERRORS,
                        standardFontDataUrl: '/pdf/standard_fonts/',
                        cMapUrl: '/pdf/cmaps/',
                        cMapPacked: true,
                        wasmUrl: '/pdf/wasm/',
                        iccUrl: '/pdf/iccs/',
                        useSystemFonts: false,
                        canvasMaxAreaInBytes: 128 * 1024 * 1024,
                    };
                    const task = browserPdfjs.getDocument({
                        data: new Uint8Array(data),
                        ...options,
                    });
                    try {
                        const referencePage = await (await task.promise).getPage(1);
                        const scale = pageWidth / referencePage.getViewport({scale: 1}).width;
                        const viewport = referencePage.getViewport({scale: scale * dpr});
                        const reference = document.createElement('canvas');
                        reference.width = Math.ceil(viewport.width);
                        reference.height = Math.ceil(viewport.height);
                        const context = reference.getContext('2d', {alpha});
                        if (!context) throw new Error('Independent Browser reference has no 2D canvas context');
                        if (typeof context.getContextAttributes !== 'function') throw new Error('Independent Browser reference context attributes are unavailable');
                        const contextAttributes = context.getContextAttributes();
                        if (contextAttributes.alpha !== alpha) throw new Error('Independent Browser reference alpha does not match public text paint');
                        await referencePage.render({
                            canvas: reference,
                            canvasContext: context,
                            viewport,
                            annotationMode: browserPdfjs.AnnotationMode.ENABLE_FORMS,
                        }).promise;
                        return {
                            png: reference.toDataURL('image/png'),
                            scale,
                            backend: {
                                version: browserPdfjs.version,
                                build: browserPdfjs.build,
                                workerSrc,
                                options,
                                requestedAlpha: alpha,
                                contextAttributes,
                                canvasWidth: reference.width,
                                canvasHeight: reference.height,
                                viewportWidth: viewport.width,
                                viewportHeight: viewport.height,
                                viewportTransform: viewport.transform,
                                canvasIsDOM: reference instanceof HTMLCanvasElement,
                                ownerDocumentIsCurrent: reference.ownerDocument === document,
                            },
                        };
                    } finally { await task.destroy(); }
                }, {
                    data: Array.from(bytes),
                    pageWidth: layout.page.width,
                    dpr: layout.dpr,
                    expectedVersion: pdfjs.version,
                    expectedBuild: pdfjs.build,
                    alpha: layout.referenceAlpha,
                });
                {
                    const scale = browserReference.scale;
                    const referencePng = Buffer.from(browserReference.png.slice('data:image/png;base64,'.length), 'base64');
                    const reference = await loadImage(referencePng);
                    writeFileSync(join(evidence, `${label}-reference.png`), referencePng);
                    writeFileSync(join(evidence, `${label}-reference-backend.json`), JSON.stringify(browserReference.backend, null, 2));
                    // Exclude the original 2pt border and all selection chrome. Compare glyphs,
                    // including horizontal extent and silhouette, in the full-viewport pixels.
                    const inset = 4 * scale;
                    const width = Math.floor((layout.box.width - 2 * inset) * layout.dpr);
                    const height = Math.floor((layout.box.height - 2 * inset) * layout.dpr);
                    const sample = (image: typeof full | typeof reference, x: number, y: number) => {
                        const canvas = createCanvas(width, height);
                        canvas.getContext('2d').drawImage(image, x, y, width, height, 0, 0, width, height);
                        return canvas.getContext('2d').getImageData(0, 0, width, height).data;
                    };
                    const actual = sample(full, (layout.box.left + inset) * layout.dpr, (layout.box.top + inset) * layout.dpr);
                    const expected = sample(reference, (layout.box.left - layout.page.left + inset) * layout.dpr, (layout.box.top - layout.page.top + inset) * layout.dpr);
                    const lightGlyphs = Math.max(expected[0]!, expected[1]!, expected[2]!) < 160;
                    const points = (pixels: Uint8ClampedArray) => {
                        const result: Array<{
                            x: number;
                            y: number
                        }> = [];
                        for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
                        // The collapsed editor caret is chrome, not a glyph. Exclude its exact column in both images.
                            const caretX = layout.caret ? (layout.caret.left - layout.box.left - inset) * layout.dpr : null;
                            if (caretX !== null && x >= Math.floor(caretX) && x <= Math.ceil(caretX)) continue;
                            const offset = (y * width + x) * 4;
                            if (lightGlyphs ? Math.min(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!) > 200
                                : Math.max(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!) < 160) result.push({
                                x,
                                y,
                            });
                        }
                        return result;
                    };
                    const liveInk = points(actual);
                    const originalInk = points(expected);
                    if (blank) {
                        expect(originalInk.length, `${label} independent normal appearance is blank`).toBe(0);
                        expect(liveInk.length, `${label} nonempty Contents must not invent glyphs`).toBe(0);
                        return;
                    }
                    expect(originalInk.length, 'Independent original appearance has glyph ink').toBeGreaterThan(0);
                    expect(liveInk.length, 'Live appearance has glyph ink').toBeGreaterThan(0);
                    const bounds = (ink: typeof liveInk) => [
                        Math.min(...ink.map(p => p.x)),
                        Math.max(...ink.map(p => p.x)),
                        Math.min(...ink.map(p => p.y)),
                        Math.max(...ink.map(p => p.y)),
                    ];
                    const liveBounds = bounds(liveInk);
                    const referenceBounds = bounds(originalInk);
                    writeFileSync(join(evidence, `${label}-glyphs.json`), JSON.stringify({
                        layout,
                        liveBounds,
                        referenceBounds,
                    }));
                    for (let i = 0; i < 4; i += 1) expect(Math.abs(liveBounds[i]! - referenceBounds[i]!) / layout.dpr, `${label} glyph extent ${i}, one CSS pixel rounding`).toBeLessThanOrEqual(1);
                    const outside = (from: typeof liveInk, to: typeof liveInk) => from.filter(a => !to.some(b => Math.abs(a.x - b.x) <= layout.dpr && Math.abs(a.y - b.y) <= layout.dpr)).length;
                    expect(outside(liveInk, originalInk), `${label} live glyph silhouette matches original font`).toBe(0);
                    expect(outside(originalInk, liveInk), `${label} original glyph silhouette is complete`).toBe(0);
                }
            } finally {
                try { await gripPaint.evaluate(element => element.remove()); }
                finally { await gripPaint.dispose(); }
            }
        }
        const normalAppearance = async (bytes: Uint8Array) => {
            const pdf = await PDFDocument.load(bytes);
            const annotation = (pdf.getPage(0).node.Annots()?.asArray() ?? []).map(ref => pdf.context.lookup(ref, PDFDict))
                .find(object => object.get(PDFName.of('Subtype'))?.toString() === '/FreeText')!;
            const normal = annotation.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'));
            if (!(normal instanceof PDFRawStream)) throw new Error('Saved normal appearance is not a stream');
            return {
                stream: Buffer.from(normal.contents),
                resources: normal.dict.lookup(PDFName.of('Resources'), PDFDict).toString(),
                rect: annotation.lookup(PDFName.of('Rect'), PDFArray).toString(),
                contents: annotation.lookup(PDFName.of('Contents'), PDFString, PDFHexString).asBytes(),
            };
        };
        await originalPaint('untouched');
        await openAnnotationsTab(page);
        await clickAnnotationTool(page, 'Select');
        await clickAsUser(page, selector);
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.down(modifier);
        try { await page.keyboard.press('c'); } finally { await page.keyboard.up(modifier); }
        await originalPaint('selected-copy');
        await clickAsUser(page, selector, {count: 2});
        await page.waitForSelector(`${selector}.is-editing [contenteditable="true"]`);
        await originalPaint('no-op-entry');
        await page.keyboard.press('Escape');
        await originalPaint('escaped');
        expect(readFileSync(saved), 'No-op input leaves original file bytes untouched').toEqual(original);
        await clickAsUser(page, selector, {count: 2});
        await page.waitForSelector(`${selector}.is-editing [contenteditable="true"]`);
        await page.keyboard.down(modifier);
        try { await page.keyboard.press('Enter'); } finally { await page.keyboard.up(modifier); }
        await originalPaint('unchanged-completion');
        for (const handleSelector of [
            '[data-pdf-annotation-move-handle]',
            '[data-pdf-annotation-resize-handle="se"]',
        ]) {
            if (handleSelector.includes('resize')) await clickAsUser(page, selector);
            const handle = await page.waitForSelector(handleSelector);
            const point = await revealForPointer(page, handle!);
            await page.mouse.move(point.x, point.y);
            await page.mouse.down();
            await page.mouse.move(point.x + 18, point.y + 8, {steps: 3});
            await page.keyboard.press('Escape');
            await page.mouse.up();
            await originalPaint(handleSelector.includes('resize') ? 'cancelled-resize' : 'cancelled-move');
        }
        const untouched = await normalAppearance(original);
        await clickAnnotationTool(page, 'Draw');
        await drawInkStroke(page);
        await saveViaVisibleToolbar(page, 12_000, saved);
        expect(await normalAppearance(readFileSync(saved)), 'Unrelated ink save preserves untouched AP, Resources, Rect and Contents bytes').toEqual(untouched);
        await originalPaint('unrelated-ink-save');
        await clickAnnotationTool(page, 'Select');
        await clickAsUser(page, selector, {count: 2});
        await page.waitForSelector(`${selector}.is-editing [contenteditable="true"]`);
        await selectAllFocusedAnnotationText(page);
        await page.keyboard.type('Core61 edited text');
        await page.keyboard.down(modifier);
        try { await page.keyboard.press('Enter'); } finally { await page.keyboard.up(modifier); }
        await clickVisibleAnnotationControl(page, '.toolbar button[aria-label="Undo"]');
        await originalPaint('text-undo-before-save');
        await clickVisibleAnnotationControl(page, '.toolbar button[aria-label="Redo"]');
        await saveViaVisibleToolbar(page, 12_000, saved);
        const edited = await PDFDocument.load(readFileSync(saved));
        const annotation = edited.context.lookup(edited.getPage(0).node.Annots()!.get(0), PDFDict);
        expect(annotation.lookup(PDFName.of('Contents'), PDFString, PDFHexString).decodeText()).toBe('Core61 edited text');
        await originalPaint('saved-edit-stale-proxy', readFileSync(saved));
        await clickVisibleAnnotationControl(page, '.toolbar button[aria-label="Undo"]');
        await originalPaint('text-undo-after-save');
        await clickVisibleAnnotationControl(page, '.toolbar button[aria-label="Redo"]');
        await originalPaint('text-redo-after-save', readFileSync(saved));
        const restarted = await sessionFixture.restart({hard: true});
        page = restarted.page;
        await openPdfInApp(restarted.page, saved);
        await waitForViewerInteractive(restarted.page);
        await originalPaint('saved-edit-reopened', readFileSync(saved));
        // Local controls keep the same semantic text while changing only the selected normal appearance.
        for (const mode of [
            'selected-state',
            'blank-state',
            'missing-appearance',
            'malformed-decode',
        ]) {
            const pdf = await PDFDocument.load(original);
            const annotation = pdf.context.lookup(pdf.getPage(0).node.Annots()!.get(0), PDFDict);
            const ap = annotation.lookup(PDFName.of('AP'), PDFDict);
            const normal = ap.get(PDFName.of('N'))!;
            if (mode === 'missing-appearance') {
                annotation.delete(PDFName.of('AP'));
                annotation.set(PDFName.of('DA'), PDFString.of('/Helv 12 Tf 0 0 0 rg'));
            } else {
                const blankStream = pdf.context.stream(mode === 'malformed-decode' ? 'invalid flate bytes' : '', {
                    Type: 'XObject',
                    Subtype: 'Form',
                    BBox: [
                        0,
                        0,
                        300,
                        40,
                    ],
                    ...(mode === 'malformed-decode' ? {Filter: 'FlateDecode'} : {}),
                });
                if (mode === 'malformed-decode') {
                    expect(
                        () => decodePDFRawStream(blankStream).decode(),
                        'Malformed normal appearance fixture contains invalid compressed data',
                    ).toThrow(/flate|decode|compression|FCHECK/iu);
                }
                const blankRef = pdf.context.register(blankStream);
                ap.set(PDFName.of('N'), mode === 'malformed-decode' ? blankRef : pdf.context.obj({
                    On: normal,
                    Off: blankRef,
                }));
                annotation.set(PDFName.of('AS'), PDFName.of(mode === 'selected-state' ? 'On' : 'Off'));
                if (mode !== 'selected-state') annotation.set(PDFName.of('DA'), PDFString.of('/Helv 12 Tf 0 0 0 rg'));
            }
            const bytes = Buffer.from(await pdf.save());
            const path = join(evidence, `${mode}.pdf`);
            writeFileSync(path, bytes);
            await openPdfInApp(page, path);
            await waitForViewerInteractive(page);
            await originalPaint(mode, bytes, mode === 'blank-state' || mode === 'malformed-decode');
        }
        // Keep PDF annotation order and Multiply against the actual whole-page backdrop.
        for (const mode of [
            'shape-before-text',
            'text-before-shape',
            'multiply-stamp-overlap',
        ]) {
            const pdf = await PDFDocument.load(original);
            const pdfPage = pdf.getPage(0);
            if (mode === 'multiply-stamp-overlap') pdfPage.drawRectangle({
                x: 80,
                y: 580,
                width: 220,
                height: 80,
                color: rgb(1, 0.5, 0.25),
            });
            const annotations = pdfPage.node.Annots()!;
            const text = annotations.get(0);
            const squareAppearance = pdf.context.register(pdf.context.stream('q /GS gs 0 0 1 rg 0 0 180 60 re f Q', {
                Type: 'XObject',
                Subtype: 'Form',
                BBox: [
                    0,
                    0,
                    180,
                    60,
                ],
                Resources: {ExtGState: {GS: {BM: mode === 'multiply-stamp-overlap' ? 'Multiply' : 'Normal'}}},
            }));
            const square = pdf.context.register(pdf.context.obj({
                Type: 'Annot',
                Subtype: 'Square',
                Rect: [
                    90,
                    590,
                    270,
                    650,
                ],
                C: [
                    0,
                    0,
                    1,
                ],
                AP: {N: squareAppearance},
                F: 4,
            }));
            const stampPixels = createCanvas(1, 1);
            stampPixels.getContext('2d').fillStyle = '#00ff00';
            stampPixels.getContext('2d').fillRect(0, 0, 1, 1);
            const stampImage = await pdf.embedPng(stampPixels.toBuffer('image/png'));
            const stampAppearance = pdf.context.register(pdf.context.stream('q 40 0 0 40 0 0 cm /Im0 Do Q', {
                Type: 'XObject',
                Subtype: 'Form',
                BBox: [
                    0,
                    0,
                    40,
                    40,
                ],
                Resources: {XObject: {Im0: stampImage.ref}},
            }));
            const stamp = pdf.context.register(pdf.context.obj({
                Type: 'Annot',
                Subtype: 'Stamp',
                Rect: [
                    140,
                    600,
                    180,
                    640,
                ],
                AP: {N: stampAppearance},
                F: 4,
            }));
            pdfPage.node.set(PDFName.of('Annots'), pdf.context.obj(mode === 'shape-before-text' ? [
                square,
                stamp,
                text,
            ] : [
                text,
                square,
                stamp,
            ]));
            const bytes = Buffer.from(await pdf.save());
            const path = join(evidence, `${mode}.pdf`);
            writeFileSync(path, bytes);
            await openPdfInApp(page, path);
            await waitForViewerInteractive(page);
            const box = await page.waitForSelector(selector);
            await revealForPointer(page, box!);
            const bounds = await box!.evaluate(element => element.closest('.page_container')!.getBoundingClientRect().toJSON());
            const dpr = await page.evaluate(() => devicePixelRatio);
            const full = await loadImage(Buffer.from(await page.screenshot()));
            const referenceTask = pdfjs.getDocument({
                data: new Uint8Array(bytes),
                ...createPdfjsNodeDocumentOptions(),
            });
            try {
                const referencePage = await (await referenceTask.promise).getPage(1);
                const viewport = referencePage.getViewport({scale: bounds.width / 600 * dpr});
                const reference = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
                await Reflect.apply(referencePage.render, referencePage, [{
                    canvas: reference,
                    canvasContext: reference.getContext('2d'),
                    viewport,
                    annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
                }]).promise;
                const screenshot = createCanvas(full.width, full.height);
                screenshot.getContext('2d').drawImage(full, 0, 0);
                for (const [
                    x,
                    y,
                ] of [
                        [
                            120,
                            605,
                        ],
                        [
                            160,
                            605,
                        ],
                        [
                            250,
                            605,
                        ],
                        [
                            95,
                            645,
                        ],
                    ]) {
                    const [
                        px,
                        py,
                    ] = viewport.convertToViewportPoint(x!, y!);
                    const expected = reference.getContext('2d').getImageData(Math.round(px!), Math.round(py!), 1, 1).data;
                    const actual = screenshot.getContext('2d').getImageData(Math.round(bounds.left * dpr + px!), Math.round(bounds.top * dpr + py!), 1, 1).data;
                    expect([...actual], `${mode} PDF order/backdrop at ${x},${y}`).toEqual([...expected]);
                }
                writeFileSync(join(evidence, `${mode}-viewport.png`), screenshot.toBuffer('image/png'));
                writeFileSync(join(evidence, `${mode}-reference.png`), reference.toBuffer('image/png'));
            } finally {await referenceTask.destroy();}
        }
        // The original fixture and every recorded viewport remain under task TMP for paired proof.
    });

    it('keeps annotation cards stationary and visibly selects every annotation kind', async () => {
        // Owner report: selecting a rectangle lost feedback, and switching types
        // moved the whole list. A6/R2/I1: visible row activation selects its mark.
        const session = sessionFixture.getSession();
        const {page} = session;
        // Hosted macOS runners cannot give a window more than 942 px of content height.
        await session.command('windowResize', [
            1280,
            900,
        ]);
        const fixturePath = await createAnnotationSidebarFixturePdf(`sidebar-selection-${Date.now()}.pdf`);
        onTestFinished(() => rmSync(fixturePath, {force: true}));
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);
        await page.waitForFunction(() => document.querySelectorAll('.note-item').length === 4);
        // Owner report: the color chip trailed each type label, so the chips
        // formed a ragged column. They must share one right edge.
        const chipRights = await page.$$eval(
            '.note-item .note-item-color-chip',
            chips => chips.map(chip => chip.getBoundingClientRect().right),
        );
        expect(chipRights.length).toBeGreaterThanOrEqual(3);
        expect(Math.max(...chipRights) - Math.min(...chipRights), 'annotation card color chips align').toBeLessThanOrEqual(1);
        const ids = await page.$$eval('.note-item', rows => rows.map(row => row.getAttribute('data-annotation-id')!));
        for (let pass = 0; pass < 2; pass += 1) {
            for (const id of ids) {
                // Scrolling to a card moves the list; only what selecting it does is measured.
                await revealAnnotationControl(page, `.note-item[data-annotation-id="${id}"] .note-item-content`);
                const before = await page.$$eval('.note-item', rows => rows.map(row => ({
                    id: row.getAttribute('data-annotation-id'),
                    top: row.getBoundingClientRect().top,
                })));
                const observation = page.evaluate(async (original) => {
                    const end = performance.now() + 1500;
                    let maxShift = 0;
                    let minRowCount = original.length;
                    while (performance.now() < end) {
                        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                        const rows = [...document.querySelectorAll('.note-item')];
                        minRowCount = Math.min(minRowCount, rows.length);
                        for (const row of rows) {
                            const previous = original.find(item => item.id === row.getAttribute('data-annotation-id'));
                            if (previous) maxShift = Math.max(maxShift, Math.abs(row.getBoundingClientRect().top - previous.top));
                        }
                    }
                    return {
                        maxShift,
                        minRowCount,
                    };
                }, before);
                await clickVisibleAnnotationControl(page, `.note-item[data-annotation-id="${id}"] .note-item-content`);
                const motion = await observation;
                expect.soft(motion.maxShift, `card ${id}, pass ${pass}`).toBeLessThanOrEqual(1);
                expect.soft(motion.minRowCount).toBe(4);
                const selected = await page.$$eval('.note-item.is-active', rows => rows.map(row => ({
                    id: row.getAttribute('data-annotation-id'),
                    background: getComputedStyle(row).backgroundColor,
                    border: getComputedStyle(row).borderLeftColor,
                })));
                expect.soft(selected.map(row => row.id), `card ${id}, pass ${pass}`).toEqual([id]);
                const inactiveBackground = await page.$eval('.note-item:not(.is-active)', row => getComputedStyle(row).backgroundColor);
                expect.soft(selected[0]?.background).not.toBe(inactiveBackground);
                await page.waitForFunction(annotationId => Boolean(document.querySelector(
                    `.pdf-annotation-editor-layer [data-annotation-id="${annotationId}"]`,
                )), {}, id);
            }
        }
        try {
            for (const scale of [
                0.85,
                0.9,
                1,
                1.1,
                1.25,
            ]) {
                // Layout setup uses the same root scale property as the settings UI.
                await page.evaluate(value => document.documentElement.style.setProperty('--app-ui-scale', String(value)), scale);
                await page.waitForFunction(value => Math.abs(Number.parseFloat(getComputedStyle(document.documentElement).fontSize) - 16 * value) < 0.01, {}, scale);
                const list = await page.$('.notes-list');
                const bounds = await list!.boundingBox();
                expect(bounds).not.toBeNull();
                await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
                await page.mouse.wheel({deltaY: 1000});
                await clickVisibleAnnotationControl(page, '.note-item[data-annotation-id="sidebar-distant"] .note-item-content');
                await expectTwoLinePreviewPaint(page);
            }
        } finally {
            await page.evaluate(() => document.documentElement.style.removeProperty('--app-ui-scale'));
        }
    }, 90_000);

    it('keeps one inline inspector stable and separates selected properties from tool defaults', async () => {
        const session = sessionFixture.getSession();
        const {page} = session;
        const fixturePath = await createBlankFixturePdf(`annotation-controls-${Date.now()}.pdf`);
        onTestFinished(() => rmSync(fixturePath, {force: true}));
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);
        await setAnnotationKeepActiveWithPointer(page, false);
        const inspector = '.editor-pane.is-active [data-annotation-inspector]';
        // Draw has the tallest editor. At the default window and sidebar width
        // none of its controls may sit below the footer's fold.
        await clickAnnotationTool(page, 'Draw');
        await page.waitForSelector(`${inspector}[data-target="defaults"]`, {visible: true});
        expect(await page.$$eval(`${inspector} button, ${inspector} input`, controls => controls.filter((control) => {
            const rect = control.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return !(hit && control.contains(hit));
        }).map(control => control.getAttribute('aria-label') ?? control.className)), 'Draw controls hidden below the footer fold').toEqual([]);
        await clickAnnotationTool(page, 'Text');
        await expectUsableStyleSlider(page);
        await resizeSidebar(page, SIDEBAR_RESIZE_DELTA_PX);
        await expectUsableStyleSlider(page);
        await waitForAnnotationPointerReady(page);

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
        await openPdfInApp(restarted.page, reopenPath);
        await waitForPdfLoaded(restarted.page);
        await waitForViewerInteractive(restarted.page);
        await openAnnotationsTab(restarted.page);
        await restarted.page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
        )).some(element => element.textContent?.replace(/[\u200B\uFEFF]/gu, '').trim() === 'Keyboard text box'), {timeout: STYLE_UPDATE_TIMEOUT_MS});
    });

    it.each([
        [
            'Syriac',
            'ܫܠܵܡܵܐ',
            'NotoSansSyriac-Regular',
        ],
        [
            'Hebrew cantillation',
            'שָׁל֑וֹם',
            'NotoSansHebrew-Regular',
        ],
    ])('paints the UI search input and results for %s with the bundled font', async (script, text, postScriptName) => {
        const {page} = sessionFixture.getSession();
        const evidence = mkdtempSync(join(tmpdir(), 'evb-semitic-search-'));
        onTestFinished(() => rmSync(evidence, {
            force: true,
            recursive: true,
        }));
        // core4's public two-page RTL fixture has exact pointed text, embedded
        // glyphs and ToUnicode mappings. Search itself is already correct.
        await openPdfInApp(page, resolve('tests/fixtures/electron/semtext/search.pdf'));
        await waitForViewerInteractive(page);
        await openDocumentSidebarTab(page, 'Search');
        const input = '.editor-pane.is-active .document-search-bar input';
        await clickAsUser(page, input);
        await page.keyboard.type(text);
        await page.keyboard.press('Enter');
        await page.waitForFunction((query: string) => {
            const panel = document.querySelector('.editor-pane.is-active .document-search-results');
            return panel?.querySelector('.document-search-results-header-summary')?.textContent?.includes(query)
                && !panel.querySelector('.document-search-results-spinner')
                && panel.querySelectorAll('.document-search-result').length === 2;
        }, {timeout: POINTER_READY_TIMEOUT_MS}, text);
        await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
        });
        await page.screenshot({path: join(evidence, 'search-page.png')});
        await (await page.$(input))!.screenshot({path: join(evidence, 'search-input.png')});
        await (await page.$('.editor-pane.is-active .document-search-results'))!.screenshot({path: join(evidence, 'search-results.png')});
        const client = await page.createCDPSession();
        await client.send('DOM.enable');
        await client.send('CSS.enable');
        const tree = await client.send('DOM.getDocument', {pierce: true});
        const samples = [];
        for (const selector of [
            input,
            '.editor-pane.is-active .document-search-result-highlight',
        ]) {
            const node = await client.send('DOM.querySelector', {
                nodeId: tree.root.nodeId,
                selector,
            });
            const {fonts} = await client.send('CSS.getPlatformFontsForNode', {nodeId: node.nodeId});
            samples.push({
                selector,
                fonts,
            });
        }
        await client.detach();
        const value = await page.$eval(input, element => (element as HTMLInputElement).value);
        const matches = await page.$$eval('.editor-pane.is-active .document-search-result-highlight', elements => elements.map(element => element.textContent));
        writeFileSync(join(evidence, 'painted-fonts.json'), JSON.stringify({
            script,
            text,
            value,
            matches,
            samples,
        }, null, 2));
        expect(value).toBe(text);
        expect(matches).toEqual([
            text,
            text,
        ]);
        for (const sample of samples) {
            const glyphs = sample.fonts.filter(font => font.glyphCount > 0);
            expect.soft(glyphs.length, `${script} ${sample.selector} has painted glyphs`).toBeGreaterThan(0);
            expect.soft(glyphs.every(font => font.isCustomFont && font.postScriptName === postScriptName),
                `${script} ${sample.selector} uses the shipped covering font`).toBe(true);
        }
    });

    it.each([
        [
            'Arabic',
            'بَسْمِ لَا بــِسْمِ',
            'DejaVuSans.ttf',
            0.12,
            false,
        ],
        [
            'Syriac',
            'ܫܠܵܡܵܐ',
            'NotoSansSyriac-Regular.ttf',
            0.12,
            false,
        ],
        [
            'Hebrew cantillation',
            'בְּרֵאשִׁ֖ית',
            'NotoSansHebrew-Regular.ttf',
            0.12,
            false,
        ],
        [
            'Syriac seyame',
            'ܡܲܠܟܹ̈ܐ',
            'NotoSansSyriac-Regular.ttf',
            0.12,
            false,
        ],
        [
            'Syriac sentence',
            'ܡܲܠܟܹ̈ܐ ܛܵܒܹ̈ܐ',
            'NotoSansSyriac-Regular.ttf',
            0.12,
            false,
        ],
        [
            'Syriac tatweel',
            'ܡـܠܟܐ',
            'NotoSansSyriac-Regular.ttf',
            0.12,
            false,
        ],
        [
            // Ordinary Latin text in a narrow margin box keeps the size it is typed in.
            'Latin narrow margin',
            'A word. A phrase. A word. A phrase. A word. A phrase.',
            'DejaVuSans.ttf',
            0.9,
            true,
        ],
    ])('paints typed %s with its bundled font and saves its appearance', async (script, text, fontFile, x, keepsTypedSize) => {
        const evidence = mkdtempSync(join(tmpdir(), 'evb-semitic-text-box-'));
        onTestFinished(() => rmSync(evidence, {
            force: true,
            recursive: true,
        }));
        const saved = join(evidence, 'saved.pdf');
        const blank = await PDFDocument.create();
        blank.addPage(PageSizes.A4);
        writeFileSync(saved, await blank.save());
        const programs = new Set([
            fontFile,
            ...Array.from(text).some(character => SHARED_CHARACTER.test(character)) ? ['DejaVuSans.ttf'] : [],
        ].map(file => file.replace('.ttf', '')));
        let {page} = sessionFixture.getSession();
        await openPdfInApp(page, saved);
        await waitForViewerInteractive(page);
        await createCanonicalTextBoxWithPointer(page, text, {
            x,
            y: 0.22,
        });
        const editorFontSize = () => page.$eval('.editor-pane.is-active .pdf-annotation-editor-text-box', element => {
            const style = getComputedStyle(element);
            return Number.parseFloat(style.fontSize) / Number.parseFloat(style.getPropertyValue('--scale-factor'));
        });

        async function paintedTextMatchesBundledProgram(label: string) {
            const box = await page.waitForSelector('.editor-pane.is-active .pdf-annotation-editor-text-box');
            expect(box).not.toBeNull();
            await page.evaluate(async () => {
                await document.fonts.ready;
                await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
            });
            await revealForPointer(page, box!);
            const camera = await box!.evaluate(element => {
                const viewer = element.closest<HTMLElement>('[data-document-viewer-chassis-viewport]')!;
                const bounds = viewer.getBoundingClientRect();
                const rect = element.getBoundingClientRect();
                const y = bounds.top + viewer.clientTop + viewer.clientHeight / 2;
                return {
                    x: bounds.left + viewer.clientLeft + viewer.clientWidth / 2,
                    y,
                    deltaY: rect.top < y - viewer.clientHeight / 2 || rect.bottom > y + viewer.clientHeight / 2 ? rect.top + rect.height / 2 - y : 0,
                };
            });
            if (camera.deltaY) {
                await page.mouse.move(camera.x, camera.y);
                await page.mouse.wheel({deltaY: camera.deltaY});
                await revealForPointer(page, box!);
            }
            const capture = await box!.evaluate(element => {
                const viewer = element.closest<HTMLElement>('[data-document-viewer-chassis-viewport]')!;
                const bounds = viewer.getBoundingClientRect();
                return {
                    clip: element.getBoundingClientRect().toJSON(),
                    viewport: new DOMRect(bounds.left + viewer.clientLeft, bounds.top + viewer.clientTop, viewer.clientWidth, viewer.clientHeight).toJSON(),
                };
            });
            writeFileSync(join(evidence, `${label}-roi.json`), JSON.stringify({
                camera,
                ...capture,
            }));
            expect(capture.clip.left >= capture.viewport.left && capture.clip.top >= capture.viewport.top
                && capture.clip.right <= capture.viewport.right && capture.clip.bottom <= capture.viewport.bottom,
            `The whole text box is inside the document viewport: ${JSON.stringify(capture)}`).toBe(true);
            const actual = Buffer.from(await page.screenshot({clip: capture.clip}));
            writeFileSync(join(evidence, `${label}-box.png`), actual);
            await page.screenshot({path: join(evidence, `${label}-page.png`)});
            const client = await page.createCDPSession();
            await client.send('DOM.enable');
            await client.send('CSS.enable');
            const tree = await client.send('DOM.getDocument');
            const node = await client.send('DOM.querySelector', {
                nodeId: tree.root.nodeId,
                selector: '.editor-pane.is-active .pdf-annotation-editor-text-box',
            });
            const platform = await client.send('CSS.getPlatformFontsForNode', {nodeId: node.nodeId});
            const previewSelector = '.editor-pane.is-active .note-item .note-item-text';
            const preview = await page.waitForSelector(previewSelector);
            await preview!.screenshot({path: join(evidence, `${label}-preview.png`)});
            const previewNode = await client.send('DOM.querySelector', {
                nodeId: tree.root.nodeId,
                selector: `${previewSelector} span span`,
            });
            const previewFonts = await client.send('CSS.getPlatformFontsForNode', {nodeId: previewNode.nodeId});
            writeFileSync(join(evidence, `${label}-preview-fonts.json`), JSON.stringify(previewFonts, null, 2));
            const previewGlyphs = previewFonts.fonts.filter(font => font.glyphCount > 0);
            expect.soft(previewGlyphs.length, `${script} comment preview paints text`).toBeGreaterThan(0);
            // Previews use the UI font: bundled script faces only for the scripts that need them.
            expect.soft(previewGlyphs.some(font => font.isCustomFont && font.postScriptName === 'DejaVuSans'),
                `${script} comment preview keeps DejaVu Sans out of the UI font`).toBe(false);
            if (fontFile !== 'DejaVuSans.ttf') {
                expect.soft(previewGlyphs.some(font => font.isCustomFont && font.postScriptName === fontFile.replace('.ttf', '')),
                    `${script} comment preview uses the bundled script program`).toBe(true);
            }
            await client.detach();
            const paintedFonts = platform.fonts.filter(font => font.glyphCount > 0);
            expect.soft(paintedFonts.some(font => font.postScriptName === fontFile.replace('.ttf', ''))).toBe(true);
            expect.soft(paintedFonts.every(font => font.isCustomFont && programs.has(font.postScriptName)),
                `${script} actually paints every glyph with the shipped program its saved layout uses`).toBe(true);

            // A separate family chooses the complete reference program. Its
            // DejaVu strut matches the shared paragraph metrics on screen.
            await page.evaluate(async (file: string, content: string) => {
                const base = new FontFace('Semtext Reference', 'url("/fonts/annotation/DejaVuSans.ttf")');
                document.fonts.add(await base.load());
                const unicodeRange = Array.from(new Set(Array.from(content).filter(character => !/\p{Script=Common}/u.test(character)).map(character => (
                    `U+${character.codePointAt(0)!.toString(16)}`
                )))).join(',');
                const font = new FontFace('Semtext Reference', `url("/fonts/annotation/${file}")`, {unicodeRange});
                document.fonts.add(await font.load());
                await document.fonts.ready;
                await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
            }, fontFile, text);

            // Compare both families in one Chromium canvas so viewport LCD
            // compositing cannot change the oracle's antialiasing. Font identity
            // above and the captured box pixels establish the real screen paint.
            const comparison = await box!.evaluate((element, content) => {
                const style = getComputedStyle(element);
                const canvas = document.createElement('canvas');
                canvas.width = 512;
                canvas.height = 128;
                const context = canvas.getContext('2d')!;
                context.direction = style.direction === 'rtl' ? 'rtl' : 'ltr';
                context.textAlign = 'right';
                context.textBaseline = 'alphabetic';
                context.fillStyle = style.color;
                function paint(family: string) {
                    context.clearRect(0, 0, canvas.width, canvas.height);
                    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${family}`;
                    context.fillText(content, 488, 80);
                    return {
                        png: canvas.toDataURL(),
                        pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
                    };
                }
                const actual = paint(style.fontFamily);
                const reference = paint('Semtext Reference');
                return {
                    matches: actual.pixels.every((value, index) => value === reference.pixels[index]),
                    actual: actual.png,
                    reference: reference.png,
                };
            }, text);
            const image = await loadImage(actual);
            const canvas = createCanvas(image.width, image.height);
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(0, 0, image.width, image.height).data;
            let ink = 0;
            for (let y = 2; y < image.height - 2; y += 1) {
                for (let x = 2; x < image.width - 2; x += 1) {
                    const offset = (y * image.width + x) * 4;
                    if (Math.max(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!) < 150) ink += 1;
                }
            }
            expect.soft(ink, 'The actual text box paints text pixels').toBeGreaterThan(0);
            for (const [
                name,
                png,
            ] of [
                    [
                        'canvas',
                        comparison.actual,
                    ],
                    [
                        'reference',
                        comparison.reference,
                    ],
                ]) {
                writeFileSync(join(evidence, `${label}-${name}.png`), Buffer.from(png!.split(',')[1]!, 'base64'));
            }
            writeFileSync(join(evidence, `${label}-pixels.json`), JSON.stringify({
                script,
                text,
                ink,
                fonts: paintedFonts,
                matches: comparison.matches,
            }));
            expect.soft(comparison.matches, `${script} glyphs and marks match the independent bundled-font pixels`).toBe(true);

        }

        await paintedTextMatchesBundledProgram('before-save');
        const typedSize = await editorFontSize();
        let saveError: string | null = null;
        try {
            await saveViaVisibleToolbar(page, 12_000, saved);
        } catch (error) {
            saveError = String(error);
        }
        expect.soft(saveError, 'The typed annotation can be saved').toBeNull();
        const pdf = await PDFDocument.load(readFileSync(saved));
        const annotations = pdf.getPage(0).node.Annots()?.asArray() ?? [];
        const freeText = annotations.map(ref => pdf.context.lookup(ref, PDFDict)).find(object => (
            object.get(PDFName.of('Subtype'))?.toString() === '/FreeText'
        ));
        const contents = freeText?.get(PDFName.of('Contents'));
        const savedText = contents instanceof PDFString || contents instanceof PDFHexString ? contents.decodeText() : null;
        const hasAppearance = Boolean(freeText?.get(PDFName.of('AP')));
        writeFileSync(join(evidence, 'save.json'), JSON.stringify({
            script,
            text,
            saveError,
            savedText,
            hasAppearance,
        }));
        expect.soft(hasAppearance).toBe(true);
        expect.soft(savedText).toBe(text);
        // The saved page draws the text at the size the editor showed and reopens with.
        const normal = pdf.context.lookup(freeText!.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')) as PDFRef) as PDFRawStream;
        const appearanceContent = Buffer.from(decodePDFRawStream(normal).decode()).toString('latin1');
        const drawnSizes = new Set(Array.from(appearanceContent
            .matchAll(/\/TextFont\d+ ([\d.]+) Tf/gu), match => Number(match[1])));
        const recordedSize = Number(/([\d.]+) Tf/u.exec(freeText!.lookup(PDFName.of('DA'), PDFString).decodeText())?.[1]);
        expect.soft([...drawnSizes], `${script} appearance draws at the size its DA records`).toEqual([recordedSize]);
        // Where the saved fonts need more room than the screen did, the size
        // shrinks only to fit, and the DA records it for the reopened editor.
        expect.soft(recordedSize, `${script} never saves a larger size than typed`).toBeLessThanOrEqual(typedSize + 0.01);
        if (keepsTypedSize) {
            expect.soft(recordedSize, `${script} saves the size the editor showed`).toBeCloseTo(typedSize, 2);
        }
        const clipped = await renderedTextBoxInk(readFileSync(saved), false);
        const unclipped = await renderedTextBoxInk(readFileSync(saved), true);
        writeFileSync(join(evidence, 'saved-ink.json'), JSON.stringify({
            clipped,
            unclipped,
        }));
        expect.soft(clipped.inside, `${script} saved page paints text in PDF.js`).toBeGreaterThan(0);
        // The clip is the box itself, so it can hide only ink placed outside the box.
        expect.soft(unclipped.outside, `${script} saved layout keeps every glyph inside its box`).toBe(0);
        // EVB's print output draws the saved appearance as saved.
        const printed = join(evidence, 'printed.pdf');
        execFileSync(resolveNativePageOpsPath()!, [
            'print-layout',
            '--input',
            saved,
            '--output',
            printed,
            '--view-mode',
            'single',
            '--orientation',
            'portrait',
        ]);
        const printedPdf = await PDFDocument.load(readFileSync(printed));
        const printedStreams = printedPdf.context.enumerateIndirectObjects().flatMap(([
            , object,
        ]) => (
            object instanceof PDFRawStream ? [Buffer.from(decodePDFRawStream(object).decode()).toString('latin1')] : []
        ));
        expect.soft(printedStreams, `${script} prints the saved appearance unchanged`).toContain(appearanceContent);
        const restarted = await sessionFixture.restart({
            sessionName: () => `e2e-semtext-reopen-${Date.now()}`,
            hard: true,
            clean: true,
        });
        page = restarted.page;
        await openPdfInApp(page, saved);
        await waitForViewerInteractive(page);
        await page.screenshot({path: join(evidence, 'reopened-page.png')});
        await page.waitForFunction((expected: string) => Array.from(document.querySelectorAll(
            '.editor-pane.is-active .pdf-annotation-editor-text-box',
        )).some(element => element.textContent === expected), {timeout: 30_000}, text);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);
        await paintedTextMatchesBundledProgram('reopened');
        expect.soft(await editorFontSize(), `${script} reopens at its saved size`).toBeCloseTo(recordedSize, 2);
    });

    it.each([
        // A 25 x 45 pt FreeText "W" at 22 pt from another program: its glyph
        // reaches past the box, so the saved size must fit it.
        [
            'compact',
            'compact.pdf',
        ],
        // review-b7f: 13.33 pt labels in 150 x 20 pt boxes. Their vowel points
        // reach below the nominal line, and the saved size must keep them.
        [
            'short Arabic',
            'short-arabic.pdf',
        ],
        [
            'short Syriac',
            'short-syriac.pdf',
        ],
        [
            'short Hebrew',
            'short-hebrew.pdf',
        ],
        // A bordered label keeps its producer's border and background: PyMuPDF
        // writes /BS and /C; a hand-written Acrobat-style label /Border, /RD,
        // /C and a stroking colour in its DA.
        [
            'bordered PyMuPDF',
            'bordered-pymupdf.pdf',
        ],
        [
            'bordered hand-written',
            'bordered-handwritten.pdf',
        ],
        // Boxes EVB wrote turned by 90 and 180 degrees, to which another program
        // later gave a border, a fill and /RD: the frame turns with the text.
        [
            'turned 90 degrees and bordered',
            'turned-90-bordered.pdf',
        ],
        [
            'turned 180 degrees and bordered',
            'turned-180-bordered.pdf',
        ],
    ])('keeps a %s foreign label whole when only its color changes', async (_label, fixture) => {
        const evidence = mkdtempSync(join(tmpdir(), 'evb-foreign-label-'));
        onTestFinished(() => rmSync(evidence, {
            force: true,
            recursive: true,
        }));
        const saved = join(evidence, 'saved.pdf');
        copyFileSync(resolve('tests/fixtures/electron/semtext', fixture), saved);
        const {page} = sessionFixture.getSession();
        await openPdfInApp(page, saved);
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);
        await clickAnnotationTool(page, 'Select');
        await clickVisibleAnnotationControl(page, '.editor-pane.is-active .pdf-annotation-editor-text-box');
        const source = await PDFDocument.load(readFileSync(saved));
        const sourceText = source.context.lookup(source.getPage(0).node.Annots()!.get(0), PDFDict);
        const borderEntries = (dict: PDFDict) => [
            'BS',
            'Border',
            'C',
            'RD',
        ].map(key => dict.get(PDFName.of(key))?.toString() ?? null);
        const rect = sourceText.lookup(PDFName.of('Rect'), PDFArray).asArray().map(value => (value as PDFNumber).asNumber());
        const borderWidth = (/\/W (\d+(?:\.\d+)?)/u.exec(sourceText.get(PDFName.of('BS'))?.toString() ?? '')
            ?? /^\[\s*\d+\s+\d+\s+(\d+(?:\.\d+)?)/u.exec(sourceText.get(PDFName.of('Border'))?.toString() ?? ''))?.[1];
        // On screen the border has the width its producer gave it, relative to the box.
        const screenBorder = await page.$eval('.editor-pane.is-active .pdf-annotation-editor-text-box', box => {
            const frame = box.querySelector<HTMLElement>('.pdf-annotation-editor-text-box__frame');
            // The frame strokes its border as an inset shadow: "<colour> 0px 0px 0px <width> inset".
            const spread = frame ? /([\d.]+)px inset$/u.exec(getComputedStyle(frame).boxShadow)?.[1] : undefined;
            return Number(spread ?? 0) / box.getBoundingClientRect().width;
        });
        expect.soft(screenBorder, 'the editor draws the label\'s border').toBeCloseTo(Number(borderWidth ?? 0) / (rect[2]! - rect[0]!), 3);
        await clickVisibleAnnotationControl(page, '.editor-pane.is-active .annotation-style-editor .swatch[aria-label="#f59e0b"]');
        await saveViaVisibleToolbar(page, 12_000, saved);
        const pdf = await PDFDocument.load(readFileSync(saved));
        const freeText = pdf.context.lookup(pdf.getPage(0).node.Annots()!.get(0), PDFDict);
        expect.soft(borderEntries(freeText), 'the saved label keeps its border entries').toEqual(borderEntries(sourceText));
        if (Number(borderWidth ?? 0) > 0) {
            expect.soft(freeText.lookup(PDFName.of('DA'), PDFString).decodeText(), 'the border keeps its colour').toMatch(/ RG$/u);
        }
        const normal = pdf.context.lookup(freeText.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')) as PDFRef) as PDFRawStream;
        const appearance = Buffer.from(decodePDFRawStream(normal).decode()).toString('latin1');
        if (Number(borderWidth ?? 0) > 0) {
            // Its frame keeps PDF's mitred corners, turned or not.
            expect.soft(appearance, 'the saved label draws its frame').toContain(`${borderWidth} w 1 J 0 j`);
        }
        const drawnSizes = new Set(Array.from(appearance
            .matchAll(/\/TextFont\d+ ([\d.]+) Tf/gu), match => Number(match[1])));
        const recordedSize = Number(/([\d.]+) Tf/u.exec(freeText.lookup(PDFName.of('DA'), PDFString).decodeText())?.[1]);
        expect.soft([...drawnSizes], 'the label draws at the size its DA records').toEqual([recordedSize]);
        expect.soft((await renderedTextBoxInk(readFileSync(saved), true)).outside, 'the saved label keeps its whole glyph').toBe(0);
    });

    it('keeps a foreign label unfilled where its own appearance paints no fill', async () => {
        // verify13w / review-b8f: /C [0 0 0] beside an appearance that strokes a
        // 2 pt black border and paints no fill. The label shows white, and
        // after a text and colour edit its saved file gains no fill.
        const evidence = mkdtempSync(join(tmpdir(), 'evb-unfilled-label-'));
        onTestFinished(() => rmSync(evidence, {
            force: true,
            recursive: true,
        }));
        const saved = join(evidence, 'saved.pdf');
        copyFileSync(resolve('tests/fixtures/electron/semtext/unfilled-black-c.pdf'), saved);
        const box = '.editor-pane.is-active .pdf-annotation-editor-text-box';
        const frameFill = (page: Page) => page.$eval(box, element => getComputedStyle(element.querySelector('.pdf-annotation-editor-text-box__frame')!).backgroundColor);
        const openLabel = async (page: Page) => {
            await openPdfInApp(page, saved);
            await waitForViewerInteractive(page);
            await openAnnotationsTab(page);
            await clickAnnotationTool(page, 'Select');
            await clickVisibleAnnotationControl(page, box);
        };
        const {page} = sessionFixture.getSession();
        await openLabel(page);
        expect.soft(await frameFill(page), 'the label shows no fill its appearance never painted').toBe('rgba(0, 0, 0, 0)');
        await clickAsUser(page, box, {count: 2});
        await page.waitForSelector('.editor-pane.is-active .pdf-annotation-editor-text-box.is-editing [contenteditable="true"]');
        await selectAllFocusedAnnotationText(page);
        await page.keyboard.type('Edited label', {delay: 4});
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.down(modifier);
        try {
            await page.keyboard.press('Enter');
        } finally {
            await page.keyboard.up(modifier);
        }
        await clickVisibleAnnotationControl(page, '.editor-pane.is-active .annotation-style-editor .swatch[aria-label="#f59e0b"]');
        await saveViaVisibleToolbar(page, 12_000, saved);
        const pdf = await PDFDocument.load(readFileSync(saved));
        const label = pdf.context.lookup(pdf.getPage(0).node.Annots()!.get(0), PDFDict);
        const normal = pdf.context.lookup(label.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')) as PDFRef) as PDFRawStream;
        const appearance = Buffer.from(decodePDFRawStream(normal).decode()).toString('latin1');
        expect.soft(label.lookup(PDFName.of('Contents'), PDFString, PDFHexString).decodeText(), 'the edit is saved').toBe('Edited label');
        expect.soft(appearance, 'the saved label draws its border and no fill').toMatch(/ 2 w 1 J 0 j\n/u);
        expect.soft(appearance, 'the saved label draws its border and no fill').not.toMatch(/ re f\b/u);
        const restarted = await sessionFixture.restart({hard: true});
        await openLabel(restarted.page);
        expect.soft(await frameFill(restarted.page), 'the reopened label is still unfilled').toBe('rgba(0, 0, 0, 0)');
    });

    it('turns a foreign label\'s frame with its box through Save and reopen', async () => {
        // review-b7s: /RD [1 2 7 12] gives a 300 x 40 pt label a different inset
        // on every side. A box turned clockwise by a quarter faces the next side.
        const evidence = mkdtempSync(join(tmpdir(), 'evb-turned-frame-'));
        onTestFinished(() => rmSync(evidence, {
            force: true,
            recursive: true,
        }));
        const saved = join(evidence, 'saved.pdf');
        copyFileSync(resolve('tests/fixtures/electron/semtext/asymmetric-frame.pdf'), saved);
        const box = '.editor-pane.is-active .pdf-annotation-editor-text-box';
        const frameInsets = (page: Page) => page.$eval(box, (element) => {
            const frame = getComputedStyle(element.querySelector<HTMLElement>('.pdf-annotation-editor-text-box__frame')!);
            // The box lays out at the label's unturned 300 pt width.
            const points = 300 / (element as HTMLElement).offsetWidth;
            return [
                frame.top,
                frame.right,
                frame.bottom,
                frame.left,
            ].map(inset => Math.round(Number.parseFloat(inset) * points * 10) / 10);
        });
        const openLabel = async (page: Page) => {
            await openPdfInApp(page, saved);
            await waitForViewerInteractive(page);
            await openAnnotationsTab(page);
            await clickAnnotationTool(page, 'Select');
            await clickVisibleAnnotationControl(page, box);
        };
        const {page} = sessionFixture.getSession();
        await openLabel(page);
        expect(await frameInsets(page), 'the upright label').toEqual([
            12,
            7,
            2,
            1,
        ]);
        await clickVisibleAnnotationControl(page, '.editor-pane.is-active [data-annotation-rotate="cw"]');
        await page.waitForFunction(() => document.querySelector('.editor-pane.is-active [data-annotation-rotation-value]')?.textContent?.includes('90'));
        const turned = await frameInsets(page);
        expect(turned, 'the turned box faces the page\'s next sides').toEqual([
            7,
            2,
            1,
            12,
        ]);
        await saveViaVisibleToolbar(page, 12_000, saved);
        const restarted = await sessionFixture.restart({hard: true});
        await openLabel(restarted.page);
        expect(await frameInsets(restarted.page), 'the reopened label keeps the frame it had before Save').toEqual(turned);
    });

    it.each([
        'dashed',
        'beveled',
        'inset',
        'underlined',
        'cloudy',
    ])('lets a person select and copy a %s label it cannot edit', async (style) => {
        // review-b7s: a label whose border the editor cannot draw keeps its
        // producer's appearance. It is selectable, says why it is read-only,
        // copies its text, and no move or delete reaches it.
        const evidence = mkdtempSync(join(tmpdir(), 'evb-read-only-label-'));
        onTestFinished(() => rmSync(evidence, {
            force: true,
            recursive: true,
        }));
        const pdfPath = join(evidence, `${style}.pdf`);
        copyFileSync(resolve('tests/fixtures/electron/semtext', `${style}.pdf`), pdfPath);
        const notice = 'This label\'s border style can\'t be edited here; it keeps its original look.';
        const box = '.editor-pane.is-active .pdf-annotation-editor-text-box';
        const {page} = sessionFixture.getSession();
        await openPdfInApp(page, pdfPath);
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);
        await clickAnnotationTool(page, 'Select');
        await clickVisibleAnnotationControl(page, box);
        // Where the label sits on its page: a scroll moves the page, not the label.
        const placement = () => page.$eval(box, (element) => {
            const label = element.getBoundingClientRect();
            const sheet = element.closest('.pdf-annotation-editor-layer')!.getBoundingClientRect();
            return [
                label.left - sheet.left,
                label.top - sheet.top,
                label.width,
                label.height,
            ];
        });
        const before = await placement();
        // pdf.js draws the label: its text and border are on the page under the box.
        const ink = async () => {
            const clip = await page.$eval(box, element => element.getBoundingClientRect().toJSON());
            const image = await loadImage(Buffer.from(await page.screenshot({clip})));
            const canvas = createCanvas(image.width, image.height);
            canvas.getContext('2d').drawImage(image, 0, 0);
            const pixels = canvas.getContext('2d').getImageData(0, 0, image.width, image.height).data;
            return Array.from({length: pixels.length / 4}, (_, index) => pixels[index * 4]! < 128).filter(Boolean).length;
        };
        await expect.poll(ink, {message: 'the label stays drawn on the page'}).toBeGreaterThan(50);
        const chrome = await page.evaluate(() => ({
            notices: Array.from(document.querySelectorAll<HTMLElement>('.editor-pane.is-active [data-pdf-annotation-read-only-notice], .editor-pane.is-active [data-annotation-read-only-notice]'))
                .filter(element => element.checkVisibility()).map(element => element.textContent?.trim()),
            grips: document.querySelectorAll('.editor-pane.is-active [data-pdf-annotation-move-handle], .editor-pane.is-active [data-pdf-annotation-resize-handle]').length,
            swatches: document.querySelectorAll('.editor-pane.is-active .annotation-style-editor .swatch').length,
            deletes: document.querySelectorAll('.editor-pane.is-active .note-item-delete').length,
        }));
        expect.soft(chrome, 'the label explains itself and offers no edit').toEqual({
            notices: [
                notice,
                notice,
            ],
            grips: 0,
            swatches: 0,
            deletes: 0,
        });
        // A drag and the Delete key leave it where and as it was.
        const grab = await page.$eval(box, element => element.getBoundingClientRect().toJSON());
        await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
        await page.mouse.down();
        await page.mouse.move(grab.x + grab.width / 2 + 60, grab.y + grab.height / 2 + 40, {steps: 8});
        await page.mouse.up();
        await page.keyboard.press('Delete');
        expect.soft(await placement(), 'the label does not move').toEqual(before);
        // Its context menu copies the text and offers no Delete.
        const target = await page.$eval(box, element => element.getBoundingClientRect().toJSON());
        await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2, {button: 'right'});
        await page.waitForSelector('.annotation-context-menu [data-annotation-read-only-notice]', {visible: true});
        const menu = await page.$$eval('.annotation-context-menu .pdf-context-menu__action', buttons => buttons
            .map(button => button.textContent?.trim()));
        expect.soft(menu.some(label => label?.startsWith('Delete')), 'no Delete in the menu').toBe(false);
        await clickAsUser(page, {
            find: (label: unknown) => Array.from(document.querySelectorAll('.annotation-context-menu .pdf-context-menu__action'))
                .find(button => button.textContent?.trim() === label),
            arg: 'Copy Text to Clipboard',
            description: 'the label\'s Copy Text action',
        });
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`Foreign ${style} label`);
        expect.soft(readFileSync(pdfPath).equals(readFileSync(resolve('tests/fixtures/electron/semtext', `${style}.pdf`))), 'the file is untouched').toBe(true);
    });

    it('drags only the editable member of a selection with a read-only label', async () => {
        // review-b8f: a read-only label in the selection neither moves nor
        // stops the editable box short of the page edge it never reaches.
        const evidence = mkdtempSync(join(tmpdir(), 'evb-mixed-drag-'));
        onTestFinished(() => rmSync(evidence, {
            force: true,
            recursive: true,
        }));
        const pdfPath = join(evidence, 'dashed.pdf');
        copyFileSync(resolve('tests/fixtures/electron/semtext/dashed.pdf'), pdfPath);
        const box = '.editor-pane.is-active .pdf-annotation-editor-text-box';
        const {page} = sessionFixture.getSession();
        await openPdfInApp(page, pdfPath);
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);
        const label = `${box}[data-annotation-id="${await page.$eval(box, element => (element as HTMLElement).dataset.annotationId)}"]`;
        const editable = `${box}[data-annotation-id="${await createCanonicalTextBoxWithPointer(page, 'Editable beside a label', {
            x: 0.3,
            y: 0.35,
        })}"]`;
        await clickAnnotationTool(page, 'Select');
        await clickVisibleAnnotationControl(page, editable);
        await page.keyboard.down('Shift');
        await clickVisibleAnnotationControl(page, label);
        await page.keyboard.up('Shift');
        expect(await page.$$(`${box}.is-selected`)).toHaveLength(2);
        const rectOf = (selector: string) => page.$eval(selector, element => element.getBoundingClientRect().toJSON());
        const [
            labelBefore,
            before,
        ] = [
            await rectOf(label),
            await rectOf(editable),
        ];
        await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
        await page.mouse.down();
        await page.mouse.move(before.x + before.width / 2 - 140, before.y + before.height / 2, {steps: 8});
        expect.soft(await rectOf(label), 'the label\'s selection stays over it during the drag').toEqual(labelBefore);
        await page.mouse.up();
        expect.soft((await rectOf(editable)).x - before.x, 'the editable box goes as far as asked').toBeCloseTo(-140, 0);
        expect.soft(await rectOf(label), 'the label stays where it is').toEqual(labelBefore);
    });

    it('opens a foreign label with a malformed DA at the size it draws', async () => {
        // Its DA ends in "/Helv invalid Tf"; its appearance draws at 22 pt.
        const {page} = sessionFixture.getSession();
        await openPdfInApp(page, resolve('tests/fixtures/electron/semtext/malformed.pdf'));
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);
        await clickAnnotationTool(page, 'Select');
        await clickVisibleAnnotationControl(page, '.editor-pane.is-active .pdf-annotation-editor-text-box');
        const size = await page.$eval('.editor-pane.is-active .annotation-style-editor input[aria-label="Text Size"]', element => (
            Number((element as HTMLInputElement).value)
        ));
        expect(size, 'the size control shows the size the label draws').toBe(22);
    });

    it('retains a visible typing box and places the caret through delayed pointer input', async () => {
        const session = sessionFixture.getSession();
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
