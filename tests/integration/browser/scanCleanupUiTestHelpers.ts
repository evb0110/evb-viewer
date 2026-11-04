import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {
    join, resolve,
} from 'node:path';
import type {
    Locator, Page,
} from 'playwright';
import {expect} from 'vitest';
import {openPdfFromChooser} from './documentLifecycleTestHelpers';

/** Shared by the browser Scan Cleanup workspace suites. */
export const evidenceRoot = resolve(process.env.SC3B_EVIDENCE_DIR ?? `.devkit/parity/sc3b-ui-${String(process.pid)}`);
export const scanCleanupUiTimeoutMs = 120_000;
export const previewImage = '.preview-comparison-layer.is-visible img.preview-pixel:not(.is-outgoing):not(.is-incoming)';
export const cleanedImage = '.cleaned-outputs img.preview-pixel:not(.is-outgoing):not(.is-incoming)';
export const browserOnlyReason = 'In the browser, scan cleanup previews pages but cannot clean up the document yet. Use the desktop app to clean it up.';
export const provisionalPageSizeNotice = 'Page size may still change until every page is analyzed.';
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export interface IProbe {
    holdNext: boolean;
    held: Array<() => void>;
    inputs: Array<{
        type: string;
        trusted: boolean
    }>;
}



export async function installProbe(page: Page) {
    await page.addInitScript(() => {
        // Cache Storage is an OCR prerequisite, not a cleanup prerequisite.
        // Leave Workers, WASM, IndexedDB and the cleanup engine intact.
        Object.defineProperty(window, 'caches', {
            configurable: true,
            value: undefined,
        });
        const probe: IProbe = {
            holdNext: false,
            held: [],
            inputs: JSON.parse(window.sessionStorage.getItem('sc3b:trusted-inputs') ?? '[]'),
        };
        Reflect.set(window, '__sc3bProbe', probe);
        for (const type of [
            'pointerdown',
            'keydown',
        ]) {
            document.addEventListener(type, event => {
                probe.inputs.push({
                    type,
                    trusted: event.isTrusted,
                });
                window.sessionStorage.setItem('sc3b:trusted-inputs', JSON.stringify(probe.inputs));
            }, true);
        }
        const post = Worker.prototype.postMessage;
        const add = Worker.prototype.addEventListener;
        const remove = Worker.prototype.removeEventListener;
        const requests = new WeakMap<Worker, Map<number, string>>();
        const listeners = new WeakMap<object, EventListenerOrEventListenerObject>();
        Worker.prototype.postMessage = function(message, transfer) {
            if (message?.type === 'render-preview') {
                const types = requests.get(this) ?? new Map<number, string>();
                types.set(message.id, message.type);
                requests.set(this, types);
            }
            return Reflect.apply(post, this, [
                message,
                transfer ?? [],
            ]);
        };
        Reflect.set(Worker.prototype, 'addEventListener', function(this: Worker, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
            if (!listener) return;
            if (type !== 'message') return add.call(this, type, listener, options);
            const wrapped: EventListener = event => {
                const deliver = () => typeof listener === 'function'
                    ? listener.call(this, event)
                    : listener.handleEvent(event);
                if (requests.get(this)?.get((event as MessageEvent).data?.id) === 'render-preview' && probe.holdNext) {
                    // Delay a real completed engine response at the Worker boundary.
                    // No fake raster, cleanup result, or application method is used.
                    probe.holdNext = false;
                    probe.held.push(deliver);
                } else deliver();
            };
            listeners.set(listener, wrapped);
            return add.call(this, type, wrapped, options);
        });
        Reflect.set(Worker.prototype, 'removeEventListener', function(this: Worker, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
            if (!listener) return;
            return remove.call(this, type, listeners.get(listener) ?? listener, options);
        });
    });
}

export async function openWorkspace(page: Page, source: Parameters<typeof openPdfFromChooser>[1]) {
    await openPdfFromChooser(page, source);
    await showWorkspace(page);
}

export async function showWorkspace(page: Page) {
    await page.locator('.page_container[data-page="1"] canvas').first().waitFor();
    expect(await page.getByRole('button', {
        name: 'OCR',
        exact: true,
    }).count(), 'OCR is unavailable in this context').toBe(0);
    const trigger = page.locator('#editor-global-toolbar-host').getByRole('button', {
        name: 'Scan cleanup',
        exact: true,
    });
    await expect.poll(() => trigger.count(), {timeout: 15_000}).toBe(1);
    await trigger.click();
    await page.locator('.scan-cleanup-surface').waitFor();
    const guidance = page.getByRole('button', {
        name: 'Got it',
        exact: true,
    });
    if (await guidance.count()) await guidance.click();
}

