import {createHash} from 'node:crypto';
import {
    readFileSync, writeFileSync, mkdirSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    PDFDocument, PDFDict, PDFHexString, PDFName, PDFArray, PDFString,
} from 'pdf-lib';
import {spawnSync} from 'node:child_process';
import type {Page} from 'playwright';
import {createPdfConformanceFixture} from '@tests/helpers/createPdfConformanceFixture';
import type {createFileSystemFileHandle as createFixtureFileHandle} from '@tests/unit/app/platform/browserPlatformTestDoubles';
import {
    afterAll, beforeAll, describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    openPdfFromChooser, lifecycle, waitForOpenFileReady, clickCenter, settleActiveOpen,
} from './documentLifecycleTestHelpers';

describe('browser document lifecycle UI', () => {

    // Keep document preparation in bounded hooks, as in the signature-field cases.
    // The five-second test body covers the real operation and its saved-byte contract.
    describe.each([
        'rotate',
        'crop',
    ] as const)('historical CMS preservation after browser %s', operation => {
        let page: Page;
        let original: PDFDocument;
        let verify: (bytes: Buffer, label: string) => void;
        const source = readFileSync(resolve('tests/fixtures/electron/pdf-preservation/signed.pdf'));
        const evidence = resolve('.devkit/fixes16/evidence/signed-browser');
        beforeAll(async () => {
            mkdirSync(evidence, {recursive: true});
            original = await PDFDocument.load(source);
            const signature = original.context.enumerateIndirectObjects().find(([
                , object,
            ]) => object instanceof PDFDict && object.has(PDFName.of('ByteRange')))?.[1];
            if (!(signature instanceof PDFDict)) throw new Error('Fixture signature missing');
            const contents = signature.get(PDFName.of('Contents'));
            if (!(contents instanceof PDFHexString)) throw new Error('Fixture CMS missing');
            const der = Buffer.from(contents.asBytes());
            writeFileSync(resolve(evidence, 'signature.der'), der);
            verify = (bytes: Buffer, label: string) => {
                const ranges = bytes.toString('latin1').match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/u);
                if (!ranges) throw new Error('Saved signature ByteRange missing');
                const [
                    a,
                    b,
                    c,
                    d,
                ] = ranges.slice(1).map(Number) as [number, number, number, number];
                writeFileSync(resolve(evidence, `${label}.ranges.bin`), Buffer.concat([
                    bytes.subarray(a, a + b),
                    bytes.subarray(c, c + d),
                ]));
                const result = spawnSync('openssl', [
                    'cms',
                    '-verify',
                    '-binary',
                    '-inform',
                    'DER',
                    '-in',
                    resolve(evidence, 'signature.der'),
                    '-content',
                    resolve(evidence, `${label}.ranges.bin`),
                    '-noverify',
                    '-out',
                    resolve(evidence, `${label}.verified.bin`),
                ], {encoding: 'utf8'});
                writeFileSync(resolve(evidence, `${label}.cms.log`), result.stderr);
                expect(result.status, `${label}: ${result.stderr}`).toBe(0);
            };
            verify(source, 'original');

            const context = await lifecycle.browser.newContext({acceptDownloads: true});
            page = await context.newPage();
            await openPdfFromChooser(page, {
                name: 'signed.pdf',
                mimeType: 'application/pdf',
                buffer: source,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor();
            await settleActiveOpen(page);
            await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
            await page.getByRole('tab', {
                name: 'Pages',
                exact: true,
            }).click();
        });

        afterAll(async () => {
            await page?.context().close();
        });

        it('preserves the historical CMS digest and saves the page edit', async () => {
            if (operation === 'rotate') {
                await clickCenter(page, '[data-thumbnail-page="1"]', 'right');
                await page.getByRole('menuitem', {
                    name: 'Rotate Clockwise',
                    exact: true,
                }).click();
            } else {
                await page.getByRole('button', {
                    name: 'Crop Pages',
                    exact: true,
                }).click();
                const overlay = page.locator('.crop-overlay.is-active').first();
                await overlay.waitFor();
                const box = await overlay.boundingBox();
                if (!box) throw new Error('Crop overlay has no painted rectangle');
                await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
                await page.mouse.down();
                await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8, {steps: 8});
                await page.mouse.up();
                await page.getByRole('button', {
                    name: 'Apply Crop',
                    exact: true,
                }).click();
            }
            const download = page.waitForEvent('download');
            await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).click();
            const path = await (await download).path();
            if (!path) throw new Error('Signed Save As produced no download');
            const saved = readFileSync(path);
            verify(saved, operation);
            expect(saved.subarray(0, source.length)).toEqual(source);
            const reopened = await PDFDocument.load(saved);
            if (operation === 'rotate') expect(reopened.getPage(0).getRotation().angle).toBe(90);
            else expect(reopened.getPage(0).getCropBox().width).toBeLessThan(original.getPage(0).getCropBox().width);
        });
    });

    describe.each([
        'delete',
        'extract',
    ] as const)('form membership after browser %s', operation => {
        let page: Page;

        beforeAll(async () => {
            const source = readFileSync(resolve('tests/fixtures/electron/pdf-preservation/forms.pdf'));
            const context = await lifecycle.browser.newContext({acceptDownloads: true});
            page = await context.newPage();
            await openPdfFromChooser(page, {
                name: 'forms.pdf',
                mimeType: 'application/pdf',
                buffer: source,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor();
            await settleActiveOpen(page);
            await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
            await page.getByRole('tab', {
                name: 'Pages',
                exact: true,
            }).click();
        });

        afterAll(async () => {
            await page?.context().close();
        });

        it('removes deleted-page form values through the page menu and saved bytes', async () => {
            await clickCenter(page, `[data-thumbnail-page="${operation === 'delete' ? 2 : 1}"]`, 'right');
            const download = page.waitForEvent('download');
            await page.getByRole('menuitem', {
                name: operation === 'delete' ? 'Delete Pages' : 'Extract to New PDF',
                exact: true,
            }).click();
            if (operation === 'delete') {
                await expect.poll(() => page.locator('.page-controls-total').first().innerText()).toBe('1');
                await page.getByRole('button', {
                    name: 'Save',
                    exact: true,
                }).click();
            }
            const path = await (await download).path();
            if (!path) throw new Error('Page operation produced no downloaded PDF');
            const saved = await PDFDocument.load(readFileSync(path));
            expect(saved.getPageCount()).toBe(1);
            expect(saved.getForm().getFields().map(field => field.getName())).toEqual(['retained']);
            expect(saved.getForm().getTextField('retained').getText()).toBe('VISIBLE');
        });
    });

    describe.each([
        'StructTreeRoot',
        'OCProperties',
    ])('browser Combine with %s', key => {
        let page: Page;
        let expectedPageCount: number;

        beforeAll(async () => {
            const context = await lifecycle.browser.newContext();
            page = await context.newPage();
            const source = await PDFDocument.load(readFileSync(resolve('tests/fixtures/electron/pdf-preservation/layers-and-tags.pdf')));
            source.catalog.delete(PDFName.of(key === 'StructTreeRoot' ? 'OCProperties' : 'StructTreeRoot'));
            const feature = Buffer.from(await source.save());
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            await page.locator('nav[aria-label="File"] button.rail-item').click();
            await page.locator('[data-combine-page]').waitFor();
            await page.locator('input[type="file"]').setInputFiles([
                {
                    name: 'features.pdf',
                    mimeType: 'application/pdf',
                    buffer: feature,
                },
                {
                    name: 'ordinary.pdf',
                    mimeType: 'application/pdf',
                    buffer: readFileSync(resolve('tests/fixtures/electron/generated-text.pdf')),
                },
            ]);
            await page.locator('[data-combine-row]').nth(1).waitFor();
            expectedPageCount = source.getPageCount() + (await PDFDocument.load(readFileSync(resolve('tests/fixtures/electron/generated-text.pdf')))).getPageCount();
        });

        afterAll(async () => {
            await page?.context().close();
        });

        it('opens the combined result without a preservation refusal', async () => {
            await page.locator('footer.combine-actions button').click();
            await expect.poll(async () => await page.locator('.app-toast, .page_container').count() > 0).toBe(true);
            await page.locator('.page_container').first().waitFor({state: 'visible'});
            expect((await page.locator('.app-toast-failure').allTextContents()).join('\n')).toBe('');
            expect(await page.locator('.page-controls-total').first().innerText()).toBe(String(expectedPageCount));
        });
    });

    // T3/T6: a populated signature requires Save As for a rewrite, including
    // above 16 MiB when the signature is compressed. An empty field saves in place.
    describe.each([
        {
            pendingPageLabels: false,
            kind: 'signed',
            paddingBytes: 0,
        },
        {
            pendingPageLabels: false,
            kind: 'unsigned-signature-field',
            paddingBytes: 0,
        },
        {
            pendingPageLabels: false,
            kind: 'signed-object-stream',
            paddingBytes: 24 * 1024 * 1024,
        },
        {
            pendingPageLabels: false,
            kind: 'unsigned-signature-field',
            paddingBytes: 24 * 1024 * 1024,
        },
        {
            pendingPageLabels: true,
            kind: 'signed-object-stream',
            paddingBytes: 24 * 1024 * 1024,
        },
    ] as const)('signature-field Save after a page edit ($kind, $paddingBytes bytes padding, pending labels $pendingPageLabels)', ({
        kind, paddingBytes, pendingPageLabels,
    }) => {
        let fixture: {
            page: Page;
            bytes: Uint8Array
        } | undefined;
        const evidenceRoot = process.env.EVB_C10_EVIDENCE_DIR;
        const evidence = evidenceRoot ? resolve(evidenceRoot, `${kind}-${paddingBytes}`) : undefined;
        const signed = kind !== 'unsigned-signature-field';
        const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

        beforeAll(async () => {
            const context = await lifecycle.browser.newContext({viewport: {
                width: 1280,
                height: 900,
            }});
            const page = await context.newPage();
            const bytes = await createPdfConformanceFixture(kind, {padding: paddingBytes ? new Uint8Array(paddingBytes) : undefined});
            fixture = {
                page,
                bytes,
            };
            if (paddingBytes) expect(bytes.byteLength).toBeGreaterThan(24 * 1024 * 1024);
            if (evidence) {
                mkdirSync(evidence, {recursive: true});
                writeFileSync(resolve(evidence, 'source.pdf'), bytes);
                page.on('console', message => {
                    writeFileSync(resolve(evidence, 'console.log'), `${message.type()}: ${message.text()}\n`, {flag: 'a'});
                });
                page.on('pageerror', error => {
                    writeFileSync(resolve(evidence, 'console.log'), `pageerror: ${error.message}\n`, {flag: 'a'});
                });
            }
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            // Seed real OPFS files through a binary response, avoiding a large
            // JSON number array over CDP. Only picker handles are substituted.
            // Keep routing until context disposal: disabling interception here
            // can strand in-flight viewer module requests before the first paint.
            const fixtureUrl = `${lifecycle.origin}/c10-signature-source.pdf`;
            await page.route(fixtureUrl, route => route.fulfill({
                contentType: 'application/pdf',
                body: Buffer.from(bytes),
            }));
            await page.evaluate(`(async () => {
                const {createFileSystemFileHandle} = await import(${JSON.stringify(`${lifecycle.origin}/_nuxt/@fs${process.cwd()}/tests/unit/app/platform/browserPlatformTestDoubles.ts`)});
                window.__createSignatureFileHandle = createFileSystemFileHandle;
            })()`);
            await page.evaluate(async fixtureUrl => {
                const createFileSystemFileHandle = Reflect.get(window, '__createSignatureFileHandle') as typeof createFixtureFileHandle;
                const directory = await navigator.storage.getDirectory();
                const original = await directory.getFileHandle('original.pdf', {create: true});
                const destination = await directory.getFileHandle('signed-copy.pdf', {create: true});
                const writable = await original.createWritable();
                await writable.write(await (await fetch(fixtureUrl)).arrayBuffer());
                await writable.close();
                const wrap = (fileHandle: FileSystemFileHandle) => {
                    const handle = Object.assign(createFileSystemFileHandle({
                        name: fileHandle.name,
                        getFile: async () => {
                            const file = await fileHandle.getFile();
                            return new File([await file.arrayBuffer()], file.name, {
                                type: file.type,
                                lastModified: file.lastModified,
                            });
                        },
                        isSameEntry: async (other: FileSystemHandle): Promise<boolean> => other === handle,
                    }), {createWritable: () => fileHandle.createWritable()});
                    return handle;
                };
                const originalHandle = wrap(original);
                const destinationHandle = wrap(destination);
                Reflect.set(window, '__signatureSaveAsPicks', 0);
                Reflect.set(window, 'showOpenFilePicker', async () => [originalHandle]);
                Reflect.set(window, 'showSaveFilePicker', async () => {
                    Reflect.set(window, '__signatureSaveAsPicks', Number(Reflect.get(window, '__signatureSaveAsPicks')) + 1);
                    return destinationHandle;
                });
            }, fixtureUrl);
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await page.locator('.page_container--rendered canvas').first().waitFor();
            await settleActiveOpen(page);
        }, 90_000);

        afterAll(async () => {
            await fixture?.page.context().close();
        });

        it(pendingPageLabels
            ? 'requires Save As for a signed PDF with unsaved page labels'
            : 'saves rotated unsigned signature fields in place and requires Save As for signed PDFs', async () => {
            if (!fixture) throw new Error(`Missing signature fixture: ${kind}`);
            const {
                page, bytes,
            } = fixture;
            const readFile = async (name: string) => Buffer.from(await page.evaluate(async name => {
                const directory = await navigator.storage.getDirectory();
                const file = await (await directory.getFileHandle(name)).getFile();
                return new Promise<string>((resolveBytes, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolveBytes(String(reader.result).split(',')[1]!);
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(file);
                });
            }, name), 'base64');
            const saveAsPicks = () => page.evaluate(() => Number(Reflect.get(window, '__signatureSaveAsPicks')));
            if (!await page.locator('[data-thumbnail-page="1"]').first().isVisible()) {
                await page.getByRole('button', {
                    name: 'Toggle Sidebar',
                    exact: true,
                }).click();
                await page.getByRole('tab', {
                    name: 'Pages',
                    exact: true,
                }).click();
            }
            if (pendingPageLabels) {
                const installHint = page.locator('.browser-install-dismiss');
                if (await installHint.isVisible()) await installHint.click();
                const disclosure = page.locator('.pdf-sidebar-pages-disclosure');
                if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
                await page.locator('#page-label-prefix-input').fill('Signed-');
                await page.getByRole('button', {name: 'Apply numbering', exact: true}).click();
                await expect.poll(() => page.locator('[data-thumbnail-page="1"] [data-document-thumbnail-label]').innerText()).toContain('Signed-1');
                await disclosure.click();
            } else {
                await clickCenter(page, '[data-thumbnail-page="1"]', 'right');
                await page.getByRole('menuitem', {
                    name: 'Rotate Clockwise',
                    exact: true,
                }).click();
                await expect.poll(() => page.locator('.page_container--rendered[data-page="1"]').first().evaluate(element => {
                    const rect = element.getBoundingClientRect();
                    return rect.width > rect.height;
                })).toBe(true);
            }
            await page.waitForFunction(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{isPageOperationInProgress: boolean}>(['isPageOperationInProgress']).isPageOperationInProgress === false;
            });
            const save = page.getByRole('button', {
                name: 'Save',
                exact: true,
            });
            await save.click();
            // Either file publication or Save As is a completion signal on both
            // revisions, so the baseline fails on routing, not on a timeout.
            await expect.poll(async () => await saveAsPicks() > 0
                || sha256(await readFile('original.pdf')) !== sha256(bytes)).toBe(true);
            await expect.poll(() => save.getAttribute('aria-busy')).toBe('false');
            const original = await readFile('original.pdf');
            const destination = await readFile('signed-copy.pdf');
            const rotation = (await PDFDocument.load(original)).getPage(0).getRotation().angle;
            const pickerRequests = await saveAsPicks();
            const rewritten = Buffer.compare(original, Buffer.from(bytes)) !== 0;
            const destinationRotation = destination.length ? (await PDFDocument.load(destination)).getPage(0).getRotation().angle : null;
            if (evidence) {
                const result = {
                    kind,
                    paddingBytes,
                    saveAsPickerRequests: pickerRequests,
                    originalRewritten: rewritten,
                    originalPage1Rotation: rotation,
                    destinationPage1Rotation: destinationRotation,
                    source: {
                        size: bytes.length,
                        sha256: sha256(bytes),
                    },
                    original: {
                        size: original.length,
                        sha256: sha256(original),
                    },
                    destination: {
                        size: destination.length,
                        sha256: sha256(destination),
                    },
                };
                console.info('Signature Save evidence', JSON.stringify(result));
                writeFileSync(resolve(evidence, 'result.json'), JSON.stringify(result, null, 2));
                writeFileSync(resolve(evidence, 'original-after-save.pdf'), original);
                writeFileSync(resolve(evidence, 'destination.pdf'), destination);
                await page.screenshot({path: resolve(evidence, 'after-save.png')});
            }
            expect(pickerRequests, `${kind}: Save As picker requests`).toBe(signed ? 1 : 0);
            expect(rewritten, `${kind}: original file rewritten`).toBe(!signed);
            expect(rotation, `${kind}: saved page 1 rotation`).toBe(signed ? 0 : 90);
            expect(destinationRotation, `${kind}: destination page 1 rotation`).toBe(signed ? pendingPageLabels ? 0 : 90 : null);
            if (pendingPageLabels) {
                const saved = await PDFDocument.load(destination);
                const labels = saved.catalog.lookup(PDFName.of('PageLabels'), PDFDict);
                const range = labels.lookup(PDFName.of('Nums'), PDFArray).lookup(1, PDFDict);
                expect(range.lookup(PDFName.of('P'), PDFString, PDFHexString).decodeText()).toBe('Signed-');
            }
            const reopened = await page.context().newPage();
            await openPdfFromChooser(reopened, {
                name: signed ? 'signed-copy.pdf' : 'original.pdf',
                mimeType: 'application/pdf',
                buffer: signed ? destination : original,
            });
            await expect.poll(() => reopened.locator('.textLayer').first().innerText()).toContain(`Conformance fixture ${kind}`);
            await expect.poll(() => reopened.locator('.page_container--rendered[data-page="1"]').first().evaluate(element => {
                const rect = element.getBoundingClientRect();
                return rect.width > rect.height;
            })).toBe(!pendingPageLabels);
            if (evidence) await reopened.screenshot({path: resolve(evidence, 'reopened.png')});
            await reopened.close();
        }, 90_000);
    });
});
