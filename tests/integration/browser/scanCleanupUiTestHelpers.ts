import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {
    join, resolve,
} from 'node:path';
import {
    PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString,
} from 'pdf-lib';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
    decodeScanCleanupProvenanceStampHex, verifyScanCleanupProvenanceStampHex,
} from '@evb/scan-cleanup/core/provenanceStamp';
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
    expect(await page.locator('.scan-cleanup-toolbar button').filter({hasText: /^Clean up/u}).isDisabled(), 'browser Scan Cleanup conversion must enable Clean up').toBe(false);
    expect(await page.getByText(browserOnlyReason, {exact: true}).count()).toBe(0);
    expect(await page.getByText('Aligning page placement', {exact: true}).count()).toBe(0);
    expect(await page.evaluate(`(async () => {
        const {getPlatformAPI} = await import('/_nuxt/utils/platform.ts');
        return getPlatformAPI().scanCleanup.getSupport();
    })()`)).toEqual({
        preview: true,
        detection: true,
        calibration: true,
        conversion: true,
    });
    const inputs = await page.evaluate(() => (Reflect.get(window, '__sc3bProbe') as IProbe).inputs);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every(input => input.trusted), 'all pointer and keyboard input is trusted').toBe(true);
}

export const conversionModes = [
    {
        name: 'B&W',
        radio: 'Black and white',
        outputMode: 'bw',
    },
    {
        name: 'Gray',
        radio: 'Grayscale',
        outputMode: 'grayscale',
    },
    {
        name: 'Color',
        radio: 'Color',
        outputMode: 'color',
    },
    {
        name: 'Auto',
        radio: 'Auto — recommended per page',
        outputMode: 'auto',
    },
    {
        name: 'Keep original images',
        radio: 'Auto — recommended per page',
        outputMode: 'auto',
    },
] as const;

export type TConversionMode = typeof conversionModes[number];

/** Pin geometry through the controls, including the lossless no-resample path. */
export async function chooseConversionOptions(page: Page, mode: TConversionMode) {
    for (const name of [
        'Crop each output page to its content',
        'Match page size with other pages',
        'Skip blank pages',
        'Keep original images',
    ]) {
        await page.getByRole('checkbox', {
            name,
            exact: true,
        }).setChecked(false);
    }
    await select(page, 'Page layout', 'Force single pages');
    await page.getByRole('radio', {
        name: 'Left to right',
        exact: true,
    }).click();
    const linked = page.getByRole('switch', {
        name: 'Link margins',
        exact: true,
    });
    if (await linked.getAttribute('aria-checked') !== 'true') await linked.click();
    const margins = page.getByRole('spinbutton', {
        name: 'All sides (mm)',
        exact: true,
    });
    await margins.click();
    await margins.press('ControlOrMeta+a');
    await margins.press('0');
    await margins.press('Tab');
    expect(await margins.inputValue()).toBe('0');
    const advanced = page.getByRole('button', {
        name: 'Advanced',
        exact: true,
    });
    if (await advanced.getAttribute('aria-expanded') !== 'true') await advanced.click();
    await page.getByRole('checkbox', {
        name: 'Normalize uneven illumination',
        exact: true,
    }).setChecked(false);
    await page.getByRole('checkbox', {
        name: 'Automatically correct page curvature (experimental)',
        exact: true,
    }).setChecked(false);
    await page.getByRole('radio', {
        name: mode.radio,
        exact: true,
    }).click();
    await page.getByRole('checkbox', {
        name: 'Keep original images',
        exact: true,
    }).setChecked(mode.name === 'Keep original images');
    // Layout changes invalidate detection; use its durable terminal state.
    await expect.poll(() => page.locator('.scan-cleanup-surface').getAttribute('data-detection-status'), {timeout: 60_000}).toBe('completed');
}

interface IImageInventory {
    bits: string | null;
    colorSpace: string | null;
    filter: string | null;
    width: string | null;
    height: string | null;
    imageMask: string | null;
    mask: string | null;
    softMask: IImageInventory | null;
    streamSha256: string;
}

/** Inspect reachable image streams, including images nested in Form XObjects. */
function pageImages(pdf: PDFDocument, resources: PDFDict | undefined) {
    const images: IImageInventory[] = [];
    const seen = new Set<PDFRawStream>();
    const imageInfo = (image: PDFRawStream): IImageInventory => {
        const value = (key: string) => image.dict.lookup(PDFName.of(key))?.toString() ?? null;
        const softMask = image.dict.lookup(PDFName.of('SMask'));
        return {
            bits: value('BitsPerComponent'),
            colorSpace: value('ColorSpace'),
            filter: value('Filter'),
            width: value('Width'),
            height: value('Height'),
            imageMask: value('ImageMask'),
            mask: value('Mask'),
            softMask: softMask instanceof PDFRawStream ? imageInfo(softMask) : null,
            streamSha256: sha256(image.getContents()),
        };
    };
    const visit = (dictionary: PDFDict | undefined) => {
        const objects = dictionary?.lookup(PDFName.of('XObject'));
        if (!(objects instanceof PDFDict)) return;
        for (const ref of objects.values()) {
            const object = pdf.context.lookup(ref);
            if (!(object instanceof PDFRawStream) || seen.has(object)) continue;
            seen.add(object);
            const subtype = object.dict.lookup(PDFName.of('Subtype'))?.toString();
            if (subtype === '/Image') images.push(imageInfo(object));
            if (subtype === '/Form') {
                const nested = object.dict.lookup(PDFName.of('Resources'));
                visit(nested instanceof PDFDict ? nested : dictionary);
            }
        }
    };
    visit(resources);
    return images.sort((a, b) => a.streamSha256.localeCompare(b.streamSha256));
}

