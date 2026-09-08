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
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {
    createBlankFixturePdf,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickAnnotationTool,
    clickVisibleAnnotationControl,
    selectAllFocusedAnnotationText,
    setAnnotationKeepActiveWithPointer,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openPdfInApp,
    openAnnotationsTab,
    waitForPdfLoaded,
    waitForViewerInteractive,
    saveViaWindowHandle,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const BOX = '.editor-pane.is-active .pdf-annotation-editor-text-box[data-annotation-kind="text-box"]';
const PREVIEW = '.editor-pane.is-active .pdf-annotation-editor-text-box-preview';

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
    return page.$eval('.editor-pane.is-active .page_container[data-page="1"]', element => {
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

async function resize(page: Page, handle: string, dx: number, dy: number) {
    // A late font swap changes the measured text width and moves its handles.
    // Aim only after the same font used by the rendered text is ready.
    await page.evaluate(async () => {
        await document.fonts.load('22px "EVB Annotation Sans"');
        await document.fonts.ready;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const selector = `.editor-pane.is-active [data-pdf-annotation-resize-handle="${handle}"]`;
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

    async function openFixture(keepActive = false, zoom = 2.62) {
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
        copyFileSync(process.env.EVB_TEXT_INTERACTION_FIXTURE ?? generated, path);
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
        return {
            session,
            page: session.page,
            path,
        };
    }

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
