import {
    afterAll,
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {
    copyFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {
    dirname,
    join,
} from 'node:path';
import { delay } from 'es-toolkit/promise';
import type { Page } from 'puppeteer-core';
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
    clickHistoryActionAcrossAnimationBoundaries,
    clickAnnotationTool,
    clickLatestVisibleNoteWindowClose,
    collectAnnotationOwnershipDebugState,
    collectStickyNoteDebugState,
    createStickyNoteWithPointer,
    createFreeTextAnnotation,
    createHighlightWithPdfjsManager,
    disconnectAnnotationUndoBoundaryProbe,
    getFreeTextEditorCount,
    getVisibleHighlightEditorCount,
    readAnnotationSyncRequestSeq,
    readAnnotationUndoBoundaryProbe,
    waitForAnnotationSyncIdle,
    waitForHighlightEditorCount,
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
    waitForWorkspaceHistorySettled,
} from '@tests/e2e/electron/helpers/viewerCore';
import { waitForActiveWorkspaceHost } from '@tests/e2e/electron/helpers/viewerDom';
import {
    callWorkspaceCommand,
    collectWorkspaceExposeDebugState,
    getWorkspaceToolbarSnapshot,
    installWorkspaceExposeProbe,
    readWorkspaceStateValues,
    type IWorkspaceExposeProbeWindow,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const NOTE_TEXT_ENTRY_TIMEOUT_MS = 20_000;
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
        const handle = await files.createManagedTempFileHandle(input.imagePath);
        const ManagedFile = new Proxy(NativeFile, {construct(target, args) {
            return Object.assign(Reflect.construct(target, args), {nativeSourceHandle: handle});
        }});
        Object.defineProperty(window, 'File', {
            configurable: true,
            value: ManagedFile,
        });
        const bytes = await files.readFile(input.imagePath);
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
    }, {imagePath});
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
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
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

async function releaseManagedImageHandle(page: Page, leaseId: string) {
    await page.evaluate(async (id: string) => {
        await window.electronAPI?.documentFiles.releaseManagedTempFileHandle?.(id);
    }, leaseId);
}

interface IAnnotationDirtyStateSnapshot extends Record<string, unknown> {dirtyState?: {hasAnnotationChanges?: boolean;};}

async function waitForActiveTabDirtyState(page: Page, expectedDirty: boolean) {
    const startedAt = Date.now();
    let actualDirty = await page.evaluate(() => (
        document.querySelector<HTMLElement>('.tab.is-active')?.classList.contains('is-dirty') ?? false
    ));
    while (Date.now() - startedAt < 10_000) {
        if (actualDirty === expectedDirty) {
            return;
        }
        await delay(100);
        actualDirty = await page.evaluate(() => (
            document.querySelector<HTMLElement>('.tab.is-active')?.classList.contains('is-dirty') ?? false
        ));
    }
    const debugState = await page.evaluate(() => {
        const api = (window as Window & { __evbTestApi?: { collectWorkspaceDebugState?: () => unknown; }; }).__evbTestApi;
        return {
            activeTabClassName: document.querySelector<HTMLElement>('.tab.is-active')?.className ?? null,
            workspace: api?.collectWorkspaceDebugState?.() ?? null,
        };
    });
    throw new Error(`Expected active tab dirty=${expectedDirty}, got ${actualDirty}; debug=${JSON.stringify(debugState)}`);
}

async function clickEnabledToolbarAction(page: Page, label: string) {
    const clickedButton = await page.evaluate((targetLabel: string) => {
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
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
            .find(candidate => (
                candidate.getAttribute('aria-label')?.trim() === targetLabel
                && isVisible(candidate)
                && !candidate.disabled
                && candidate.getAttribute('aria-disabled') !== 'true'
            ));
        button?.click();
        return Boolean(button);
    }, label);
    if (clickedButton) {
        return;
    }

    const commandName = label === 'Undo'
        ? 'handleUndo'
        : label === 'Redo'
            ? 'handleRedo'
            : null;
    const canRunKey = label === 'Undo'
        ? 'canUndo'
        : label === 'Redo'
            ? 'canRedo'
            : null;
    const toolbarSnapshot = await getWorkspaceToolbarSnapshot(page);
    const commandResult = commandName && canRunKey && toolbarSnapshot?.[canRunKey] === true
        ? await callWorkspaceCommand(page, commandName)
        : { called: false };

    if (!commandResult.called) {
        const buttonState = await page.evaluate((targetLabel: string) => {
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
            return { buttons: Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
                .filter(button => button.getAttribute('aria-label')?.trim() === targetLabel)
                .map(button => ({
                    visible: isVisible(button),
                    disabled: button.disabled,
                    ariaDisabled: button.getAttribute('aria-disabled'),
                    text: button.textContent?.trim() ?? '',
                })) };
        }, label);
        const debugState = {
            ...buttonState,
            toolbarSnapshot,
            workspaceDebug: await collectWorkspaceExposeDebugState(page),
        };
        throw new Error(`Enabled toolbar action not found: ${label}: ${JSON.stringify(debugState)}`);
    }
}

