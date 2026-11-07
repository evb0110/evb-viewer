import {
    createHash, randomBytes,
} from 'node:crypto';
import {
    readFileSync, writeFileSync, rmSync, openSync, writeSync, closeSync, mkdirSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    PDFDocument, PDFDict, PDFHexString, PDFName, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject, setTextRenderingMode, TextRenderingMode,
} from 'pdf-lib';
import {spawnSync} from 'node:child_process';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {chromium} from 'playwright';
import type {Page} from 'playwright';
import {createPdfConformanceFixture} from '@tests/helpers/createPdfConformanceFixture';
import type {createFileSystemFileHandle as createFixtureFileHandle} from '@tests/unit/app/platform/browserPlatformTestDoubles';
import {
    afterAll, beforeAll, describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    installPickerHandleFixture, openPdfFromChooser, lifecycle, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled, addNote, noteTexts, clickCenter, paneSelector, zoomActivePane, readRecoveries, settleActiveOpen,
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
    ])('browser Combine refusal for %s', key => {
        let page: Page;
        let tabCount: number;

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
            tabCount = await page.getByRole('tab').count();
        });

        afterAll(async () => {
            await page?.context().close();
        });

        it('shows the localized refusal without saving a result or generating a tab', async () => {
            await page.locator('footer.combine-actions button').click();
            await expect.poll(async () => await page.locator('.app-toast, .page_container').count() > 0
                || await page.getByRole('tab').count() > tabCount).toBe(true);
            expect((await page.locator('.app-toast').allTextContents()).join('\n')).toContain('This operation was stopped because it cannot preserve the PDF’s accessibility tags or layers. No result was saved.');
            expect(await page.locator('[data-combine-row]').count()).toBe(2);
            expect(await page.getByRole('tab').count()).toBe(tabCount);
            expect(await page.locator('.page_container').count()).toBe(0);
        });
    });

    it('saves a note and rotation in a PDF over 16 MiB', async () => {
        const context = await lifecycle.browser.newContext({
            viewport: {
                width: 1280,
                height: 900,
            },
            acceptDownloads: true,
        });
        try {
            const page = await context.newPage();
            const pdf = await PDFDocument.create();
            pdf.addPage([
                400,
                600,
            ]).drawText('Large PDF page one', {
                x: 40,
                y: 500,
                size: 24,
            });
            // A valid, incompressible stream crosses the old 16 MiB limit
            // without making the rendered page expensive or the fixture huge.
            pdf.catalog.set(PDFName.of('EvidencePadding'), pdf.context.register(
                pdf.context.stream(randomBytes(20 * 1024 * 1024)),
            ));
            const bytes = Buffer.from(await pdf.save({useObjectStreams: false}));
            expect(bytes.byteLength).toBeGreaterThan(20 * 1024 * 1024);
            await openPdfFromChooser(page, {
                name: 'large-note-and-rotation.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 60_000});
            await settleActiveOpen(page);
            await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
            await page.getByRole('tab', {
                name: 'Pages',
                exact: true,
            }).click();
            await clickCenter(page, '[data-thumbnail-page="1"]', 'right');
            await page.getByRole('menuitem', {
                name: 'Rotate Clockwise',
                exact: true,
            }).click();
            await expect.poll(async () => {
                const box = await page.locator('.page_container--rendered[data-page="1"]').first().boundingBox();
                return box ? box.width > box.height : false;
            }, {timeout: 60_000}).toBe(true);
            await page.waitForFunction(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{isPageOperationInProgress: boolean}>(
                    ['isPageOperationInProgress'],
                ).isPageOperationInProgress === false;
            }, undefined, {timeout: 60_000});
            // Rotation can show its preview before the replacement page is interactive.
            await settleActiveOpen(page);
            await page.locator('.page_container[data-page="1"][data-page-raster="current"] [data-pdf-annotation-editor-ready="true"]').first().waitFor();
            await addNote(page, 'Large PDF note survives Save', {
                x: 120,
                y: 120,
            });
            const download = page.waitForEvent('download', {timeout: 60_000}).catch(() => null);
            const save = page.getByRole('button', {
                name: 'Save',
                exact: true,
            });
            await save.click();
            await expect.poll(() => save.getAttribute('aria-busy'), {timeout: 60_000}).toBe('false');
            expect(await page.locator('.app-toast-failure').allTextContents()).toEqual([]);
            const artifact = await download;
            expect(artifact).not.toBeNull();
            const savedPath = await artifact!.path();
            expect(savedPath).not.toBeNull();
            const saved = await PDFDocument.load(readFileSync(savedPath!));
            expect(saved.getPage(0).getRotation().angle).toBe(90);
            expect(Array.from(noteTexts(saved, '/Text'))).toContain('Large PDF note survives Save');
            expect(await page.locator('.app-toast-failure').count()).toBe(0);
        } finally {
            await context.close();
        }
    }, 180_000);
    // Behavior contract: Optimize publishes a distinct copy, keeps live text and
    // editable annotations, and makes the bytes it published the next Save base.
    it('optimizes a dirty PDF copy and adopts exactly the published bytes', async () => {
        const profile = resolve(process.cwd(), `.devkit/optimize-ui-profile-${process.pid}`);
        const context = await chromium.launchPersistentContext(profile, {
            headless: true,
            channel: 'chromium',
            viewport: {
                width: 1600,
                height: 1000,
            },
        });
        const page = await context.newPage();
        let stage = 'fixture';
        const diagnostics: string[] = [];
        page.on('crash', () => diagnostics.push('PAGE CRASH'));
        page.on('close', () => diagnostics.push('PAGE CLOSE'));
        page.on('console', message => {
            diagnostics.push(`${message.type()}: ${message.text()}`);
            if (message.type() === 'error' || message.type() === 'warning') {
                void Promise.all(message.args().map(argument => argument.jsonValue().catch(() => null)))
                    .then(arguments_ => diagnostics.push(JSON.stringify(arguments_)));
            }
        });
        page.on('pageerror', error => diagnostics.push(`pageerror: ${String(error)}`));
        const outputDirectory = resolve(process.cwd(), '.devkit/optimize-ui-evidence');
        mkdirSync(outputDirectory, {recursive: true});
        const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
        try {
            const pdf = await PDFDocument.create();
            pdf.setCreationDate(new Date(0));
            pdf.setModificationDate(new Date(0));
            const scanPage = pdf.addPage([
                400,
                600,
            ]);
            // Uncompressed RGB scan with paper texture and dark text-like bars.
            // The deterministic texture keeps this a useful compression fixture.
            const width = 800;
            const height = 1200;
            const pixels = new Uint8Array(width * height * 3);
            for (let y = 0; y < height; y += 1) {
                for (let x = 0; x < width; x += 1) {
                    const value = y % 65 < 9 && x > 90 && x < 1080 ? 35 : 230 + (x * 17 + y * 29) % 25;
                    pixels.fill(value, (y * width + x) * 3, (y * width + x) * 3 + 3);
                }
            }
            const scan = pdf.context.register(pdf.context.stream(pixels, {
                Type: 'XObject',
                Subtype: 'Image',
                Width: width,
                Height: height,
                BitsPerComponent: 8,
                ColorSpace: 'DeviceRGB',
            }));
            const scanName = scanPage.node.newXObject('Scan', scan);
            scanPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(400, 0, 0, 600, 0, 0), drawObject(scanName), popGraphicsState());
            scanPage.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
            scanPage.drawText('Hidden OCR survives Optimize', {
                x: 40,
                y: 550,
                size: 14,
            });
            scanPage.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
            const original = Buffer.from(await pdf.save({useObjectStreams: false}));
            writeFileSync(resolve(outputDirectory, 'fixture.pdf'), original);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            await page.evaluate(async (bytes) => {
                const directory = await navigator.storage.getDirectory();
                const source = await directory.getFileHandle('original-scan.pdf', {create: true});
                const writer = await source.createWritable();
                await writer.write(Uint8Array.from(bytes));
                await writer.close();
                Reflect.set(window, '__optimizeOriginalHandle', source);
                // This activation-sensitive OPFS fixture is not a native picker.
                Reflect.set(window, 'showSaveFilePicker', async () => {
                    Reflect.set(window, '__optimizePickerActivation', navigator.userActivation.isActive);
                    if (!navigator.userActivation.isActive) throw new DOMException('No user activation', 'SecurityError');
                    return directory.getFileHandle('optimized-scan.pdf', {create: true});
                });
            }, Array.from(original));
            // Bind the byte-identical native target before the open takes its
            // revision. This setup must not invalidate a document already open.
            await page.evaluate(`(async () => {
                const {browserDocumentStore: store} = await import('/_nuxt/platform/browserDocumentStore.ts');
                const register = store.registerFileWithOwnership.bind(store);
                store.registerFileWithOwnership = async (...args) => {
                    const result = await register(...args);
                    await store.assignSaveTarget(result.ref, 'original-scan.pdf', 'pdf', Reflect.get(window, '__optimizeOriginalHandle'));
                    await store.getDocumentRevision(result.ref);
                    store.registerFileWithOwnership = register;
                    return result;
                };
            })()`);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'original-scan.pdf',
                mimeType: 'application/pdf',
                buffer: original,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor();
            await settleActiveOpen(page);
            const originalRef = await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{originalPath: string}>(['originalPath']).originalPath;
            });
            expect(originalRef).toBeDefined();
            const readOriginal = () => page.evaluate(async () => {
                const source = await (await navigator.storage.getDirectory()).getFileHandle('original-scan.pdf');
                return Array.from(new Uint8Array(await (await source.getFile()).arrayBuffer()));
            });
            await addNote(page, 'Dirty note survives Optimize', {
                x: 170,
                y: 220,
            });
            await page.evaluate(`(async () => {
                const {getDocumentFilesCapability, getDocumentPdfCapability} = await import('/_nuxt/utils/platformDocuments.ts');
                const {browserDocumentStore: store} = await import('/_nuxt/platform/browserDocumentStore.ts');
                const pdf = getDocumentPdfCapability();
                const validate = pdf.validatePdfPath.bind(pdf);
                const gate = new Promise(resolve => Reflect.set(window, '__releaseOptimizeValidation', resolve));
                let delayed = false;
                pdf.validatePdfPath = async (...args) => {
                    if (!delayed) {
                        delayed = true;
                        Reflect.set(window, '__optimizeValidationWaiting', true);
                        await gate;
                        Reflect.set(window, '__optimizeValidationActivation', navigator.userActivation.isActive);
                    }
                    return validate(...args);
                };
                const files = getDocumentFilesCapability();
                const prepare = files.prepareOptimizePdfAsCopy?.bind(files);
                if (prepare) files.prepareOptimizePdfAsCopy = (...args) => {
                    const selected = prepare(...args);
                    return selected.then(prepared => prepared && (async (...operation) => {
                        const result = await prepared(...operation);
                        Reflect.set(window, '__optimizeReturned', result);
                        if (result.path) Reflect.set(window, '__optimizeReturnedBytes', Array.from(await store.read(result.path)));
                        return result;
                    }));
                };
            })()`);
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            const optimize = page.getByRole('menuitem', {name: /^Optimize PDF/u});
            // Require the advertised Optimize action; the before revision lacks its browser implementation.
            await expect.poll(() => optimize.count(), {timeout: 5000}).toBe(1);
            await optimize.click();
            await page.getByRole('radio', {name: /^Balanced scanned PDF/u}).click();
            await page.getByRole('button', {
                name: 'Save Optimized Copy',
                exact: true,
            }).click();
            expect(await page.evaluate(() => Reflect.get(window, '__optimizePickerActivation'))).toBe(true);
            stage = 'awaiting validation';
            await page.waitForFunction(() => Reflect.get(window, '__optimizeValidationWaiting') === true);
            await page.waitForFunction(() => !navigator.userActivation.isActive, undefined, {timeout: 15_000});
            stage = 'optimizing';
            // Playwright evaluate grants activation. Release through CDP without
            // a user gesture so the delayed validation really resumes inactive.
            const validationSession = await context.newCDPSession(page);
            try {
                await validationSession.send('Runtime.evaluate', {
                    expression: 'Reflect.get(window, \'__releaseOptimizeValidation\')()',
                    userGesture: false,
                });
            } finally {
                await validationSession.detach();
            }
            await page.waitForFunction(() => Boolean(Reflect.get(window, '__optimizeReturned')), undefined, {timeout: 120_000});
            expect(await page.evaluate(() => Reflect.get(window, '__optimizeReturned')?.outcome)).toBe('saved');
            await page.getByRole('dialog', {
                name: 'Optimize PDF',
                exact: true,
            }).waitFor({state: 'hidden'});
            await settleActiveOpen(page);
            stage = 'reading published bytes';
            const state = await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{
                    originalPath: string;
                    workingCopyPath: string
                }>([
                    'originalPath',
                    'workingCopyPath',
                ]);
            });
            expect(state).toBeDefined();
            const returned = await page.evaluate(() => Reflect.get(window, '__optimizeReturned'));
            const returnedBytes = Buffer.from(await page.evaluate(() => Reflect.get(window, '__optimizeReturnedBytes')));
            // Handle-backed and source-proxy records own a file reference, not
            // an inline payload. Read each through the real repository resolver.
            const readStored = (ref: string) => page.evaluate<number[]>(`(async () => {
                const {browserDocumentStore: store} = await import('/_nuxt/platform/browserDocumentStore.ts');
                return Array.from(await store.read(${JSON.stringify(ref)}));
            })()`);
            const storedBytes = Buffer.from(await readStored(returned.path));
            const adoptedBytes = Buffer.from(await readStored(state!.workingCopyPath));
            const readOutput = () => page.evaluate(async () => {
                const directory = await navigator.storage.getDirectory();
                return Array.from(new Uint8Array(await (await (await directory.getFileHandle('optimized-scan.pdf')).getFile()).arrayBuffer()));
            });
            const savedBytes = Buffer.from(await readOutput());
            const originalAfterDirtySave = Buffer.from(await readOriginal());
            expect(returned.path).not.toBe(originalRef);
            expect(returned.optimizedBytes).toBe(savedBytes.length);
            expect(savedBytes.length).toBeLessThan(returned.originalBytes);
            expect([
                returnedBytes,
                storedBytes,
                adoptedBytes,
            ].map(bytes => ({
                size: bytes.length,
                hash: sha256(bytes),
            })))
                .toEqual(Array.from({length: 3}, () => ({
                    size: savedBytes.length,
                    hash: sha256(savedBytes),
                })));
            expect(state!.originalPath).toBe(returned.path);
            expect(await page.evaluate(() => Reflect.get(window, '__optimizeValidationActivation'))).toBe(false);
            expect(originalAfterDirtySave.subarray(0, original.length)).toEqual(original);
            expect(noteTexts(await PDFDocument.load(originalAfterDirtySave), '/Text')).toContain('Dirty note survives Optimize');
            const savedPath = resolve(outputDirectory, 'optimized.pdf');
            writeFileSync(savedPath, savedBytes);
            const check = spawnSync(getPdfNativeToolPaths().qpdf, [
                '--check',
                savedPath,
            ], {encoding: 'utf8'});
            expect(check.error).toBeUndefined();
            expect([
                0,
                3,
            ], check.stderr).toContain(check.status);
            const savedPdf = await PDFDocument.load(savedBytes);
            expect(savedPdf.getPage(0).getSize()).toEqual({
                width: 400,
                height: 600,
            });
            expect(noteTexts(savedPdf, '/Text')).toContain('Dirty note survives Optimize');
            stage = 'reopening';
            const reopened = await context.newPage();
            await openPdfFromChooser(reopened, savedPath);
            await expect.poll(() => reopened.locator('.textLayer').first().innerText()).toContain('Hidden OCR survives Optimize');
            await settleActiveOpen(reopened);
            const pageBounds = await reopened.locator('.page_container--rendered[data-page="1"]').first().boundingBox();
            expect(pageBounds).not.toBeNull();
            expect(pageBounds!.width / pageBounds!.height).toBeCloseTo(2 / 3, 2);
            stage = 'editing reopened note';
            await reopened.locator('.pdf-annotation-editor-note').first().click();
            const noteEditor = reopened.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            });
            await expect.poll(() => noteEditor.inputValue()).toBe('Dirty note survives Optimize');
            await noteEditor.fill('Reopened note remains editable');
            await reopened.screenshot({path: resolve(outputDirectory, 'reopened-editable.png')});
            await reopened.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            const reopenedDownload = reopened.waitForEvent('download');
            await reopened.getByRole('button', {
                name: 'Save',
                exact: true,
            }).click();
            const editedPath = await (await reopenedDownload).path();
            writeFileSync(resolve(outputDirectory, 'reopened-edited.pdf'), readFileSync(editedPath!));
            expect(noteTexts(await PDFDocument.load(readFileSync(editedPath!)), '/Text')).toContain('Reopened note remains editable');
            await reopened.screenshot({path: resolve(outputDirectory, 'reopened.png')});
            await reopened.close();
            await addNote(page, 'Later ordinary Save uses adopted copy', {
                x: 270,
                y: 320,
            });
            await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).click();
            await expect.poll(async () => Array.from(noteTexts(await PDFDocument.load(Buffer.from(await readOutput())), '/Text')), {timeout: 30_000})
                .toEqual(expect.arrayContaining([
                    'Dirty note survives Optimize',
                    'Later ordinary Save uses adopted copy',
                ]));
            const finalOriginal = Buffer.from(await readOriginal());
            expect(finalOriginal).toEqual(originalAfterDirtySave);
            writeFileSync(resolve(outputDirectory, 'dirty-original.pdf'), originalAfterDirtySave);
            const laterSave = Buffer.from(await readOutput());
            writeFileSync(resolve(outputDirectory, 'later-save.pdf'), laterSave);
            writeFileSync(resolve(outputDirectory, 'evidence.json'), JSON.stringify({
                picker: 'activation-sensitive OPFS fixture, not native',
                activation: {
                    picker: await page.evaluate(() => Reflect.get(window, '__optimizePickerActivation')),
                    resumedValidation: await page.evaluate(() => Reflect.get(window, '__optimizeValidationActivation')),
                },
                geometry: {
                    width: 400,
                    height: 600,
                    renderedAspect: pageBounds!.width / pageBounds!.height,
                },
                reopenedHiddenText: 'Hidden OCR survives Optimize',
                reopenedEditedNote: 'Reopened note remains editable',
                laterSave: {
                    size: laterSave.length,
                    sha256: sha256(laterSave),
                },
                originalRef,
                adoptedOriginalRef: state!.originalPath,
                adoptedWorkingRef: state!.workingCopyPath,
                fixture: {
                    size: original.length,
                    sha256: sha256(original),
                },
                dirtySavedOriginal: {
                    size: originalAfterDirtySave.length,
                    sha256: sha256(originalAfterDirtySave),
                },
                published: {
                    size: savedBytes.length,
                    sha256: sha256(savedBytes),
                },
                returned: {
                    size: returnedBytes.length,
                    sha256: sha256(returnedBytes),
                },
                stored: {
                    size: storedBytes.length,
                    sha256: sha256(storedBytes),
                },
                adopted: {
                    size: adoptedBytes.length,
                    sha256: sha256(adoptedBytes),
                },
                qpdf: {
                    status: check.status,
                    stdout: check.stdout,
                    stderr: check.stderr,
                },
            }, null, 2));
        } catch (error) {
            writeFileSync(resolve(outputDirectory, 'failure.json'), JSON.stringify({
                error: String(error),
                stage,
                diagnostics,
                browser: await page.evaluate(() => ({
                    text: document.body.innerText,
                    picker: Reflect.get(window, '__optimizePickerActivation'),
                    returned: Reflect.get(window, '__optimizeReturned'),
                })).catch(readError => ({readError: String(readError)})),
            }, null, 2));
            await page.screenshot({path: resolve(outputDirectory, 'failure.png')}).catch(() => undefined);
            throw error;
        } finally {
            if (!page.isClosed()) await page.evaluate(() => Reflect.get(window, '__releaseOptimizeValidation')?.()).catch(() => undefined);
            await context.close();
            rmSync(profile, {
                recursive: true,
                force: true,
            });
        }
    }, 180_000);

    // T3/T4: lossless Save As publishes the accepted staged note and adopts the exact saved bytes.
    // Existing browser-integration lane budget: 120_000 ms, including reopen and the next ordinary Save.
    it('losslessly optimizes the staged Save As frontier and adopts it for the next save', async () => {
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1600,
            height: 900,
        }});
        const savedPath = resolve(process.cwd(), `.devkit/qp2-ui-${process.pid}.pdf`);
        try {
            const pdf = await PDFDocument.create();
            pdf.addPage([
                612,
                792,
            ]).drawText('Lossless frontier fixture', {
                x: 40,
                y: 720,
            });
            pdf.catalog.set(PDFName.of('Fixture'), pdf.context.obj(Array.from({length: 2000}, (_, index) =>
                pdf.context.register(pdf.context.obj({
                    Index: index,
                    Value: `Reachable fixture dictionary ${index}`,
                })))));
            const original = Buffer.from(await pdf.save({useObjectStreams: false}));
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            await page.locator('.rail-item', {hasText: 'Settings'}).click();
            const optimize = page.getByRole('switch', {
                name: 'PDF Save As',
                exact: true,
            });
            if (await optimize.getAttribute('aria-checked') !== 'true') await optimize.click();
            await expect.poll(() => optimize.getAttribute('aria-checked')).toBe('true');
            await page.waitForFunction(() => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').optimizePdfOnSaveAs === true);
            await openPdfFromChooser(page, {
                name: 'lossless-frontier.pdf',
                mimeType: 'application/pdf',
                buffer: original,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor();
            await addNote(page, 'Accepted staged frontier', {
                x: 200,
                y: 220,
            });
            await page.evaluate(`(async () => {
                const {getDocumentFilesCapability} = await import('/_nuxt/utils/platformDocuments.ts');
                const {browserDocumentStore: store} = await import('/_nuxt/platform/browserDocumentStore.ts');
                const capability = getDocumentFilesCapability();
                const saveAs = capability.savePdfAs.bind(capability);
                capability.savePdfAs = async (working, options, revision) => {
                    Reflect.set(window, '__qp2FrontierSize', (await store.stat(options?.stagedOutput?.path ?? working)).size);
                    Reflect.set(window, '__qp2HasStage', Boolean(options?.stagedOutput));
                    Reflect.set(window, '__qp2OptimizeRequested', options?.optimizeLossless);
                    return saveAs(working, options, revision);
                };
            })()`);
            const downloaded = page.waitForEvent('download');
            await page.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            await (await downloaded).saveAs(savedPath);
            const saved = readFileSync(savedPath);
            expect(await page.evaluate(() => Reflect.get(window, '__qp2OptimizeRequested'))).toBe(true);
            expect(saved.toString('latin1')).toMatch(/\/Linearized\s/u);
            expect(saved.length).toBeLessThan(await page.evaluate(() => Number(Reflect.get(window, '__qp2FrontierSize'))));
            expect(await page.evaluate(() => Reflect.get(window, '__qp2HasStage'))).toBe(true);
            const check = spawnSync(getPdfNativeToolPaths().qpdf, [
                '--check',
                savedPath,
            ], {encoding: 'utf8'});
            expect(check.error).toBeUndefined();
            expect(check.status, check.stderr).toBe(0);
            const reopened = await PDFDocument.load(saved);
            expect(reopened.getPageCount()).toBe(1);
            expect(noteTexts(reopened)).toContain('Accepted staged frontier');
            writeFileSync(resolve(process.cwd(), '.devkit/qp2-saveas-evidence.json'), JSON.stringify({
                sourceBytes: original.length,
                frontierBytes: await page.evaluate(() => Number(Reflect.get(window, '__qp2FrontierSize'))),
                savedBytes: saved.length,
                sourceSha256: createHash('sha256').update(original).digest('hex'),
                savedSha256: createHash('sha256').update(saved).digest('hex'),
                qpdf: {
                    status: check.status,
                    stdout: check.stdout,
                    stderr: check.stderr,
                },
            }, null, 2));
            const reopenedPage = await lifecycle.browser.newPage();
            await openPdfFromChooser(reopenedPage, savedPath);
            await expect.poll(() => reopenedPage.locator('.textLayer').first().innerText()).toContain('Lossless frontier fixture');
            await reopenedPage.close();
            await addNote(page, 'After optimized adoption', {
                x: 300,
                y: 320,
            });
            const nextDownload = page.waitForEvent('download');
            await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).click();
            await (await nextDownload).saveAs(savedPath);
            const next = await PDFDocument.load(readFileSync(savedPath));
            expect(noteTexts(next)).toEqual(new Set([
                'Accepted staged frontier',
                'After optimized adoption',
            ]));
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
            rmSync(savedPath, {force: true});
        }
    }, 120_000);

    // T2, T3, C4: publication followed by a bookkeeping failure keeps the work
    // protected and reports what happened to the file, with a usable Save As.
    it('keeps work protected when Save writes the PDF but open-document synchronization fails', async () => {
        const context = await lifecycle.browser.newContext({
            viewport: {
                width: 1280,
                height: 900,
            },
            acceptDownloads: true,
        });
        const page = await context.newPage();
        const note = 'This note was written before the IndexedDB failure';
        try {
            await openPdfFromChooser(page, {
                name: 'save-sync-required.pdf',
                mimeType: 'application/pdf',
                buffer: readFileSync(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf')),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await settleActiveOpen(page);
            // Reuse this lane's cloneable picker fixture. Its handle methods
            // wrap real OPFS files/streams without native-handle rehydration.
            await page.evaluate(installPickerHandleFixture);
            await page.evaluate(() => {
                let picks = 0;
                Reflect.set(window, 'showSaveFilePicker', async () => new File([], ++picks === 1
                    ? 'save-sync-required.pdf' : 'save-sync-rescued.pdf'));
            });
            await addNote(page, note, {
                x: 120,
                y: 120,
            });
            await expect.poll(async () => (await readRecoveries(page, '/Text')).some(record => record.notes.has(note)), {timeout: 30_000}).toBe(true);
            const recoveryBefore = (await readRecoveries(page, '/Text')).find(record => record.notes.has(note));
            expect(recoveryBefore?.tab?.isDirty).toBe(true);
            const sourceRef = await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{originalPath: string}>(['originalPath']).originalPath;
            });
            expect(sourceRef).toBeTruthy();
            // K-idb-after-write, narrowed to this opened source record. Working
            // bytes, staging records and recovery writes remain available.
            await page.evaluate((ref) => {
                const put = IDBObjectStore.prototype.put;
                Reflect.set(window, '__restoreSaveSyncPut', () => {IDBObjectStore.prototype.put = put;});
                IDBObjectStore.prototype.put = function (value, ...args) {
                    if (this.name === 'documents' && value?.ref === ref && value.storageMode === 'handle') {
                        Reflect.set(window, '__saveSyncFaultRecord', value.ref);
                        throw new DOMException('Injected document bookkeeping failure after publication', 'QuotaExceededError');
                    }
                    return put.call(this, value, ...args);
                };
            }, sourceRef);
            const save = page.getByRole('button', {
                name: 'Save',
                exact: true,
            });
            await save.evaluate(button => button.addEventListener('click', event => {
                Reflect.set(window, '__saveSyncTrustedClick', event.isTrusted);
            }, {once: true}));
            await save.click();
            await expect.poll(() => save.getAttribute('aria-busy'), {timeout: 60_000}).toBe('false');
            expect(await page.evaluate(() => Reflect.get(window, '__saveSyncTrustedClick'))).toBe(true);
            expect(await page.evaluate(() => Reflect.get(window, '__saveSyncFaultRecord'))).toBe(sourceRef);
            const readOutput = (name: string) => page.evaluate(async (fileName) => {
                const root = await navigator.storage.getDirectory();
                const handle = await root.getFileHandle(fileName);
                return Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
            }, name);
            const writtenBytes = Uint8Array.from(await readOutput('save-sync-required.pdf'));
            writeFileSync(resolve(process.cwd(), '.devkit/browser-save-sync-required-written.pdf'), writtenBytes);
            const written = await PDFDocument.load(writtenBytes);
            expect(noteTexts(written, '/Text')).toContain(note);
            const activeTab = page.locator('[data-tab-list] [role="tab"][aria-selected="true"]');
            expect(await activeTab.getAttribute('aria-description')).toBe('Unsaved changes');
            expect(await save.isEnabled()).toBe(true);
            const recoveryAfter = (await readRecoveries(page, '/Text')).find(record => record.ownerId === recoveryBefore?.ownerId);
            expect(recoveryAfter?.tab).toMatchObject({
                isDirty: true,
                workingCopyRef: recoveryBefore?.tab?.workingCopyRef,
            });
            expect(recoveryAfter?.notes).toContain(note);
            await page.screenshot({path: resolve(process.cwd(), '.devkit/browser-save-sync-required.png')});
            const failures = page.locator('.app-toast-failure');
            expect(await failures.count()).toBe(1);
            const text = await failures.innerText();
            expect(text).toContain('Could not update the open document after Save');
            expect(text).toContain('Your changes were written to the PDF. Any newer unsaved edits remain open here.');
            expect(text).toContain('Error ID:');
            expect(text).not.toContain('The PDF writer could not apply your changes');
            expect(text).not.toContain('The file could not be written');
            expect(await failures.getByRole('button', {
                name: 'Copy details',
                exact: true,
            }).isVisible()).toBe(true);
            expect(await failures.getByRole('button', {name: /^Save As/u}).isVisible()).toBe(true);

            await page.getByRole('button', {
                name: 'Close Tab',
                exact: true,
            }).click();
            const closeDialog = page.getByRole('dialog', {name: 'Close tab with unsaved changes?'});
            await closeDialog.waitFor({state: 'visible'});
            await closeDialog.getByRole('button', {
                name: 'Cancel',
                exact: true,
            }).click();
            expect(await activeTab.getAttribute('aria-description')).toBe('Unsaved changes');
            await page.evaluate(() => {
                const restore = Reflect.get(window, '__restoreSaveSyncPut') as (() => void);
                restore();
            });
            // A trusted Save As through the toolbar stays available after the
            // failure toast, and must carry the accepted note to another file.
            await page.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            await expect.poll(async () => (await readOutput('save-sync-rescued.pdf').catch(() => [])).length, {timeout: 30_000}).toBeGreaterThan(0);
            const rescuedBytes = Uint8Array.from(await readOutput('save-sync-rescued.pdf'));
            writeFileSync(resolve(process.cwd(), '.devkit/browser-save-sync-required-rescued.pdf'), rescuedBytes);
            expect(noteTexts(await PDFDocument.load(rescuedBytes), '/Text')).toContain(note);
            await expect.poll(async () => [
                await page.locator('.save-split-primary').first().getAttribute('aria-busy'),
                await page.locator('.save-split-primary').first().isDisabled(),
            ], {timeout: 60_000}).toEqual([
                'false',
                true,
            ]);
            expect(await activeTab.getAttribute('aria-description')).toBeNull();
            await expect.poll(() => readRecoveries(page), {timeout: 30_000}).toEqual([]);
            await page.getByRole('button', {
                name: 'Close Tab',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('[data-tab-list] [role="tab"]').filter({hasText: '.pdf'}).count()).toBe(0);
            expect(await page.getByRole('dialog', {name: 'Close tab with unsaved changes?'}).count()).toBe(0);
        } finally {
            try {
                await page.evaluate(() => {
                    const restore = Reflect.get(window, '__restoreSaveSyncPut') as (() => void) | undefined;
                    restore?.();
                });
            } finally {
                await context.close();
            }
        }
    }, 180_000);

    // T3/T6: a populated signature requires Save As for a rewrite, including
    // above 16 MiB when the signature is compressed. An empty field saves in place.
    describe.each([
        {
            kind: 'signed',
            paddingBytes: 0,
        },
        {
            kind: 'unsigned-signature-field',
            paddingBytes: 0,
        },
        {
            kind: 'signed-object-stream',
            paddingBytes: 24 * 1024 * 1024,
        },
        {
            kind: 'unsigned-signature-field',
            paddingBytes: 24 * 1024 * 1024,
        },
    ] as const)('signature-field Save after a page edit ($kind, $paddingBytes bytes padding)', ({
        kind, paddingBytes,
    }) => {
        let fixture: {
            page: Page;
            bytes: Uint8Array
        } | undefined;
        const evidence = resolve('.devkit/c10-verify/signature-save', `${kind}-${paddingBytes}`);
        const signed = kind !== 'unsigned-signature-field';
        const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

        beforeAll(async () => {
            mkdirSync(evidence, {recursive: true});
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
            writeFileSync(resolve(evidence, 'source.pdf'), bytes);
            page.on('console', message => {
                writeFileSync(resolve(evidence, 'console.log'), `${message.type()}: ${message.text()}\n`, {flag: 'a'});
            });
            page.on('pageerror', error => {
                writeFileSync(resolve(evidence, 'console.log'), `pageerror: ${error.message}\n`, {flag: 'a'});
            });
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            // Seed real OPFS files through a binary response, avoiding a large
            // JSON number array over CDP. Only picker handles are substituted.
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
            await page.unroute(fixtureUrl);
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

        it('saves rotated unsigned signature fields in place and requires Save As for signed PDFs', async () => {
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
            await clickCenter(page, '[data-thumbnail-page="1"]', 'right');
            await page.getByRole('menuitem', {
                name: 'Rotate Clockwise',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.page_container--rendered[data-page="1"]').first().evaluate(element => {
                const rect = element.getBoundingClientRect();
                return rect.width > rect.height;
            })).toBe(true);
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
            expect(pickerRequests, `${kind}: Save As picker requests`).toBe(signed ? 1 : 0);
            expect(rewritten, `${kind}: original file rewritten`).toBe(!signed);
            expect(rotation, `${kind}: saved page 1 rotation`).toBe(signed ? 0 : 90);
            expect(destinationRotation, `${kind}: destination page 1 rotation`).toBe(signed ? 90 : null);
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
            })).toBe(true);
            await reopened.screenshot({path: resolve(evidence, 'reopened.png')});
            await reopened.close();
        }, 90_000);
    });

    // C2/C4/T6: opening and annotation editing have no unnecessary size gate;
    // a refused open explains its cause on screen and leaves the next open usable.
    it('opens large PDFs through the chooser and Recent Files, keeps annotation editing available and explains invalid input', async () => {
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1280,
            height: 900,
        }});
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        const dropPath = resolve(process.cwd(), `.devkit/large-drop-${process.pid}.pdf`);
        const largePath = resolve(process.cwd(), `.devkit/billion-byte-${process.pid}.pdf`);
        const trace: string[] = [];
        page.on('console', message => trace.push(message.text()));
        page.on('crash', () => trace.push('PAGE CRASHED'));
        page.on('close', () => trace.push('PAGE CLOSED'));
        page.on('request', request => {
            if (request.isNavigationRequest()) trace.push(`NAVIGATION REQUEST ${request.url()}`);
        });
        page.on('response', response => {
            if (response.request().isNavigationRequest()) trace.push(`NAVIGATION RESPONSE ${response.status()} ${response.url()}`);
        });
        page.on('requestfailed', request => {
            if (request.isNavigationRequest()) trace.push(`NAVIGATION FAILED ${request.failure()?.errorText} ${request.url()}`);
        });
        page.on('framenavigated', frame => {
            if (frame === page.mainFrame()) trace.push(`NAVIGATION COMMITTED ${frame.url()}`);
        });
        page.on('domcontentloaded', () => trace.push('DOM CONTENT LOADED'));
        let phase = 'chooser';
        try {
            const pdf = await PDFDocument.create();
            pdf.addPage([
                612,
                792,
            ]).drawText('A large document opens in the browser', {
                x: 40,
                y: 740,
            });
            // A real, uncompressed PDF stream exceeds the former 16 MiB open ceiling.
            pdf.catalog.set(pdf.context.obj('LargeFixture'), pdf.context.register(pdf.context.stream(new Uint8Array(18 * 1024 * 1024))));
            const buffer = Buffer.from(await pdf.save({useObjectStreams: false}));
            expect(buffer.byteLength).toBeGreaterThan(16 * 1024 * 1024);
            await openPdfFromChooser(page, {
                name: 'large-open.pdf',
                mimeType: 'application/pdf',
                buffer,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
            await expect.poll(async () => (await page.locator('.workspace-host[data-workspace-active="true"] .textLayer').allTextContents()).join(' ')).toContain('A large document opens in the browser');
            expect(problems).toEqual([]);
            phase = 'password prompt';
            const protectedChooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Open File/u}).click();
            await (await protectedChooser).setFiles({
                name: 'protected-open.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(readFileSync(resolve('tests/fixtures/electron/password-protected.pdf.b64'), 'utf8').trim(), 'base64'),
            });
            await page.getByRole('textbox', {
                name: 'Password',
                exact: true,
            }).fill('frame-secret');
            await page.getByRole('button', {
                name: 'Open',
                exact: true,
            }).click();
            await page.locator('.workspace-host[data-workspace-active="true"] .page_container--rendered canvas').first().waitFor({timeout: 30000});
            await expect.poll(() => page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').textContent()).toContain('protected-open.pdf');
            expect(problems).toEqual([]);
            phase = 'recent';
            await page.reload({waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            const recent = page.getByRole('button', {name: /large-open\.pdf/u}).first();
            await recent.click();
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
            await expect.poll(async () => (await page.locator('.workspace-host[data-workspace-active="true"] .textLayer').allTextContents()).join(' ')).toContain('A large document opens in the browser');
            expect(problems).toEqual([]);
            phase = 'drop';
            writeFileSync(dropPath, buffer);
            const drag = await context.newCDPSession(page);
            const dropTarget = await page.locator('.workspace-host').first().boundingBox();
            if (!dropTarget) throw new Error('The workspace has no drop target');
            for (const type of [
                'dragEnter',
                'dragOver',
                'drop',
            ] as const) {
                await drag.send('Input.dispatchDragEvent', {
                    type,
                    x: dropTarget.x + dropTarget.width / 2,
                    y: dropTarget.y + dropTarget.height / 2,
                    data: {
                        items: [],
                        files: [dropPath],
                        dragOperationsMask: 1,
                    },
                });
            }
            await expect.poll(() => page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').textContent()).toContain(`large-drop-${process.pid}.pdf`);
            await page.locator('.workspace-host[data-workspace-active="true"] .page_container--rendered canvas').first().waitFor({timeout: 30000});
            await drag.detach();
            expect(problems).toEqual([]);

            // A sparse local file crosses the real chooser without allocating
            // its unused 1 GiB stream in the test process.
            phase = 'large local file';
            const length = 1024 * 1024 * 1024;
            const prefix = `%PDF-1.7\n1 0 obj\n<< /Length ${length} >>\nstream\n`;
            const offsets = [
                0,
                9,
            ];
            let tail = '\nendstream\nendobj\n';
            const add = (id: number, body: string) => {
                offsets[id] = prefix.length + length + tail.length;
                tail += `${id} 0 obj\n${body}\nendobj\n`;
            };
            add(2, '<< /Type /Catalog /Pages 3 0 R >>');
            add(3, '<< /Type /Pages /Count 1 /Kids [4 0 R] >>');
            add(4, '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 5 0 R >>');
            const content = 'BT /F1 18 Tf 40 740 Td (A billion bytes can be viewed) Tj ET';
            add(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
            add(6, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
            const xref = prefix.length + length + tail.length;
            tail += 'xref\n0 7\n0000000000 65535 f \n';
            tail += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
            tail += `trailer\n<< /Size 7 /Root 2 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
            const descriptor = openSync(largePath, 'w');
            try {
                writeSync(descriptor, prefix);
                writeSync(descriptor, tail, prefix.length + length, 'utf8');
            } finally {
                closeSync(descriptor);
            }
            const largeChooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Open File/u}).click();
            await (await largeChooser).setFiles(largePath);
            await expect.poll(async () => (await page.locator('.workspace-host[data-workspace-active="true"] .textLayer').allTextContents()).join(' '), {timeout: 30000}).toContain('A billion bytes can be viewed');
            await settleActiveOpen(page);
            expect(await page.getByText('Existing annotation editing is unavailable', {exact: true}).count()).toBe(0);
            expect(await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).isEnabled()).toBe(true);
            expect(problems).toEqual([]);

            phase = 'invalid PDF';
            await page.evaluate(() => sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input'));
            const invalid = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Open File/u}).click();
            await (await invalid).setFiles({
                name: 'invalid.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from('%PDF-1.7\nbroken'),
            });
            await page.locator('.app-toast-failure-reason').filter({hasText: 'The file is damaged or is not a supported document.'}).waitFor();
            expect(await page.locator('.workspace-host[data-workspace-active="true"] .textLayer').first().textContent()).toContain('A billion bytes can be viewed');
        } catch (error) {
            console.info('LARGE_OPEN_FAILURE', JSON.stringify({
                phase,
                trace: trace.slice(-35),
                error: String(error),
                problems,
                url: page.url(),
                closed: page.isClosed(),
                serverOutput: lifecycle.serverOutput,
            }));
            throw error;
        } finally {
            await context.close();
            rmSync(dropPath, {force: true});
            rmSync(largePath, {force: true});
        }
    }, 120000);

    // T4: every accepted note belongs to the document's Save As frontier.
    it.each([
        'single',
        'split',
    ])('writes the accepted note through browser Save As from %s view', async (view) => {
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1600,
                height: 900,
            }});
            const fixture = resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf');
            await openPdfFromChooser(page, fixture);
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
            const text = 'Accepted note survives information routes';
            await addNote(page, text, {
                x: 200,
                y: 200,
            });
            await page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).click();
            expect(await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).inputValue()).toBe(text);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            if (view === 'split') {
                await clickCenter(page, '.editor-pane.is-active .tab.is-active[data-tab-id]', 'right');
                await page.getByRole('menuitem', {
                    name: 'Split Right',
                    exact: true,
                }).click();
                await expect.poll(() => page.locator('.editor-pane').count()).toBe(2);
                const panes = await page.locator('.editor-pane').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.editorPaneId!));
                const right = panes[1]!;
                await page.locator(`${paneSelector(right)} .page_container--rendered canvas`).first().waitFor({timeout: 30000});
                await zoomActivePane(page, right, 'Zoom Out', 1);
            }
            expect(await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).isEnabled()).toBe(true);
            const savedContents: string[] = [];
            const downloads: Array<Promise<void>> = [];
            page.on('download', download => {
                const index = downloads.length;
                downloads.push((async () => {
                    const path = resolve(process.cwd(), `.devkit/browser-save-as-${process.pid}-${view}-${index}.pdf`);
                    await download.saveAs(path);
                    const bytes = readFileSync(path);
                    const pdf = await PDFDocument.load(bytes);
                    savedContents.push(...noteTexts(pdf));
                    console.info('SAVE_AS_BYTES', JSON.stringify({
                        view,
                        path,
                        byteLength: bytes.length,
                        originalChecksum: createHash('sha256').update(readFileSync(fixture)).digest('hex'),
                        savedChecksum: createHash('sha256').update(bytes).digest('hex'),
                        savedContents,
                    }));
                })());
            });
            await page.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            try {
                await expect.poll(() => savedContents, {timeout: 30000}).toContain(text);
            } finally {
                await Promise.all(downloads);
            }
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120000);

    it.each([
        'save',
        'save-as',
    ] as const)('retains a note accepted after the %s frontier for the next save', async mode => {
        const context = await lifecycle.browser.newContext({
            viewport: {
                width: 1280,
                height: 900,
            },
            acceptDownloads: true,
        });
        let page: Awaited<ReturnType<typeof context.newPage>> | undefined;
        try {
            await context.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            page = await context.newPage();
            const problems = collectConsoleProblems(page);
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const pdf = await PDFDocument.create();
            pdf.addPage([
                612,
                792,
            ]).drawText('Accepted edits stay in their document', {
                x: 40,
                y: 740,
            });
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'save-frontier.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await pdf.save()),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
            const save = async (as: boolean) => {
                const download = page!.waitForEvent('download');
                if (as) {
                    await page!.getByRole('button', {
                        name: 'Save options',
                        exact: true,
                    }).click();
                    await page!.getByRole('menuitem', {name: /^Save As/u}).click();
                } else await page!.getByRole('button', {
                    name: 'Save',
                    exact: true,
                }).click();
                const path = await (await download).path();
                if (!path) throw new Error('Save did not provide its downloaded bytes');
                return PDFDocument.load(readFileSync(path));
            };
            if (mode === 'save') {
                await save(true);
                await expect.poll(() => page!.getByRole('button', {
                    name: 'Save options',
                    exact: true,
                }).isEnabled()).toBe(true);
                await page.evaluate(async () => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    await api.waitForActiveDocumentOpenSettled?.();
                });
                await page.locator('.editor-pane.is-active .page_container--rendered [data-pdf-annotation-editor-ready="true"]').first().waitFor();
            }
            await addNote(page, 'Before the save frontier', {
                x: 160,
                y: 180,
            });
            await expect.poll(() => page!.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues!<{annotationComments: Array<{text: string}>}>(['annotationComments']).annotationComments.map(note => note.text);
            })).toContain('Before the save frontier');
            await page.evaluate(`(async () => {
                const {getDocumentWorkingCopyCapability} = await import('/_nuxt/utils/platformDocuments.ts');
                const capability = getDocumentWorkingCopyCapability();
                const method = ${JSON.stringify(mode)} === 'save-as' ? 'createWorkingCopyFromPath' : 'parsePdfAnnotations';
                const original = capability[method].bind(capability);
                const held = new Promise(resolve => Reflect.set(window, '__releaseSaveFrontier', resolve));
                capability[method] = async (...args) => {
                    capability[method] = original;
                    const result = ${JSON.stringify(mode)} === 'save' ? await original(...args) : undefined;
                    Reflect.set(window, '__saveFrontierHeld', true);
                    await held;
                    return ${JSON.stringify(mode)} === 'save' ? result : original(...args);
                };
            })()`);
            const first = save(mode === 'save-as');
            await page.waitForFunction(() => Reflect.get(window, '__saveFrontierHeld') === true);
            await addNote(page, 'Accepted after the save frontier', {
                x: 260,
                y: 280,
            });
            expect(await page.locator('.pdf-annotation-editor-note').count()).toBe(2);
            await expect.poll(() => page!.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues!<{annotationComments: Array<{text: string}>}>(['annotationComments']).annotationComments.map(note => note.text);
            })).toContain('Accepted after the save frontier');
            await page.evaluate(() => Reflect.get(window, '__releaseSaveFrontier')());
            const published = noteTexts(await first);
            await expect.poll(() => page!.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).isEnabled()).toBe(true);
            expect(published).toContain('Before the save frontier');
            await expect.poll(() => page!.locator('.pdf-annotation-editor-note').count()).toBe(2);
            if (!published.has('Accepted after the save frontier')) {
                await expect.poll(() => page!.getByRole('button', {
                    name: 'Save',
                    exact: true,
                }).isEnabled()).toBe(true);
            }
            await page.locator('.pdf-annotation-editor-note').last().click();
            await expect.poll(() => page!.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).inputValue()).toBe('Accepted after the save frontier');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            expect(noteTexts(await save(published.has('Accepted after the save frontier')))).toEqual(new Set([
                'Before the save frontier',
                'Accepted after the save frontier',
            ]));
            await page.locator('.pdf-annotation-editor-note').last().click();
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).fill('Edited after Save As');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            expect(noteTexts(await save(false))).toContain('Edited after Save As');
            expect(problems).toEqual([]);
        } finally {
            if (page && !page.isClosed()) await page.evaluate(() => Reflect.get(window, '__releaseSaveFrontier')?.()).catch(() => undefined);
            await context.close();
        }
    }, 120000);

});
