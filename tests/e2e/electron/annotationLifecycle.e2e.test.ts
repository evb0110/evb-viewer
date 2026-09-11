import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {
    copyFileSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {
    dirname,
    join,
} from 'node:path';
import { tmpdir } from 'node:os';
import { delay } from 'es-toolkit/promise';
import type { Page } from 'puppeteer-core';
import {
    asAnnotationId,
    toLegacyShapeStableKey,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    requireDocumentRef,
    type TLegacyDocumentRef,
} from '@contracts/documentRef';
import {
    requireLeaseId,
    type TLeaseId,
} from '@contracts/shared';
import {
    copyProjectFixture,
    createCanonicalAnnotationSurfaceFixturePdf,
    createForeignNoteReplyFixturePdf,
    createLinkOnlyFixturePdf,
    createMultiPageTextFixturePdf,
    readPdfTextAnnotationRecords,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickAnnotationTool,
    clickLatestVisibleNoteWindowClose,
    collectAnnotationOwnershipDebugState,
    createCanonicalTextBoxWithPointer,
    createTextMarkupWithPointer,
    clickVisibleAnnotationControl,
    selectAllFocusedAnnotationText,
    setAnnotationKeepActiveWithPointer,
    createStickyNoteWithPointer,
    createFreeTextAnnotation,
    getFreeTextEditorCount,
    waitForNoOpenNoteWindows,
    waitForPdfAnnotationSubtypeCount,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openAnnotationsTab,
    openPdfInApp,
    saveViaVisibleToolbar,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import { waitForActiveWorkspaceHost } from '@tests/e2e/electron/helpers/viewerDom';
import {
    callWorkspaceCommand,
    installWorkspaceExposeProbe,
    readWorkspaceStateValues,
    type IWorkspaceExposeProbeWindow,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const POINTER_STYLE_CASES = [
    {
        tool: 'Draw',
        preset: 'Pen',
        subtype: 'Ink',
    },
    {
        tool: 'Draw',
        preset: 'Pencil',
        subtype: 'Ink',
    },
    {
        tool: 'Draw',
        preset: 'Marker',
        subtype: 'Ink',
    },
    {
        tool: 'Rectangle',
        subtype: 'Square',
    },
    {
        tool: 'Circle',
        subtype: 'Circle',
    },
    {
        tool: 'Line',
        subtype: 'Line',
    },
    {
        tool: 'Arrow',
        subtype: 'Line',
    },
    {
        tool: 'Highlight',
        subtype: 'Highlight',
    },
    {
        tool: 'Underline',
        subtype: 'Underline',
    },
    {
        tool: 'Strikethrough',
        subtype: 'StrikeOut',
    },
    {
        tool: 'Squiggly',
        subtype: 'Squiggly',
    },
] as const;

function isMarkupTool(tool: string): tool is 'Highlight' | 'Underline' | 'Strikethrough' | 'Squiggly' {
    return [
        'Highlight',
        'Underline',
        'Strikethrough',
        'Squiggly',
    ].includes(tool);
}

async function readPaintedAnnotation(page: Page) {
    return page.evaluate(() => {
        const entity = document.querySelector<SVGElement>('.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="shape"], .editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-markup"]');
        const visual = entity?.querySelector<SVGElement>('[data-annotation-visual]');
        const pageRect = entity?.closest('.page_container')?.getBoundingClientRect();
        const card = entity ? document.querySelector<HTMLElement>(`.editor-pane.is-active .note-item[data-annotation-id="${entity.dataset.annotationId}"]`) : null;
        const chip = card?.querySelector<HTMLElement>('.note-item-color-chip');
        if (!entity || !visual || !pageRect || !chip) {
            return null;
        }
        const style = getComputedStyle(visual);
        const rect = entity.getBoundingClientRect();
        return {
            id: entity.dataset.annotationId,
            kind: entity.dataset.annotationKind,
            subtype: entity.dataset.markupSubtype ?? null,
            color: entity.dataset.markupSubtype === 'Highlight' ? style.fill : style.stroke,
            opacity: Number(style.opacity),
            cardColor: getComputedStyle(chip).backgroundColor,
            chipWidth: chip.getBoundingClientRect().width,
            left: (rect.left - pageRect.left) / pageRect.width,
            top: (rect.top - pageRect.top) / pageRect.height,
            width: rect.width / pageRect.width,
            height: rect.height / pageRect.height,
        };
    });
}

// The stale repaint lands when the forced page render finishes, so a single
// sample would miss it. Sample the page canvas across animation frames and
// report the largest highlight pixel count seen.
async function maxPageCanvasHighlightPixelsAcrossFrames(page: Page, rect: {
    left: number;
    top: number;
    width: number;
    height: number;
}, pageNumber = 1) {
    return page.evaluate(async (input: {
        left: number;
        top: number;
        width: number;
        height: number;
        pageNumber: number;
    }) => {
        const count = () => {
            const canvas = document.querySelector<HTMLCanvasElement>(
                `.editor-pane.is-active .page_container[data-page="${input.pageNumber}"] .page_canvas canvas`,
            );
            if (!canvas || canvas.width <= 0 || canvas.height <= 0) throw new Error('Page canvas is not painted');
            const context = canvas.getContext('2d', {willReadFrequently: true});
            if (!context) throw new Error('Page canvas has no 2d context');
            const x = Math.max(0, Math.floor(input.left * canvas.width));
            const y = Math.max(0, Math.floor(input.top * canvas.height));
            const width = Math.max(1, Math.ceil(input.width * canvas.width));
            const height = Math.max(1, Math.ceil(input.height * canvas.height));
            const pixels = context.getImageData(x, y, width, height).data;
            let highlighted = 0;
            for (let index = 0; index < pixels.length; index += 4) {
                const r = pixels[index]!;
                const g = pixels[index + 1]!;
                const b = pixels[index + 2]!;
                if (r > 175 && g > 95 && r - b > 45 && g - b > 20) highlighted += 1;
            }
            return highlighted;
        };
        let max = count();
        for (let frame = 0; frame < 90; frame += 1) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            max = Math.max(max, count());
        }
        return max;
    }, {
        ...rect,
        pageNumber,
    });
}

async function annotationPointerTarget(page: Page, selector = '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="shape"], .editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-markup"]') {
    return page.evaluate((entitySelector: string) => {
        const entity = document.querySelector<HTMLElement | SVGElement>(entitySelector);
        const rect = entity?.getBoundingClientRect();
        if (!entity || !rect) throw new Error('No authored annotation to select');
        // Hollow circles/rectangles and diagonal lines have different hit areas.
        // Sample the actual visible entity; never call its handlers directly.
        for (const [
            rx,
            ry,
        ] of [
                [
                    0.5,
                    0.5,
                ],
                [
                    0.5,
                    0,
                ],
                [
                    0,
                    0.5,
                ],
                [
                    1,
                    0.5,
                ],
                [
                    0.5,
                    1,
                ],
                [
                    0.25,
                    0.25,
                ],
                [
                    0.75,
                    0.75,
                ],
            ]) {
            const x = rect.left + rect.width * rx!;
            const y = rect.top + rect.height * ry!;
            const hit = document.elementFromPoint(x, y);
            if (hit && entity.contains(hit)) {
                return {
                    x,
                    y,
                };
            }
        }
        throw new Error(`Authored ${entity.dataset.annotationKind} has no reachable pointer target`);
    }, selector);
}

const NOTE_TEXT_ENTRY_TIMEOUT_MS = 20_000;
const COMMAND_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';
const ACTIVE_IMAGE_PLACEMENT_SELECTOR = '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .pdf-image-placement';
const CANONICAL_STAMP_SELECTOR = '.editor-pane.is-active .page_container[data-page="1"] .pdf-annotation-editor-stamp';
const PLACED_IMAGE_JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAoAEADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAcI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Al7UCSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//Z',
    'base64',
);

interface IStampVisualSnapshot {
    annotationId: string | null;
    height: number;
    imageSource: string | null;
    left: number;
    rotationDegrees: number;
    top: number;
    width: number;
}

async function installManagedJpegClipboard(page: Page, imagePath: string) {
    const documentPath = requireDocumentRef(imagePath);
    return page.evaluate(async (input: {imagePath: string;}) => {
        const files = window.electronAPI?.documentFiles;
        if (!files?.createManagedTempFileHandle) {
            throw new Error('Managed image handles are unavailable');
        }
        const NativeFile = window.File;
        const originalFileDescriptor = Object.getOwnPropertyDescriptor(window, 'File');
        const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
        Object.defineProperty(window, '__evbRestoreManagedClipboard', {
            configurable: true,
            value: () => {
                if (originalFileDescriptor) {
                    Object.defineProperty(window, 'File', originalFileDescriptor);
                }
                else {
                    Reflect.deleteProperty(window, 'File');
                }
                if (originalClipboardDescriptor) {
                    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
                }
                else {
                    Reflect.deleteProperty(navigator, 'clipboard');
                }
            },
        });
        const handle = await files.createManagedTempFileHandle(input.imagePath as TLegacyDocumentRef);
        const ManagedFile = new Proxy(NativeFile, {construct(target, args) {
            return Object.assign(Reflect.construct(target, args), {nativeSourceHandle: handle});
        }});
        Object.defineProperty(window, 'File', {
            configurable: true,
            value: ManagedFile,
        });
        const bytes = await files.readFile(input.imagePath as TLegacyDocumentRef);
        const blob = new Blob([bytes as BlobPart], {type: 'image/jpeg'});
        const probeFile = new ManagedFile([blob], 'clipboard-probe.jpg', {type: 'image/jpeg'});
        const bitmap = await createImageBitmap(probeFile);
        const dimensions = {
            height: bitmap.height,
            width: bitmap.width,
        };
        bitmap.close();
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {read: async () => [{
                types: ['image/jpeg'],
                getType: async () => blob,
            }]},
        });
        return {
            dimensions,
            hasNativeSourceHandle: 'nativeSourceHandle' in probeFile,
            leaseId: handle.leaseId,
        };
    }, {imagePath: documentPath});
}

async function uninstallManagedJpegClipboard(page: Page) {
    await page.evaluate(() => {
        const windowWithRestore = window as Window & {__evbRestoreManagedClipboard?: () => void;};
        windowWithRestore.__evbRestoreManagedClipboard?.();
        delete windowWithRestore.__evbRestoreManagedClipboard;
    });
}

async function dragImagePlacementControl(
    page: Page,
    selector: string,
    deltaX: number,
    deltaY: number,
    holdShift = false,
) {
    await page.$eval(selector, element => {
        element.scrollIntoView({
            block: 'center',
            inline: 'center',
        });
    });
    const center = await page.$eval(selector, element => {
        const rect = element.getBoundingClientRect();
        const frame = element.closest<HTMLElement>('.pdf-image-placement');
        const container = frame?.parentElement?.getBoundingClientRect();
        if (!container) throw new Error('Image placement container is missing');
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            containerWidth: container.width,
            containerHeight: container.height,
        };
    });
    if (holdShift) {
        await page.keyboard.down('Shift');
    }
    try {
        await page.mouse.move(center.x, center.y);
        await page.mouse.down();
        await page.mouse.move(center.x + deltaX, center.y + deltaY, {steps: 8});
        await page.mouse.up();
    } finally {
        if (holdShift) {
            await page.keyboard.up('Shift');
        }
    }
    return center;
}

async function rotateImagePlacementByQuarterTurn(page: Page) {
    const points = await page.$eval(ACTIVE_IMAGE_PLACEMENT_SELECTOR, element => {
        const frameRect = element.getBoundingClientRect();
        const center = {
            x: frameRect.left + frameRect.width / 2,
            y: frameRect.top + frameRect.height / 2,
        };
        const handle = element.querySelector<HTMLElement>('.pdf-image-placement__rotate-handle');
        if (!handle) {
            throw new Error('Image placement rotate handle is unavailable');
        }
        const handleRect = handle.getBoundingClientRect();
        const start = {
            x: handleRect.left + handleRect.width / 2,
            y: handleRect.top + handleRect.height / 2,
        };
        const offset = {
            x: start.x - center.x,
            y: start.y - center.y,
        };
        return {
            start,
            target: {
                x: center.x - offset.y,
                y: center.y + offset.x,
            },
        };
    });
    await page.keyboard.down('Shift');
    try {
        await page.mouse.move(points.start.x, points.start.y);
        await page.mouse.down();
        await page.mouse.move(points.target.x, points.target.y, {steps: 8});
        await page.mouse.up();
    } finally {
        await page.keyboard.up('Shift');
    }
}

async function readPendingImagePlacementSnapshot(page: Page) {
    return page.$eval(ACTIVE_IMAGE_PLACEMENT_SELECTOR, element => {
        const frame = element as HTMLElement;
        const transform = frame.querySelector<HTMLElement>('.pdf-image-placement__transform');
        const rotation = getComputedStyle(transform ?? frame)
            .getPropertyValue('--pdf-image-placement-rotation')
            .trim();
        return {
            height: Number.parseFloat(frame.style.height) / 100,
            left: Number.parseFloat(frame.style.left) / 100,
            rotationDegrees: Number.parseFloat(rotation.replace(/deg$/u, '')) || 0,
            top: Number.parseFloat(frame.style.top) / 100,
            width: Number.parseFloat(frame.style.width) / 100,
        };
    });
}

