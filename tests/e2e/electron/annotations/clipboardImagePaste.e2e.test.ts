import {rmSync} from 'node:fs';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createMultiPageTextFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';

const PAGE = '.editor-pane.is-active .page_container--rendered';
const ACTIVE_IMAGE_PLACEMENT = '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .pdf-image-placement';

interface IClipboardWriteResult {
    written: boolean;
    error?: string;
}

interface IClipboardWriteWindow extends Window {__clipboardWriteFromClick?: Promise<IClipboardWriteResult>;}

const sessionFixture = createElectronE2ESessionFixture({
    restartBeforeEach: true,
    sessionName: () => 'e2e-clipboard-image-paste-' + Date.now(),
});

describe('clipboard image paste', () => {
    it('shows an image placement preview for a PNG pasted from the clipboard', async () => {
        const session = sessionFixture.getSession();
        const fixturePath = await createMultiPageTextFixturePdf(`clipboard-image-paste-${Date.now()}.pdf`, 1);
        onTestFinished(() => rmSync(fixturePath, {force: true}));
        const {page} = session;

        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await page.waitForSelector(PAGE, {visible: true});

        await page.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 48;
            canvas.height = 32;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Canvas 2D context is unavailable');
            context.fillStyle = '#d22f48';
            context.fillRect(0, 0, canvas.width, canvas.height);
            const blob = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not create a PNG blob')), 'image/png');
            });
            const item = new ClipboardItem({'image/png': blob});
            (window as IClipboardWriteWindow).__clipboardWriteFromClick = new Promise((resolve) => {
                document.addEventListener('click', () => {
                    void navigator.clipboard.write([item]).then(
                        () => resolve({written: true}),
                        error => resolve({
                            written: false,
                            error: error instanceof Error ? error.message : String(error),
                        }),
                    );
                }, {
                    capture: true,
                    once: true,
                });
            });
        });

        const pageRect = await page.$eval(PAGE, element => {
            const rect = element.getBoundingClientRect();
            return {
                x: rect.right - 40,
                y: rect.top + Math.min(180, rect.height / 2),
            };
        });
        await page.mouse.click(pageRect.x, pageRect.y);
        const clipboardWrite = await page.evaluate(() => (
            (window as IClipboardWriteWindow).__clipboardWriteFromClick
        ));
        expect(clipboardWrite).toEqual({written: true});

        await page.mouse.click(pageRect.x, pageRect.y, {button: 'right'});
        await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="menuitem"], button'))
            .some(element => element.textContent?.includes('Paste Image from Clipboard')), {timeout: 5_000});
        const pasteItem = await page.evaluate(() => {
            const element = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"], button'))
                .find(candidate => candidate.textContent?.trim() === 'Paste Image from Clipboard');
            const rect = element?.getBoundingClientRect();
            return rect && rect.width > 0 && rect.height > 0
                ? {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                }
                : null;
        });
        expect(pasteItem).not.toBeNull();
        await page.mouse.click(pasteItem!.x, pasteItem!.y);

        await page.waitForSelector(ACTIVE_IMAGE_PLACEMENT, {
            visible: true,
            timeout: 5_000,
        });
        const preview = await page.$eval(ACTIVE_IMAGE_PLACEMENT, element => {
            const rect = element.getBoundingClientRect();
            return {
                width: rect.width,
                height: rect.height,
            };
        });
        expect(preview.width).toBeGreaterThan(0);
        expect(preview.height).toBeGreaterThan(0);
    }, 120_000);
});