async function clickFirstSidebarAnnotationDelete(page: Page) {
    const result = await page.evaluate(() => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 100
                && rect.height > 100
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && isVisible(activeHost))
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
        const buttons = Array.from(host?.querySelectorAll<HTMLButtonElement>('.pdf-sidebar .note-item-delete') ?? [])
            .filter(button => !button.disabled && button.offsetParent !== null);
        buttons[0]?.click();
        return buttons.length;
    });

    if (result < 1) {
        throw new Error('No visible sidebar annotation delete button found');
    }
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

async function tryCreatePageNoteViaContextMenu(page: Page) {
    const point = await resolvePageNotePoint(page);
    if (!point) {
        return null;
    }

    await page.mouse.click(point.x, point.y, { button: 'right' });
    const created = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(
            '.annotation-context-menu .pdf-context-menu__action',
        ));
        const button = buttons.find(candidate =>
            (candidate.textContent ?? '').trim().toLowerCase() === 'add note here',
        );
        if (!button || button.disabled) {
            return false;
        }
        button.click();
        return true;
    });

    if (!created) {
        return null;
    }

    try {
        await page.waitForSelector('textarea.note-window__textarea', { timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS });
    } catch {
        throw new Error(`Context-menu note action did not open a note window: ${JSON.stringify(await collectStickyNoteDebugState(page))}`);
    }
    return point;
}

async function tryCreatePageNoteViaSidebarButton(page: Page) {
    const point = await resolvePageNotePoint(page);
    if (!point) {
        return null;
    }

    const started = await page.evaluate(() => {
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
        const host = activeHost && isVisible(activeHost)
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
        const button = Array.from(host?.querySelectorAll<HTMLButtonElement>(
            '.notes-list-header .notes-header-btn',
        ) ?? [])
            .filter(button => !button.disabled && isVisible(button))
            .find((button) => {
                const label = (button.getAttribute('aria-label') ?? '').trim().toLowerCase();
                return label.startsWith('place note') || label.includes('place note on page');
            });
        button?.click();
        return Boolean(button);
    });

    if (!started) {
        return null;
    }

    await page.mouse.click(point.x, point.y);
    try {
        await page.waitForSelector('textarea.note-window__textarea', { timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS });
    } catch {
        return null;
    }
    return point;
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
    const clicked = await page.evaluate((targetColor: string) => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>(
            '.annotation-context-menu-color-button',
        )).find(candidate => (
            candidate.getAttribute('aria-label')?.trim().toLowerCase() === targetColor.toLowerCase()
        ));
        button?.click();
        return Boolean(button);
    }, color);
    if (!clicked) {
        throw new Error(`Canonical note color swatch was not available: ${color}`);
    }
    await expect.poll(
        async () => (await readCanonicalNoteSnapshots(page)).find(note => note.stableKey === stableKey)?.color ?? null,
        {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS},
    ).toBe(color);
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

async function openThumbnailsTab(page: Page) {
    const result = await page.evaluate(() => {
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
        const host = activeHost && isVisible(activeHost)
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
        const sidebar = host?.querySelector<HTMLElement>('.pdf-sidebar');
        const tabList = sidebar?.querySelector<HTMLElement>('[role="tablist"]') ?? sidebar?.firstElementChild;
        const roleTabs = Array.from(tabList?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
            .filter(isVisible);
        const tabs = roleTabs.length > 0
            ? roleTabs
            : Array.from(tabList?.querySelectorAll<HTMLElement>('button') ?? [])
                .filter(isVisible);
        const pagesTab = tabs.find(tab => (
            (tab.textContent ?? '').includes('Pages')
            || (tab.getAttribute('aria-label') ?? '').includes('Pages')
            || (tab.getAttribute('title') ?? '').includes('Pages')
        )) ?? tabs[1] ?? null;
        const rect = pagesTab?.getBoundingClientRect();
        return {
            clicked: Boolean(pagesTab),
            clickPoint: rect
                ? {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                }
                : null,
            tabCount: tabs.length,
            tabText: tabs.map(tab => tab.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
        };
    });

    if (!result.clicked || !result.clickPoint) {
        throw new Error(`Could not open thumbnails tab: ${JSON.stringify(result)}`);
    }
    await page.mouse.click(result.clickPoint.x, result.clickPoint.y);

    try {
        await page.waitForFunction(() => {
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
            const host = activeHost && isVisible(activeHost)
                ? activeHost
                : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
            const thumbnail = host?.querySelector<HTMLElement>('.pdf-sidebar-pages-thumbnails .pdf-thumbnail.is-active');
            const canvas = thumbnail?.querySelector<HTMLCanvasElement>('canvas') ?? null;
            return Boolean(thumbnail && canvas && isVisible(thumbnail) && isVisible(canvas));
        }, { timeout: 8_000 });
    } catch {
        const debug = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.pdf-sidebar'))
            .map((sidebar) => {
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
                const tabs = Array.from(sidebar.querySelectorAll<HTMLElement>('[role="tab"], button'))
                    .map(tab => ({
                        visible: isVisible(tab),
                        text: tab.textContent?.replace(/\s+/g, ' ').trim() ?? '',
                        aria: tab.getAttribute('aria-label') ?? null,
                        title: tab.getAttribute('title') ?? null,
                        selected: tab.getAttribute('aria-selected') ?? null,
                        state: tab.getAttribute('data-state') ?? null,
                        classes: tab.className,
                    }));
                const pages = sidebar.querySelector<HTMLElement>('.pdf-sidebar-pages');
                const pagesRect = pages?.getBoundingClientRect();
                return {
                    sidebarVisible: isVisible(sidebar),
                    tabs,
                    pagesDisplay: pages ? window.getComputedStyle(pages).display : null,
                    pagesRect: pagesRect
                        ? {
                            width: Math.round(pagesRect.width),
                            height: Math.round(pagesRect.height),
                        }
                        : null,
                };
            }));
        throw new Error(`Could not open visible thumbnails tab: clicked=${JSON.stringify(result)} debug=${JSON.stringify(debug)}`);
    }
}

async function getActiveThumbnailYellowPixelCount(page: Page) {
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
        const host = activeHost && isVisible(activeHost)
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
        const canvas = host?.querySelector<HTMLCanvasElement>(
            '.pdf-sidebar-pages-thumbnails .pdf-thumbnail.is-active canvas',
        ) ?? null;
        if (
            !canvas
            || !isVisible(canvas)
            || canvas.width <= 0
            || canvas.height <= 0
            || canvas.dataset.thumbnailRendered !== 'true'
        ) {
            return null;
        }
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
            return null;
        }
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let yellowPixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index] ?? 0;
            const green = pixels[index + 1] ?? 0;
            const blue = pixels[index + 2] ?? 0;
            const alpha = pixels[index + 3] ?? 0;
            if (
                alpha > 120
                && red > 190
                && green > 155
                && blue < 205
                && red - blue > 35
                && green - blue > 10
            ) {
                yellowPixels += 1;
            }
        }
        return yellowPixels;
    });
}