async function readCanonicalStampSnapshot(page: Page): Promise<IStampVisualSnapshot> {
    return page.$eval(CANONICAL_STAMP_SELECTOR, element => {
        const stamp = element as HTMLElement;
        const image = stamp.querySelector<HTMLImageElement>('.pdf-annotation-editor-stamp__image');
        const rotation = /rotate\((-?[0-9.]+)deg\)/u.exec(stamp.style.transform)?.[1];
        return {
            annotationId: stamp.dataset.annotationId ?? null,
            height: Number.parseFloat(stamp.style.height) / 100,
            imageSource: image?.src ?? null,
            left: Number.parseFloat(stamp.style.left) / 100,
            rotationDegrees: rotation ? Number.parseFloat(rotation) : 0,
            top: Number.parseFloat(stamp.style.top) / 100,
            width: Number.parseFloat(stamp.style.width) / 100,
        };
    });
}

async function readCanonicalStampPixels(page: Page) {
    return page.$eval(CANONICAL_STAMP_SELECTOR, async element => {
        const image = element.querySelector<HTMLImageElement>('.pdf-annotation-editor-stamp__image');
        if (!image?.complete || image.naturalWidth === 0) throw new Error('Stamp image has not decoded');
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Cannot read decoded stamp pixels');
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(pixels));
        return {
            width: canvas.width,
            height: canvas.height,
            rgbaSha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
        };
    });
}

async function releaseManagedImageHandle(page: Page, leaseId: string) {
    const managedLeaseId = requireLeaseId(leaseId);
    await page.evaluate(async (id: TLeaseId) => {
        await window.electronAPI?.documentFiles.releaseManagedTempFileHandle?.(id);
    }, managedLeaseId);
}

async function waitForActiveTabDirtyState(page: Page, expectedDirty: boolean) {
    const startedAt = Date.now();
    const readDirtyState = async () => {
        const mountedWorkspace = await page.evaluate(() => {
            const pane = document.querySelector<HTMLElement>('.editor-pane.is-active');
            const host = pane?.querySelector<HTMLElement>('.workspace-host[data-workspace-active="true"]')
                ?? pane?.querySelector<HTMLElement>('.workspace-host');
            const debug = (window as Window & { __evbTestApi?: {collectWorkspaceDebugState?: () => {activeTabId?: string | null}}; }).__evbTestApi?.collectWorkspaceDebugState?.();
            return {
                activeTabId: debug?.activeTabId ?? null,
                hasMountedWorkspace: Boolean(host?.isConnected),
            };
        });
        if (!mountedWorkspace.hasMountedWorkspace || !mountedWorkspace.activeTabId) {
            throw new Error(`Active workspace is unavailable while reading dirty projection: ${JSON.stringify(mountedWorkspace)}`);
        }
        const workspaceDirty = await readWorkspaceStateValues<{dirtyState?: {
            fileDirty?: boolean;
            hasAnnotationChanges?: boolean;
            hasPendingUnsavedChanges?: boolean;
            pageLabelsDirty?: boolean;
        };}>(page, ['dirtyState']);
        const projection = workspaceDirty.dirtyState;
        const projectionKeys = [
            projection?.fileDirty,
            projection?.hasAnnotationChanges,
            projection?.hasPendingUnsavedChanges,
            projection?.pageLabelsDirty,
        ];
        if (!projection || projectionKeys.some(value => typeof value !== 'boolean')) {
            throw new Error(`Active workspace dirty projection is unavailable or invalid: ${JSON.stringify({
                activeTabId: mountedWorkspace.activeTabId,
                dirtyState: projection ?? null,
            })}`);
        }
        return projectionKeys.some(Boolean);
    };
    let actualDirty = await readDirtyState();
    while (Date.now() - startedAt < 10_000) {
        if (actualDirty === expectedDirty) {
            return;
        }
        await delay(100);
        actualDirty = await readDirtyState();
    }
    const debugState = await page.evaluate(() => {
        const api = (window as Window & { __evbTestApi?: { collectWorkspaceDebugState?: () => unknown; }; }).__evbTestApi;
        return {workspace: api?.collectWorkspaceDebugState?.() ?? null};
    });
    throw new Error(`Expected active workspace dirty projection=${expectedDirty}, got ${actualDirty}; debug=${JSON.stringify(debugState)}`);
}

function preserveFixtureAcrossRestart(path: string) {
    const directory = mkdtempSync(join(tmpdir(), 'evb-annotation-reopen-'));
    const target = join(directory, 'saved.pdf');
    copyFileSync(path, target);
    onTestFinished(() => rmSync(directory, {
        recursive: true,
        force: true,
    }));
    return target;
}

async function moveFocusedTextCaretToEnd(page: Page) {
    await page.waitForFunction(() => document.activeElement?.getAttribute('contenteditable') === 'true');
    if (process.platform === 'darwin') {
        const client = await page.createCDPSession();
        try {
            await client.send('Input.dispatchKeyEvent', {
                type: 'keyDown',
                key: 'End',
                commands: ['moveToEndOfDocument'],
            });
            await client.send('Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: 'End',
            });
        } finally {
            await client.detach();
        }
    } else {
        await page.keyboard.down('Control');
        await page.keyboard.press('End');
        await page.keyboard.up('Control');
    }
}

async function readAnnotationInteractionDiagnostic(page: Page) {
    await installWorkspaceExposeProbe(page);
    return page.evaluate(() => ({
        active: {
            tag: document.activeElement?.tagName,
            class: document.activeElement?.getAttribute('class'),
            annotationId: document.activeElement?.closest('[data-annotation-id]')?.getAttribute('data-annotation-id'),
        },
        selected: Array.from(document.querySelectorAll('.pdf-annotation-editor-layer .is-selected')).map(element => ({
            id: element.getAttribute('data-annotation-id'),
            kind: element.getAttribute('data-annotation-kind'),
        })),
        buttons: Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]')).filter(button => /Undo|Redo/.test(button.getAttribute('aria-label') ?? '')).map(button => ({
            label: button.getAttribute('aria-label'),
            disabled: button.disabled,
            ariaDisabled: button.getAttribute('aria-disabled'),
            bounds: button.getBoundingClientRect().toJSON(),
        })),
        workspace: (window as IWorkspaceExposeProbeWindow).__evbTestApi?.collectWorkspaceDebugState?.(),
    }));
}

async function clickEnabledToolbarAction(page: Page, label: string) {
    try {
        // Responsive layouts can mount hidden toolbar copies. Resolve the
        // enabled, visible button instead of waiting on the first DOM match.
        const target = await page.waitForFunction((name: string) => {
            const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'));
            for (const button of buttons) {
                if (button.getAttribute('aria-label') !== name || button.disabled || button.getAttribute('aria-disabled') === 'true') continue;
                const rect = button.getBoundingClientRect();
                const style = getComputedStyle(button);
                if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue;
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                const hit = document.elementFromPoint(x, y);
                if (hit && button.contains(hit)) {
                    return {
                        x,
                        y,
                    };
                }
            }
            return false;
        }, {timeout: 20_000}, label);
        const point = await target.jsonValue();
        await target.dispose();
        if (!point) throw new Error(`No visible enabled ${label} button`);
        await page.mouse.click(point.x, point.y);
    } catch (error) {
        throw new Error(`Visible ${label} failed: ${JSON.stringify(await readAnnotationInteractionDiagnostic(page))}`, {cause: error});
    }
}

async function clickFirstSidebarAnnotationDelete(page: Page) {
    await clickVisibleAnnotationControl(page, '.editor-pane.is-active .pdf-sidebar .note-item-delete');
}

async function expectCanonicalCountsAcrossFrames(page: Page, expected: {
    markup: number;
    notes: number;
    cards: number
}) {
    await page.waitForFunction((counts: {
        markup: number;
        notes: number;
        cards: number
    }) => {
        const host = document.querySelector('.editor-pane.is-active .workspace-host');
        return host?.querySelectorAll('.pdf-annotation-editor-layer [data-annotation-kind="text-markup"]').length === counts.markup
            && host.querySelectorAll('.pdf-annotation-editor-layer [data-annotation-kind="note"]').length === counts.notes
            && host.querySelectorAll('.note-item').length === counts.cards;
    }, {timeout: 20_000}, expected);
    const samples = await page.evaluate(async () => {
        const read = () => {
            const host = document.querySelector('.editor-pane.is-active .workspace-host');
            return {
                markup: host?.querySelectorAll('.pdf-annotation-editor-layer [data-annotation-kind="text-markup"]').length ?? -1,
                notes: host?.querySelectorAll('.pdf-annotation-editor-layer [data-annotation-kind="note"]').length ?? -1,
                cards: host?.querySelectorAll('.note-item').length ?? -1,
            };
        };
        const result = [read()];
        for (let frame = 0; frame < 8; frame += 1) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            result.push(read());
        }
        await new Promise<void>(resolve => setTimeout(resolve, 350));
        result.push(read());
        return result;
    });
    for (const sample of samples) expect(sample).toEqual(expected);
    const ownership = await collectAnnotationOwnershipDebugState(page);
    expect(ownership.canonicalEntities).toHaveLength(expected.markup + expected.notes);
    expect(ownership.legacyEditorLayerCount).toBe(0);
}

async function resolvePageNotePoint(page: Page) {
    return page.evaluate(() => {
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter((host) => {
                const rect = host.getBoundingClientRect();
                const style = window.getComputedStyle(host);
                return rect.width > 100 && rect.height > 100 && style.display !== 'none' && style.visibility !== 'hidden';
            });
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts[0] ?? null);
        const pageElement = host?.querySelector<HTMLElement>('.page_container--rendered')
            ?? host?.querySelector<HTMLElement>('.page_container')
            ?? null;
        if (!pageElement) {
            return null;
        }

        const rect = pageElement.getBoundingClientRect();
        const x = Math.min(
            Math.max(rect.left + 24, rect.left + rect.width * 0.72),
            window.innerWidth - 96,
        );
        const y = Math.min(
            Math.max(rect.top + 24, rect.top + rect.height * 0.24),
            window.innerHeight - 96,
        );
        return {
            x,
            y,
        };
    });
}

async function getVisibleSidebarAnnotationCount(page: Page) {
    return page.evaluate(() => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisible);
        const host = (activeHost && visibleHosts.includes(activeHost))
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        return Array.from(host?.querySelectorAll<HTMLElement>('.notes-list .note-item') ?? [])
            .filter(isVisible)
            .length;
    });
}

/**
 * The canonical identity the workspace publishes for one annotation. `source`
 * reports whether the entity claims a persisted revision and `annotationId`
 * carries its PDF object ref, so a replayed history entry that lost either one
 * is visible here without reaching into renderer internals.
 */
interface ICanonicalAnnotationIdentity {
    appAnnotationId: string | undefined;
    annotationId: string | null;
    source: string;
    stableKey: string;
    subtype: string | undefined;
}

interface ICanonicalNoteSnapshot {
    color: string | null;
    markerRect: {
        height: number;
        left: number;
        top: number;
        width: number;
    } | null;
    replies: Array<{
        author: string | null;
        contents: string;
        modifiedAt: number | null;
    }>;
    source: string;
    stableKey: string;
    subtype: string | null;
    text: string;
}

async function readCanonicalNoteSnapshots(page: Page) {
    await installWorkspaceExposeProbe(page);
    return page.evaluate((): ICanonicalNoteSnapshot[] => {
        const state = (window as IWorkspaceExposeProbeWindow).__evbTestApi
            ?.readActiveWorkspaceStateValues<{annotationComments?: Array<{
            color?: string | null;
            hasNote?: boolean;
            markerRect?: {
                height: number;
                left: number;
                top: number;
                width: number;
            } | null;
            replies?: Array<{
                author?: string | null;
                contents: string;
                modifiedAt?: number | null;
            }>;
            source: string;
            stableKey: string;
            subtype?: string | null;
            text: string;
        }>;}>(['annotationComments']);
        return (state?.annotationComments ?? [])
            .filter(comment => comment.hasNote === true)
            .map(comment => ({
                color: comment.color ?? null,
                markerRect: comment.markerRect
                    ? {
                        height: comment.markerRect.height,
                        left: comment.markerRect.left,
                        top: comment.markerRect.top,
                        width: comment.markerRect.width,
                    }
                    : null,
                replies: (comment.replies ?? []).map(reply => ({
                    author: reply.author ?? null,
                    contents: reply.contents,
                    modifiedAt: reply.modifiedAt ?? null,
                })),
                source: comment.source,
                stableKey: comment.stableKey,
                subtype: comment.subtype ?? null,
                text: comment.text,
            }));
    });
}

async function waitForCanonicalNote(
    page: Page,
    text: string,
    timeoutMs = NOTE_TEXT_ENTRY_TIMEOUT_MS,
) {
    const startedAt = Date.now();
    let notes = await readCanonicalNoteSnapshots(page);
    while (Date.now() - startedAt < timeoutMs) {
        const note = notes.find(candidate => candidate.text === text);
        if (note) {
            return note;
        }
        await delay(100);
        notes = await readCanonicalNoteSnapshots(page);
    }
    throw new Error(`Timed out waiting for canonical note ${text}: ${JSON.stringify(notes)}`);
}

