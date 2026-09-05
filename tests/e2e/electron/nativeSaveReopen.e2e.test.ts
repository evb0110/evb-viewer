import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {stat} from 'node:fs/promises';
import {
    copyProjectFixture,
    createCanonicalAnnotationSurfaceFixturePdf,
    createMultiPageTextFixturePdf,
    createOutlinePageLabelFixturePdf,
    readFreeTextObjectByName,
    readPdfMetadataWithQpdf,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    openAnnotationsTab,
    saveViaWindowHandle,
    waitForActiveDocumentSource,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    clickAnnotationTool,
    setAnnotationColor,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    callWorkspaceCommand,
    readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    startElectronE2ESession,
    type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';
import type {KeyInput} from 'puppeteer-core';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';
import type { TAnnotationResizeHandle } from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';

const NATIVE_SAVE_REOPEN_TIMEOUT_MS = 120_000;
const OUTLINE_METADATA_MATRIX_TIMEOUT_MS = 15 * 60_000;

interface IAgentActionResult extends Record<string, unknown> {
    comment?: Record<string, unknown>;
    markerRect?: unknown;
    tabId?: string;
    updated?: boolean;
}

interface ICanonicalAnnotationSnapshot {
    comments: Array<Record<string, unknown>>;
    shapes: Array<Record<string, unknown>>;
}

interface IDisplayRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface IAnnotationDirtyState {
    annotationDirty?: boolean;
    fileDirty?: boolean;
    annotationDirtyEntityCount?: number;
    hasPendingUnsavedChanges?: boolean;
}

interface IQpdfOutline {
    title?: string;
    destpageposfrom1?: number;
    kids?: IQpdfOutline[];
}

interface IAutomationFileOpenGrantWindow extends IE2EWindow {__allowRendererFileOpenForAutomation?: (value: string) => Promise<boolean>;}

function flattenQpdfOutlines(outlines: IQpdfOutline[]): Array<{
    title: string;
    page: number;
    depth: number
}> {
    return outlines.flatMap(outline => [
        ...(typeof outline.title === 'string' && typeof outline.destpageposfrom1 === 'number'
            ? [{
                title: outline.title,
                page: outline.destpageposfrom1,
                depth: 0,
            }]
            : []),
        ...flattenQpdfOutlines(outline.kids ?? []).map(item => ({
            ...item,
            depth: item.depth + 1,
        })),
    ]);
}

async function waitForOpenedPdf(session: IElectronE2ESession, path: string) {
    // Startup events can predate the CDP attachment after a fresh-process
    // reopen. Verify the exact active source and rendered UI instead.
    await waitForActiveDocumentSource(session.page, path, 45_000);
    await waitForPdfLoaded(session.page, 45_000);
    await waitForViewerInteractive(session.page, 45_000);
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function numberField(record: Record<string, unknown>, name: string) {
    const value = record[name];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringField(record: Record<string, unknown>, name: string) {
    const value = record[name];
    return typeof value === 'string' ? value : null;
}

function pdfUtf16BeHex(value: string) {
    return Array.from(`\uFEFF${value}`)
        .map(character => character.charCodeAt(0).toString(16).padStart(4, '0'))
        .join('');
}

function qpdfObjectContainsText(value: string, text: string) {
    return value.includes(text)
        || value.replaceAll(/\s+/gu, '').toLowerCase().includes(pdfUtf16BeHex(text));
}

function roundGeometry(value: number) {
    return Math.round(value * 10_000) / 10_000;
}

function normalizedRect(value: unknown): IDisplayRect | null {
    const record = asRecord(value);
    if (!record) {
        return null;
    }
    const left = numberField(record, 'left');
    const top = numberField(record, 'top');
    const width = numberField(record, 'width');
    const height = numberField(record, 'height');
    return left === null || top === null || width === null || height === null
        ? null
        : {
            left: roundGeometry(left),
            top: roundGeometry(top),
            width: roundGeometry(width),
            height: roundGeometry(height),
        };
}

function normalizedPoints(value: unknown): unknown {
    if (!Array.isArray(value)) {
        return null;
    }
    return value.map((point) => {
        if (Array.isArray(point)) {
            return normalizedPoints(point);
        }
        const record = asRecord(point);
        if (!record) {
            return point;
        }
        const x = numberField(record, 'x');
        const y = numberField(record, 'y');
        return x === null || y === null
            ? point
            : {
                x: roundGeometry(x),
                y: roundGeometry(y),
            };
    });
}

function canonicalAnnotationFingerprint(snapshot: ICanonicalAnnotationSnapshot) {
    const comments = snapshot.comments.map(comment => ({
        pageIndex: numberField(comment, 'pageIndex'),
        text: stringField(comment, 'text'),
        subtype: stringField(comment, 'subtype'),
        color: stringField(comment, 'color'),
        fillColor: stringField(comment, 'fillColor'),
        opacity: numberField(comment, 'opacity') === null
            ? null
            : roundGeometry(numberField(comment, 'opacity')!),
        strokeWidth: numberField(comment, 'strokeWidth') === null
            ? null
            : roundGeometry(numberField(comment, 'strokeWidth')!),
        markerRect: normalizedRect(comment.markerRect),
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const shapes = snapshot.shapes.map(shape => ({
        pageIndex: numberField(shape, 'pageIndex'),
        pdfSubtype: stringField(shape, 'pdfSubtype'),
        x: numberField(shape, 'x') === null ? null : roundGeometry(numberField(shape, 'x')!),
        y: numberField(shape, 'y') === null ? null : roundGeometry(numberField(shape, 'y')!),
        width: numberField(shape, 'width') === null ? null : roundGeometry(numberField(shape, 'width')!),
        height: numberField(shape, 'height') === null ? null : roundGeometry(numberField(shape, 'height')!),
        x2: numberField(shape, 'x2') === null ? null : roundGeometry(numberField(shape, 'x2')!),
        y2: numberField(shape, 'y2') === null ? null : roundGeometry(numberField(shape, 'y2')!),
        color: stringField(shape, 'color'),
        fillColor: stringField(shape, 'fillColor'),
        opacity: numberField(shape, 'opacity') === null ? null : roundGeometry(numberField(shape, 'opacity')!),
        strokeWidth: numberField(shape, 'strokeWidth') === null ? null : roundGeometry(numberField(shape, 'strokeWidth')!),
        points: normalizedPoints(shape.points),
        strokes: normalizedPoints(shape.strokes),
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return JSON.stringify({
        comments,
        shapes,
    });
}

async function readCanonicalAnnotationSnapshot(page: Parameters<typeof evaluateInPage>[0]): Promise<ICanonicalAnnotationSnapshot> {
    return page.evaluate(async (): Promise<ICanonicalAnnotationSnapshot> => {
        const api = (window as IE2EWindow).__evbTestApi;
        const copyValue = (value: unknown): unknown => {
            if (Array.isArray(value)) {
                return value.map(copyValue);
            }
            if (value !== null && typeof value === 'object') {
                return Object.fromEntries(
                    Object.entries(value).map(([
                        key,
                        nestedValue,
                    ]) => [
                        key,
                        copyValue(nestedValue),
                    ]),
                );
            }
            return value;
        };
        const state = api?.readActiveWorkspaceStateValues<{annotationComments?: unknown[]}>(['annotationComments']);
        const shapeResult = await api?.callActiveWorkspaceCommand<unknown[]>('getAllShapes');
        const comments = Array.isArray(state?.annotationComments)
            ? state.annotationComments.flatMap(comment => {
                const copied = copyValue(comment);
                return copied !== null && typeof copied === 'object' && !Array.isArray(copied)
                    ? [copied as Record<string, unknown>]
                    : [];
            })
            : [];
        const shapes = Array.isArray(shapeResult?.value)
            ? shapeResult.value.flatMap(shape => {
                const copied = copyValue(shape);
                return copied !== null && typeof copied === 'object' && !Array.isArray(copied)
                    ? [copied as Record<string, unknown>]
                    : [];
            })
            : [];
        return {
            comments,
            shapes,
        };
    });
}

async function waitForParsedTextBoxComment(page: Parameters<typeof evaluateInPage>[0]) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        const snapshot = await readCanonicalAnnotationSnapshot(page);
        const textBox = snapshot.comments.find(comment => (
            stringField(comment, 'subtype') === 'FreeText'
            && typeof comment.stableKey === 'string'
            && normalizedRect(comment.markerRect) !== null
        ));
        if (textBox) {
            return textBox;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The parsed canonical text box was not published');
}

async function readTextBoxDisplayRect(page: Parameters<typeof evaluateInPage>[0]): Promise<IDisplayRect | null> {
    return evaluateInPage(page, () => {
        const pageContainer = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .page_container[data-page="1"]',
        );
        const textBox = pageContainer?.querySelector<HTMLElement>('[data-annotation-kind="text-box"]');
        if (!pageContainer || !textBox) {
            return null;
        }
        const pageRect = pageContainer.getBoundingClientRect();
        const boxRect = textBox.getBoundingClientRect();
        if (pageRect.width <= 0 || pageRect.height <= 0) {
            return null;
        }
        return {
            left: (boxRect.left - pageRect.left) / pageRect.width,
            top: (boxRect.top - pageRect.top) / pageRect.height,
            width: boxRect.width / pageRect.width,
            height: boxRect.height / pageRect.height,
        };
    });
}

async function waitForTextBoxDisplay(page: Parameters<typeof evaluateInPage>[0]) {
    await page.waitForFunction(() => Boolean(document.querySelector(
        '.editor-pane.is-active .page_container[data-page="1"] [data-annotation-kind="text-box"]',
    )), {timeout: 20_000});
}

function findTextBoxComment(
    snapshot: ICanonicalAnnotationSnapshot,
    expectedText?: string,
) {
    return snapshot.comments.find(comment => (
        stringField(comment, 'subtype') === 'FreeText'
        && normalizedRect(comment.markerRect) !== null
        && (expectedText === undefined || stringField(comment, 'text') === expectedText)
    )) ?? null;
}

function findTextBoxById(snapshot: ICanonicalAnnotationSnapshot, annotationId: string) {
    return snapshot.comments.find(comment => (
        stringField(comment, 'subtype') === 'FreeText'
        && stringField(comment, 'appAnnotationId') === annotationId
    )) ?? null;
}

async function readPagePoint(
    page: Parameters<typeof evaluateInPage>[0],
    xRatio: number,
    yRatio: number,
) {
    return page.evaluate((ratios: {
        x: number;
        y: number;
    }) => {
        const pageContainer = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .page_container[data-page="1"]',
        );
        if (!pageContainer) {
            return null;
        }
        pageContainer.scrollIntoView({
            block: 'center',
            inline: 'center',
        });
        const rect = pageContainer.getBoundingClientRect();
        return {
            x: rect.left + rect.width * ratios.x,
            y: rect.top + rect.height * ratios.y,
        };
    }, {
        x: xRatio,
        y: yRatio,
    });
}

async function readTextBoxScreenPoints(
    page: Parameters<typeof evaluateInPage>[0],
    handle: TAnnotationResizeHandle | null = null,
) {
    return page.evaluate((requestedHandle: TAnnotationResizeHandle | null) => {
        const pageContainer = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .page_container[data-page="1"]',
        );
        const textBox = pageContainer?.querySelector<HTMLElement>('[data-annotation-kind="text-box"]');
        if (!pageContainer || !textBox) {
            return null;
        }
        const pageRect = pageContainer.getBoundingClientRect();
        const boxRect = textBox.getBoundingClientRect();
        const handleElement = requestedHandle
            ? pageContainer.querySelector<HTMLElement>(
                `[data-pdf-annotation-resize-handle="${requestedHandle}"]`,
            )
            : null;
        const handleRect = handleElement?.getBoundingClientRect();
        return {
            page: {
                left: pageRect.left,
                top: pageRect.top,
                right: pageRect.right,
                bottom: pageRect.bottom,
            },
            box: {
                left: boxRect.left,
                top: boxRect.top,
                right: boxRect.right,
                bottom: boxRect.bottom,
                width: boxRect.width,
                height: boxRect.height,
            },
            style: {
                color: window.getComputedStyle(textBox).color,
                fontSize: window.getComputedStyle(textBox).fontSize,
            },
            handle: handleRect
                ? {
                    x: handleRect.left + handleRect.width / 2,
                    y: handleRect.top + handleRect.height / 2,
                }
                : null,
        };
    }, handle);
}

async function readTextBoxComputedStyle(
    page: Parameters<typeof evaluateInPage>[0],
    annotationId?: string,
) {
    return page.evaluate((id: string | null) => {
        const textBoxes = Array.from(document.querySelectorAll<HTMLElement>(
            '[data-annotation-kind="text-box"]',
        ));
        const textBox = id === null
            ? textBoxes[0]
            : textBoxes.find(candidate => candidate.dataset.annotationId === id);
        if (!textBox) {
            return null;
        }
        const style = window.getComputedStyle(textBox);
        const scaleFactor = Number.parseFloat(style.getPropertyValue('--scale-factor')) || 1;
        const userUnit = Number.parseFloat(style.getPropertyValue('--user-unit')) || 1;
        const fontSizeCssPixels = Number.parseFloat(style.fontSize);
        return {
            color: style.color,
            fontSize: Number.isFinite(fontSizeCssPixels)
                ? Number((fontSizeCssPixels / (scaleFactor * userUnit)).toFixed(3))
                : null,
        };
    }, annotationId ?? null);
}

async function readFirstTextBoxComputedStyle(page: Parameters<typeof evaluateInPage>[0]) {
    return readTextBoxComputedStyle(page);
}

async function increaseSelectedTextBoxFontSize(page: Parameters<typeof evaluateInPage>[0]) {
    await page.waitForSelector('.annotation-style-popover .style-step-button', {
        visible: true,
        timeout: 20_000,
    });
    const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(
            '.annotation-style-popover .style-step-button',
        ));
        const increaseButton = buttons.at(-1);
        if (!increaseButton) {
            return false;
        }
        increaseButton.click();
        return true;
    });
    if (!clicked) {
        throw new Error('The selected text box font-size control was not mounted');
    }
}

async function dragPointer(
    page: Parameters<typeof evaluateInPage>[0],
    start: {
        x: number;
        y: number;
    },
    end: {
        x: number;
        y: number;
    },
) {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, {steps: 5});
    await page.mouse.up();
}

async function pressModifiedKey(
    page: Parameters<typeof evaluateInPage>[0],
    key: KeyInput,
) {
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(modifier);
    await page.keyboard.press(key);
    await page.keyboard.up(modifier);
}

async function runHistoryAction(
    page: Parameters<typeof evaluateInPage>[0],
    action: 'undo' | 'redo',
) {
    const result = await callWorkspaceCommand<Record<string, unknown>>(
        page,
        'runAgentAction',
        [
            `history.${action}`,
            {},
        ],
    );
    expect(result.called).toBe(true);
    expect(result.value?.ok).toBe(true);
}

async function readAnnotationDirtyState(page: Parameters<typeof evaluateInPage>[0]) {
    const values = await readWorkspaceStateValues<{dirtyState?: IAnnotationDirtyState}>(
        page,
        ['dirtyState'],
    );
    return values.dirtyState;
}

describe('Electron E2E - native save and reopen', () => {
    let session: IElectronE2ESession | null = null;

    afterEach(async () => {
        await session?.stop();
        session = null;
    });

    it('moves a parsed store-owned text box through save and fresh-process reopen', async () => {
        const pdfPath = await createCanonicalAnnotationSurfaceFixturePdf(
            `native-save-reopen-${Date.now()}-canonical-surface.pdf`,
        );

        session = await startElectronE2ESession(`e2e-native-save-reopen-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session, pdfPath);
        await openAnnotationsTab(session.page, 30_000);
        await waitForTextBoxDisplay(session.page);

        const initialSnapshot = await readCanonicalAnnotationSnapshot(session.page);
        const initialFingerprint = canonicalAnnotationFingerprint(initialSnapshot);
        const textBoxComment = await waitForParsedTextBoxComment(session.page);
        const originalRect = normalizedRect(textBoxComment.markerRect);
        const text = stringField(textBoxComment, 'text');
        const stableKey = stringField(textBoxComment, 'stableKey');
        expect(originalRect).not.toBeNull();
        expect(text).not.toBeNull();
        expect(stableKey).not.toBeNull();
        if (!originalRect || !text || !stableKey) {
            throw new Error('The parsed text box did not expose its canonical identity and geometry');
        }
        expect(textBoxComment).toMatchObject({
            source: 'pdf',
            hasNote: true,
        });

        const movedRect = normalizedRect({
            ...originalRect,
            left: originalRect.left + 0.08,
            top: originalRect.top + 0.06,
        });
        if (!movedRect) {
            throw new Error('The moved text box rectangle could not be normalized');
        }
        const updateResult = await callWorkspaceCommand<IAgentActionResult>(session.page, 'runAgentAction', [
            'annotation.update_note',
            {
                markerRect: movedRect,
                stableKey,
                text,
            },
        ]);
        expect(updateResult.called).toBe(true);
        expect(updateResult.value?.updated).toBe(true);

        await expect.poll(async () => {
            const snapshot = await readCanonicalAnnotationSnapshot(session!.page);
            const updatedTextBox = snapshot.comments.find(comment => stringField(comment, 'stableKey') === stableKey);
            return normalizedRect(updatedTextBox?.markerRect);
        }, {timeout: 20_000}).toEqual(movedRect);
        await expect.poll(async () => {
            const rect = await readTextBoxDisplayRect(session!.page);
            return rect !== null
                && Math.abs(rect.left - movedRect.left) < 0.005
                && Math.abs(rect.top - movedRect.top) < 0.005;
        }, {timeout: 20_000}).toBe(true);
        const movedDisplayRect = await readTextBoxDisplayRect(session.page);
        expect(movedDisplayRect).not.toBeNull();
        if (!movedDisplayRect) {
            throw new Error('The moved canonical text box was not rendered');
        }
        expect(movedDisplayRect.left).toBeCloseTo(movedRect.left, 2);
        expect(movedDisplayRect.top).toBeCloseTo(movedRect.top, 2);
        const movedSnapshot = await readCanonicalAnnotationSnapshot(session.page);
        const movedFingerprint = canonicalAnnotationFingerprint(movedSnapshot);
        expect(movedFingerprint).not.toBe(initialFingerprint);

        await expect.poll(async () => (
            await readWorkspaceStateValues<{dirtyState?: {
                annotationDirty?: boolean;
                fileDirty?: boolean;
                hasPendingUnsavedChanges?: boolean;
            };}>(
                session!.page,
                ['dirtyState'],
            )
        ).dirtyState, {timeout: 20_000}).toMatchObject({
            annotationDirty: true,
            hasPendingUnsavedChanges: true,
        });

        await saveViaWindowHandle(session.page, 60_000);
        await expect.poll(async () => (
            await readWorkspaceStateValues<{dirtyState?: {
                annotationDirty?: boolean;
                fileDirty?: boolean;
                annotationDirtyEntityCount?: number;
                hasPendingUnsavedChanges?: boolean;
            };}>(session!.page, ['dirtyState'])
        ).dirtyState, {timeout: 20_000}).toMatchObject({
            annotationDirty: false,
            fileDirty: false,
            annotationDirtyEntityCount: 0,
            hasPendingUnsavedChanges: false,
        });
        expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.FreeText ?? 0).toBeGreaterThan(0);

        const savedSnapshot = await readCanonicalAnnotationSnapshot(session.page);
        expect(savedSnapshot.comments.length).toBeGreaterThan(0);
        expect(savedSnapshot.comments.every(comment => (
            typeof comment.annotationId === 'string' && comment.annotationId.length > 0
        ))).toBe(true);
        expect(savedSnapshot.shapes.length).toBeGreaterThan(0);
        expect(savedSnapshot.shapes.every(shape => (
            typeof shape.annotationId === 'string' && shape.annotationId.length > 0
        ))).toBe(true);

        const cleanSaveBefore = await stat(pdfPath);
        const cleanSaveResult = await callWorkspaceCommand<boolean>(session.page, 'handleSave');
        expect(cleanSaveResult.called).toBe(true);
        expect(cleanSaveResult.value).toBe(true);
        const cleanSaveAfter = await stat(pdfPath);
        expect(cleanSaveAfter.size).toBe(cleanSaveBefore.size);
        expect(cleanSaveAfter.mtimeMs).toBe(cleanSaveBefore.mtimeMs);

        const savedSession = session;
        session = null;
        await savedSession.stop();
        session = await startElectronE2ESession(`e2e-native-save-reopen-fresh-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session, pdfPath);
        await waitForTextBoxDisplay(session.page);
        const reopenedSnapshot = await readCanonicalAnnotationSnapshot(session.page);
        expect(canonicalAnnotationFingerprint(reopenedSnapshot)).toBe(movedFingerprint);
        const reopenedDisplayRect = await readTextBoxDisplayRect(session.page);
        expect(reopenedDisplayRect).not.toBeNull();
        if (!reopenedDisplayRect) {
            throw new Error('The canonical text box was not rendered after fresh-process reopen');
        }
        expect(reopenedDisplayRect.left).toBeCloseTo(movedRect.left, 2);
        expect(reopenedDisplayRect.top).toBeCloseTo(movedRect.top, 2);
        expect(reopenedSnapshot.comments.every(comment => (
            typeof comment.annotationId === 'string' && comment.annotationId.length > 0
        ))).toBe(true);
        expect(reopenedSnapshot.shapes.every(shape => (
            typeof shape.annotationId === 'string' && shape.annotationId.length > 0
        ))).toBe(true);
        expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.FreeText ?? 0).toBeGreaterThan(0);
    }, NATIVE_SAVE_REOPEN_TIMEOUT_MS);

    it('creates, edits, resizes, moves, recolors, undoes, saves, and reopens a text box', async () => {
        const pdfPath = await createMultiPageTextFixturePdf(
            `native-save-reopen-${Date.now()}-created-text-box.pdf`,
            1,
        );

        session = await startElectronE2ESession(`e2e-native-save-reopen-created-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session, pdfPath);
        await openAnnotationsTab(session.page, 30_000);
        await clickAnnotationTool(session.page, 'Text');

        const creationPoint = await readPagePoint(session.page, 0.62, 0.52);
        expect(creationPoint).not.toBeNull();
        if (!creationPoint) {
            throw new Error('The empty fixture page was not mounted');
        }
        await session.page.mouse.click(creationPoint.x, creationPoint.y);
        await session.page.waitForSelector(
            '.editor-pane.is-active .pdf-annotation-editor-text-box [contenteditable="true"]',
            {
                visible: true,
                timeout: 20_000,
            },
        );

        const typedText = `Created canonical text box ${Date.now()}`;
        await session.page.focus(
            '.editor-pane.is-active .pdf-annotation-editor-text-box [contenteditable="true"]',
        );
        await pressModifiedKey(session.page, 'A');
        await session.page.keyboard.type(typedText);
        await expect.poll(async () => session!.page.evaluate(() => document.querySelector<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-text-box [contenteditable="true"]',
        )?.textContent ?? null), {timeout: 20_000}).toBe(typedText);
        await pressModifiedKey(session.page, 'Enter');
        await expect.poll(async () => stringField(
            findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), typedText) ?? {},
            'text',
        ), {timeout: 20_000}).toBe(typedText);

        const typedSnapshot = await readCanonicalAnnotationSnapshot(session.page);
        const typedComment = findTextBoxComment(typedSnapshot, typedText);
        expect(typedComment).not.toBeNull();
        if (!typedComment) {
            throw new Error('The created text box was not published to the canonical store');
        }
        const annotationId = stringField(typedComment, 'appAnnotationId');
        const originalRect = normalizedRect(typedComment.markerRect);
        const originalColor = stringField(typedComment, 'color');
        expect(annotationId).not.toBeNull();
        expect(originalRect).not.toBeNull();
        expect(originalColor).not.toBeNull();
        if (!annotationId || !originalRect || !originalColor) {
            throw new Error('The created text box did not expose its canonical identity, geometry, or color');
        }

        await runHistoryAction(session.page, 'undo');
        await expect.poll(async () => stringField(
            findTextBoxById(await readCanonicalAnnotationSnapshot(session!.page), annotationId) ?? {},
            'text',
        ), {timeout: 20_000}).toBe('');
        await runHistoryAction(session.page, 'redo');
        await expect.poll(async () => stringField(
            findTextBoxById(await readCanonicalAnnotationSnapshot(session!.page), annotationId) ?? {},
            'text',
        ), {timeout: 20_000}).toBe(typedText);

        await clickAnnotationTool(session.page, 'Select');
        await session.page.waitForFunction((id: string) => Array.from(document.querySelectorAll<HTMLElement>(
            '[data-annotation-kind="text-box"]',
        )).some(entity => entity.dataset.annotationId === id && entity.classList.contains('is-selected')), {timeout: 20_000}, annotationId);

        const originalStyle = await readTextBoxComputedStyle(session.page, annotationId);
        expect(originalStyle).not.toBeNull();
        if (!originalStyle) {
            throw new Error('The selected text box did not expose its computed style');
        }
        await increaseSelectedTextBoxFontSize(session.page);
        await expect.poll(async () => (
            await readTextBoxComputedStyle(session!.page, annotationId)
        ), {timeout: 20_000}).not.toEqual(originalStyle);
        const resizedFontStyle = await readTextBoxComputedStyle(session.page, annotationId);
        expect(resizedFontStyle).not.toBeNull();
        if (!resizedFontStyle) {
            throw new Error('The selected text box font size was not readable');
        }
        expect(resizedFontStyle.fontSize).not.toBe(originalStyle.fontSize);

        await setAnnotationColor(session.page, '#ef4444');
        await expect.poll(async () => stringField(
            findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), typedText) ?? {},
            'color',
        ), {timeout: 20_000}).toBe('#ef4444');
        await runHistoryAction(session.page, 'undo');
        await expect.poll(async () => stringField(
            findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), typedText) ?? {},
            'color',
        ), {timeout: 20_000}).toBe(originalColor);
        await runHistoryAction(session.page, 'redo');
        await expect.poll(async () => stringField(
            findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), typedText) ?? {},
            'color',
        ), {timeout: 20_000}).toBe('#ef4444');

        const beforeResizeSnapshot = await readCanonicalAnnotationSnapshot(session.page);
        const beforeResizeComment = findTextBoxComment(beforeResizeSnapshot, typedText);
        const beforeResizeRect = normalizedRect(beforeResizeComment?.markerRect);
        const beforeResizeScreen = await readTextBoxScreenPoints(session.page, 'se');
        const fontSizeBeforeResize = (await readTextBoxComputedStyle(session.page))?.fontSize ?? null;
        expect(beforeResizeRect).not.toBeNull();
        expect(beforeResizeScreen?.handle).not.toBeNull();
        expect(fontSizeBeforeResize).not.toBeNull();
        if (!beforeResizeRect || !beforeResizeScreen?.handle || fontSizeBeforeResize === null) {
            throw new Error('The selected text box resize handle was not mounted');
        }
        const resizeTarget = {
            x: Math.min(beforeResizeScreen.page.right - 6, beforeResizeScreen.handle.x + 48),
            y: Math.min(beforeResizeScreen.page.bottom - 6, beforeResizeScreen.handle.y + 36),
        };
        expect(Math.hypot(
            resizeTarget.x - beforeResizeScreen.handle.x,
            resizeTarget.y - beforeResizeScreen.handle.y,
        )).toBeGreaterThan(8);
        await dragPointer(session.page, beforeResizeScreen.handle, resizeTarget);
        await expect.poll(async () => (
            normalizedRect(findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), typedText)?.markerRect)?.width ?? 0
        ), {timeout: 20_000}).toBeGreaterThan(beforeResizeRect.width);
        const resizedSnapshot = await readCanonicalAnnotationSnapshot(session.page);
        const resizedComment = findTextBoxComment(resizedSnapshot, typedText);
        const resizedRect = normalizedRect(resizedComment?.markerRect);
        expect(resizedRect).not.toBeNull();
        expect((await readTextBoxComputedStyle(session.page))?.fontSize ?? null).toBe(fontSizeBeforeResize);
        if (!resizedRect) {
            throw new Error('The resized text box was not published to the canonical store');
        }
        await runHistoryAction(session.page, 'undo');
        await expect.poll(async () => normalizedRect(
            findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), typedText)?.markerRect,
        ), {timeout: 20_000}).toEqual(beforeResizeRect);
        await runHistoryAction(session.page, 'redo');
        await expect.poll(async () => normalizedRect(
            findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), typedText)?.markerRect,
        ), {timeout: 20_000}).toEqual(resizedRect);

        const beforeMoveSnapshot = await readCanonicalAnnotationSnapshot(session.page);
        const beforeMoveRect = normalizedRect(
            findTextBoxComment(beforeMoveSnapshot, typedText)?.markerRect,
        );
        const beforeMoveScreen = await readTextBoxScreenPoints(session.page);
        expect(beforeMoveRect).not.toBeNull();
        expect(beforeMoveScreen).not.toBeNull();
        if (!beforeMoveRect || !beforeMoveScreen) {
            throw new Error('The resized text box was not mounted for moving');
        }
        const moveStart = {
            x: beforeMoveScreen.box.left + beforeMoveScreen.box.width / 2,
            y: beforeMoveScreen.box.top + beforeMoveScreen.box.height / 2,
        };
        const moveTarget = {
            x: Math.min(beforeMoveScreen.page.right - beforeMoveScreen.box.width / 2 - 6, moveStart.x + 32),
            y: Math.min(beforeMoveScreen.page.bottom - beforeMoveScreen.box.height / 2 - 6, moveStart.y + 24),
        };
        expect(Math.hypot(moveTarget.x - moveStart.x, moveTarget.y - moveStart.y)).toBeGreaterThan(8);
        await dragPointer(session.page, moveStart, moveTarget);
        await expect.poll(async () => (
            normalizedRect(findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), typedText)?.markerRect)?.left ?? 0
        ), {timeout: 20_000}).toBeGreaterThan(beforeMoveRect.left);
        const movedSnapshot = await readCanonicalAnnotationSnapshot(session.page);
        const movedRect = normalizedRect(findTextBoxComment(movedSnapshot, typedText)?.markerRect);
        expect(movedRect).not.toBeNull();
        if (!movedRect) {
            throw new Error('The moved text box was not published to the canonical store');
        }
        await runHistoryAction(session.page, 'undo');
        await expect.poll(async () => normalizedRect(
            findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), typedText)?.markerRect,
        ), {timeout: 20_000}).toEqual(beforeMoveRect);
        await runHistoryAction(session.page, 'redo');
        await expect.poll(async () => normalizedRect(
            findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), typedText)?.markerRect,
        ), {timeout: 20_000}).toEqual(movedRect);

        // Walk the complete history back to the empty fixture and forward to
        // the saved state. This proves creation and text commit join the same
        // one-gesture-at-a-time history as style and geometry changes.
        await runHistoryAction(session.page, 'undo');
        await expect.poll(async () => normalizedRect(
            findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), typedText)?.markerRect,
        ), {timeout: 20_000}).toEqual(beforeMoveRect);
        await runHistoryAction(session.page, 'undo');
        await expect.poll(async () => normalizedRect(
            findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), typedText)?.markerRect,
        ), {timeout: 20_000}).toEqual(beforeResizeRect);
        await runHistoryAction(session.page, 'undo');
        await expect.poll(async () => stringField(
            findTextBoxById(await readCanonicalAnnotationSnapshot(session!.page), annotationId) ?? {},
            'color',
        ), {timeout: 20_000}).toBe(originalColor);
        await runHistoryAction(session.page, 'undo');
        await expect.poll(async () => readTextBoxComputedStyle(session!.page, annotationId), {timeout: 20_000})
            .toEqual(originalStyle);
        await runHistoryAction(session.page, 'undo');
        await expect.poll(async () => stringField(
            findTextBoxById(await readCanonicalAnnotationSnapshot(session!.page), annotationId) ?? {},
            'text',
        ), {timeout: 20_000}).toBe('');
        await runHistoryAction(session.page, 'undo');
        await expect.poll(async () => findTextBoxById(
            await readCanonicalAnnotationSnapshot(session!.page),
            annotationId,
        ), {timeout: 20_000}).toBeNull();

        await runHistoryAction(session.page, 'redo');
        await expect.poll(async () => findTextBoxById(
            await readCanonicalAnnotationSnapshot(session!.page),
            annotationId,
        ), {timeout: 20_000}).not.toBeNull();
        await runHistoryAction(session.page, 'redo');
        await expect.poll(async () => stringField(
            findTextBoxById(await readCanonicalAnnotationSnapshot(session!.page), annotationId) ?? {},
            'text',
        ), {timeout: 20_000}).toBe(typedText);
        await runHistoryAction(session.page, 'redo');
        await expect.poll(async () => readTextBoxComputedStyle(session!.page, annotationId), {timeout: 20_000})
            .toEqual(resizedFontStyle);
        await runHistoryAction(session.page, 'redo');
        await expect.poll(async () => stringField(
            findTextBoxById(await readCanonicalAnnotationSnapshot(session!.page), annotationId) ?? {},
            'color',
        ), {timeout: 20_000}).toBe('#ef4444');
        await runHistoryAction(session.page, 'redo');
        await expect.poll(async () => normalizedRect(
            findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), typedText)?.markerRect,
        ), {timeout: 20_000}).toEqual(resizedRect);
        await runHistoryAction(session.page, 'redo');
        await expect.poll(async () => normalizedRect(
            findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), typedText)?.markerRect,
        ), {timeout: 20_000}).toEqual(movedRect);

        const finalSnapshot = await readCanonicalAnnotationSnapshot(session.page);
        const finalFingerprint = canonicalAnnotationFingerprint(finalSnapshot);
        const finalStyle = await readTextBoxComputedStyle(session.page, annotationId);
        expect(finalStyle).toEqual({
            color: 'rgb(239, 68, 68)',
            fontSize: resizedFontStyle.fontSize,
        });
        await saveViaWindowHandle(session.page, 60_000);
        await expect.poll(
            () => readAnnotationDirtyState(session!.page),
            {timeout: 20_000},
        ).toMatchObject({
            annotationDirty: false,
            fileDirty: false,
            annotationDirtyEntityCount: 0,
            hasPendingUnsavedChanges: false,
        });
        expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.FreeText).toBe(1);

        const savedSession = session;
        session = null;
        await savedSession.stop();
        session = await startElectronE2ESession(`e2e-native-save-reopen-created-fresh-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session, pdfPath);
        await waitForTextBoxDisplay(session.page);
        await expect.poll(async () => canonicalAnnotationFingerprint(
            await readCanonicalAnnotationSnapshot(session!.page),
        ), {timeout: 20_000}).toBe(finalFingerprint);
        expect(await readFirstTextBoxComputedStyle(session.page)).toEqual(finalStyle);
    }, NATIVE_SAVE_REOPEN_TIMEOUT_MS);

    it('edits a fixture text box and preserves its foreign dictionary keys through save', async () => {
        const pdfPath = copyProjectFixture(
            'freetext-lifecycle-test.pdf',
            `native-save-reopen-${Date.now()}-foreign-text-box.pdf`,
        );

        session = await startElectronE2ESession(`e2e-native-save-reopen-foreign-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session, pdfPath);
        await openAnnotationsTab(session.page, 30_000);
        await waitForTextBoxDisplay(session.page);

        const fixtureText = 'Reachable text box one';
        await expect.poll(async () => Boolean(
            findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), fixtureText),
        ), {timeout: 20_000}).toBe(true);
        const initialSnapshot = await readCanonicalAnnotationSnapshot(session.page);
        const initialComment = findTextBoxComment(initialSnapshot, fixtureText);
        const annotationId = stringField(initialComment ?? {}, 'appAnnotationId');
        expect(annotationId).not.toBeNull();
        if (!annotationId) {
            throw new Error('The fixture text box did not expose its canonical identity');
        }
        const initialRect = normalizedRect(initialComment?.markerRect);
        const initialStyle = await readTextBoxComputedStyle(session.page, annotationId);
        expect(initialRect).not.toBeNull();
        expect(initialStyle).not.toBeNull();
        if (!initialRect || !initialStyle || initialStyle.fontSize === null) {
            throw new Error('The fixture text box did not expose stable geometry or style');
        }
        const initialFontSize = initialStyle.fontSize;
        const point = await session.page.evaluate((id: string) => {
            const entity = Array.from(document.querySelectorAll<HTMLElement>(
                '[data-annotation-kind="text-box"]',
            )).find(candidate => candidate.dataset.annotationId === id);
            if (!entity) {
                return null;
            }
            const rect = entity.getBoundingClientRect();
            return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            };
        }, annotationId);
        expect(point).not.toBeNull();
        if (!point) {
            throw new Error('The fixture text box was not rendered');
        }
        await session.page.mouse.click(point.x, point.y);
        await session.page.waitForSelector(
            '.annotation-style-popover .style-row-width .style-label',
            {
                visible: true,
                timeout: 20_000,
            },
        );
        await expect.poll(async () => session!.page.evaluate(() => (
            document.querySelector<HTMLElement>(
                '.annotation-style-popover .style-row-width .style-label',
            )?.textContent ?? ''
        )), {timeout: 20_000}).toContain(String(initialFontSize));
        await increaseSelectedTextBoxFontSize(session.page);
        await expect.poll(async () => (
            await readTextBoxComputedStyle(session!.page, annotationId)
        ), {timeout: 20_000}).toSatisfy(style => (
            typeof style?.fontSize === 'number'
            && style.fontSize > initialFontSize
        ));
        const editedStyle = await readTextBoxComputedStyle(session.page, annotationId);
        expect(editedStyle).not.toBeNull();
        if (!editedStyle || editedStyle.fontSize === null) {
            throw new Error('The selected imported text box did not publish its font-size update');
        }
        await session.page.mouse.click(point.x, point.y, {
            count: 2,
            delay: 80,
        });
        await session.page.waitForSelector(
            '.editor-pane.is-active .pdf-annotation-editor-text-box [contenteditable="true"]',
            {
                visible: true,
                timeout: 20_000,
            },
        );
        const editedText = `Edited fixture text box ${Date.now()}`;
        await session.page.focus(
            '.editor-pane.is-active .pdf-annotation-editor-text-box [contenteditable="true"]',
        );
        await pressModifiedKey(session.page, 'A');
        await session.page.keyboard.type(editedText);
        await expect.poll(async () => session!.page.evaluate(() => document.querySelector<HTMLElement>(
            '.editor-pane.is-active .pdf-annotation-editor-text-box [contenteditable="true"]',
        )?.textContent ?? null), {timeout: 20_000}).toBe(editedText);
        await pressModifiedKey(session.page, 'Enter');
        await expect.poll(async () => stringField(
            findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), editedText) ?? {},
            'text',
        ), {timeout: 20_000}).toBe(editedText);

        await saveViaWindowHandle(session.page, 60_000);
        expect((await readPdfAnnotationSummary(pdfPath)).bySubtype.FreeText).toBe(3);
        const editedSnapshot = await readCanonicalAnnotationSnapshot(session.page);
        const editedComment = findTextBoxComment(editedSnapshot, editedText);
        const editedRect = normalizedRect(editedComment?.markerRect);
        expect(editedRect).toEqual(initialRect);
        expect(await readTextBoxComputedStyle(session.page, annotationId)).toEqual(editedStyle);
        const savedTextBox = await readFreeTextObjectByName(pdfPath, 'lifecycle-text-box-one');
        expect(qpdfObjectContainsText(savedTextBox.object, editedText)).toBe(true);
        expect(savedTextBox.object).toContain(`/DA (/Helvetica ${editedStyle.fontSize} Tf 0 0 1 rg)`);
        expect(savedTextBox.object).toContain('/RC (<body>Foreign rich text sentinel</body>)');
        expect(savedTextBox.object).toContain('/DS (foreign-style-sentinel)');

        const savedSession = session;
        session = null;
        await savedSession.stop();
        session = await startElectronE2ESession(`e2e-native-save-reopen-foreign-fresh-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForOpenedPdf(session, pdfPath);
        await waitForTextBoxDisplay(session.page);
        await expect.poll(async () => stringField(
            findTextBoxComment(await readCanonicalAnnotationSnapshot(session!.page), editedText) ?? {},
            'text',
        ), {timeout: 20_000}).toBe(editedText);
        expect(await readTextBoxComputedStyle(session.page, annotationId)).toEqual(editedStyle);
    }, NATIVE_SAVE_REOPEN_TIMEOUT_MS);

    it('preserves outlines and page labels through the six-operation fresh-process matrix', async () => {
        const cases = [
            {
                name: 'rotate',
                totalPages: 4,
                expectedPages: [
                    1,
                    3,
                    4,
                ],
                run: async (page: Parameters<typeof evaluateInPage>[0], path: string) => {
                    return evaluateInPage(page, async ({workingCopyPath}) => {
                        const api = (window as IE2EWindow).electronAPI;
                        if (!api) throw new Error('electronAPI is unavailable');
                        const revision = await api.documentFiles.getDocumentRevision(workingCopyPath);
                        return api.pageOps.rotate(workingCopyPath, [1], 4, 90, {expectedDocumentRevisionToken: revision?.token});
                    }, {workingCopyPath: path});
                },
            },
            {
                name: 'delete',
                totalPages: 3,
                expectedPages: [
                    1,
                    2,
                    3,
                ],
                run: async (page: Parameters<typeof evaluateInPage>[0], path: string) => {
                    return evaluateInPage(page, async ({workingCopyPath}) => {
                        const api = (window as IE2EWindow).electronAPI;
                        if (!api) throw new Error('electronAPI is unavailable');
                        const revision = await api.documentFiles.getDocumentRevision(workingCopyPath);
                        return api.pageOps.delete(workingCopyPath, [2], 4, {expectedDocumentRevisionToken: revision?.token});
                    }, {workingCopyPath: path});
                },
            },
            {
                name: 'reorder',
                totalPages: 4,
                expectedPages: [
                    2,
                    4,
                    1,
                ],
                run: async (page: Parameters<typeof evaluateInPage>[0], path: string) => {
                    return evaluateInPage(page, async ({workingCopyPath}) => {
                        const api = (window as IE2EWindow).electronAPI;
                        if (!api) throw new Error('electronAPI is unavailable');
                        const revision = await api.documentFiles.getDocumentRevision(workingCopyPath);
                        return api.pageOps.reorder(workingCopyPath, [
                            4,
                            1,
                            2,
                            3,
                        ], {expectedDocumentRevisionToken: revision?.token});
                    }, {workingCopyPath: path});
                },
            },
            {
                name: 'crop',
                totalPages: 4,
                expectedPages: [
                    1,
                    3,
                    4,
                ],
                run: async (page: Parameters<typeof evaluateInPage>[0], path: string) => {
                    return evaluateInPage(page, async ({workingCopyPath}) => {
                        const api = (window as IE2EWindow).electronAPI;
                        if (!api) throw new Error('electronAPI is unavailable');
                        const revision = await api.documentFiles.getDocumentRevision(workingCopyPath);
                        return api.pageOps.crop(workingCopyPath, [1], 4, {
                            top: 5,
                            bottom: 5,
                            left: 5,
                            right: 5,
                        }, {expectedDocumentRevisionToken: revision?.token});
                    }, {workingCopyPath: path});
                },
            },
            {
                name: 'move',
                totalPages: 4,
                expectedPages: [
                    4,
                    2,
                    3,
                ],
                run: async (page: Parameters<typeof evaluateInPage>[0], path: string) => {
                    return evaluateInPage(page, async ({workingCopyPath}) => {
                        const api = (window as IE2EWindow).electronAPI;
                        if (!api) throw new Error('electronAPI is unavailable');
                        const revision = await api.documentFiles.getDocumentRevision(workingCopyPath);
                        return api.pageOps.move(workingCopyPath, 1, 1, 4, 4, {expectedDocumentRevisionToken: revision?.token});
                    }, {workingCopyPath: path});
                },
            },
            {
                name: 'insert',
                totalPages: 5,
                expectedPages: [
                    1,
                    4,
                    5,
                ],
                run: async (page: Parameters<typeof evaluateInPage>[0], path: string, sourcePath?: string) => {
                    if (!sourcePath) throw new Error('Insert fixture source is unavailable');
                    return evaluateInPage(page, async ({
                        workingCopyPath,
                        sourcePath: source,
                    }) => {
                        const api = (window as IE2EWindow).electronAPI;
                        if (!api) throw new Error('electronAPI is unavailable');
                        const revision = await api.documentFiles.getDocumentRevision(workingCopyPath);
                        return api.pageOps.insertFile(workingCopyPath, 4, 2, [source], 'outline-matrix-insert', {expectedDocumentRevisionToken: revision?.token});
                    }, {
                        workingCopyPath: path,
                        sourcePath,
                    });
                },
            },
        ] as const;

        for (const testCase of cases) {
            const pdfPath = await createOutlinePageLabelFixturePdf(`outline-matrix-${testCase.name}-${Date.now()}.pdf`);
            const sourcePath = testCase.name === 'insert'
                ? await createMultiPageTextFixturePdf(`outline-matrix-${testCase.name}-source-${Date.now()}.pdf`, 1)
                : undefined;
            session = await startElectronE2ESession(`e2e-outline-matrix-${testCase.name}-${Date.now()}`, {
                clean: true,
                extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
                initialOpenPaths: [pdfPath],
            });
            await waitForOpenedPdf(session, pdfPath);

            if (sourcePath) {
                const granted = await evaluateInPage(session.page, async path => {
                    const grant = (window as IAutomationFileOpenGrantWindow)
                        .__allowRendererFileOpenForAutomation;
                    return typeof grant === 'function' && grant(path);
                }, sourcePath);
                expect(granted, 'insert source path automation grant').toBe(true);
            }

            const workingCopyPath = await evaluateInPage(session.page, async path => {
                const api = (window as IE2EWindow).electronAPI;
                if (!api) throw new Error('electronAPI is unavailable');
                return api.documentWorkingCopy.createWorkingCopyFromPath(path, path);
            }, pdfPath);
            const result = await testCase.run(session.page, workingCopyPath, sourcePath);
            expect(result?.success, `${testCase.name} native page operation`).toBe(true);
            const saveResult = await evaluateInPage(session.page, async ({workingCopyPath: path}) => {
                const api = (window as IE2EWindow).electronAPI;
                if (!api) throw new Error('electronAPI is unavailable');
                const revision = await api.documentFiles.getDocumentRevision(path);
                return api.documentFiles.saveFileStructured(path, {expectedDocumentRevisionToken: revision.token});
            }, {workingCopyPath});
            expect(saveResult.ok, `${testCase.name} structured save`).toBe(true);
            const previousSession = session;
            session = null;
            await previousSession.stop();
            session = await startElectronE2ESession(`e2e-outline-matrix-${testCase.name}-fresh-${Date.now()}`, {
                clean: true,
                extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
                initialOpenPaths: [pdfPath],
            });
            await waitForOpenedPdf(session, pdfPath);

            const freshSession = session;
            session = null;
            await freshSession.stop();
            const metadata = await readPdfMetadataWithQpdf(pdfPath);
            const flattenedOutlines = flattenQpdfOutlines(metadata.outlines);
            expect(flattenedOutlines.map(outline => outline.title)).toEqual([
                'Parent',
                'Child',
                'Appendix',
            ]);
            expect(flattenedOutlines.map(outline => outline.page)).toEqual(testCase.expectedPages);
            expect(flattenedOutlines.map(outline => outline.depth)).toEqual([
                0,
                1,
                0,
            ]);
            expect(metadata.pagelabels.length).toBeGreaterThanOrEqual(2);
            expect(metadata.pagelabels.map(label => label.label?.['/P'])).toEqual(expect.arrayContaining([
                'u:front-',
                'u:chapter-',
            ]));
        }
    }, OUTLINE_METADATA_MATRIX_TIMEOUT_MS);
});
