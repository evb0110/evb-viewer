import {createHash} from 'node:crypto';
import {
    readFileSync, writeFileSync, rmSync, mkdirSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    PDFDocument, PDFName, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject, setTextRenderingMode, TextRenderingMode,
} from 'pdf-lib';
import {spawnSync} from 'node:child_process';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {chromium} from 'playwright';
import {
    describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    openPdfFromChooser, lifecycle, waitForOpenFileReady, keepFileChooserInterceptionEnabled, addNote, noteTexts, settleActiveOpen,
} from './documentLifecycleTestHelpers';

describe('browser document lifecycle UI', () => {
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
});