async function readVisibleCanonicalNoteCenter(page: Page, stableKey: string) {
    return page.evaluate((expectedStableKey: string) => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const notes = Array.from(document.querySelectorAll<HTMLElement>('.pdf-annotation-editor-note'))
            .filter(note => note.dataset.stableKey === expectedStableKey && isVisible(note));
        const note = notes.find(candidate => activeHost?.contains(candidate)) ?? notes[0] ?? null;
        if (!note) {
            return null;
        }
        const rect = note.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    }, stableKey);
}

async function recolorCanonicalNote(page: Page, stableKey: string, color: string) {
    const center = await readVisibleCanonicalNoteCenter(page, stableKey);
    if (!center) {
        throw new Error(`Canonical note was not visible for recolor: ${stableKey}`);
    }
    await page.mouse.click(center.x, center.y, {button: 'right'});
    await page.waitForSelector(
        `.annotation-context-menu-color-button[aria-label="${color}"]`,
        {
            timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS,
            visible: true,
        },
    );
    await clickVisibleAnnotationControl(page, `.annotation-context-menu-color-button[aria-label="${color}"]`);
    await expect.poll(
        async () => (await readCanonicalNoteSnapshots(page)).find(note => note.stableKey === stableKey)?.color ?? null,
        {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS},
    ).toBe(color);
}

async function readNoteColorPresentation(page: Page, stableKey: string) {
    return page.evaluate((key: string) => {
        const marker = Array.from(document.querySelectorAll<HTMLElement>('.editor-pane.is-active .pdf-annotation-editor-note'))
            .find(note => note.dataset.stableKey === key);
        const id = marker?.dataset.annotationId;
        const chip = id ? document.querySelector<HTMLElement>(`.editor-pane.is-active .note-item[data-annotation-id="${id}"] .note-item-color-chip`) : null;
        const noteWindow = document.querySelector<HTMLElement>('.editor-pane.is-active .note-window');
        const title = noteWindow?.querySelector<HTMLElement>('.note-window__title');
        return {
            chip: chip ? getComputedStyle(chip).backgroundColor : null,
            markerColor: marker ? getComputedStyle(marker).getPropertyValue('--annotation-note-color').trim() : null,
            windowColor: noteWindow ? getComputedStyle(noteWindow).getPropertyValue('--annotation-note-color').trim() : null,
            windowBorder: noteWindow ? getComputedStyle(noteWindow).borderTopColor : null,
            titleBackground: title ? getComputedStyle(title).backgroundColor : null,
        };
    }, stableKey);
}

async function moveCanonicalNote(page: Page, stableKey: string, before: NonNullable<ICanonicalNoteSnapshot['markerRect']>) {
    const center = await readVisibleCanonicalNoteCenter(page, stableKey);
    if (!center) {
        throw new Error(`Canonical note was not visible for move: ${stableKey}`);
    }
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 110, center.y + 70, {steps: 8});
    await page.mouse.up();

    await expect.poll(async () => {
        const note = (await readCanonicalNoteSnapshots(page)).find(candidate => candidate.stableKey === stableKey);
        return note?.markerRect
            ? Math.hypot(note.markerRect.left - before.left, note.markerRect.top - before.top)
            : 0;
    }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBeGreaterThan(0.01);
    const moved = (await readCanonicalNoteSnapshots(page)).find(note => note.stableKey === stableKey);
    if (!moved?.markerRect) {
        throw new Error(`Canonical note lost its marker rectangle after move: ${stableKey}`);
    }
    return moved;
}

function expectMarkerAnchorClose(actual: ICanonicalNoteSnapshot['markerRect'], expected: ICanonicalNoteSnapshot['markerRect']) {
    expect(actual).not.toBeNull();
    expect(expected).not.toBeNull();
    if (!actual || !expected) {
        return;
    }
    expect(actual.left).toBeCloseTo(expected.left, 3);
    expect(actual.top).toBeCloseTo(expected.top, 3);
}

async function readCanonicalHighlightIdentities(page: Page) {
    // The published summaries are reactive proxies, which do not survive the
    // structured transfer out of the page; the projection is copied in-page.
    await installWorkspaceExposeProbe(page);
    const identities = await page.evaluate((): ICanonicalAnnotationIdentity[] => {
        const state = (window as IWorkspaceExposeProbeWindow).__evbTestApi
            ?.readActiveWorkspaceStateValues<{annotationComments?: ICanonicalAnnotationIdentity[]}>(
                ['annotationComments'],
            );
        return (state?.annotationComments ?? []).map(comment => ({
            appAnnotationId: comment.appAnnotationId,
            annotationId: comment.annotationId ?? null,
            source: String(comment.source),
            stableKey: String(comment.stableKey),
            subtype: comment.subtype,
        }));
    });
    return identities.filter(identity => identity.subtype === 'Highlight');
}