async function waitForActiveThumbnailYellowPixelCount(
    page: Page,
    predicate: (count: number) => boolean,
    label: string,
) {
    const startedAt = Date.now();
    let count = await getActiveThumbnailYellowPixelCount(page);
    while (Date.now() - startedAt < 12_000) {
        if (typeof count === 'number' && predicate(count)) {
            return count;
        }
        await delay(200);
        count = await getActiveThumbnailYellowPixelCount(page);
    }
    const debug = await page.evaluate(() => {
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
        const host = activeHost && isVisible(activeHost)
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
        const thumbnails = Array.from(host?.querySelectorAll<HTMLElement>(
            '.pdf-sidebar-pages-thumbnails .pdf-thumbnail',
        ) ?? []);
        return {
            hostVisible: Boolean(host),
            activeTabButton: Array.from(host?.querySelectorAll<HTMLElement>('[role="tab"], button') ?? [])
                .filter(isVisible)
                .map(button => ({
                    text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
                    aria: button.getAttribute('aria-label') ?? null,
                    selected: button.getAttribute('aria-selected') ?? null,
                    state: button.getAttribute('data-state') ?? null,
                }))
                .slice(0, 8),
            thumbnails: thumbnails.map((thumbnail) => {
                const rect = thumbnail.getBoundingClientRect();
                const canvas = thumbnail.querySelector<HTMLCanvasElement>('canvas');
                return {
                    page: thumbnail.dataset.page ?? null,
                    active: thumbnail.classList.contains('is-active'),
                    visible: isVisible(thumbnail),
                    rect: {
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                    },
                    canvasWidth: canvas?.width ?? null,
                    canvasHeight: canvas?.height ?? null,
                    rendered: canvas?.dataset.thumbnailRendered ?? null,
                    renderKey: canvas?.dataset.thumbnailRenderKey ?? null,
                };
            }),
        };
    });
    throw new Error(`Timed out waiting for thumbnail yellow pixels (${label}); last count=${count}; debug=${JSON.stringify(debug)}`);
}

async function placeEmptyNote(page: Page) {
    const contextMenuPoint = await tryCreatePageNoteViaContextMenu(page);
    if (contextMenuPoint) {
        return;
    }

    const sidebarPoint = await tryCreatePageNoteViaSidebarButton(page);
    if (sidebarPoint) {
        return;
    }

    throw new Error(`Could not create sticky note through visible controls: ${JSON.stringify(await collectStickyNoteDebugState(page))}`);
}

async function setLatestNoteWindowText(page: Page, text: string) {
    await page.evaluate((noteText: string) => {
        const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea.note-window__textarea'));
        const textarea = textareas.at(-1) ?? null;
        if (!textarea) {
            throw new Error('No note window textarea found');
        }
        const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value',
        )?.set;
        setter?.call(textarea, noteText);
        textarea.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            data: noteText,
            inputType: 'insertText',
        }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }, text);
}

async function editCanonicalNoteText(page: Page, currentText: string, nextText: string) {
    const opened = await page.evaluate((expectedText: string) => {
        const row = Array.from(document.querySelectorAll<HTMLElement>('.notes-list .note-item'))
            .find(item => item.querySelector('.note-item-text')?.textContent?.includes(expectedText));
        const button = row?.querySelector<HTMLButtonElement>('.note-item-content');
        button?.dispatchEvent(new MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            detail: 2,
            view: window,
        }));
        return Boolean(button);
    }, currentText);
    if (!opened) {
        throw new Error(`Could not open canonical note for editing: ${currentText}`);
    }

    const textarea = await page.waitForSelector('textarea.note-window__textarea', {
        timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS,
        visible: true,
    });
    if (!textarea) {
        throw new Error('Canonical note editor did not provide a textarea for keyboard editing');
    }
    await textarea.click();
    const selectAllModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(selectAllModifier);
    await page.keyboard.press('A');
    await page.keyboard.up(selectAllModifier);
    await page.keyboard.type(nextText, {delay: 10});
    await page.keyboard.press('Tab');
    return waitForCanonicalNote(page, nextText);
}

