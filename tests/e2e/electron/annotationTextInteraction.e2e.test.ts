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

    async function openFixture() {
        const session = sessions.getSession();
        if (!session) throw new Error('Text interaction session did not start');
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
        await setAnnotationKeepActiveWithPointer(session.page, false);
        await callWorkspaceCommand(session.page, 'setViewRotation', [0]);
        await callWorkspaceCommand(session.page, 'setCustomZoomFromDisplay', [2.62]);
        await session.page.waitForFunction(() => document.querySelector('.zoom-controls-display-value')?.textContent?.trim() === '262%');
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