async function waitForCanonicalHighlightIdentity(
    page: Page,
    matches: (identities: ICanonicalAnnotationIdentity[]) => boolean,
    description: string,
) {
    const startedAt = Date.now();
    let identities = await readCanonicalHighlightIdentities(page);
    while (Date.now() - startedAt < 10_000) {
        if (matches(identities)) {
            return identities;
        }
        await delay(100);
        identities = await readCanonicalHighlightIdentities(page);
    }
    throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(identities)}`);
}

async function waitForSidebarAnnotationCount(page: Page, expectedCount: number) {
    await page.waitForFunction((count: number) => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisible);
        const host = (activeHost && visibleHosts.includes(activeHost))
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const visibleItems = Array.from(host?.querySelectorAll<HTMLElement>('.notes-list .note-item') ?? [])
            .filter(isVisible);
        return visibleItems.length === count;
    }, { timeout: 8_000 }, expectedCount);
}

async function waitForSidebarAnnotationText(page: Page, expectedText: string) {
    await page.waitForFunction((text: string) => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisible);
        const host = (activeHost && visibleHosts.includes(activeHost))
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        return Array.from(host?.querySelectorAll<HTMLElement>('.notes-list .note-item') ?? [])
            .filter(isVisible)
            .some(item => item.textContent?.includes(text));
    }, { timeout: 8_000 }, expectedText);
}

async function openCanonicalTextBoxEditor(page: Page, annotationId: string) {
    await clickAnnotationTool(page, 'Select');
    const centerHandle = await page.waitForFunction((expectedId: string) => {
        const entity = Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
        )).find(candidate => candidate.dataset.annotationId === expectedId);
        const rect = entity?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
            return false;
        }
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    }, {timeout: 30_000}, annotationId);
    const center = await centerHandle.jsonValue() as {
        x: number;
        y: number;
    };
    await page.mouse.click(center.x, center.y, {count: 2});
    await page.waitForFunction((expectedId: string) => {
        const entity = Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
        )).find(candidate => candidate.dataset.annotationId === expectedId);
        const editor = entity?.querySelector('[contenteditable="true"]');
        return Boolean(
            entity?.classList.contains('is-editing')
            && editor
            && document.activeElement === editor,
        );
    }, {timeout: 30_000}, annotationId);
}

async function readCanonicalTextBoxEditorState(page: Page, annotationId: string) {
    return page.evaluate((expectedId: string) => {
        const entity = Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
        )).find(candidate => candidate.dataset.annotationId === expectedId);
        const editor = entity?.querySelector<HTMLElement>('[contenteditable="true"]');
        return {
            focused: editor !== null && document.activeElement === editor,
            editing: entity?.classList.contains('is-editing') ?? false,
            text: (editor?.textContent ?? entity?.textContent ?? '').replace(/[\u200B\uFEFF]/gu, '').trim(),
        };
    }, annotationId);
}

async function placeEmptyNote(page: Page) {
    await clickAnnotationTool(page, 'Note');
    const point = await resolvePageNotePoint(page);
    if (!point) throw new Error('No visible page point for note placement');
    const hit = await page.evaluate(({
        x,
        y,
    }) => {
        const element = document.elementFromPoint(x, y);
        const layer = element?.closest('.pdf-annotation-editor-layer');
        return {
            point: {
                x,
                y,
            },
            tag: element?.tagName,
            class: element?.getAttribute('class'),
            annotationId: element?.closest('[data-annotation-id]')?.getAttribute('data-annotation-id'),
            layerClass: layer?.getAttribute('class'),
            pointerEvents: layer ? getComputedStyle(layer).pointerEvents : null,
        };
    }, point);
    await page.mouse.click(point.x, point.y);
    try {
        await page.waitForSelector('textarea.note-window__textarea', {
            visible: true,
            timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS,
        });
        await page.waitForFunction(() => document.activeElement?.matches('textarea.note-window__textarea') === true,
            {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS});
    } catch (error) {
        throw new Error(`Pointer note creation failed: ${JSON.stringify({
            hit,
            state: await readAnnotationInteractionDiagnostic(page),
        })}`, {cause: error});
    }
}

async function setLatestNoteWindowText(page: Page, text: string) {
    await clickVisibleAnnotationControl(page, '.editor-pane.is-active textarea.note-window__textarea');
    await selectAllFocusedAnnotationText(page);
    await page.keyboard.type(text, {delay: 10});
    await page.waitForFunction((expected: string) => (
        document.querySelector<HTMLTextAreaElement>('.editor-pane.is-active textarea.note-window__textarea')?.value === expected
    ), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, text);
}

async function editCanonicalNoteText(page: Page, currentText: string, nextText: string) {
    const id = await page.evaluate((expectedText: string) => {
        const row = Array.from(document.querySelectorAll<HTMLElement>('.editor-pane.is-active .notes-list .note-item'))
            .find(item => item.querySelector('.note-item-text')?.textContent?.includes(expectedText));
        return row?.dataset.annotationId;
    }, currentText);
    if (!id) throw new Error(`Could not find the canonical note card: ${currentText}`);
    await clickVisibleAnnotationControl(page, `.editor-pane.is-active .note-item[data-annotation-id="${id}"] .note-item-content`, 2);
    const textarea = await page.waitForSelector('textarea.note-window__textarea', {
        timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS,
        visible: true,
    });
    if (!textarea) {
        throw new Error('Canonical note editor did not provide a textarea for keyboard editing');
    }
    await textarea.click();
    await selectAllFocusedAnnotationText(page);
    await page.keyboard.type(nextText, {delay: 10});
    await page.keyboard.press('Tab');
    return waitForCanonicalNote(page, nextText);
}

describe('Electron E2E - Annotation Lifecycle', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        restartBeforeEach: true,
        extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
        sessionName: () => `e2e-annotation-lifecycle-${Date.now()}`,
    });

    it('creates every shape, draw preset and markup with matching styles, undo, save and hard reopen', async () => {
        const session = sessionFixture.getSession();
        if (!session) throw new Error('Annotation lifecycle session did not start');
        const {page} = session;
        const saved: Array<{
            path: string;
            subtype: string;
            paint: NonNullable<Awaited<ReturnType<typeof readPaintedAnnotation>>>
        }> = [];
        for (const [
            caseIndex,
            scenario,
        ] of POINTER_STYLE_CASES.entries()) {
            console.info(`[annotation matrix] ${caseIndex + 1}/${POINTER_STYLE_CASES.length} ${scenario.tool}${'preset' in scenario ? ` ${scenario.preset}` : ''}`);
            if (caseIndex > 0) await sessionFixture.restart();
            const fixturePath = await createMultiPageTextFixturePdf(`annotation-all-tools-${caseIndex}-${Date.now()}.pdf`, 1);
            onTestFinished(() => rmSync(fixturePath, {force: true}));
            await openPdfInApp(page, fixturePath);
            await waitForPdfLoaded(page);
            await waitForViewerInteractive(page);
            await openAnnotationsTab(page);
            await setAnnotationKeepActiveWithPointer(page, false);
            await clickAnnotationTool(page, scenario.tool);
            const inspector = '.editor-pane.is-active [data-annotation-inspector]';
            await page.waitForSelector(`${inspector}[data-target="defaults"]`, {visible: true});
            await clickVisibleAnnotationControl(page, `${inspector} .swatch[aria-label="#06b6d4"]`);
            if ('preset' in scenario) {
                const presetIndex = [
                    'Pen',
                    'Pencil',
                    'Marker',
                ].indexOf(scenario.preset) + 1;
                await clickVisibleAnnotationControl(page, `${inspector} .draw-style-button:nth-child(${presetIndex})`);
            }
            if (isMarkupTool(scenario.tool)) {
                await createTextMarkupWithPointer(page, scenario.tool);
            } else {
                const bounds = await page.$eval('.editor-pane.is-active .page_container[data-page="1"] .pdf-annotation-editor-layer', layer => layer.getBoundingClientRect().toJSON());
                // Alternate drag direction, including the reverse Line/Arrow path.
                const reverse = caseIndex % 2 === 0;
                const start = {
                    x: bounds.left + bounds.width * (reverse ? 0.62 : 0.34),
                    y: bounds.top + bounds.height * (reverse ? 0.55 : 0.36),
                };
                const end = {
                    x: bounds.left + bounds.width * (reverse ? 0.34 : 0.62),
                    y: bounds.top + bounds.height * (reverse ? 0.36 : 0.55),
                };
                if (caseIndex === 0) {
                    await page.mouse.move(start.x, start.y);
                    await page.mouse.down();
                    await page.mouse.move(end.x, end.y, {steps: 4});
                    await page.keyboard.press('Escape');
                    await page.mouse.up();
                    await expect.poll(() => page.$$eval(
                        '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="shape"]',
                        elements => elements.length,
                    )).toBe(0);
                    // Escape first cancels the captured gesture. The tool stays
                    // armed so the next complete drag creates the first stroke.
                }
                await page.mouse.move(start.x, start.y);
                await page.mouse.down();
                await page.mouse.move(end.x, end.y, {steps: 20});
                await page.mouse.up();
            }
            await page.waitForSelector('.editor-pane.is-active .tool-button[data-tool="select"].is-active');
            await expect.poll(async () => (await readPaintedAnnotation(page))?.cardColor).toBe('rgb(6, 182, 212)');
            const initial = await readPaintedAnnotation(page);
            expect(initial?.color, JSON.stringify(scenario)).toBe('rgb(6, 182, 212)');
            expect(initial?.chipWidth).toBeGreaterThan(0);
            if (isMarkupTool(scenario.tool)) expect(initial?.subtype).toBe(scenario.subtype);

            const target = await annotationPointerTarget(page);
            await page.mouse.click(target.x, target.y);
            await page.waitForSelector(`${inspector}[data-target="selection"]`, {visible: true});
            await clickVisibleAnnotationControl(page, `${inspector} .swatch[aria-label="#8b5cf6"]`);
            await expect.poll(async () => (await readPaintedAnnotation(page))?.color).toBe('rgb(139, 92, 246)');
            expect((await readPaintedAnnotation(page))?.cardColor).toBe('rgb(139, 92, 246)');
            const opacitySelector = `${inspector} input[type="number"][aria-label^="Opacity"]`;
            const opacityControl = await page.$eval(opacitySelector, element => {
                const input = element as HTMLInputElement;
                return {
                    value: input.valueAsNumber,
                    min: Number(input.min),
                    step: Number(input.step),
                };
            });
            // Native number inputs snap off-grid values such as Marker 42%
            // to the next lower supported step, 40%, rather than subtracting 5.
            const expectedOpacityPercent = opacityControl.min
                + (Math.ceil((opacityControl.value - opacityControl.min) / opacityControl.step) - 1) * opacityControl.step;
            expect(expectedOpacityPercent).toBeLessThan(opacityControl.value);
            await clickVisibleAnnotationControl(page, opacitySelector);
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Tab');
            expect(await page.$eval(opacitySelector, element => (element as HTMLInputElement).valueAsNumber)).toBe(expectedOpacityPercent);
            await expect.poll(async () => (await readPaintedAnnotation(page))?.opacity).toBeCloseTo(expectedOpacityPercent / 100, 5);
            // Reacquire focus by clicking the annotation, then use the keyboard.
            const moveTarget = await annotationPointerTarget(page);
            await page.mouse.click(moveTarget.x, moveTarget.y);
            const beforeMove = await readPaintedAnnotation(page);
            await page.keyboard.press('ArrowRight');
            await expect.poll(async () => (await readPaintedAnnotation(page))?.left).toBeGreaterThan(beforeMove!.left);
            if (!isMarkupTool(scenario.tool)) {
                const beforeResize = await readPaintedAnnotation(page);
                const handle = '.editor-pane.is-active [data-pdf-annotation-resize-handle="se"]';
                await page.waitForSelector(handle, {visible: true});
                const resize = await page.$eval(handle, element => {
                    const rect = element.getBoundingClientRect();
                    const x = rect.left + rect.width / 2;
                    const y = rect.top + rect.height / 2;
                    if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Shape resize handle is obstructed');
                    return {
                        x,
                        y,
                    };
                });
                await page.mouse.move(resize.x, resize.y);
                await page.mouse.down();
                await page.mouse.move(resize.x + 24, resize.y + 18, {steps: 10});
                await page.mouse.up();
                await expect.poll(async () => (await readPaintedAnnotation(page))?.width).toBeGreaterThan(beforeResize!.width);
            }
            const edited = await readPaintedAnnotation(page);
            await clickFirstSidebarAnnotationDelete(page);
            await page.waitForSelector('.editor-pane.is-active .pdf-annotation-editor-entity', {hidden: true});
            await clickEnabledToolbarAction(page, 'Undo');
            await expect.poll(() => readPaintedAnnotation(page)).toEqual(edited);
            await saveViaVisibleToolbar(page, 30_000);
            await waitForActiveTabDirtyState(page, false);
            await waitForPdfAnnotationSubtypeCount(fixturePath, scenario.subtype, 1);
            const paint = await readPaintedAnnotation(page);
            if (!paint) throw new Error(`Saved ${scenario.tool} disappeared`);
            saved.push({
                path: preserveFixtureAcrossRestart(fixturePath),
                subtype: scenario.subtype,
                paint,
            });
        }
        const restarted = await sessionFixture.restart({hard: true});
        if (!restarted) throw new Error('All-tools hard reopen did not start');
        for (const sample of saved) {
            console.info(`[annotation matrix reopen] ${sample.subtype}`);
            await sessionFixture.restart();
            await openPdfInApp(restarted.page, sample.path);
            await waitForPdfLoaded(restarted.page);
            await openAnnotationsTab(restarted.page);
            await expect.poll(async () => (await readPaintedAnnotation(restarted.page))?.cardColor).toBe(sample.paint.cardColor);
            const reopened = await readPaintedAnnotation(restarted.page);
            expect(reopened).toMatchObject({
                kind: sample.paint.kind,
                subtype: sample.paint.subtype,
                color: sample.paint.color,
                cardColor: sample.paint.cardColor,
            });
            for (const key of [
                'left',
                'top',
                'width',
                'height',
                'opacity',
            ] as const) {
                expect(reopened?.[key], `${sample.subtype} reopened ${key}`).toBeCloseTo(sample.paint[key], 3);
            }
            await waitForPdfAnnotationSubtypeCount(sample.path, sample.subtype, 1);
        }
    }, 360_000);

    it.each([
        90,
        270,
    ])('keeps pointer shape geometry and identity through view rotation %s and reopen', async (rotation) => {
        const session = sessionFixture.getSession();
        if (!session) throw new Error('Annotation lifecycle session did not start');
        let {page} = session;
        const fixture = await createMultiPageTextFixturePdf(`rotated-shape-${rotation}-${Date.now()}.pdf`, 1);
        onTestFinished(() => rmSync(fixture, {force: true}));
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);
        const layer = '.editor-pane.is-active .page_container[data-page="1"] .pdf-annotation-editor-layer';
        async function rotateTo(target: number) {
            for (let count = 0; count < 4; count += 1) {
                const current = await page.$eval(layer, element => Number(element.getAttribute('data-view-rotation')));
                if (current === target) {
                    return;
                }
                expect((await callWorkspaceCommand(page, 'handleViewRotationCw')).called).toBe(true);
                await page.waitForFunction((selector: string, before: number) => (
                    Number(document.querySelector(selector)?.getAttribute('data-view-rotation')) !== before
                ), {}, layer, current);
            }
            throw new Error(`View rotation did not reach ${target}`);
        }
        await rotateTo(rotation);
        await waitForViewerInteractive(page);
        await clickAnnotationTool(page, 'Rectangle');
        const bounds = await page.$eval(layer, element => element.getBoundingClientRect().toJSON());
        const start = {
            x: bounds.left + bounds.width * 0.3,
            y: bounds.top + bounds.height * 0.3,
        };
        const end = {
            x: start.x + 100,
            y: start.y + 70,
        };
        expect(await page.evaluate((point) => Boolean(document.elementFromPoint(point.x, point.y)?.closest('.pdf-annotation-editor-layer')), start)).toBe(true);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, {steps: 8});
        await page.mouse.up();
        await clickAnnotationTool(page, 'Select');
        await expect.poll(() => readPaintedAnnotation(page)).not.toBeNull();
        const initial = (await readPaintedAnnotation(page))!;
        expect(initial.width * bounds.width).toBeCloseTo(100, -1);
        expect(initial.height * bounds.height).toBeCloseTo(70, -1);
        const target = await annotationPointerTarget(page);
        await page.mouse.move(target.x, target.y);
        await page.mouse.down();
        await page.mouse.move(target.x + 24, target.y + 18, {steps: 6});
        await page.mouse.up();
        const moved = (await readPaintedAnnotation(page))!;
        expect((moved.left - initial.left) * bounds.width).toBeCloseTo(24, 0);
        expect((moved.top - initial.top) * bounds.height).toBeCloseTo(18, 0);
        const resize = await page.$$eval('.editor-pane.is-active [data-pdf-annotation-resize-handle]', elements => {
            // Canonical handle names rotate with the page. Drag the visible
            // bottom-right handle, irrespective of its canonical name.
            const handles = elements.map(element => {
                const rect = element.getBoundingClientRect();
                return {
                    element,
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                };
            }).sort((a, b) => (b.x + b.y) - (a.x + a.y));
            const handle = handles[0];
            if (!handle || !handle.element.contains(document.elementFromPoint(handle.x, handle.y))) throw new Error('Rotated resize handle is obstructed');
            return {
                x: handle.x,
                y: handle.y,
            };
        });
        await page.mouse.move(resize.x, resize.y);
        await page.mouse.down();
        await page.mouse.move(resize.x + 30, resize.y + 20, {steps: 8});
        await page.mouse.up();
        const resized = (await readPaintedAnnotation(page))!;
        expect(resized.width).toBeGreaterThan(moved.width);
        expect(resized.height).toBeGreaterThan(moved.height);
        await saveViaVisibleToolbar(page, 30_000);
        await waitForActiveTabDirtyState(page, false);
        const saved = (await readPaintedAnnotation(page))!;
        expect(saved.id).toBe(initial.id);
        const reopenPath = preserveFixtureAcrossRestart(fixture);
        const restarted = await sessionFixture.restart({hard: true});
        if (!restarted) throw new Error('Rotated shape hard reopen did not start');
        page = restarted.page;
        await openPdfInApp(page, reopenPath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);
        await rotateTo(rotation);
        await expect.poll(async () => (await readPaintedAnnotation(page))?.id).toBe(toLegacyShapeStableKey(asAnnotationId(saved.id!)));
        expect(await page.$$eval(`${layer} [data-annotation-kind="shape"]`, elements => elements.length)).toBe(1);
        const reopened = (await readPaintedAnnotation(page))!;
        for (const key of [
            'left',
            'top',
            'width',
            'height',
        ] as const) {
            expect(reopened[key], key).toBeCloseTo(saved[key], 3);
        }
    }, 120_000);

    it('renders the canonical annotation surface once and keeps PDF.js read-only', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Annotation lifecycle session did not start');
        }
        const { page } = session;
        const fixturePath = await createCanonicalAnnotationSurfaceFixturePdf(
            `annotation-lifecycle-${Date.now()}-canonical-surface.pdf`,
        );

        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await page.waitForFunction(() => {
            const layer = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .page_container[data-page="1"] .pdf-annotation-editor-layer',
            );
            if (!layer) {
                return false;
            }
            const kinds = Array.from(layer.querySelectorAll<HTMLElement>('[data-annotation-kind]'))
                .map(entity => entity.dataset.annotationKind ?? '')
                .sort();
            return kinds.join(',') === 'note,placed-image,shape,text-box,text-markup'
                && document.querySelectorAll(
                    '.editor-pane.is-active .page_container[data-page="1"] .annotation-editor-layer',
                ).length === 0;
        }, {timeout: 20_000});
        await page.waitForFunction(() => {
            const image = document.querySelector<HTMLImageElement>(
                '.editor-pane.is-active .page_container[data-page="1"] .pdf-annotation-editor-stamp__image',
            );
            return Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
        }, {timeout: 20_000});

        const initial = await collectAnnotationOwnershipDebugState(page);
        expect(initial.annotationDirtyEntityCount).toBe(0);
        expect(initial.canonicalEntities).toHaveLength(5);
        expect(initial.canonicalEntities.map(entity => entity.kind).sort()).toEqual([
            'note',
            'placed-image',
            'shape',
            'text-box',
            'text-markup',
        ]);
        expect(initial.legacyEditorLayerCount).toBe(0);
        expect(initial.staticNonLinkAnnotationCount).toBe(0);
        expect(initial.staticLinkHrefs).toEqual(['https://example.com/evb-viewer-surface']);

        const clickEntity = async (kind: string) => {
            const point = await page.evaluate((entityKind: string) => {
                const entity = document.querySelector<HTMLElement>(
                    `.editor-pane.is-active .page_container[data-page="1"] [data-annotation-kind="${entityKind}"]`,
                );
                if (!entity) {
                    return null;
                }
                const rect = entity.getBoundingClientRect();
                return {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                };
            }, kind);
            if (!point) {
                throw new Error(`Canonical ${kind} entity was not mounted`);
            }
            await page.mouse.click(point.x, point.y);
        };

        await clickEntity('text-box');
        await page.waitForFunction(() => (
            document.querySelectorAll(
                '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id].is-selected',
            ).length === 1
        ));
        await page.keyboard.down('Shift');
        await clickEntity('note');
        await page.keyboard.up('Shift');
        await page.waitForFunction(() => (
            document.querySelectorAll(
                '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id].is-selected',
            ).length === 2
        ));

        const pagePoint = await page.evaluate(() => {
            const pageContainer = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .page_container[data-page="1"]',
            );
            if (!pageContainer) {
                return null;
            }
            const rect = pageContainer.getBoundingClientRect();
            const xRatios = [
                0.96,
                0.04,
                0.5,
                0.92,
                0.08,
            ];
            const yRatios = [
                0.9,
                0.8,
                0.7,
                0.45,
                0.4,
                0.5,
                0.6,
            ];
            for (const xRatio of xRatios) {
                for (const yRatio of yRatios) {
                    const x = rect.left + rect.width * xRatio;
                    const y = Math.min(rect.top + rect.height * yRatio, window.innerHeight - 20);
                    const target = document.elementFromPoint(x, y);
                    if (
                        !target
                        || !pageContainer.contains(target)
                        || target.closest('[data-annotation-id], a, button, input, textarea, [role="button"]')
                    ) {
                        continue;
                    }
                    return {
                        x,
                        y,
                    };
                }
            }
            return null;
        });
        if (!pagePoint) {
            throw new Error('Canonical annotation fixture page was not mounted');
        }
        await page.mouse.click(pagePoint.x, pagePoint.y);
        await page.waitForFunction(() => (
            document.querySelectorAll(
                '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id].is-selected',
            ).length === 0
        ));

        const afterInteraction = await collectAnnotationOwnershipDebugState(page);
        expect(afterInteraction.annotationDirtyEntityCount).toBe(0);
    }, 90_000);

    it('supports keyboard editing for every canonical kind and atomic mixed selection history', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Annotation lifecycle session did not start');
        }
        const {page} = session;
        const fixturePath = await createCanonicalAnnotationSurfaceFixturePdf(
            `annotation-lifecycle-${Date.now()}-keyboard-selection.pdf`,
        );

        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        const entitySelector = '.editor-pane.is-active .page_container[data-page="1"] '
            + '.pdf-annotation-editor-layer [data-annotation-id][data-annotation-kind]';
        await page.waitForFunction((selector: string) => (
            document.querySelectorAll(selector).length === 5
        ), {timeout: 20_000}, entitySelector);

        interface ICanonicalEntityGeometry {
            id: string;
            kind: string;
            left: number;
            top: number;
            width: number;
            height: number;
        }
        const readGeometry = async () => page.evaluate((selector: string) => (
            Array.from(document.querySelectorAll<HTMLElement>(selector)).map((element) => {
                const rect = element.getBoundingClientRect();
                return {
                    id: element.dataset.annotationId ?? '',
                    kind: element.dataset.annotationKind ?? '',
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                } satisfies ICanonicalEntityGeometry;
            })
        ), entitySelector);
        const waitForSelectedCount = async (count: number) => {
            await page.waitForFunction((expected: number) => (
                document.querySelectorAll(
                    '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id].is-selected',
                ).length === expected
            ), {timeout: 10_000}, count);
        };
        const expectEditorLayerFocused = async (context = 'mixed selection') => {
            try {
                await page.waitForFunction(() => {
                    const active = document.activeElement;
                    return active instanceof HTMLElement
                        && !active.isContentEditable
                        && !(active instanceof HTMLInputElement)
                        && !(active instanceof HTMLTextAreaElement)
                        && active.closest('[data-pdf-annotation-editor-surface]') !== null;
                }, {timeout: 10_000});
            } catch (error) {
                throw new Error(`Natural annotation keyboard focus lost after ${context}: ${JSON.stringify(await readAnnotationInteractionDiagnostic(page))}`, {cause: error});
            }
        };
        const clickEntity = async (id: string, additive = false) => {
            const point = await annotationPointerTarget(page,
                `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${id}"]`);
            if (additive) {
                await page.keyboard.down('Shift');
            }
            try {
                await page.mouse.click(point.x, point.y);
            }
            finally {
                if (additive) {
                    await page.keyboard.up('Shift');
                }
            }
        };
        const waitForGeometry = async (
            id: string,
            predicate: (before: ICanonicalEntityGeometry, after: ICanonicalEntityGeometry) => boolean,
            before: ICanonicalEntityGeometry,
        ) => {
            await page.waitForFunction((input: {
                annotationId: string;
                before: ICanonicalEntityGeometry;
            }) => {
                const element = document.querySelector<HTMLElement>(
                    `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${input.annotationId}"]`,
                );
                if (!element) {
                    return false;
                }
                const rect = element.getBoundingClientRect();
                return Math.abs(rect.left - input.before.left) > 0.05
                    || Math.abs(rect.top - input.before.top) > 0.05
                    || Math.abs(rect.width - input.before.width) > 0.05
                    || Math.abs(rect.height - input.before.height) > 0.05;
            }, {timeout: 10_000}, {
                annotationId: id,
                before,
            });
            const after = (await readGeometry()).find(entity => entity.id === id);
            if (!after || !predicate(before, after)) {
                throw new Error(`Canonical entity geometry did not satisfy the expected change: ${id}`);
            }
            return after;
        };
        const geometryByKind = new Map((await readGeometry()).map(entity => [
            entity.kind,
            entity,
        ]));
        for (const kind of [
            'text-box',
            'note',
            'text-markup',
            'shape',
            'placed-image',
        ]) {
            const entity = geometryByKind.get(kind);
            if (!entity) {
                throw new Error(`Canonical fixture did not contain ${kind}`);
            }
            await clickEntity(entity.id);
            await waitForSelectedCount(1);
            if (kind === 'note') {
                await clickLatestVisibleNoteWindowClose(page);
                await waitForNoOpenNoteWindows(page);
            }
            // Note markers translate by one pixel while hovered. Move the
            // pointer away before reading layout geometry so the undo checks
            // compare the annotation position rather than hover styling.
            await page.mouse.move(0, 0);
            await expectEditorLayerFocused(`${kind} ${entity.id}`);
            const before = (await readGeometry()).find(candidate => candidate.id === entity.id);
            if (!before) {
                throw new Error(`Canonical entity geometry was not readable: ${entity.id}`);
            }
            await page.keyboard.press('ArrowRight');
            const moved = await waitForGeometry(entity.id, (initial, next) => next.left > initial.left, before);
            await page.keyboard.down(COMMAND_MODIFIER);
            await page.keyboard.press('z');
            await page.keyboard.up(COMMAND_MODIFIER);
            await page.waitForFunction((input: {
                annotationId: string;
                left: number;
                top: number;
            }) => {
                const element = document.querySelector<HTMLElement>(
                    `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${input.annotationId}"]`,
                );
                const rect = element?.getBoundingClientRect();
                return rect !== undefined
                    && Math.abs(rect.left - input.left) < 0.05
                    && Math.abs(rect.top - input.top) < 0.05;
            }, {timeout: 10_000}, {
                annotationId: entity.id,
                left: before.left,
                top: before.top,
            });
            await page.keyboard.down(COMMAND_MODIFIER);
            await page.keyboard.down('Shift');
            await page.keyboard.press('z');
            await page.keyboard.up('Shift');
            await page.keyboard.up(COMMAND_MODIFIER);
            await page.waitForFunction((input: {
                annotationId: string;
                left: number;
            }) => {
                const element = document.querySelector<HTMLElement>(
                    `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${input.annotationId}"]`,
                );
                return (element?.getBoundingClientRect().left ?? 0) > input.left + 0.05;
            }, {timeout: 10_000}, {
                annotationId: entity.id,
                left: before.left,
            });
            expect(moved.left).toBeGreaterThan(before.left);

            await page.keyboard.press('Backspace');
            await page.waitForFunction((annotationId: string) => (
                !document.querySelector(
                    `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${annotationId}"]`,
                )
            ), {timeout: 10_000}, entity.id);
            await page.keyboard.down(COMMAND_MODIFIER);
            await page.keyboard.press('z');
            await page.keyboard.up(COMMAND_MODIFIER);
            await page.waitForFunction((annotationId: string) => Boolean(
                document.querySelector(
                    `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${annotationId}"]`,
                ),
            ), {timeout: 10_000}, entity.id);
        }

        // Exercise the native macOS Edit menu path as well as the layer's
        // keyboard handler. All five canonical kinds must form one undo step.
        await page.keyboard.down(COMMAND_MODIFIER);
        await page.keyboard.press('a');
        await page.keyboard.up(COMMAND_MODIFIER);
        await waitForSelectedCount(5);
        await expectEditorLayerFocused('Select All');
        await page.keyboard.press('Backspace');
        await expect.poll(async () => (await readGeometry()).length).toBe(0);
        await page.keyboard.down(COMMAND_MODIFIER);
        await page.keyboard.press('z');
        await page.keyboard.up(COMMAND_MODIFIER);
        await expect.poll(async () => (await readGeometry()).length).toBe(5);

        const restoredGeometry = await readGeometry();
        const first = restoredGeometry.find(entity => entity.kind === 'text-box');
        const second = restoredGeometry.find(entity => entity.kind === 'note');
        if (!first || !second) {
            throw new Error('Canonical mixed-selection fixture entities are missing');
        }
        await clickEntity(first.id);
        await waitForSelectedCount(1);
        await clickEntity(second.id, true);
        await waitForSelectedCount(2);
        await expectEditorLayerFocused();
        const mixedBefore = new Map((await readGeometry())
            .filter(entity => entity.id === first.id || entity.id === second.id)
            .map(entity => [
                entity.id,
                entity,
            ]));
        const dragPoint = await page.evaluate((annotationId: string) => {
            const entity = document.querySelector<HTMLElement>(
                `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${annotationId}"]`,
            );
            const rect = entity?.getBoundingClientRect();
            return rect
                ? {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                }
                : null;
        }, first.id);
        if (!dragPoint) {
            throw new Error('Canonical mixed-selection drag target is missing');
        }
        await page.mouse.move(dragPoint.x, dragPoint.y);
        await page.mouse.down();
        await page.mouse.move(dragPoint.x + 28, dragPoint.y + 18, {steps: 6});
        await page.mouse.up();
        await expectEditorLayerFocused();
        await page.waitForFunction((ids: string[]) => ids.every((annotationId) => {
            const entity = document.querySelector<HTMLElement>(
                `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${annotationId}"]`,
            );
            return entity?.classList.contains('is-selected') === true;
        }), {timeout: 10_000}, [
            first.id,
            second.id,
        ]);
        const mixedAfter = await readGeometry();
        [
            first.id,
            second.id,
        ].forEach((id) => {
            const before = mixedBefore.get(id);
            const after = mixedAfter.find(entity => entity.id === id);
            expect(after?.left).toBeGreaterThan(before?.left ?? Number.POSITIVE_INFINITY);
            expect(after?.top).toBeGreaterThan(before?.top ?? Number.POSITIVE_INFINITY);
        });
        await page.keyboard.down(COMMAND_MODIFIER);
        await page.keyboard.press('z');
        await page.keyboard.up(COMMAND_MODIFIER);
        await page.waitForFunction((input: Array<{
            id: string;
            left: number;
            top: number;
        }>) => input.every((expected) => {
            const entity = document.querySelector<HTMLElement>(
                `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${expected.id}"]`,
            );
            const rect = entity?.getBoundingClientRect();
            return rect !== undefined
                && Math.abs(rect.left - expected.left) < 0.05
                && Math.abs(rect.top - expected.top) < 0.05;
        }), {timeout: 10_000}, [
            first.id,
            second.id,
        ].map(id => ({
            id,
            left: mixedBefore.get(id)?.left ?? 0,
            top: mixedBefore.get(id)?.top ?? 0,
        })));
    }, 120_000);

    it('places a stamp through the editor layer and round-trips its edited geometry', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Annotation lifecycle session did not start');
        }
        const {page} = session;
        const fixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-stamp-round-trip.pdf`,
            1,
        );
        const reopenPath = fixturePath.replace(/\.pdf$/u, '-reopen.pdf');
        onTestFinished(() => rmSync(reopenPath, {force: true}));

        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        const state = await readWorkspaceStateValues<{workingCopyPath?: string | null}>(page, ['workingCopyPath']);
        if (typeof state.workingCopyPath !== 'string') {
            throw new Error('Stamp lifecycle working copy is unavailable');
        }
        const imagePath = join(dirname(state.workingCopyPath), `annotation-lifecycle-${process.pid}-stamp.jpg`);
        writeFileSync(imagePath, PLACED_IMAGE_JPEG);
        onTestFinished(() => rmSync(imagePath, {force: true}));
        let clipboardLeaseId: string | null = null;
        onTestFinished(async () => {
            await uninstallManagedJpegClipboard(page);
            if (clipboardLeaseId) {
                await releaseManagedImageHandle(page, clipboardLeaseId);
            }
        });
        const clipboard = await installManagedJpegClipboard(page, imagePath);
        clipboardLeaseId = clipboard.leaseId;
        expect(clipboard).toMatchObject({
            dimensions: {
                height: 40,
                width: 64,
            },
            hasNativeSourceHandle: true,
        });

        try {
            const pasteResult = await callWorkspaceCommand(page, 'handlePasteImageFromClipboard');
            expect(pasteResult.called).toBe(true);
            await page.waitForSelector(ACTIVE_IMAGE_PLACEMENT_SELECTOR, {
                timeout: 30_000,
                visible: true,
            });

            const initial = await readPendingImagePlacementSnapshot(page);
            const drag = await dragImagePlacementControl(
                page,
                `${ACTIVE_IMAGE_PLACEMENT_SELECTOR} .pdf-image-placement__surface`,
                48,
                32,
            );
            const expectedLeft = Math.min(1 - initial.width, initial.left + 48 / drag.containerWidth);
            const expectedTop = Math.min(1 - initial.height, initial.top + 32 / drag.containerHeight);
            await expect.poll(async () => {
                const value = await readPendingImagePlacementSnapshot(page);
                return Math.max(
                    Math.abs(value.left - expectedLeft) * drag.containerWidth,
                    Math.abs(value.top - expectedTop) * drag.containerHeight,
                );
            }, {message: JSON.stringify({
                initial,
                drag,
                expectedLeft,
                expectedTop,
            })}).toBeLessThanOrEqual(1);
            const moved = await readPendingImagePlacementSnapshot(page);

            const aspectRatio = moved.width / moved.height;
            await dragImagePlacementControl(
                page,
                `${ACTIVE_IMAGE_PLACEMENT_SELECTOR} .pdf-image-placement__resizer--se`,
                42,
                18,
                true,
            );
            await page.waitForFunction((selector: string, previousWidth: number) => {
                const frame = document.querySelector<HTMLElement>(selector);
                return frame ? Number.parseFloat(frame.style.width) > (previousWidth * 100) : false;
            }, {timeout: 10_000}, ACTIVE_IMAGE_PLACEMENT_SELECTOR, moved.width);
            const resized = await readPendingImagePlacementSnapshot(page);
            expect(resized.width).toBeGreaterThan(moved.width);
            expect(resized.height).toBeGreaterThan(moved.height);
            expect(resized.width / resized.height).toBeCloseTo(aspectRatio, 2);

            await rotateImagePlacementByQuarterTurn(page);
            await page.waitForFunction((selector: string, previousRotation: number) => {
                const frame = document.querySelector<HTMLElement>(selector);
                const transform = frame?.querySelector<HTMLElement>('.pdf-image-placement__transform');
                const rotation = Number.parseFloat(
                    getComputedStyle(transform ?? frame ?? document.body)
                        .getPropertyValue('--pdf-image-placement-rotation')
                        .replace(/deg$/u, ''),
                ) || 0;
                return Math.abs(rotation - previousRotation) > 5;
            }, {timeout: 10_000}, ACTIVE_IMAGE_PLACEMENT_SELECTOR, resized.rotationDegrees);
            const rotated = await readPendingImagePlacementSnapshot(page);
            expect(Math.abs(rotated.rotationDegrees)).toBeGreaterThan(5);

            await page.click(`${ACTIVE_IMAGE_PLACEMENT_SELECTOR} .pdf-image-placement__action--primary`);
            await page.waitForSelector(ACTIVE_IMAGE_PLACEMENT_SELECTOR, {
                hidden: true,
                timeout: 60_000,
            });
            await page.waitForFunction((selector: string) => {
                const stamp = document.querySelector<HTMLElement>(selector);
                const image = stamp?.querySelector<HTMLImageElement>('.pdf-annotation-editor-stamp__image');
                return Boolean(
                    stamp
                    && image?.complete
                    && image.naturalWidth > 0
                    && image.naturalHeight > 0,
                );
            }, {timeout: 30_000}, CANONICAL_STAMP_SELECTOR);

            const created = await readCanonicalStampSnapshot(page);
            expect(created.annotationId).toBeTypeOf('string');
            expect(created.annotationId?.length).toBeGreaterThan(0);
            expect(created.left + (created.width / 2)).toBeCloseTo(rotated.left + (rotated.width / 2), 3);
            expect(created.top + (created.height / 2)).toBeCloseTo(rotated.top + (rotated.height / 2), 3);
            expect(created.width).toBeGreaterThan(0);
            expect(created.height).toBeGreaterThan(0);
            expect(created.rotationDegrees).toBeCloseTo(rotated.rotationDegrees, 3);
            expect(created.imageSource).toBe(`data:image/jpeg;base64,${PLACED_IMAGE_JPEG.toString('base64')}`);
            const createdPixels = await readCanonicalStampPixels(page);

            const saveEvent = await saveViaVisibleToolbar(page, 30_000);
            expect(realpathSync(String(saveEvent.detail.path))).toBe(realpathSync(fixturePath));

            copyFileSync(fixturePath, reopenPath);
            await openPdfInApp(page, reopenPath);
            await waitForPdfLoaded(page);
            await waitForViewerInteractive(page);
            await page.waitForFunction((selector: string) => {
                const stamp = document.querySelector<HTMLElement>(selector);
                const image = stamp?.querySelector<HTMLImageElement>('.pdf-annotation-editor-stamp__image');
                return Boolean(
                    stamp
                    && image?.complete
                    && image.naturalWidth > 0
                    && image.naturalHeight > 0,
                );
            }, {timeout: 30_000}, CANONICAL_STAMP_SELECTOR);

            const reopened = await readCanonicalStampSnapshot(page);
            // Native import can expose a PNG preview of the saved JPEG. Compare
            // decoded pixels exactly, alongside unchanged identity and geometry.
            expect(reopened.imageSource).toMatch(/^data:image\/(?:png|jpeg);base64,/u);
            expect(reopened.annotationId).toBe(created.annotationId);
            expect(reopened.rotationDegrees).toBe(created.rotationDegrees);
            // Allow subpixel rounding during the PDF coordinate round trip.
            // Identity, rotation, and decoded pixels must remain exact.
            for (const key of [
                'left',
                'top',
                'width',
                'height',
            ] as const) {
                expect(reopened[key], key).toBeCloseTo(created[key], 5);
            }
            expect(await readCanonicalStampPixels(page)).toEqual(createdPixels);
        }
        catch (error) {
            console.log('[stamp lifecycle failure]', await page.evaluate((selector: string) => ({
                title: document.title,
                runtimeError: document.querySelector('.runtime-error-reports')?.textContent?.trim(),
                stamps: Array.from(document.querySelectorAll(selector)).map(stamp => {
                    const image = stamp.querySelector<HTMLImageElement>('.pdf-annotation-editor-stamp__image');
                    return {
                        id: stamp.getAttribute('data-annotation-id'),
                        source: image?.getAttribute('src')?.slice(0, 160),
                        complete: image?.complete,
                        width: image?.naturalWidth,
                        height: image?.naturalHeight,
                        text: stamp.textContent,
                    };
                }),
            }), CANONICAL_STAMP_SELECTOR).catch(() => null));
            throw error;
        }
        finally {
            await uninstallManagedJpegClipboard(page);
            if (clipboardLeaseId) {
                await releaseManagedImageHandle(page, clipboardLeaseId);
                clipboardLeaseId = null;
            }
        }
    }, 120_000);

    it('creates and edits a text box through the active workspace pointer path', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Annotation lifecycle session did not start');
        }
        const { page } = session;

        const fixturePath = copyProjectFixture('freetext-lifecycle-test.pdf', `annotation-lifecycle-${Date.now()}-freetext.pdf`);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);

        const baselineCount = await getFreeTextEditorCount(page);
        const typedText = `Annotation lifecycle free text ${Date.now()}`;
        await waitForNoOpenNoteWindows(page);
        await clickAnnotationTool(page, 'Text');
        const importedSelector = '.editor-pane.is-active .page_container[data-page="1"] .pdf-annotation-editor-text-box';
        const imported = await page.$eval(importedSelector, element => {
            element.scrollIntoView({
                block: 'center',
                inline: 'center',
            });
            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            if (!element.contains(document.elementFromPoint(x, y))) {
                throw new Error('Imported text selection target is obstructed');
            }
            return {
                id: element.getAttribute('data-annotation-id'),
                x,
                y,
            };
        });
        await page.mouse.click(imported.x, imported.y);
        await expect.poll(() => page.$eval(importedSelector, element => ({
            id: element.getAttribute('data-annotation-id'),
            selected: element.classList.contains('is-selected'),
            editing: element.classList.contains('is-editing'),
        }))).toEqual({
            id: imported.id,
            selected: true,
            editing: false,
        });
        expect(await getFreeTextEditorCount(page)).toBe(baselineCount);

        const placement = await page.$eval('.editor-pane.is-active .page_container[data-page="1"]', async element => {
            element.scrollIntoView({
                block: 'center',
                inline: 'center',
            });
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            const layer = element.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
            const viewer = element.closest<HTMLElement>('.pdfViewer');
            if (!layer || !viewer) throw new Error('Text creation page is unavailable');
            const rect = layer.getBoundingClientRect();
            const viewport = viewer.getBoundingClientRect();
            for (const y of [
                0.5,
                0.65,
                0.8,
                0.4,
            ]) {
                for (const x of [
                    0.7,
                    0.5,
                    0.3,
                ]) {
                    const clientX = Math.round(rect.left + rect.width * x);
                    const clientY = Math.round(rect.top + rect.height * y);
                    if (clientX < viewport.left + 24 || clientX > viewport.right - 24
                        || clientY < viewport.top + 24 || clientY > viewport.bottom - 24) continue;
                    const hit = document.elementFromPoint(clientX, clientY);
                    if (hit?.classList.contains('pdf-annotation-editor-surface__background') && layer.contains(hit)) {
                        return {
                            x,
                            y,
                        };
                    }
                }
            }
            throw new Error('No hit-tested background point is available for text creation');
        });
        const createdCount = await createFreeTextAnnotation(page, typedText, placement);
        expect(createdCount).toBeGreaterThan(baselineCount);

        await waitForActiveWorkspaceHost(page);
        const latestTextHandle = await page.waitForFunction((expectedText: string) => {
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .filter((candidate) => {
                    const rect = candidate.getBoundingClientRect();
                    const style = window.getComputedStyle(candidate);
                    return (
                        style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && Number(style.opacity || '1') > 0
                        && rect.width > 100
                        && rect.height > 100
                    );
                });
            const host = (activeHost && visibleHosts.includes(activeHost))
                ? activeHost
                : (visibleHosts.length === 1 ? visibleHosts[0] : null);
            const editors = Array.from(host?.querySelectorAll<HTMLElement>('.pdf-annotation-editor-text-box') ?? []);
            const matchingText = editors
                .map((editor) => (editor.querySelector<HTMLElement>('[contenteditable], .internal') ?? editor).textContent ?? '')
                .map(text => text.replace(/\u200B/g, '').trim())
                .find(text => text.includes(expectedText));
            return matchingText ?? false;
        }, { timeout: 8_000 }, typedText);
        const latestText = await latestTextHandle.jsonValue();
        expect(latestText).toContain(typedText);
    });

    it('saves focused canonical text-box drafts across two saves and reopen', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Annotation lifecycle session did not start');
        }
        const {page} = session;
        const fixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-focused-text-box-save.pdf`,
            1,
        );
        const reopenPath = fixturePath.replace(/\.pdf$/u, '-reopen.pdf');
        onTestFinished(() => rmSync(reopenPath, {force: true}));

        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);

        const initialText = `Focused Привет café ’ box ${Date.now()}`;
        const firstDraft = `${initialText} first`;
        const secondDraft = `${firstDraft} second`;
        const annotationId = await createCanonicalTextBoxWithPointer(page, initialText, {
            x: 0.34,
            y: 0.28,
        });

        await openCanonicalTextBoxEditor(page, annotationId);
        await moveFocusedTextCaretToEnd(page);
        await page.keyboard.type(' first', {delay: 10});
        await expect.poll(
            () => readCanonicalTextBoxEditorState(page, annotationId),
            {timeout: 10_000},
        ).toMatchObject({
            focused: true,
            editing: true,
            text: firstDraft,
        });
        await waitForActiveTabDirtyState(page, true);

        const firstSave = await saveViaWindowHandle(page, 30_000);
        expect(realpathSync(String(firstSave.detail.path))).toBe(realpathSync(fixturePath));
        await expect.poll(
            () => readCanonicalTextBoxEditorState(page, annotationId),
            {timeout: 10_000},
        ).toMatchObject({
            editing: false,
            text: firstDraft,
        });
        await waitForActiveTabDirtyState(page, false);
        const firstRecords = (await readPdfTextAnnotationRecords(fixturePath))
            .filter(record => record.subtype === '/FreeText');
        expect(firstRecords).toEqual([expect.objectContaining({
            contents: firstDraft,
            subtype: '/FreeText',
        })]);

        await openCanonicalTextBoxEditor(page, annotationId);
        await moveFocusedTextCaretToEnd(page);
        await page.keyboard.type(' second', {delay: 10});
        await expect.poll(
            () => readCanonicalTextBoxEditorState(page, annotationId),
            {timeout: 10_000},
        ).toMatchObject({
            focused: true,
            editing: true,
            text: secondDraft,
        });
        await waitForActiveTabDirtyState(page, true);

        const secondSave = await saveViaWindowHandle(page, 30_000);
        expect(realpathSync(String(secondSave.detail.path))).toBe(realpathSync(fixturePath));
        await expect.poll(
            () => readCanonicalTextBoxEditorState(page, annotationId),
            {timeout: 10_000},
        ).toMatchObject({
            editing: false,
            text: secondDraft,
        });
        await waitForActiveTabDirtyState(page, false);
        const secondRecords = (await readPdfTextAnnotationRecords(fixturePath))
            .filter(record => record.subtype === '/FreeText');
        expect(secondRecords).toEqual([expect.objectContaining({
            contents: secondDraft,
            subtype: '/FreeText',
        })]);

        copyFileSync(fixturePath, reopenPath);
        await openPdfInApp(page, reopenPath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);
        await waitForSidebarAnnotationText(page, secondDraft);
        await page.waitForFunction((expectedText: string) => Array.from(
            document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
            ),
        ).filter(entity => entity.textContent?.replace(/[\u200B\uFEFF]/gu, '').trim() === expectedText).length === 1,
        {timeout: 30_000}, secondDraft);
        const reopenedRecords = (await readPdfTextAnnotationRecords(reopenPath))
            .filter(record => record.subtype === '/FreeText');
        expect(reopenedRecords).toEqual([expect.objectContaining({
            contents: secondDraft,
            subtype: '/FreeText',
        })]);
    }, 120_000);

    it('opens writer annotations in the canonical sidebar and excludes link annotations', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Annotation lifecycle session did not start');
        }
        const { page } = session;

        const freeTextFixturePath = copyProjectFixture(
            'freetext-lifecycle-test.pdf',
            `annotation-lifecycle-${Date.now()}-writer-parse.pdf`,
        );
        await openPdfInApp(page, freeTextFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);
        await waitForSidebarAnnotationCount(page, 3);
        await waitForSidebarAnnotationText(page, 'Reachable lifecycle note');
        await waitForSidebarAnnotationText(page, 'Reachable text box one');
        await waitForSidebarAnnotationText(page, 'Reachable text box two');

        const linkFixturePath = await createLinkOnlyFixturePdf(
            `annotation-lifecycle-${Date.now()}-link-only.pdf`,
        );
        await openPdfInApp(page, linkFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);
        await waitForSidebarAnnotationCount(page, 0);
    });

    it.each([
        'sidebar',
        'toolbar',
    ] as const)('exits note placement after a %s note even when Keep active is enabled', async (entry) => {
        const session = sessionFixture.getSession();
        if (!session) throw new Error('Annotation lifecycle session did not start');
        const {page} = session;
        const fixture = await createMultiPageTextFixturePdf(`one-shot-note-${entry}-${Date.now()}.pdf`, 1);
        onTestFinished(() => rmSync(fixture, {force: true}));
        await openPdfInApp(page, fixture);
        await waitForPdfLoaded(page);
        await clickAnnotationTool(page, 'Select');
        await setAnnotationKeepActiveWithPointer(page, true);
        if (entry === 'sidebar') {
            await clickAnnotationTool(page, 'Note');
        } else {
            const overflowPoint = await page.waitForFunction(() => {
                for (const button of document.querySelectorAll<HTMLElement>('header.toolbar .toolbar-icon-button')) {
                    const rect = button.getBoundingClientRect();
                    const x = rect.left + rect.width / 2;
                    const y = rect.top + rect.height / 2;
                    const hit = document.elementFromPoint(x, y);
                    if (rect.width > 0 && rect.height > 0 && hit && button.contains(hit)) {
                        return {
                            x,
                            y,
                        };
                    }
                }
                return false;
            });
            const overflow = await overflowPoint.jsonValue();
            await overflowPoint.dispose();
            if (!overflow) throw new Error('Visible toolbar menu is unavailable');
            await page.mouse.click(overflow.x, overflow.y);
            const menuPoint = await page.waitForFunction(() => {
                const item = Array.from(document.querySelectorAll<HTMLElement>('.overflow-menu-item'))
                    .find(candidate => candidate.textContent?.trim() === 'Add note');
                if (!item) {
                    return false;
                }
                const rect = item.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                const hit = document.elementFromPoint(x, y);
                return rect.width > 0 && hit && item.contains(hit) ? {
                    x,
                    y,
                } : false;
            });
            const target = await menuPoint.jsonValue();
            await menuPoint.dispose();
            if (!target) throw new Error('Add note menu item is unavailable');
            await page.mouse.click(target.x, target.y);
            await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('.overflow-menu')).every(menu => {
                const rect = menu.getBoundingClientRect();
                const style = getComputedStyle(menu);
                return rect.width === 0 || rect.height === 0
                    || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
            }));
        }
        const point = await resolvePageNotePoint(page);
        if (!point) {
            throw new Error('Note placement point is unavailable');
        }
        await page.mouse.click(point.x, point.y);
        await page.waitForFunction(() => document.activeElement?.matches('textarea.note-window__textarea') === true);
        await expect.poll(() => page.$eval('.editor-pane.is-active .notes-panel .tool-button.is-active', button => button.getAttribute('data-tool'))).toBe('select');
        const text = `One note from ${entry}`;
        await page.keyboard.type(text);
        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);
        await waitForSidebarAnnotationText(page, text);
        const notes = await readCanonicalNoteSnapshots(page);
        expect(notes).toHaveLength(1);
        const clearPoint = await page.evaluate(() => {
            const layer = document.querySelector<HTMLElement>('.editor-pane.is-active .pdf-annotation-editor-layer');
            if (!layer) throw new Error('Annotation layer is absent');
            const rect = layer.getBoundingClientRect();
            const x = rect.left + rect.width * 0.8;
            const y = rect.top + Math.min(rect.height, window.innerHeight - rect.top - 30) * 0.7;
            const hit = document.elementFromPoint(x, y);
            const pageContainer = layer.closest('.page_container');
            if (!hit || !pageContainer?.contains(hit) || hit.closest('[data-annotation-kind]')) {
                throw new Error('The follow-up click must hit empty page content without an annotation');
            }
            return {
                x,
                y,
            };
        });
        await page.mouse.click(clearPoint.x, clearPoint.y);
        await expectCanonicalCountsAcrossFrames(page, {
            markup: 0,
            notes: 1,
            cards: 1,
        });
        await waitForNoOpenNoteWindows(page);
        expect(await readCanonicalNoteSnapshots(page)).toEqual(notes);
    });

    it('shows a placed empty sticky note in the sidebar before text is entered', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Annotation lifecycle session did not start');
        }
        const { page } = session;

        const noteFixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-sticky-sidebar.pdf`,
            1,
        );
        await openPdfInApp(page, noteFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);

        const baselineCount = await getVisibleSidebarAnnotationCount(page);
        await placeEmptyNote(page);
        await waitForSidebarAnnotationCount(page, baselineCount + 1);

        const noteText = `Sticky sidebar text ${Date.now()}`;
        await setLatestNoteWindowText(page, noteText);
        await waitForSidebarAnnotationCount(page, baselineCount + 1);
        await waitForSidebarAnnotationText(page, noteText);

        await clickFirstSidebarAnnotationDelete(page);
        await waitForNoOpenNoteWindows(page);
        await waitForSidebarAnnotationCount(page, baselineCount);
    });

    it('round-trips a canonical sticky note after editing, recoloring, and moving it', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Annotation lifecycle session did not start');
        }
        const {page} = session;
        const fixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-sticky-round-trip.pdf`,
            1,
        );
        const noteText = `Canonical round-trip note ${Date.now()}`;
        const reopenPath = fixturePath.replace(/\.pdf$/u, '-reopen.pdf');

        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await clickAnnotationTool(page, 'Note');
        await clickVisibleAnnotationControl(page, '.editor-pane.is-active [data-annotation-inspector] .swatch[aria-label="#f59e0b"]');
        await createStickyNoteWithPointer(page, noteText, {
            x: 0.72,
            y: 0.24,
        });
        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);

        const created = await waitForCanonicalNote(page, noteText);
        if (!created.markerRect) {
            throw new Error(`Created canonical note has no marker rectangle: ${JSON.stringify(created)}`);
        }
        const initialNoteEditorCount = await getFreeTextEditorCount(page);
        await clickAnnotationTool(page, 'Select');
        const clearSelectionPoint = await page.evaluate(() => {
            const pageElement = document.querySelector<HTMLElement>('.page_container--rendered');
            if (!pageElement) {
                return null;
            }
            const rect = pageElement.getBoundingClientRect();
            return {
                x: rect.left + rect.width * 0.24,
                y: rect.top + rect.height * 0.76,
            };
        });
        if (!clearSelectionPoint) {
            throw new Error('Could not resolve a page point for clearing native note selection');
        }
        await page.mouse.click(clearSelectionPoint.x, clearSelectionPoint.y);
        await page.waitForFunction((stableKey: string) => {
            const marker = document.querySelector<HTMLElement>(
                `.pdf-annotation-editor-note[data-stable-key="${CSS.escape(stableKey)}"]`,
            );
            return marker?.classList.contains('is-selected') !== true;
        }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, created.stableKey);
        const createdMarkerCenter = await readVisibleCanonicalNoteCenter(page, created.stableKey);
        if (!createdMarkerCenter) {
            throw new Error(`Created canonical note marker was not visible: ${created.stableKey}`);
        }
        await page.mouse.move(createdMarkerCenter.x, createdMarkerCenter.y);
        await page.waitForFunction((expectedText: string) => Array.from(
            document.querySelectorAll<HTMLElement>('[role="tooltip"]'),
        ).some(element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && style.visibility !== 'hidden'
                && style.display !== 'none'
                && element.textContent?.trim() === expectedText;
        }), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, noteText);
        await page.mouse.click(createdMarkerCenter.x, createdMarkerCenter.y);
        await page.waitForSelector('.note-window', {
            timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS,
            visible: true,
        });
        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);
        const editedText = `${noteText} edited`;
        const edited = await editCanonicalNoteText(page, noteText, editedText);
        expect(edited.stableKey).toBe(created.stableKey);
        if (!edited.markerRect) {
            throw new Error(`Edited canonical note has no marker rectangle: ${JSON.stringify(edited)}`);
        }
        const oldPresentation = await readNoteColorPresentation(page, edited.stableKey);
        await recolorCanonicalNote(page, edited.stableKey, '#ef4444');
        await expect.poll(() => readNoteColorPresentation(page, edited.stableKey)).toMatchObject({
            chip: 'rgb(239, 68, 68)',
            markerColor: '#ef4444',
            windowColor: '#ef4444',
        });
        const newPresentation = await readNoteColorPresentation(page, edited.stableKey);
        expect(newPresentation.titleBackground).not.toBe(oldPresentation.titleBackground);
        expect(newPresentation.windowBorder).not.toBe(oldPresentation.windowBorder);
        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);
        await clickAnnotationTool(page, 'Select');
        const moved = await moveCanonicalNote(page, edited.stableKey, edited.markerRect);
        expect(moved.text).toBe(editedText);
        expect(moved.color).toBe('#ef4444');
        expect(moved.markerRect).not.toEqual(edited.markerRect);

        const saveEvent = await saveViaVisibleToolbar(page, 30_000);
        expect(realpathSync(String(saveEvent.detail.path))).toBe(realpathSync(fixturePath));
        const savedNotes = await readPdfTextAnnotationRecords(fixturePath);
        expect(savedNotes.filter(note => note.contents === editedText)).toEqual([expect.objectContaining({subtype: '/Text'})]);

        copyFileSync(fixturePath, reopenPath);
        onTestFinished(() => rmSync(reopenPath, {force: true}));
        await openPdfInApp(page, reopenPath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);
        await waitForSidebarAnnotationText(page, editedText);
        const reopened = await waitForCanonicalNote(page, editedText);
        expect(reopened).toMatchObject({
            color: '#ef4444',
            source: 'pdf',
            subtype: 'Text',
            text: editedText,
        });
        expect((await readNoteColorPresentation(page, reopened.stableKey)).chip).toBe('rgb(239, 68, 68)');
        // The native `/Text` writer expands the in-memory point marker to its
        // 20-point icon rectangle. Its normalized anchor remains stable.
        expectMarkerAnchorClose(reopened.markerRect, moved.markerRect);
        const secondEditText = `${editedText} second`;
        const secondEdited = await editCanonicalNoteText(page, editedText, secondEditText);
        expect(secondEdited.stableKey).toBe(reopened.stableKey);
        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);
        const secondSaveEvent = await saveViaVisibleToolbar(page, 30_000);
        expect(realpathSync(String(secondSaveEvent.detail.path))).toBe(realpathSync(reopenPath));
        const secondSavedNotes = await readPdfTextAnnotationRecords(reopenPath);
        expect(secondSavedNotes.filter(note => note.contents === secondEditText)).toEqual([expect.objectContaining({subtype: '/Text'})]);
        expect(await getFreeTextEditorCount(page)).toBe(initialNoteEditorCount);
    }, 90_000);

    it('shows foreign note replies as read-only and deletes them with their parent', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Annotation lifecycle session did not start');
        }
        const {page} = session;
        const fixture = await createForeignNoteReplyFixturePdf(
            `annotation-lifecycle-${Date.now()}-foreign-note-replies.pdf`,
        );

        await openPdfInApp(page, fixture.filePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await openAnnotationsTab(page);
        await waitForSidebarAnnotationText(page, fixture.parentText);
        const canonicalParent = await waitForCanonicalNote(page, fixture.parentText);
        expect(canonicalParent.replies.map(reply => reply.modifiedAt)).toEqual([
            Date.parse('2026-09-02T09:01:00Z'),
            Date.parse('2026-09-02T09:02:00Z'),
        ]);
        await expect.poll(() => page.evaluate((expected: {
            parentText: string;
            replyTexts: readonly string[];
        }) => {
            const row = Array.from(document.querySelectorAll<HTMLElement>('.notes-list .note-item'))
                .find(item => item.querySelector('.note-item-text')?.textContent?.includes(expected.parentText));
            if (!row) {
                return null;
            }
            return {
                replyInteractiveElements: row.querySelectorAll(
                    '.note-item-reply button, .note-item-reply input, .note-item-reply textarea, '
                    + '.note-item-reply [contenteditable="true"], .note-item-reply [role="button"]',
                ).length,
                replyTexts: Array.from(row.querySelectorAll<HTMLElement>('.note-item-reply-text'))
                    .map(reply => reply.textContent?.trim() ?? ''),
            };
        }, {
            parentText: fixture.parentText,
            replyTexts: fixture.replyTexts,
        }), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toEqual({
            replyInteractiveElements: 0,
            replyTexts: [...fixture.replyTexts],
        });

        const parentId = await page.evaluate((parentText: string) => Array.from(document.querySelectorAll<HTMLElement>('.notes-list .note-item'))
            .find(item => item.querySelector('.note-item-text')?.textContent?.includes(parentText))?.dataset.annotationId, fixture.parentText);
        if (!parentId) throw new Error('The foreign note card has no canonical identity');
        await clickVisibleAnnotationControl(page, `.note-item[data-annotation-id="${parentId}"] .note-item-delete`);
        await page.waitForFunction((parentText: string) => !Array.from(
            document.querySelectorAll<HTMLElement>('.notes-list .note-item'),
        ).some(item => item.querySelector('.note-item-text')?.textContent?.includes(parentText)), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, fixture.parentText);

        const saveEvent = await saveViaVisibleToolbar(page, 30_000);
        expect(realpathSync(String(saveEvent.detail.path))).toBe(realpathSync(fixture.filePath));
        const savedNotes = await readPdfTextAnnotationRecords(fixture.filePath);
        const deletedTexts = new Set([
            fixture.parentText,
            ...fixture.replyTexts,
        ]);
        expect(savedNotes.filter(note => deletedTexts.has(note.contents))).toHaveLength(0);
        const deletedNames = new Set([
            fixture.parentName,
            ...fixture.replyNames,
        ]);
        expect(savedNotes.filter(note => deletedNames.has(note.name))).toHaveLength(0);
        expect(savedNotes.filter(note => note.replyTo !== null)).toHaveLength(0);
    }, 90_000);

    it('persists a restored note after undo before saving a second note', async () => {
        const session = sessionFixture.getSession();
        if (!session) throw new Error('Annotation lifecycle session did not start');
        const {page} = session;
        const fixturePath = await createMultiPageTextFixturePdf(`annotation-note-two-saves-${Date.now()}.pdf`, 1);
        onTestFinished(() => rmSync(fixturePath, {force: true}));
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await createStickyNoteWithPointer(page, 'First note draft', {
            x: 0.72,
            y: 0.24,
        });
        await waitForActiveTabDirtyState(page, true);
        await saveViaVisibleToolbar(page, 30_000);
        await waitForActiveTabDirtyState(page, false);
        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);
        await editCanonicalNoteText(page, 'First note draft', 'Second note draft');
        await waitForActiveTabDirtyState(page, true);
        await saveViaVisibleToolbar(page, 30_000);
        await waitForActiveTabDirtyState(page, false);
        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);
        await clickEnabledToolbarAction(page, 'Undo');
        await waitForSidebarAnnotationText(page, 'First note draft');
        await waitForActiveTabDirtyState(page, true);
        await createStickyNoteWithPointer(page, 'Second note after undo', {
            x: 0.38,
            y: 0.46,
        });
        await waitForActiveTabDirtyState(page, true);
        await saveViaVisibleToolbar(page, 30_000);
        await waitForActiveTabDirtyState(page, false);
        expect(await getFreeTextEditorCount(page)).toBe(0);
        const records = await readPdfTextAnnotationRecords(fixturePath);
        expect(records.filter(record => record.subtype === '/Text').map(record => record.contents).sort()).toEqual([
            'First note draft',
            'Second note after undo',
        ]);
        expect(records.filter(record => record.subtype === '/FreeText')).toHaveLength(0);
        const reopenPath = preserveFixtureAcrossRestart(fixturePath);
        const restarted = await sessionFixture.restart({hard: true});
        if (!restarted) throw new Error('Hard note reopen did not start');
        await openPdfInApp(restarted.page, reopenPath);
        await waitForPdfLoaded(restarted.page);
        await openAnnotationsTab(restarted.page);
        await waitForSidebarAnnotationText(restarted.page, 'First note draft');
        await waitForSidebarAnnotationText(restarted.page, 'Second note after undo');
        const reopenedNotes = await readCanonicalNoteSnapshots(restarted.page);
        expect(reopenedNotes.map(note => note.text).sort()).toEqual([
            'First note draft',
            'Second note after undo',
        ]);
        expect(new Set(reopenedNotes.map(note => note.stableKey)).size).toBe(2);
        expect((await readPdfTextAnnotationRecords(reopenPath))
            .filter(record => record.subtype === '/Text')
            .map(record => record.contents)
            .sort()).toEqual([
            'First note draft',
            'Second note after undo',
        ]);
    }, 120_000);

    it('undoes a note created after a pointer highlight without removing that highlight', async () => {
        const session = sessionFixture.getSession();
        if (!session) throw new Error('Annotation lifecycle session did not start');
        const {page} = session;
        const fixturePath = await createMultiPageTextFixturePdf(`annotation-mixed-create-undo-${Date.now()}.pdf`, 1);
        onTestFinished(() => rmSync(fixturePath, {force: true}));
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await createTextMarkupWithPointer(page);
        const [highlight] = await readCanonicalHighlightIdentities(page);
        await placeEmptyNote(page);
        await waitForSidebarAnnotationCount(page, 2);
        await clickEnabledToolbarAction(page, 'Undo');
        await waitForNoOpenNoteWindows(page);
        await expectCanonicalCountsAcrossFrames(page, {
            markup: 1,
            notes: 0,
            cards: 1,
        });
        expect(await readCanonicalHighlightIdentities(page)).toEqual([highlight]);
    });

    it('keeps saved highlight create undo and redo coherent across intervening saves', async () => {
        const session = sessionFixture.getSession();
        if (!session) throw new Error('Annotation lifecycle session did not start');
        const {page} = session;
        const fixturePath = await createMultiPageTextFixturePdf(`annotation-save-undo-redo-${Date.now()}.pdf`, 1);
        onTestFinished(() => rmSync(fixturePath, {force: true}));
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await createTextMarkupWithPointer(page);
        await saveViaVisibleToolbar(page, 30_000);
        await waitForPdfAnnotationSubtypeCount(fixturePath, 'Highlight', 1);
        await clickEnabledToolbarAction(page, 'Undo');
        await expectCanonicalCountsAcrossFrames(page, {
            markup: 0,
            notes: 0,
            cards: 0,
        });
        await saveViaVisibleToolbar(page, 30_000);
        await waitForPdfAnnotationSubtypeCount(fixturePath, 'Highlight', 0);
        await clickEnabledToolbarAction(page, 'Redo');
        await expectCanonicalCountsAcrossFrames(page, {
            markup: 1,
            notes: 0,
            cards: 1,
        });
        await saveViaVisibleToolbar(page, 30_000);
        await waitForPdfAnnotationSubtypeCount(fixturePath, 'Highlight', 1);
        await waitForActiveTabDirtyState(page, false);
        const reopenPath = preserveFixtureAcrossRestart(fixturePath);
        const restarted = await sessionFixture.restart({hard: true});
        if (!restarted) throw new Error('Hard highlight reopen did not start');
        await openPdfInApp(restarted.page, reopenPath);
        await waitForPdfLoaded(restarted.page);
        await openAnnotationsTab(restarted.page);
        await expectCanonicalCountsAcrossFrames(restarted.page, {
            markup: 1,
            notes: 0,
            cards: 1,
        });
    }, 120_000);

    it('keeps the saved highlight identity across undo and redo without another save', async () => {
        const session = sessionFixture.getSession();
        if (!session) throw new Error('Annotation lifecycle session did not start');
        const {page} = session;
        const fixturePath = await createMultiPageTextFixturePdf(`annotation-saved-identity-${Date.now()}.pdf`, 1);
        onTestFinished(() => rmSync(fixturePath, {force: true}));
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await createTextMarkupWithPointer(page);
        await saveViaVisibleToolbar(page, 30_000);
        await waitForActiveTabDirtyState(page, false);
        const [saved] = await waitForCanonicalHighlightIdentity(page,
            identities => identities.length === 1 && Boolean(identities[0]?.annotationId), 'saved canonical highlight identity');
        expect(saved?.appAnnotationId).toEqual(expect.any(String));
        expect(saved?.annotationId).toEqual(expect.any(String));
        await clickEnabledToolbarAction(page, 'Undo');
        await expectCanonicalCountsAcrossFrames(page, {
            markup: 0,
            notes: 0,
            cards: 0,
        });
        await clickEnabledToolbarAction(page, 'Redo');
        await expectCanonicalCountsAcrossFrames(page, {
            markup: 1,
            notes: 0,
            cards: 1,
        });
        expect(await readCanonicalHighlightIdentities(page)).toEqual([saved]);
        await waitForActiveTabDirtyState(page, false);
        await waitForPdfAnnotationSubtypeCount(fixturePath, 'Highlight', 1);
    });

    it('restores a persisted highlight after saving its sidebar deletion and undoing', async () => {
        const session = sessionFixture.getSession();
        if (!session) throw new Error('Annotation lifecycle session did not start');
        const {page} = session;
        const fixturePath = await createMultiPageTextFixturePdf(`annotation-saved-delete-${Date.now()}.pdf`, 1);
        onTestFinished(() => rmSync(fixturePath, {force: true}));
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await createTextMarkupWithPointer(page);
        await saveViaVisibleToolbar(page, 30_000);
        const reopenPath = preserveFixtureAcrossRestart(fixturePath);
        const restarted = await sessionFixture.restart({hard: true});
        if (!restarted) throw new Error('Hard persisted-highlight reopen did not start');
        const reopenedPage = restarted.page;
        await openPdfInApp(reopenedPage, reopenPath);
        await waitForPdfLoaded(reopenedPage);
        await openAnnotationsTab(reopenedPage);
        await expectCanonicalCountsAcrossFrames(reopenedPage, {
            markup: 1,
            notes: 0,
            cards: 1,
        });
        const persistedHighlight = await readPaintedAnnotation(reopenedPage);
        if (!persistedHighlight) throw new Error('Reopened highlight is not painted');
        await clickFirstSidebarAnnotationDelete(reopenedPage);
        await expectCanonicalCountsAcrossFrames(reopenedPage, {
            markup: 0,
            notes: 0,
            cards: 0,
        });
        await saveViaVisibleToolbar(reopenedPage, 30_000);
        await waitForPdfAnnotationSubtypeCount(reopenPath, 'Highlight', 0);
        await waitForActiveTabDirtyState(reopenedPage, false);
        // The saved file no longer holds the highlight, but PDF.js keeps the
        // pre-save document. Its next page render must not repaint the deleted
        // highlight; a zoom step forces that render.
        expect((await callWorkspaceCommand(reopenedPage, 'handleZoomIn')).called).toBe(true);
        expect(await maxPageCanvasHighlightPixelsAcrossFrames(reopenedPage, persistedHighlight)).toBe(0);
        await clickEnabledToolbarAction(reopenedPage, 'Undo');
        await expectCanonicalCountsAcrossFrames(reopenedPage, {
            markup: 1,
            notes: 0,
            cards: 1,
        });
        await saveViaVisibleToolbar(reopenedPage, 30_000);
        await waitForPdfAnnotationSubtypeCount(reopenPath, 'Highlight', 1);
        await waitForActiveTabDirtyState(reopenedPage, false);
    }, 120_000);

    // Replaces the retired PDF.js deferred-sync proofs for both create kinds.
    for (const kind of [
        'highlight',
        'note',
    ] as const) {
        it(`keeps an undone ${kind} creation absent through subsequent animation frames`, async () => {
            const session = sessionFixture.getSession();
            if (!session) throw new Error('Annotation lifecycle session did not start');
            const {page} = session;
            const reopenPath = await createMultiPageTextFixturePdf(`annotation-no-revival-${kind}-${Date.now()}.pdf`, 1);
            onTestFinished(() => rmSync(reopenPath, {force: true}));
            await openPdfInApp(page, reopenPath);
            await waitForPdfLoaded(page);
            await waitForViewerInteractive(page);
            if (kind === 'highlight') await createTextMarkupWithPointer(page);
            else await placeEmptyNote(page);
            await waitForSidebarAnnotationCount(page, 1);
            await clickEnabledToolbarAction(page, 'Undo');
            await expectCanonicalCountsAcrossFrames(page, {
                markup: 0,
                notes: 0,
                cards: 0,
            });
            await clickEnabledToolbarAction(page, 'Redo');
            await expectCanonicalCountsAcrossFrames(page, {
                markup: kind === 'highlight' ? 1 : 0,
                notes: kind === 'note' ? 1 : 0,
                cards: 1,
            });
        });
    }

    it('restores one canonical entity and one painted markup when a deletion is undone immediately', async () => {
        const session = sessionFixture.getSession();
        if (!session) throw new Error('Annotation lifecycle session did not start');
        const {page} = session;
        const fixturePath = await createMultiPageTextFixturePdf(`annotation-immediate-delete-undo-${Date.now()}.pdf`, 1);
        onTestFinished(() => rmSync(fixturePath, {force: true}));
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await createTextMarkupWithPointer(page);
        const [identity] = await readCanonicalHighlightIdentities(page);
        await clickFirstSidebarAnnotationDelete(page);
        await clickEnabledToolbarAction(page, 'Undo');
        await expectCanonicalCountsAcrossFrames(page, {
            markup: 1,
            notes: 0,
            cards: 1,
        });
        expect(await readCanonicalHighlightIdentities(page)).toEqual([identity]);
    });
});
