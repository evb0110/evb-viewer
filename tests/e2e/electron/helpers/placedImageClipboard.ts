import {expect} from 'vitest';
import type {Page} from 'puppeteer-core';
import {
    requireDocumentRef,
    type TLegacyDocumentRef,
} from '@contracts/documentRef';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {callWorkspaceCommand} from '@tests/e2e/electron/helpers/workspaceExpose';

const ACTIVE_IMAGE_PLACEMENT_SELECTOR = '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .pdf-image-placement';
/** A 64x40 JPEG for placed-image tests. */
export const PLACED_IMAGE_JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAoAEADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAcI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AntWpOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/9k=',
    'base64',
);

export async function installManagedJpegClipboard(page: Page, imagePath: string) {
    const documentPath = requireDocumentRef(imagePath);
    const probe = await page.evaluate(async (input: {imagePath: TLegacyDocumentRef}) => {
        const files = window.electronAPI?.documentFiles;
        if (!files?.createManagedTempFileHandle) {
            throw new Error('Managed image handles are unavailable');
        }
        const handle = await files.createManagedTempFileHandle(input.imagePath);
        const NativeFile = window.File;
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
        };
    }, {imagePath: documentPath});
    expect(probe).toEqual({
        dimensions: {
            height: 40,
            width: 64,
        },
        hasNativeSourceHandle: true,
    });
}

export async function pasteImageFromVisibleMenu(page: Page, pageNumber: number) {
    await page.waitForFunction((targetPage: number) => {
        const pageContainer = document.querySelector<HTMLElement>(
            `.editor-pane.is-active .page_container[data-page="${targetPage}"]`,
        );
        const rect = pageContainer?.getBoundingClientRect();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
    }, {timeout: 5_000}, pageNumber);
    const command = await callWorkspaceCommand(page, 'handlePasteImageFromClipboard');
    if (!command.called) {
        throw new Error('Electron paste-image menu command was not available');
    }
    // The command can resolve before reporting its result; the placement
    // surface below is what proves it started.
    if (command.value === false) {
        throw new Error(`Electron paste-image command did not start placement: ${JSON.stringify(command)}`);
    }
    await page.waitForSelector(ACTIVE_IMAGE_PLACEMENT_SELECTOR, {
        timeout: 30_000,
        visible: true,
    });
}

export async function finalizeImagePlacement(page: Page) {
    await clickAsUser(page, `${ACTIVE_IMAGE_PLACEMENT_SELECTOR} .pdf-image-placement__action--primary`);
    await page.waitForSelector(ACTIVE_IMAGE_PLACEMENT_SELECTOR, {
        hidden: true,
        timeout: 60_000,
    });
}