export async function waitForPixels(page: Page, pageNumber: number, totalPages = 3) {
    await page.locator('.page-label .scan-cleanup-stable-width-value').filter({hasText: `Page ${String(pageNumber)} of ${String(totalPages)}`}).waitFor();
    await page.waitForFunction(({
        selector, pageNumber,
    }) => {
        const images = [...document.querySelectorAll<HTMLImageElement>(selector)];
        return images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0
            && image.alt.startsWith(`Cleaned scan preview for page ${String(pageNumber)},`))
            && !document.querySelector('.refresh-indicator, .page-loading-overlay, .preview-loading, .preview-refresh-error, .preview-message.is-error')
            && !document.querySelector('.cleaned-outputs .is-incoming, .cleaned-outputs .is-outgoing, .cutter-stage.is-stale-content');
    }, {
        selector: cleanedImage,
        pageNumber,
    }, {timeout: 30_000});
}

export async function pixels(image: Locator) {
    return image.evaluate(element => {
        const img = element as HTMLImageElement;
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d')!.drawImage(img, 0, 0);
        return canvas.toDataURL('image/png').split(',')[1]!;
    });
}

/** The first inked pixel row of the cleaned preview, and the preview's height. */
export async function cleanedInkTop(page: Page) {
    return page.locator(cleanedImage).first().evaluate(element => {
        const img = element as HTMLImageElement;
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const context = canvas.getContext('2d')!;
        context.drawImage(img, 0, 0);
        const {data} = context.getImageData(0, 0, canvas.width, canvas.height);
        for (let y = 0; y < canvas.height; y += 1) {
            for (let x = 0; x < canvas.width; x += 1) {
                if (data[(y * canvas.width + x) * 4]! < 128) return {
                    row: y,
                    height: canvas.height,
                };
            }
        }
        return null;
    });
}

export async function cleanedPixels(page: Page) {
    return JSON.stringify(await Promise.all((await page.locator(cleanedImage).all()).map(async image => sha256(Buffer.from(await pixels(image), 'base64')))));
}

export async function assertBrowserScope(page: Page) {
    // The workspace detects every page on its own, as desktop does: the
    // control to detect again is offered, and matched page sizes settle.
    await expect.poll(() => page.locator('.scan-cleanup-surface').getAttribute('data-detection-status'), {timeout: 60_000}).toBe('completed');
    expect(await page.getByRole('button', {
        name: 'Detect layout for all pages',
        exact: true,
    }).isDisabled()).toBe(false);
    await expect.poll(() => page.getByText(provisionalPageSizeNotice, {exact: true}).count(), {timeout: 30_000}).toBe(0);
    expect(await page.locator('.scan-cleanup-toolbar button').filter({hasText: /^Clean up/u}).isDisabled()).toBe(true);
    expect(await page.locator('[data-run-disabled-reason]').innerText()).toBe(browserOnlyReason);
    expect(await page.getByText('Aligning page placement', {exact: true}).count()).toBe(0);
    expect(await page.evaluate(`(async () => {
        const {getPlatformAPI} = await import('/_nuxt/utils/platform.ts');
        return getPlatformAPI().scanCleanup.getSupport();
    })()`)).toEqual({
        preview: true,
        detection: true,
        calibration: true,
        conversion: false,
    });
    const inputs = await page.evaluate(() => (Reflect.get(window, '__sc3bProbe') as IProbe).inputs);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every(input => input.trusted), 'all pointer and keyboard input is trusted').toBe(true);
}

export async function select(page: Page, name: string, option: string) {
    await page.getByRole('combobox', {
        name,
        exact: true,
    }).click();
    await page.getByRole('option', {
        name: option,
        exact: true,
    }).click();
}

export async function drag(page: Page, locator: Locator, dx: number, dy: number) {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + dx, box!.y + box!.height / 2 + dy, {steps: 8});
    await page.mouse.up();
}

export async function undoRedo(page: Page, label: string, observe: () => Promise<string>, before: string, after: string) {
    await page.screenshot({path: join(evidenceRoot, `${label}-edited.png`)});
    await page.keyboard.press('ControlOrMeta+z');
    try {
        await expect.poll(observe).toBe(before);
    } finally {
        await writeFile(join(evidenceRoot, `${label}-undo.json`), JSON.stringify({
            before,
            edited: after,
            afterUndo: await observe(),
        }, null, 2));
        await page.screenshot({path: join(evidenceRoot, `${label}-undo.png`)});
    }
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(observe).toBe(after);
}