export async function inspectConversionPdf(bytes: Uint8Array) {
    const pdf = await PDFDocument.load(bytes);
    const task = getDocument({
        data: Uint8Array.from(bytes),
        useSystemFonts: true,
    });
    try {
        const textPdf = await task.promise;
        const pages = await Promise.all(pdf.getPages().map(async (page, index) => {
            const rendered = await textPdf.getPage(index + 1);
            const text = (await rendered.getTextContent()).items.flatMap(item => 'str' in item ? [item.str] : []).join('');
            return {
                mediaBox: page.getMediaBox(),
                cropBox: page.getCropBox(),
                rotation: page.getRotation().angle,
                images: pageImages(pdf, page.node.Resources()),
                text,
                annotationCount: page.node.Annots()?.size() ?? 0,
            };
        }));
        const info = pdf.context.lookup(pdf.context.trailerInfo.Info);
        const stamps = [
            pdf.catalog,
            info,
        ].flatMap(dictionary => {
            if (!(dictionary instanceof PDFDict)) return [];
            const value = dictionary.lookup(PDFName.of('EVBScanCleanup'));
            return value instanceof PDFString || value instanceof PDFHexString ? [value.decodeText()] : [];
        });
        return {
            pages,
            stamps,
        };
    } finally {
        await task.destroy();
    }
}

export function assertConversionPdf(
    source: Awaited<ReturnType<typeof inspectConversionPdf>>,
    output: Awaited<ReturnType<typeof inspectConversionPdf>>,
    sourceBytes: Uint8Array,
    mode: TConversionMode,
) {
    expect(source.pages).toHaveLength(4);
    expect(output.pages).toHaveLength(4);
    for (const [
        index,
        page,
    ] of output.pages.entries()) {
        const original = source.pages[index]!;
        for (const box of [
            'mediaBox',
            'cropBox',
        ] as const) {
            for (const dimension of [
                'x',
                'y',
                'width',
                'height',
            ] as const) {
                // Existing desktop oracle geometry tolerance: 0.5 pt.
                expect(Math.abs(page[box][dimension] - original[box][dimension]), `page ${String(index + 1)} ${box}.${dimension}`).toBeLessThanOrEqual(0.5);
            }
        }
        expect(page.rotation).toBe(original.rotation);
        // This primary fixture has neither OCR nor annotations. Conversion
        // must not invent either; preservation fixtures have their own lane.
        expect(original.text).toBe('');
        expect(original.annotationCount).toBe(0);
        expect(page.text).toBe(original.text);
        expect(page.annotationCount).toBe(original.annotationCount);
        expect(page.images.length).toBeGreaterThan(0);
        if (mode.name === 'Keep original images') {
            expect(page.images, 'lossless mode preserves each original compressed image stream').toEqual(original.images);
        } else {
            expect(page.images.every(image => image.softMask === null && image.mask === null)).toBe(true);
            for (const image of page.images) {
                if (mode.name === 'B&W') expect(image.bits).toBe('1');
                if (mode.name === 'Gray') {
                    expect(image.bits).toBe('8');
                    expect(image.colorSpace).toBe('/DeviceGray');
                }
                if (mode.name === 'Color') {
                    expect(image.bits).toBe('8');
                    // Desktop retains DeviceGray for an achromatic scan.
                    expect([
                        '/DeviceRGB',
                        '/DeviceGray',
                    ]).toContain(image.colorSpace);
                }
                if (mode.name === 'Auto') {
                    expect([
                        '1',
                        '8',
                    ]).toContain(image.bits);
                    expect([
                        '/DeviceGray',
                        '/DeviceRGB',
                    ]).toContain(image.colorSpace);
                }
            }
        }
    }
    expect(output.stamps, 'one run-level PDF provenance stamp').toHaveLength(1);
    const hex = output.stamps[0]!;
    expect(verifyScanCleanupProvenanceStampHex(hex, {expectedSourceSha256: sha256(sourceBytes)}).status).toBe('valid');
    const stamp = decodeScanCleanupProvenanceStampHex(hex);
    expect(stamp.effectiveOptions.perSourcePage.map(record => record.sourcePage)).toEqual([
        1,
        2,
        3,
        4,
    ]);
    expect(stamp.pagePlanDigests.map(record => record.sourcePage)).toEqual([
        1,
        2,
        3,
        4,
    ]);
    expect(stamp.outputMappings.map(mapping => ({
        sourcePage: mapping.sourcePage,
        ordinal: mapping.outputOrdinal,
        excluded: mapping.excluded,
        blank: mapping.blank,
    }))).toEqual(
        [
            1,
            2,
            3,
            4,
        ].map(sourcePage => ({
            sourcePage,
            ordinal: sourcePage,
            excluded: false,
            blank: false,
        })),
    );
    for (const {options} of stamp.effectiveOptions.perSourcePage) {
        expect(options).toMatchObject({
            preserveOriginalQuality: mode.name === 'Keep original images',
            layoutMode: 'force-single',
            cropContent: false,
            matchPageSize: false,
            normalizeIllumination: false,
        });
        if (mode.name === 'Auto') expect([
            'auto',
            'bw',
            'grayscale',
            'color',
            'mixed',
        ]).toContain(options.outputMode);
        else expect(options.outputMode).toBe(mode.name === 'Keep original images' ? 'color' : mode.outputMode);
        expect(options.experimental.autoDewarp).toBe(false);
    }
    return stamp;
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