describe('Electron E2E - Annotation Lifecycle', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        restartBeforeEach: true,
        sessionName: () => `e2e-annotation-lifecycle-${Date.now()}`,
    });

    // The undo boundary probe keeps its MutationObserver attached past the
    // sampled boundaries, so release it before the session shuts down.
    afterAll(async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Electron E2E session was not initialized for the writer parse proof');
        }
        await disconnectAnnotationUndoBoundaryProbe(session.page);
    });

    it('renders the canonical annotation surface once and keeps PDF.js read-only', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
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
                    '.editor-pane.is-active .page_container[data-page="1"] .annotation-editor-layer, '
                    + '.editor-pane.is-active .page_container[data-page="1"] .pdf-annotation-editor-layer',
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
            return;
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
        const focusEditorLayer = async () => {
            await page.$eval(
                '.editor-pane.is-active .page_container[data-page="1"] [data-pdf-annotation-editor-surface]',
                (element) => (element as HTMLElement).focus({preventScroll: true}),
            );
            await page.waitForFunction(() => (
                document.activeElement?.matches('[data-pdf-annotation-editor-surface]') === true
            ), {timeout: 10_000});
        };
        const clickEntity = async (id: string, additive = false) => {
            const point = await page.evaluate((annotationId: string) => {
                const entity = document.querySelector<HTMLElement>(
                    `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${annotationId}"]`,
                );
                if (!entity) {
                    return null;
                }
                const rect = entity.getBoundingClientRect();
                return {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                };
            }, id);
            if (!point) {
                throw new Error(`Canonical entity was not mounted: ${id}`);
            }
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
            await focusEditorLayer();
            const before = (await readGeometry()).find(candidate => candidate.id === entity.id);
            if (!before) {
                throw new Error(`Canonical entity geometry was not readable: ${entity.id}`);
            }
            await page.keyboard.press('ArrowRight');
            const moved = await waitForGeometry(entity.id, (initial, next) => next.left > initial.left, before);
            await page.keyboard.down('Control');
            await page.keyboard.press('z');
            await page.keyboard.up('Control');
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
            await page.keyboard.down('Control');
            await page.keyboard.down('Shift');
            await page.keyboard.press('z');
            await page.keyboard.up('Shift');
            await page.keyboard.up('Control');
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
            await page.keyboard.down('Control');
            await page.keyboard.press('z');
            await page.keyboard.up('Control');
            await page.waitForFunction((annotationId: string) => Boolean(
                document.querySelector(
                    `.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-id="${annotationId}"]`,
                ),
            ), {timeout: 10_000}, entity.id);
        }

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
        await focusEditorLayer();
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
        await focusEditorLayer();
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
        await page.keyboard.down('Control');
        await page.keyboard.press('z');
        await page.keyboard.up('Control');
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
            return;
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
            await dragImagePlacementControl(
                page,
                `${ACTIVE_IMAGE_PLACEMENT_SELECTOR} .pdf-image-placement__surface`,
                48,
                32,
            );
            await page.waitForFunction((selector: string, previousLeft: number) => {
                const frame = document.querySelector<HTMLElement>(selector);
                return frame ? Math.abs(Number.parseFloat(frame.style.left) - (previousLeft * 100)) > 0.5 : false;
            }, {timeout: 10_000}, ACTIVE_IMAGE_PLACEMENT_SELECTOR, initial.left);
            const moved = await readPendingImagePlacementSnapshot(page);
            expect(Math.abs(moved.left - initial.left)).toBeGreaterThan(0.005);
            expect(Math.abs(moved.top - initial.top)).toBeGreaterThan(0.005);

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
            expect(created.annotationId).toMatch(/^anno_/u);
            expect(created.left + (created.width / 2)).toBeCloseTo(rotated.left + (rotated.width / 2), 3);
            expect(created.top + (created.height / 2)).toBeCloseTo(rotated.top + (rotated.height / 2), 3);
            expect(created.width).toBeGreaterThan(0);
            expect(created.height).toBeGreaterThan(0);
            expect(created.rotationDegrees).toBeCloseTo(rotated.rotationDegrees, 3);
            expect(created.imageSource).toMatch(/^data:image\/png;base64,/u);

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
            expect(reopened).toEqual(created);
        }
        finally {
            await uninstallManagedJpegClipboard(page);
            if (clipboardLeaseId) {
                await releaseManagedImageHandle(page, clipboardLeaseId);
                clipboardLeaseId = null;
            }
        }
    }, 120_000);

    // Retired with #185's live PDF.js editor detachment. Canonical creation,
    // editing, note-anchor, markup, and history proofs return with #187, #188,
    // #189, and #192 against the EVB editor layer.
    it.skip('creates and edits a FreeText annotation in the active workspace', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const fixturePath = copyProjectFixture('freetext-lifecycle-test.pdf', `annotation-lifecycle-${Date.now()}-freetext.pdf`);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);

        const baselineCount = await getFreeTextEditorCount(page);
        const typedText = `Annotation lifecycle free text ${Date.now()}`;
        const createdCount = await createFreeTextAnnotation(page, typedText);
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

    it('opens writer annotations in the canonical sidebar and excludes link annotations', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
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

    it('shows a placed empty sticky note in the sidebar before text is entered', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
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
            return;
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
        const editedText = `${noteText} edited`;
        const edited = await editCanonicalNoteText(page, noteText, editedText);
        expect(edited.stableKey).toBe(created.stableKey);
        if (!edited.markerRect) {
            throw new Error(`Edited canonical note has no marker rectangle: ${JSON.stringify(edited)}`);
        }
        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);
        await recolorCanonicalNote(page, edited.stableKey, '#ef4444');
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
        // The native `/Text` writer expands the in-memory point marker to its
        // 20-point icon rectangle. Its normalized anchor remains stable.
        expectMarkerAnchorClose(reopened.markerRect, moved.markerRect);
    }, 90_000);

    it('shows foreign note replies as read-only and deletes them with their parent', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
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

        const deleted = await page.evaluate((parentText: string) => {
            const row = Array.from(document.querySelectorAll<HTMLElement>('.notes-list .note-item'))
                .find(item => item.querySelector('.note-item-text')?.textContent?.includes(parentText));
            const button = row?.querySelector<HTMLButtonElement>('.note-item-delete');
            button?.click();
            return Boolean(button);
        }, fixture.parentText);
        expect(deleted).toBe(true);
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

    it.skip('saves a persisted sticky note edit a second time without replaying its hidden anchor', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;
        const fixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-sticky-second-save.pdf`,
            1,
        );
        const firstText = `Sticky first save ${Date.now()}`;
        const secondText = `${firstText} edited`;

        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await createStickyNoteWithPointer(page, firstText, {
            x: 0.72,
            y: 0.24,
        });
        await waitForActiveTabDirtyState(page, true);

        const firstCommit = await saveViaVisibleToolbar(page, 30_000);
        expect(realpathSync(String(firstCommit.detail.path))).toBe(realpathSync(fixturePath));
        await waitForActiveTabDirtyState(page, false);
        const cleanState = await readWorkspaceStateValues<IAnnotationDirtyStateSnapshot>(page, ['dirtyState']);
        expect(cleanState.dirtyState?.hasAnnotationChanges).toBe(false);
        const firstSaveDebug = await collectStickyNoteDebugState(page);
        const firstSaveStickyNotes = (firstSaveDebug.annotationComments ?? [])
            .filter(comment => comment.hasNote === true);
        expect(firstSaveStickyNotes).toHaveLength(1);
        expect(firstSaveStickyNotes[0]?.text).toBe(firstText);
        const firstSaveEditorCount = await getFreeTextEditorCount(page);

        const textarea = await page.waitForSelector('textarea.note-window__textarea', {
            timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS,
            visible: true,
        });
        if (!textarea) {
            throw new Error('Saved sticky note did not retain its visible editor');
        }
        await textarea.click({
            count: 3,
            delay: 80,
        });
        const selectedText = await textarea.evaluate(input => ({
            end: input.selectionEnd,
            length: input.value.length,
            start: input.selectionStart,
        }));
        expect(selectedText).toEqual({
            end: firstText.length,
            length: firstText.length,
            start: 0,
        });
        await page.keyboard.type(secondText, {delay: 10});
        await page.keyboard.press('Tab');
        await waitForActiveTabDirtyState(page, true);

        const preSecondSaveDebug = await collectStickyNoteDebugState(page);
        let secondCommit;
        try {
            secondCommit = await saveViaVisibleToolbar(page, 30_000);
        } catch (error) {
            throw new Error(`Second sticky-note save failed: ${JSON.stringify({
                cause: error instanceof Error ? error.message : String(error),
                debug: await collectStickyNoteDebugState(page),
                preSecondSaveDebug,
            })}`, {cause: error});
        }
        expect(realpathSync(String(secondCommit.detail.path))).toBe(realpathSync(fixturePath));
        await waitForActiveTabDirtyState(page, false);
        const secondCleanState = await readWorkspaceStateValues<IAnnotationDirtyStateSnapshot>(page, ['dirtyState']);
        expect(secondCleanState.dirtyState?.hasAnnotationChanges).toBe(false);
        const secondSaveDebug = await collectStickyNoteDebugState(page);
        const secondSaveStickyNotes = (secondSaveDebug.annotationComments ?? [])
            .filter(comment => comment.hasNote === true);
        expect(secondSaveStickyNotes).toHaveLength(1);
        expect(secondSaveStickyNotes[0]?.text).toBe(secondText);
        expect(await getFreeTextEditorCount(page)).toBe(firstSaveEditorCount);
    }, 90_000);

    it.skip('undoes a sticky note created after a highlight without removing the highlight', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const noteFixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-highlight-then-note-undo.pdf`,
            1,
        );
        await openPdfInApp(page, noteFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);

        const baselineHighlightCount = await getVisibleHighlightEditorCount(page);
        const baselineSidebarCount = await getVisibleSidebarAnnotationCount(page);
        await createHighlightWithPdfjsManager(page);
        await waitForHighlightEditorCount(page, baselineHighlightCount + 1);
        await waitForSidebarAnnotationCount(page, baselineSidebarCount + 1);

        await placeEmptyNote(page);
        await waitForSidebarAnnotationCount(page, baselineSidebarCount + 2);

        await clickEnabledToolbarAction(page, 'Undo');

        await waitForNoOpenNoteWindows(page);
        await waitForSidebarAnnotationCount(page, baselineSidebarCount + 1);
        await waitForHighlightEditorCount(page, baselineHighlightCount + 1);
    });

    it.skip('keeps highlight undo and redo coherent after saving', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const highlightFixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-highlight.pdf`,
            1,
        );
        await openPdfInApp(page, highlightFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);

        const baselineCount = await getVisibleHighlightEditorCount(page);
        const createdCount = await createHighlightWithPdfjsManager(page);
        expect(createdCount).toBeGreaterThan(baselineCount);
        await waitForActiveTabDirtyState(page, true);
        await openThumbnailsTab(page);
        await waitForActiveThumbnailYellowPixelCount(
            page,
            count => count > 80,
            'live highlight visible before save',
        );
        await openAnnotationsTab(page);

        await saveViaWindowHandle(page);
        await waitForHighlightEditorCount(page, baselineCount + 1);
        await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 1);
        await waitForActiveTabDirtyState(page, false);
        const [savedIdentity] = await waitForCanonicalHighlightIdentity(
            page,
            identities => identities.length === 1 && identities[0]?.source === 'pdf',
            'the saved highlight to carry its persisted identity',
        );
        expect(savedIdentity?.annotationId).toEqual(expect.any(String));
        expect(savedIdentity?.stableKey).toMatch(/^ann:0:/u);

        await clickEnabledToolbarAction(page, 'Undo');
        await waitForHighlightEditorCount(page, baselineCount);
        await waitForActiveTabDirtyState(page, true);
        await openThumbnailsTab(page);
        await waitForActiveThumbnailYellowPixelCount(
            page,
            count => count < 20,
            'undone live highlight hidden before save',
        );
        await openAnnotationsTab(page);

        await saveViaWindowHandle(page);
        const deletedSummary = await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 0);
        expect(deletedSummary.bySubtype.Highlight ?? 0).toBe(0);
        await waitForHighlightEditorCount(page, baselineCount);
        await waitForActiveTabDirtyState(page, false);

        await clickEnabledToolbarAction(page, 'Redo');
        await waitForHighlightEditorCount(page, baselineCount + 1);
        await waitForActiveTabDirtyState(page, true);

        await saveViaWindowHandle(page);
        const summary = await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 1);
        expect(summary.bySubtype.Highlight ?? 0).toBe(1);
        await waitForActiveTabDirtyState(page, false);
        // The intervening save wrote the document without the undone create, so
        // the redone annotation was rebound to the ref this revision holds.
        const [reboundIdentity] = await waitForCanonicalHighlightIdentity(
            page,
            identities => identities.length === 1 && identities[0]?.source === 'pdf',
            'the re-saved highlight to carry a persisted identity again',
        );
        expect(reboundIdentity?.annotationId).toEqual(expect.any(String));
        expect(reboundIdentity?.stableKey).toMatch(/^ann:0:/u);
    });

    it.skip('keeps the saved highlight identity across an undo and redo', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Annotation lifecycle Electron E2E session failed to start');
        }
        const { page } = session;

        const highlightFixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-highlight-identity.pdf`,
            1,
        );
        await openPdfInApp(page, highlightFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);

        const baselineCount = await getVisibleHighlightEditorCount(page);
        await createHighlightWithPdfjsManager(page);
        await waitForHighlightEditorCount(page, baselineCount + 1);

        await saveViaWindowHandle(page);
        await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 1);
        await waitForActiveTabDirtyState(page, false);
        const [savedIdentity] = await waitForCanonicalHighlightIdentity(
            page,
            identities => identities.length === 1 && identities[0]?.source === 'pdf',
            'the saved highlight to carry its persisted identity',
        );
        // The comparisons below are only evidence if the save actually bound a
        // ref: matching two absent ids would pass while proving nothing.
        expect(savedIdentity?.annotationId).toEqual(expect.any(String));
        expect(savedIdentity?.appAnnotationId).toEqual(expect.any(String));

        await clickEnabledToolbarAction(page, 'Undo');
        await waitForHighlightEditorCount(page, baselineCount);
        await clickEnabledToolbarAction(page, 'Redo');
        await waitForHighlightEditorCount(page, baselineCount + 1);

        // No save ran between the undo and the redo, so the file still holds the
        // annotation the acknowledgement bound: the redone entity has to come
        // back as that saved annotation, not as a fresh unsaved one.
        const redoneIdentities = await waitForCanonicalHighlightIdentity(
            page,
            identities => identities.some(identity => (
                identity.appAnnotationId === savedIdentity?.appAnnotationId
            )),
            'the redone highlight to be projected under its canonical id',
        );
        const redoneIdentity = redoneIdentities.find(identity => (
            identity.appAnnotationId === savedIdentity?.appAnnotationId
        ));
        expect(redoneIdentity).toMatchObject({
            annotationId: savedIdentity?.annotationId,
            source: 'pdf',
            stableKey: savedIdentity?.stableKey,
        });

        await saveViaWindowHandle(page);
        const summary = await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 1);
        expect(summary.bySubtype.Highlight ?? 0).toBe(1);
        await waitForActiveTabDirtyState(page, false);
    });

    it.skip('restores a persisted highlight when undoing a saved sidebar delete', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const highlightFixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-persisted-highlight-delete.pdf`,
            1,
        );
        await openPdfInApp(page, highlightFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);

        const baselineCount = await getVisibleHighlightEditorCount(page);
        await createHighlightWithPdfjsManager(page);
        await saveViaWindowHandle(page);
        await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 1);
        await waitForActiveTabDirtyState(page, false);

        const reopenFixturePath = highlightFixturePath.replace(/\.pdf$/u, '-reopen.pdf');
        copyFileSync(highlightFixturePath, reopenFixturePath);
        await openPdfInApp(page, reopenFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForHighlightEditorCount(page, baselineCount + 1);
        await openThumbnailsTab(page);
        const highlightedThumbnailYellowCount = await waitForActiveThumbnailYellowPixelCount(
            page,
            count => count > 80,
            'persisted highlight visible in thumbnail',
        );
        await openAnnotationsTab(page);

        await clickFirstSidebarAnnotationDelete(page);
        await waitForHighlightEditorCount(page, baselineCount);
        await waitForActiveTabDirtyState(page, true);
        await openThumbnailsTab(page);
        const deletedThumbnailYellowCount = await waitForActiveThumbnailYellowPixelCount(
            page,
            count => count <= Math.max(20, Math.floor(highlightedThumbnailYellowCount * 0.25)),
            'deleted persisted highlight hidden in thumbnail',
        );
        expect(deletedThumbnailYellowCount).toBeLessThan(highlightedThumbnailYellowCount);
        await openAnnotationsTab(page);

        await saveViaWindowHandle(page);
        await waitForPdfAnnotationSubtypeCount(reopenFixturePath, 'Highlight', 0);
        await waitForActiveTabDirtyState(page, false);

        await clickEnabledToolbarAction(page, 'Undo');
        await waitForHighlightEditorCount(page, baselineCount + 1);
        await waitForActiveTabDirtyState(page, true);
        await waitForWorkspaceHistorySettled(page);

        await saveViaWindowHandle(page);
        const restoredSummary = await waitForPdfAnnotationSubtypeCount(reopenFixturePath, 'Highlight', 1);
        expect(restoredSummary.bySubtype.Highlight ?? 0).toBe(1);
        await waitForActiveTabDirtyState(page, false);
    });

    it.skip('keeps an undone toolbar highlight create removed across frames and the deferred sync', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const fixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-undo-create-orphan.pdf`,
            1,
        );
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);

        const baselineSidebarCount = await getVisibleSidebarAnnotationCount(page);
        await createHighlightWithPdfjsManager(page);
        await waitForHighlightEditorCount(page, 1);
        await waitForSidebarAnnotationCount(page, baselineSidebarCount + 1);
        await waitForCanonicalHighlightIdentity(
            page,
            identities => identities.length === 1,
            'the live highlight to be projected canonically',
        );

        const boundary = await clickHistoryActionAcrossAnimationBoundaries(page, 'Undo');
        const trace = `undo boundary trace: ${JSON.stringify(boundary.samples)}`;

        expect(boundary.at('before'), trace).toMatchObject({
            canonicalTextMarkupCount: 1,
            highlightAnnotationCount: 0,
            canonicalHighlightCount: 1,
        });
        // One undo has to retire the annotation and its PDF.js editor in the
        // same task: an editor that outlives the annotation is the orphan a
        // later comment sync rescans back into existence.
        expect(boundary.at('synchronous'), trace).toMatchObject({
            canonicalTextMarkupCount: 0,
            highlightAnnotationCount: 0,
            canonicalHighlightCount: 0,
        });
        // Removal records are delivered after the synchronous task, so the
        // first frame is the earliest sample that can name the removed node.
        expect(boundary.at('frame-1').removedHighlightNodeIds, trace).toHaveLength(1);
        // Same layer tags before and after: the editor node went away, the
        // editor layer did not get torn down and rebuilt under it.
        expect(boundary.at('frame-2').editorLayerTags, trace).toEqual(boundary.at('before').editorLayerTags);
        [
            'frame-1',
            'frame-2',
            'deferred-task',
        ].forEach((label) => {
            const sample = boundary.at(label);
            expect(sample.canonicalTextMarkupCount, `${label}: ${trace}`).toBe(0);
            expect(sample.highlightAnnotationCount, `${label}: ${trace}`).toBe(0);
            expect(sample.canonicalHighlightCount, `${label}: ${trace}`).toBe(0);
            expect(sample.addedHighlightNodeIds, `${label}: ${trace}`).toEqual([]);
        });

        await waitForCanonicalHighlightIdentity(
            page,
            identities => identities.length === 0,
            'the undone highlight to leave the canonical projection',
        );
        // A later annotation mutation forces a full deferred comment sync to
        // run and finish after the undo. If the editor had survived, that scan
        // would recreate the entity it carries.
        const syncBaselineSeq = await readAnnotationSyncRequestSeq(page);
        await placeEmptyNote(page);
        await waitForSidebarAnnotationCount(page, baselineSidebarCount + 1);
        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);
        // The sidebar settles from the canonical projection, which the sync's
        // editor scan could still overwrite once its PDF snapshot resolves, so
        // the resurrection check waits for that sync to actually finish.
        await waitForAnnotationSyncIdle(page, syncBaselineSeq);

        const afterDeferredSync = await readAnnotationUndoBoundaryProbe(page);
        expect(afterDeferredSync.added).toEqual([]);
        expect(afterDeferredSync.canonicalTextMarkupCount).toBe(0);
        expect(afterDeferredSync.highlightAnnotationCount).toBe(0);
        expect(await readCanonicalHighlightIdentities(page)).toEqual([]);
    });

    it.skip('restores the editor, DOM, and canonical entity when a deferred delete is undone', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const fixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-deferred-delete-undo.pdf`,
            1,
        );
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);

        await createHighlightWithPdfjsManager(page);
        await saveViaWindowHandle(page);
        await waitForPdfAnnotationSubtypeCount(fixturePath, 'Highlight', 1);
        await waitForActiveTabDirtyState(page, false);

        const reopenFixturePath = fixturePath.replace(/\.pdf$/u, '-reopen.pdf');
        copyFileSync(fixturePath, reopenFixturePath);
        await openPdfInApp(page, reopenFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);
        await waitForHighlightEditorCount(page, 1);
        const [persistedIdentity] = await waitForCanonicalHighlightIdentity(
            page,
            identities => identities.length === 1 && identities[0]?.source === 'pdf',
            'the reopened highlight to carry its persisted identity',
        );

        // The sidebar delete of a persisted annotation takes the deferred path:
        // a canonical tombstone plus DOM removal, with no save in between.
        await clickFirstSidebarAnnotationDelete(page);
        await waitForHighlightEditorCount(page, 0);
        await waitForActiveTabDirtyState(page, true);

        const boundary = await clickHistoryActionAcrossAnimationBoundaries(page, 'Undo');
        const trace = `deferred-delete undo boundary trace: ${JSON.stringify(boundary.samples)}`;
        expect(boundary.at('before'), trace).toMatchObject({
            canonicalTextMarkupCount: 0,
            highlightAnnotationCount: 0,
        });

        await waitForCanonicalHighlightIdentity(
            page,
            identities => identities.some(identity => (
                identity.appAnnotationId === persistedIdentity?.appAnnotationId
            )),
            'the undone delete to restore the canonical entity',
        );
        await waitForHighlightEditorCount(page, 1);

        const afterRestore = await readAnnotationUndoBoundaryProbe(page);
        expect(
            afterRestore.added.length,
            `expected a restored highlight node: ${JSON.stringify(afterRestore)}`,
        ).toBeGreaterThan(0);
        expect(afterRestore.canonicalTextMarkupCount + afterRestore.highlightAnnotationCount).toBe(1);

        const restored = (await readCanonicalHighlightIdentities(page))
            .find(identity => identity.appAnnotationId === persistedIdentity?.appAnnotationId);
        expect(restored).toMatchObject({
            annotationId: persistedIdentity?.annotationId,
            source: 'pdf',
            stableKey: persistedIdentity?.stableKey,
        });
    });


    it.skip('keeps an undone sticky note removed across frames and the deferred sync', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const fixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-undo-note-orphan.pdf`,
            1,
        );
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);

        const baselineSidebarCount = await getVisibleSidebarAnnotationCount(page);
        const baselineFreeTextCount = await getFreeTextEditorCount(page);
        await placeEmptyNote(page);
        await waitForSidebarAnnotationCount(page, baselineSidebarCount + 1);
        expect(await getFreeTextEditorCount(page)).toBe(baselineFreeTextCount + 1);
        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);

        const boundary = await clickHistoryActionAcrossAnimationBoundaries(page, 'Undo');
        const trace = `sticky-note undo boundary trace: ${JSON.stringify(boundary.samples)}`;
        expect(boundary.at('before').canonicalAnnotationCount, trace).toBe(baselineSidebarCount + 1);
        // A FreeText anchor editor has no PDF.js creation command of its own, so
        // the canonical undo is the only thing that can retire it. If it stays
        // attached, the next comment sync rescans it and mints the note back.
        expect(boundary.at('synchronous'), trace).toMatchObject({
            canonicalAnnotationCount: baselineSidebarCount,
            canonicalTextBoxCount: baselineFreeTextCount,
        });
        [
            'frame-1',
            'frame-2',
            'deferred-task',
        ].forEach((label) => {
            expect(boundary.at(label).canonicalTextBoxCount, `${label}: ${trace}`).toBe(baselineFreeTextCount);
        });

        await waitForSidebarAnnotationCount(page, baselineSidebarCount);
        // Force a full comment sync to run and finish after the undo.
        const syncBaselineSeq = await readAnnotationSyncRequestSeq(page);
        await createHighlightWithPdfjsManager(page);
        await waitForSidebarAnnotationCount(page, baselineSidebarCount + 1);
        // Same reason as the highlight scenario: only the sync ledger proves
        // the pass that rescans the editor layer has completed.
        await waitForAnnotationSyncIdle(page, syncBaselineSeq);
        expect(await getFreeTextEditorCount(page)).toBe(baselineFreeTextCount);
    });


});
