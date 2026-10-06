import {
    afterEach, expect, it,
} from 'vitest';
import {
    readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {encode} from 'fast-png';
import {
    startElectronE2ESession,
    type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    activateMenuItemAsUser, clickAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    clickVisibleToolbarButton, waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {readToolbarPageIndicator} from '@tests/e2e/electron/helpers/toolbarPageIndicator';

let session: IElectronE2ESession | null = null;
const paths: string[] = [];

afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
        await session?.captureFailureArtifacts('jp2-open');
    }
    await session?.stop();
    session = null;
    paths.splice(0).forEach(path => rmSync(path, {force: true}));
});

it('opens JP2 scans and combines them with PNG while preserving their compressed bytes', async () => {
    const stem = join(process.cwd(), '.devkit', `jp2-open-${process.pid}-${Date.now()}`);
    const jp2Path = `${stem}.JP2`;
    const pngPath = `${stem}.png`;
    const savedPath = `${stem}.pdf`;
    paths.push(jp2Path, pngPath, savedPath);
    // OpenJPEG 2.5.4, lossless RGB 64x40, red left half and green right half:
    // opj_compress -n 3 -i scan.ppm -o scan.jp2
    const jp2 = Buffer.from(readFileSync(join(process.cwd(), 'tests/fixtures/electron/jp2-rgb-scan.jp2.b64'), 'utf8').trim(), 'base64');
    writeFileSync(jp2Path, jp2);
    writeFileSync(pngPath, encode({
        width: 1,
        height: 1,
        channels: 3,
        data: Uint8Array.of(20, 40, 200),
    }));
    session = await startElectronE2ESession(`e2e-jp2-open-${Date.now()}`, {
        clean: true,
        extraEnv: {
            EVB_E2E_OPEN_DIALOG_PATH: jp2Path,
            EVB_E2E_SAVE_DIALOG_PATH: savedPath,
            EVB_PDF_IMAGE_COMBINE_ENABLE: '1',
            EVB_PDF_NATIVE_ASSEMBLER_ENABLE: '1',
        },
    });
    const {page} = session;
    await page.waitForFunction(() => document.querySelector('#evb-startup-overlay') === null);
    // Hidden automation answers the native picker; the installed menu's real
    // Open handler and document conversion still run.
    await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+O'});
    await waitForPdfLoaded(page);
    await expect.poll(async () => page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('.editor-pane.is-active .page_container--rendered canvas');
        const context = canvas?.getContext('2d');
        if (!canvas || !context) return null;
        return [
            0.25,
            0.75,
        ].map(x => Array.from(context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height / 2), 1, 1).data));
    }), {timeout: 20_000}).toEqual([
        [
            200,
            30,
            20,
            255,
        ],
        [
            20,
            160,
            40,
            255,
        ],
    ]);
    await clickVisibleToolbarButton(page, 'Save');
    await expect.poll(() => {
        try { return readFileSync(savedPath).includes(jp2); } catch { return false; }
    }, {timeout: 20_000}).toBe(true);

    await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+W'});
    await page.waitForSelector('nav[aria-label="File"] button.rail-item', {visible: true});
    await clickAsUser(page, 'nav[aria-label="File"] button.rail-item');
    await page.waitForSelector('[data-combine-page]', {visible: true});
    const input = await page.$('input[type="file"]');
    expect(input).not.toBeNull();
    await input!.uploadFile(jp2Path, pngPath);
    await page.waitForFunction(() => document.querySelectorAll('[data-combine-row]').length === 2);
    await clickAsUser(page, 'footer.combine-actions button');
    await waitForPdfLoaded(page);
    await expect.poll(async () => (await readToolbarPageIndicator(page)).totalPagesText).toBe('2');
    await expect.poll(async () => page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('.editor-pane.is-active [data-page="1"].page_container--rendered canvas');
        const context = canvas?.getContext('2d');
        return canvas && context
            ? Array.from(context.getImageData(Math.floor(canvas.width / 4), Math.floor(canvas.height / 2), 1, 1).data)
            : null;
    }), {timeout: 20_000}).toEqual([
        200,
        30,
        20,
        255,
    ]);
    await clickVisibleToolbarButton(page, 'Next Page');
    await expect.poll(async () => page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('.editor-pane.is-active [data-page="2"].page_container--rendered canvas');
        const context = canvas?.getContext('2d');
        return canvas && context
            ? Array.from(context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data)
            : null;
    }), {timeout: 20_000}).toEqual([
        20,
        40,
        200,
        255,
    ]);
    rmSync(savedPath, {force: true});
    await clickVisibleToolbarButton(page, 'Save');
    await expect.poll(() => {
        try { return readFileSync(savedPath).includes(jp2); } catch { return false; }
    }, {timeout: 20_000}).toBe(true);
}, 120_000);
