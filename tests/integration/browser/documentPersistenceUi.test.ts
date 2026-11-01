import {
    createHash, randomBytes,
} from 'node:crypto';
import {
    readFileSync, writeFileSync, rmSync, openSync, writeSync, closeSync, mkdirSync,
} from 'node:fs';
import {
    basename, resolve,
} from 'node:path';
import {
    PDFDocument, PDFName, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject, setTextRenderingMode, TextRenderingMode,
} from 'pdf-lib';
import {DEFAULT_SETTINGS} from '@contracts/settings';
import {spawnSync} from 'node:child_process';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {chromium} from 'playwright';
import type {
    Download, Page,
} from 'playwright';
import {createPdfConformanceFixture} from '@tests/helpers/createPdfConformanceFixture';
import type {createFileSystemFileHandle as createFixtureFileHandle} from '@tests/unit/app/platform/browserPlatformTestDoubles';
import {
    afterAll, beforeAll, describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    openPdfFromChooser, lifecycle, readPersistedDocumentBytes, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled, addNote, noteTexts, clickCenter, paneSelector, readPanePageWidth, zoomActivePane, readBrowserPayloadCounts, readRecoveries,
} from './documentLifecycleTestHelpers';

// A six-page portrait PDF whose pages read "<label> page <n>".
async function createReadingBook(label: string, name: string) {
    const pdf = await PDFDocument.create();
    for (let pageNumber = 1; pageNumber <= 6; pageNumber += 1) {
        pdf.addPage([
            400,
            600,
        ]).drawText(`${label} page ${String(pageNumber)}`, {
            x: 40,
            y: 500,
            size: 24,
        });
    }
    return {
        name,
        mimeType: 'application/pdf',
        buffer: Buffer.from(await pdf.save()),
    };
}

// What the reader sees of the active view: the toolbar's page and zoom, and
// the page in the middle of the viewport with its painted orientation.
function readReadingView(page: Page) {
    return page.evaluate(() => {
        const host = document.querySelector('.workspace-host[data-workspace-active="true"]');
        const viewport = host?.getBoundingClientRect();
        const visible = Array.from(host?.querySelectorAll<HTMLElement>('.page_container--rendered') ?? []).find((container) => {
            const rect = container.getBoundingClientRect();
            return viewport && rect.bottom > viewport.top + viewport.height / 4 && rect.top < viewport.bottom - viewport.height / 4;
        });
        const rect = visible?.getBoundingClientRect();
        return {
            indicator: document.querySelector('.page-controls-current-primary')?.textContent?.trim(),
            zoom: document.querySelector('.zoom-controls-display-value')?.textContent?.trim(),
            visibleText: visible?.querySelector('.textLayer')?.textContent?.trim(),
            landscape: rect ? rect.width > rect.height : null,
        };
    });
}

async function settleActiveOpen(page: Page) {
    await page.evaluate(async () => {
        const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
        if (!await testApi?.waitForActiveDocumentOpenSettled?.()) throw new Error('PDF viewer open did not settle');
    });
}

// Opens a reading book through Start's Open File button and the file chooser.
async function openReadingBook(page: Page, label: string, name: string) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', {
        name: 'Open File',
        exact: true,
    }).first().click();
    await (await chooser).setFiles(await createReadingBook(label, name));
    await expect.poll(async () => (await readReadingView(page)).visibleText, {timeout: 30_000}).toBe(`${label} page 1`);
    await settleActiveOpen(page);
}

describe('browser document lifecycle UI', () => {

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
            await settleActiveOpen(reopened);
            await expect.poll(() => reopened.locator('.textLayer').first().innerText()).toContain('Hidden OCR survives Optimize');
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
            await page.evaluate(() => {
                Object.defineProperties(File.prototype, {
                    kind: {get: () => 'file'},
                    getFile: {value: async function (this: File) {
                        const root = await navigator.storage.getDirectory();
                        const handle = await root.getFileHandle(this.name, {create: true});
                        const file = await handle.getFile();
                        return new File([await file.arrayBuffer()], file.name, {
                            type: file.type,
                            lastModified: file.lastModified,
                        });
                    }},
                    createWritable: {value: async function (this: File) {
                        const root = await navigator.storage.getDirectory();
                        return (await root.getFileHandle(this.name, {create: true})).createWritable();
                    }},
                    isSameEntry: {value: async function (this: File, other: FileSystemHandle) {
                        return this.name === other.name;
                    }},
                });
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

    // T3: Save publishes a page edit to the original unsigned form; a populated
    // signature requires Save As and leaves the original file untouched.
    describe.each([
        'signed',
        'unsigned-signature-field',
    ] as const)('signature-field Save after a page edit (%s)', kind => {
        let fixture: {
            page: Page;
            bytes: Uint8Array
        } | undefined;

        beforeAll(async () => {
            const context = await lifecycle.browser.newContext({viewport: {
                width: 1280,
                height: 900,
            }});
            const page = await context.newPage();
            const bytes = await createPdfConformanceFixture(kind);
            fixture = {
                page,
                bytes,
            };
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            // Reuse the shared picker handle fixture around a real OPFS
            // file and writable stream. Materialize the open snapshot so
            // Chromium need not persist an OPFS-backed Blob in IndexedDB.
            await page.evaluate(`(async () => {
                const {createFileSystemFileHandle} = await import(${JSON.stringify(`${lifecycle.origin}/_nuxt/@fs${process.cwd()}/tests/unit/app/platform/browserPlatformTestDoubles.ts`)});
                window.__createSignatureFileHandle = createFileSystemFileHandle;
            })()`);
            await page.evaluate(async (bytes) => {
                const createFileSystemFileHandle = Reflect.get(window, '__createSignatureFileHandle') as typeof createFixtureFileHandle;
                const directory = await navigator.storage.getDirectory();
                const original = await directory.getFileHandle('original.pdf', {create: true});
                const writable = await original.createWritable();
                await writable.write(Uint8Array.from(bytes));
                await writable.close();
                const handle = Object.assign(createFileSystemFileHandle({
                    name: original.name,
                    getFile: async () => {
                        const file = await original.getFile();
                        return new File([await file.arrayBuffer()], file.name, {
                            type: file.type,
                            lastModified: file.lastModified,
                        });
                    },
                    isSameEntry: async (other: FileSystemHandle): Promise<boolean> => other === handle,
                }), {createWritable: () => original.createWritable()});
                Reflect.set(window, '__signatureSaveAsPicks', 0);
                Reflect.set(window, 'showOpenFilePicker', async () => [handle]);
                Reflect.set(window, 'showSaveFilePicker', async () => {
                    Reflect.set(window, '__signatureSaveAsPicks', Number(Reflect.get(window, '__signatureSaveAsPicks')) + 1);
                    throw new DOMException('The user aborted a request.', 'AbortError');
                });
            }, Array.from(bytes));
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await page.locator('.page_container--rendered canvas').first().waitFor();
            await page.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('Signature fixture did not finish opening');
            });
        }, 90_000);

        afterAll(async () => {
            await fixture?.page.context().close();
        });

        it('saves rotated unsigned signature fields in place and requires Save As for signed PDFs', async () => {
            if (!fixture) throw new Error(`Missing signature fixture: ${kind}`);
            const {
                page, bytes,
            } = fixture;
            const readOriginal = () => page.evaluate(async () => {
                const directory = await navigator.storage.getDirectory();
                const handle = await directory.getFileHandle('original.pdf');
                return Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
            });
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
            // Observe either publication or the picker before checking the
            // settled result. This also gives the defect a direct failure.
            await expect.poll(async () => await saveAsPicks() > 0
                || (await PDFDocument.load(Uint8Array.from(await readOriginal()))).getPage(0).getRotation().angle === 90).toBe(true);
            await expect.poll(() => save.getAttribute('aria-busy')).toBe('false');
            const original = Uint8Array.from(await readOriginal());
            const rotation = (await PDFDocument.load(original)).getPage(0).getRotation().angle;
            const pickerRequests = await saveAsPicks();
            const rewritten = Buffer.compare(Buffer.from(original), Buffer.from(bytes)) !== 0;
            console.info('Signature Save evidence', JSON.stringify({
                kind,
                saveAsPickerRequests: pickerRequests,
                originalRewritten: rewritten,
                originalPage1Rotation: rotation,
            }));
            expect(pickerRequests, `${kind}: Save As picker requests`).toBe(kind === 'signed' ? 1 : 0);
            expect(rewritten, `${kind}: original file rewritten`).toBe(kind !== 'signed');
            expect(rotation, `${kind}: saved page 1 rotation`).toBe(kind === 'signed' ? 0 : 90);
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
                text: await page.locator('body').innerText().catch(() => '<page closed>'),
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

    it.each([
        'corrupt',
        'clean',
        'future-storage',
        'future-cookie',
        'future-between-pages',
    ] as const)('recovers browser settings without overwriting another version (%s)', async (scenario) => {
        // The full headless browser supports history-cache restores; the
        // default headless shell always reports every tab as visible.
        const historyBrowser = scenario === 'future-between-pages'
            ? await chromium.launch({
                headless: true,
                channel: 'chromium',
                ignoreDefaultArgs: ['--disable-back-forward-cache'],
            })
            : null;
        const context = await (historyBrowser ?? lifecycle.browser).newContext({viewport: {
            width: 1280,
            height: 1000,
        }});
        const page = await context.newPage();
        const settingsKey = 'evb-viewer:browser:settings';
        const cookieKey = 'evb_viewer_settings';
        const supported = JSON.stringify({
            ...DEFAULT_SETTINGS,
            authorName: 'Compatible author',
        }, null, 2);
        const future = JSON.stringify({
            ...DEFAULT_SETTINGS,
            version: 99,
            authorName: 'Future author must not be adopted',
            clientDiagnosticsPreference: 'granted',
        }, null, 2);
        const requests: string[] = [];
        const problems: string[] = [];
        const historyMisses: unknown[] = [];
        context.on('request', request => requests.push(request.url()));
        page.on('pageerror', error => problems.push(error.message));
        await context.route('**/api/1/envelope/**', route => route.fulfill({
            status: 200,
            body: '{}',
        }));
        const evidenceDirectory = process.env.EVB_SETTINGS_EVIDENCE_DIR;
        if (evidenceDirectory) mkdirSync(evidenceDirectory, {recursive: true});
        async function capture(phase: string) {
            const evidence = {
                scenario,
                phase,
                browser: lifecycle.browser.version(),
                ready: await page.evaluate(() => Reflect.get(window, '__appReady') === true),
                stored: await page.evaluate(key => localStorage.getItem(key), settingsKey),
                cookie: (await context.cookies()).find(cookie => cookie.name === cookieKey)?.value ?? null,
                diagnosticsRequests: requests.filter(url => /@sentry|sentry[_/.]|\/api\/1\/envelope/iu.test(url)),
                problems,
                resumeEvents: await page.evaluate(() => Reflect.get(window, '__settingsResumeEvents') as string[] | undefined),
                historyMisses,
            };
            console.info('Browser settings evidence', JSON.stringify(evidence));
            if (evidenceDirectory) {
                writeFileSync(resolve(evidenceDirectory, `${scenario}-${phase}.json`), JSON.stringify(evidence, null, 2));
                await page.screenshot({path: resolve(evidenceDirectory, `${scenario}-${phase}.png`)});
            }
            return evidence;
        }
        try {
            const notice = page.getByText('Saved settings could not be used, so defaults were restored.', {exact: false});
            const newerNotice = page.getByText('These settings were saved by a newer version of EVB Viewer. They are kept unchanged, and this version uses its defaults and cannot save settings. Open the newer version to change them.', {exact: false});
            const loadApp = async (load: () => Promise<unknown>) => {
                await load();
                // Bootstrap adds the notice before it reports the app ready.
                await page.waitForFunction(() => Reflect.get(window, '__appReady') === true, undefined, {timeout: 60_000});
            };
            if (scenario.startsWith('future-')) {
                // Seed a fresh origin before any app script runs. Whitespace in
                // these raw values makes a parse-and-rewrite lose byte parity.
                await context.addInitScript(({
                    key, value,
                }) => {
                    if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
                }, {
                    key: settingsKey,
                    value: scenario === 'future-storage' ? future : supported,
                });
                await context.addCookies([{
                    name: cookieKey,
                    value: encodeURIComponent(scenario === 'future-cookie' ? future : supported),
                    url: lifecycle.origin,
                }]);
            }
            await loadApp(() => page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'}));
            if (scenario === 'corrupt') {
                await expect(notice.count()).resolves.toBe(0);

                // Setup: storage corrupted outside the app, as by a crash mid-write or an extension.
                await page.evaluate(() => window.localStorage.setItem('evb-viewer:browser:settings', '{"version": 2, "authorName": '));
                await loadApp(() => page.reload({waitUntil: 'domcontentloaded'}));
                await notice.first().waitFor({timeout: 10_000});
                const stored = await page.evaluate(() => window.localStorage.getItem('evb-viewer:browser:settings'));
                expect(JSON.parse(stored ?? 'null')).toMatchObject({version: 2});

                await loadApp(() => page.reload({waitUntil: 'domcontentloaded'}));
                await expect(notice.count()).resolves.toBe(0);
                return;
            }
            if (scenario === 'future-storage' || scenario === 'future-cookie') {
                await newerNotice.first().waitFor();
                await capture('startup');
            } else {
                expect(await newerNotice.count()).toBe(0);
                expect(await notice.count()).toBe(0);
            }
            await page.getByRole('button', {
                name: 'Settings',
                exact: true,
            }).filter({visible: true}).first().click();
            const author = page.getByRole('textbox', {
                name: 'Author Name',
                exact: true,
            });
            const consent = page.getByRole('switch', {
                name: 'Send privacy-sanitized error diagnostics',
                exact: true,
            });
            expect(await consent.isChecked()).toBe(false);
            expect(await author.inputValue()).toBe(scenario === 'future-between-pages' ? 'Compatible author' : '');
            if (scenario === 'future-between-pages') {
                await page.evaluate(() => {
                    const events: string[] = [];
                    Reflect.set(window, '__settingsResumeEvents', events);
                    document.addEventListener('visibilitychange', () => events.push(document.visibilityState));
                    window.addEventListener('pageshow', event => events.push(`pageshow:${String(event.persisted)}`));
                });
                // The peer supplies a newer version's bytes. Loading another
                // copy of this old app would contend with its cached document
                // lease and make Chromium evict A before pageshow can run.
                const away = `${lifecycle.origin}/__settings-history-away`;
                await context.route(away, route => route.fulfill({
                    contentType: 'text/html',
                    body: '<p>Settings history navigation fixture</p>',
                }));
                const second = await context.newPage();
                await second.goto(away);
                const session = await context.newCDPSession(page);
                await session.send('Page.enable');
                session.on('Page.backForwardCacheNotUsed', event => historyMisses.push(event));
                // Resume the original page from the history cache after another
                // page writes newer settings. A reload would lose this listener
                // and cannot satisfy the persisted pageshow assertion.
                await page.goto(away);
                await second.evaluate(({
                    key, value,
                }) => localStorage.setItem(key, value), {
                    key: settingsKey,
                    value: future,
                });
                await page.goBack({waitUntil: 'commit'});
                await page.waitForFunction(() => {
                    const events = Reflect.get(window, '__settingsResumeEvents') as string[] | undefined;
                    return events?.includes('pageshow:true');
                });
                await session.detach();
                expect(await author.inputValue()).not.toBe('Future author must not be adopted');
                expect(await consent.isChecked()).toBe(false);
            }
            if (scenario !== 'clean') {
                // A real keyboard event also exercises error reporting. Future
                // consent must neither load the SDK nor transmit an envelope.
                await author.evaluate(element => element.addEventListener('keydown', () => {
                    throw new Error('Settings compatibility input failure');
                }, {once: true}));
                await author.press('ArrowRight');
                await page.locator('.app-toast-error-id').first().waitFor();
            }
            await author.fill(`Saved by ${scenario}`);
            if (scenario === 'clean') {
                await page.waitForFunction(({
                    key, name,
                }) => JSON.parse(localStorage.getItem(key) ?? '{}').authorName === name, {
                    key: settingsKey,
                    name: `Saved by ${scenario}`,
                });
                expect(await newerNotice.count()).toBe(0);
                expect(await page.getByText('Last save failed', {exact: true}).count()).toBe(0);
            } else {
                await page.getByText('Last save failed', {exact: true}).first().waitFor();
                const refused = await capture('save-refused');
                expect(refused.stored).toBe(scenario === 'future-cookie' ? supported : future);
                // A supported legacy cookie is migrated away on a normal start.
                expect(refused.cookie).toBe(scenario === 'future-between-pages' ? null : encodeURIComponent(scenario === 'future-cookie' ? future : supported));
                expect(refused.diagnosticsRequests).toEqual([]);
                if (scenario === 'future-between-pages') {
                    // The other version releases ownership. The same live page
                    // can save again without a reload or private settings API.
                    await context.addCookies([{
                        name: cookieKey,
                        value: encodeURIComponent(supported),
                        url: lifecycle.origin,
                    }]);
                    await page.evaluate(({
                        key, value,
                    }) => localStorage.setItem(key, value), {
                        key: settingsKey,
                        value: supported,
                    });
                    await author.fill('Saved after compatible settings returned');
                    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key) ?? '{}').authorName === 'Saved after compatible settings returned', settingsKey);
                }
            }
            expect((await capture('passed')).diagnosticsRequests).toEqual([]);
        } finally {
            try {
                await capture('final');
            } finally {
                try {
                    await context.close();
                } finally {
                    await historyBrowser?.close();
                }
            }
        }
    }, 120_000);

    it('withdraws hosted diagnostics in another open window and allows an explicit regrant', async () => {
        try {
            const context = await lifecycle.browser.newContext();
            const envelopes: string[] = [];
            await context.route('**/api/1/envelope/**', async (route) => {
                envelopes.push(route.request().postData() ?? '');
                await route.fulfill({
                    status: 200,
                    body: '{}',
                });
            });
            await context.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            const first = await context.newPage();
            await first.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(first);
            await first.getByRole('button', {
                name: 'Settings',
                exact: true,
            }).filter({visible: true}).first().click();
            const consent = first.getByRole('switch', {
                name: 'Send privacy-sanitized error diagnostics',
                exact: true,
            });
            await consent.check();
            await first.waitForFunction(() => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').clientDiagnosticsPreference === 'granted');

            const second = await context.newPage();
            await second.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(second);
            await second.getByRole('button', {
                name: 'Settings',
                exact: true,
            }).filter({visible: true}).first().click();
            const remoteConsent = second.getByRole('switch', {
                name: 'Send privacy-sanitized error diagnostics',
                exact: true,
            });
            const author = second.getByRole('textbox', {
                name: 'Author Name',
                exact: true,
            });
            async function reportInputFailure(phase: string) {
                const previousIds = await second.locator('.app-toast-error-id').allTextContents();
                // Fault a real input handler, then reach it through trusted keyboard
                // input. Unique causes prevent Sentry deduplication hiding a send.
                await second.evaluate((message) => {
                    document.querySelector('#settings-author')!.addEventListener('keydown', () => {
                        throw new Error(message);
                    }, {once: true});
                }, phase);
                await author.press('ArrowRight');
                const receipt = await second.waitForFunction((previous) => {
                    const id = Array.from(document.querySelectorAll('.app-toast-error-id'))
                        .map(element => element.textContent ?? '')
                        .find(text => !previous.includes(text));
                    return id?.replace('Error ID: ', '');
                }, previousIds);
                const id = await receipt.jsonValue();
                if (!id) throw new Error('The visible failure has no Error ID');
                return id;
            }
            const grantedId = await reportInputFailure('granted-control');
            await expect.poll(() => envelopes.some(body => body.includes(grantedId))).toBe(true);
            // Pause delivery of the committed denial, without retaining an
            // unrelated IndexedDB transaction needed by the first window's save.
            const session = await context.newCDPSession(second);
            try {
                await session.send('Debugger.enable');
                const paused = new Promise<void>(resolvePaused => session.once('Debugger.paused', () => resolvePaused()));
                await session.send('DOMDebugger.setEventListenerBreakpoint', {eventName: 'storage'});
                await consent.uncheck();
                await first.waitForFunction(() => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').clientDiagnosticsPreference === 'denied');
                await paused;
            } finally {
                await session.send('DOMDebugger.removeEventListenerBreakpoint', {eventName: 'storage'}).catch(() => undefined);
                await session.send('Debugger.resume').catch(() => undefined);
                await session.detach();
            }
            await author.fill('After withdrawal');
            await second.waitForFunction(() => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').authorName === 'After withdrawal');
            const withdrawnId = await reportInputFailure('withdrawn-control');
            const checkedAfterWithdrawal = await remoteConsent.isChecked();
            await consent.check();
            await first.waitForFunction(() => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').clientDiagnosticsPreference === 'granted');
            await expect.poll(() => remoteConsent.isChecked()).toBe(true);
            const regrantedId = await reportInputFailure('regranted-control');
            await expect.poll(() => envelopes.some(body => body.includes(regrantedId))).toBe(true);
            console.info('Hosted consent evidence', JSON.stringify({
                granted: envelopes.some(body => body.includes(grantedId)),
                withdrawn: envelopes.some(body => body.includes(withdrawnId)),
                regranted: envelopes.some(body => body.includes(regrantedId)),
                checkedAfterWithdrawal,
            }));
            expect(envelopes.some(body => body.includes(withdrawnId))).toBe(false);
            expect(checkedAfterWithdrawal).toBe(false);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    // T2/T4: reading an information page keeps accepted work and both live views.
    it('preserves an unsaved note and linked view zoom through Privacy and About routes', async () => {
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_600,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf'));
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            const bounds = await page.locator('.page_container[data-page="1"]').first().boundingBox();
            if (!bounds) throw new Error('The first PDF page is not visible');
            await page.mouse.click(bounds.x + 200, bounds.y + 200);
            const text = 'Accepted note survives information routes';
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).fill(text);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
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
            await clickCenter(page, '.editor-pane.is-active .tab.is-active[data-tab-id]', 'right');
            await page.getByRole('menuitem', {
                name: 'Split Right',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.editor-pane').count()).toBe(2);
            const panes = await page.locator('.editor-pane').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.editorPaneId!));
            const right = panes[1]!;
            await page.locator(`${paneSelector(right)} .page_container--rendered canvas`).first().waitFor({timeout: 30_000});
            await zoomActivePane(page, right, 'Zoom Out', 1);
            const widths = await Promise.all(panes.map(pane => readPanePageWidth(page, pane)));
            expect(widths[0]).not.toBe(widths[1]);
            await page.screenshot({path: resolve(process.cwd(), '.devkit/browser-information-before.png')});

            for (const informationPage of [
                'privacy',
                'about',
            ]) {
                if (informationPage === 'privacy') {
                    await page.locator(`${paneSelector(right)} .pdf-annotation-editor-note`).last().click();
                    await page.getByRole('button', {
                        name: 'Minimize note',
                        exact: true,
                    }).click();
                    expect(await page.locator(`${paneSelector(right)} .pdf-annotation-editor-note.is-selected`).count()).toBe(1);
                } else {
                    await page.getByRole('button', {
                        name: 'Toggle Sidebar',
                        exact: true,
                    }).click();
                    await page.locator(`${paneSelector(right)} [data-thumbnail-page="1"] .pdf-thumbnail-selection-toggle`).click();
                    expect(await page.locator(`${paneSelector(right)} [data-thumbnail-page="1"] .pdf-thumbnail-selection-toggle`).getAttribute('aria-pressed')).toBe('true');
                    await page.getByRole('button', {
                        name: 'Toggle Sidebar',
                        exact: true,
                    }).click();
                }
                const currentPage = await page.locator('.page-controls-current-primary:visible').textContent();
                const activeTabs = await page.locator('.tab.is-active[data-tab-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-tab-id')));
                let unexpectedChoosers = 0;
                let unexpectedDownloads = 0;
                const onChooser = () => { unexpectedChoosers += 1; };
                const onDownload = () => { unexpectedDownloads += 1; };
                page.on('filechooser', onChooser);
                page.on('download', onDownload);
                await page.getByRole('button', {
                    name: 'Settings',
                    exact: true,
                }).filter({visible: true}).first().click();
                const tabCount = await page.locator('.tab[data-tab-id]').count();
                await page.getByRole('link', {
                    name: informationPage === 'privacy'
                        ? 'Read the complete privacy notice' : 'Open About and Acknowledgements',
                    exact: true,
                }).filter({visible: true}).click();
                await expect.poll(() => new URL(page.url()).pathname).toBe(`/${informationPage}`);
                await page.locator(`.${informationPage}-document h1`).waitFor();
                await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-information-${informationPage}.png`)});
                const documentKeys = [
                    'Backspace',
                    'Delete',
                    'Control+s',
                    'PageDown',
                    'Control+=',
                    'Control+b',
                ];
                for (const key of documentKeys) {
                    await page.keyboard.press(key);
                }
                // Window-level tab and file accelerators must also belong to
                // the visible shell, rather than its retained document owner.
                await page.keyboard.press('Control+Shift+Tab');
                for (const key of [
                    ...documentKeys,
                    'Control+o',
                ]) {
                    await page.keyboard.press(key);
                }
                if (informationPage === 'about') {
                    await page.getByRole('link', {
                        name: 'Back to viewer',
                        exact: true,
                    }).click();
                } else {
                    await page.goBack();
                }
                await expect.poll(() => new URL(page.url()).pathname).toBe('/');
                await page.locator('.editor-pane .tab[data-tab-id]').first().waitFor();
                page.off('filechooser', onChooser);
                page.off('download', onDownload);
                expect(unexpectedChoosers).toBe(0);
                expect(unexpectedDownloads).toBe(0);
                expect(await page.locator('.tab[data-tab-id]').count()).toBe(tabCount);
                // Settings itself is a new empty tab; the document tab in
                // each pane remains selected when returning to it below.
                expect(await page.locator(`${paneSelector(panes[0]!)} .tab.is-active[data-tab-id]`).getAttribute('data-tab-id')).toBe(activeTabs[0]);
                await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-information-${informationPage}-returned-shell.png`)});
                await page.locator(`${paneSelector(right)} .tab`).filter({hasText: 'generated-text.pdf'}).click();
                await page.locator('.page-controls-current-primary:visible').waitFor();
                expect(await page.locator('.page-controls-current-primary:visible').textContent()).toBe(currentPage);
                await page.getByRole('button', {
                    name: 'Open Note',
                    exact: true,
                }).filter({visible: true}).last().click();
                expect(await page.getByRole('textbox', {
                    name: 'Write annotation note',
                    exact: true,
                }).inputValue()).toBe(text);
                await page.getByRole('button', {
                    name: 'Minimize note',
                    exact: true,
                }).click();
                expect(await page.getByRole('button', {
                    name: 'Save',
                    exact: true,
                }).isEnabled()).toBe(true);
                if (informationPage === 'about') {
                    await page.getByRole('button', {
                        name: 'Toggle Sidebar',
                        exact: true,
                    }).click();
                    expect(await page.locator(`${paneSelector(right)} [data-thumbnail-page="1"] .pdf-thumbnail-selection-toggle`).getAttribute('aria-pressed')).toBe('true');
                    await page.getByRole('button', {
                        name: 'Toggle Sidebar',
                        exact: true,
                    }).click();
                }
                expect(await Promise.all(panes.map(pane => readPanePageWidth(page, pane)))).toEqual(widths);
                await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-information-${informationPage}-return.png`)});
            }
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    it('keeps the rendered document and tab identity after a corrupt replacement is rejected', async () => {
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            const validChooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const validChooser = await validChooserPromise;
            await validChooser.setFiles(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ));

            const renderedCanvas = page.locator('.page_container--rendered canvas').first();
            await renderedCanvas.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('Active browser document did not settle');
                }
            });
            const activeTab = page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            );
            await expect.poll(() => activeTab.textContent()).toContain('generated-text.pdf');
            const canvasCountBefore = await page.locator('.page_container--rendered canvas').count();

            const corruptChooserPromise = page.waitForEvent('filechooser');
            await page.keyboard.press('Control+O');
            const corruptChooser = await corruptChooserPromise;
            await corruptChooser.setFiles({
                name: 'corrupt-replacement.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from('%PDF-1.7\ncorrupt and truncated'),
            });

            await page.locator('.app-toast-failure').filter({hasText: 'Failed to open file'}).waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await expect.poll(() => activeTab.textContent()).toContain('generated-text.pdf');
            await expect.poll(() => renderedCanvas.isVisible()).toBe(true);
            expect(await page.locator('.page_container--rendered canvas').count())
                .toBe(canvasCountBefore);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    it.each([
        [
            'removal',
            'Remove from Recent',
            undefined,
        ],
        [
            'clear',
            'Clear Recent Files',
            'Clear History',
        ],
    ] as const)('keeps an open document source when Recent Files %s meets an unreadable dependent record', async (_action, buttonName, confirmName) => {
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const chooser = await chooserPromise;
            await chooser.setFiles({
                name: 'recent-dependent.pdf',
                mimeType: 'application/pdf',
                buffer: readFileSync(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf')),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('Active browser document did not settle');
                }
            });
            // The open document's source record, found by its file name.
            const sourceRef = await page.evaluate(`(async () => {
                const {loadAllRecordKeys, loadRecord} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
                for (const key of await loadAllRecordKeys()) {
                    const found = await loadRecord(key);
                    if (found?.fileName === 'recent-dependent.pdf' && found.kind === 'source') return key;
                }
                return null;
            })()`);
            expect(typeof sourceRef).toBe('string');
            // Opening the file also creates a readable working copy that names the source,
            // which keeps the source by itself. Remove those copies so the unreadable record
            // below is the only dependent of the source.
            await page.evaluate(`(async () => {
                const {loadAllRecordKeys, loadRecord, runObjectStoresTransaction} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
                const {DOCUMENTS_STORE} = await import('/_nuxt/platform/browser/browserDocumentConstants.ts');
                const dependents = [];
                for (const key of await loadAllRecordKeys()) {
                    if ((await loadRecord(key))?.sourceRef === ${JSON.stringify(sourceRef)}) dependents.push(key);
                }
                await runObjectStoresTransaction([DOCUMENTS_STORE], 'readwrite', (transaction, setResult) => {
                    for (const key of dependents) transaction.objectStore(DOCUMENTS_STORE).delete(key);
                    setResult(true);
                });
            })()`);
            // A working record that names the source but cannot be decoded. The helper
            // resolves null when its database cannot open, so the write is asserted.
            const planted = await page.evaluate(`(async () => {
                const {runObjectStoresTransaction} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
                const {DOCUMENTS_STORE} = await import('/_nuxt/platform/browser/browserDocumentConstants.ts');
                return runObjectStoresTransaction([DOCUMENTS_STORE], 'readwrite', (transaction, setResult) => {
                    transaction.objectStore(DOCUMENTS_STORE).put({
                        ref: 'browser://documents/unreadable-dependent.pdf',
                        sourceRef: ${JSON.stringify(sourceRef)},
                        kind: 'working',
                        storageMode: 'source-proxy',
                    });
                    setResult(true);
                });
            })()`);
            expect(planted).toBe(true);

            await page.getByRole('button', {
                name: 'New Tab',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: buttonName,
                exact: true,
            }).click();
            if (confirmName) {
                await page.getByRole('button', {
                    name: confirmName,
                    exact: true,
                }).click();
            }
            await expect.poll(() => page.getByRole('button', {
                name: 'Remove from Recent',
                exact: true,
            }).count()).toBe(0);
            // The row can leave the list before the detached cleanup that follows the
            // removal has finished. An awaited cleanup of the same ref, serialized behind
            // it, settles the outcome before the stored record is read.
            await page.evaluate(`(async () => {
                const {browserDocumentStore} = await import('/_nuxt/platform/browser/browserDocumentRepository.ts');
                await browserDocumentStore.cleanupDetachedDocument(${JSON.stringify(sourceRef)});
            })()`);
            // Read the stored record and its first chunk on a raw connection: the bytes helper
            // reads nothing whenever its database connection fails to open.
            const stored = await page.evaluate<{
                present: boolean;
                chunkBytes: number | null
            }>(`(async () => {
                const database = await new Promise((resolve, reject) => {
                    const request = indexedDB.open('evb-viewer-browser-documents');
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                const transaction = database.transaction(['documents', 'document-chunks'], 'readonly');
                const read = (store, key) => new Promise((resolve, reject) => {
                    const request = transaction.objectStore(store).get(key);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                const record = await read('documents', ${JSON.stringify(sourceRef)});
                const chunk = record?.storageMode === 'chunked'
                    ? await read('document-chunks', ${JSON.stringify(sourceRef)} + '::' + record.chunkGeneration + '::0')
                    : undefined;
                database.close();
                return {present: Boolean(record), chunkBytes: chunk?.data?.byteLength ?? chunk?.byteLength ?? null};
            })()`);
            expect(stored.present).toBe(true);
            expect(stored.chunkBytes).toBeGreaterThan(0);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    // A committed producer target must survive peer collection until its consumer adopts it.
    it.each([
        'conversion',
        'save-as',
    ] as const)('retains pending %s bytes through peer Recent clearing', async operation => {
        const browser = await chromium.launch({headless: true});
        const context = await browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        const page = await context.newPage();
        const peer = await context.newPage();
        const problems = collectConsoleProblems(page);
        let savedDigest: number[] | null = null;
        try {
            for (const participant of [
                page,
                peer,
            ]) {
                await participant.addInitScript(() => {
                    Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                    Reflect.set(window, 'showSaveFilePicker', undefined);
                    sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                });
                await participant.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(participant);
                keepFileChooserInterceptionEnabled(participant);
            }
            const peerChooser = peer.waitForEvent('filechooser');
            await peer.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await peerChooser).setFiles(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf'));
            await peer.locator('.page_container--rendered canvas').first().waitFor();
            await peer.getByRole('button', {name: 'Close tab'}).last().click();
            // Observe completion of the actual UI-triggered collection, not just the list repaint.
            await peer.evaluate(`(async () => {
                const {browserDocumentStore: store} = await import('/_nuxt/platform/browser/browserDocumentRepository.ts');
                const clear = store.clearRecentFiles.bind(store);
                store.clearRecentFiles = async () => {await clear(); window.__peerClearCompleted = true;};
            })()`);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            if (operation === 'conversion') {
                await (await chooser).setFiles(resolve(process.cwd(), 'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu'));
                await page.locator('[data-testid="document-page-source-image"]').first().waitFor({timeout: 90_000});
                await page.evaluate(`(async () => {
                    const {browserDocumentStore: store} = await import('/_nuxt/platform/browser/browserDocumentRepository.ts');
                    const retain = store.setRetention.bind(store);
                    store.setRetention = async (ref, retention) => {
                        const result = await retain(ref, retention);
                        if ((await store.requireEntry(ref)).kind === 'output' && retention === 'durable') {
                            window.__pendingTargetRef = ref;
                            await new Promise(resolve => {window.__resumeTarget = resolve;});
                        }
                        return result;
                    };
                })()`);
                await page.getByRole('button', {name: /Convert to PDF/}).filter({visible: true}).first().click();
                await page.getByRole('dialog').getByRole('button', {
                    name: 'Convert',
                    exact: true,
                }).click();
            } else {
                await page.evaluate(`(async () => {
                    const {getDocumentPdfCapability} = await import('/_nuxt/utils/platformDocuments.ts');
                    const capability = getDocumentPdfCapability();
                    const analyze = capability.analyzePdfConformance.bind(capability);
                    capability.analyzePdfConformance = async (ref, options) => {
                        if (!options?.purpose && ref.endsWith('/pending-save.pdf') && !window.__lateConformanceRef) {
                            window.__lateConformanceRef = ref;
                            await new Promise(resolve => {window.__resumeLateConformance = resolve;});
                            try {return await analyze(ref, options);}
                            catch(error) {console.info('LATE_CONFORMANCE_CAUSE', {name:error.name, message:error.message, stack:error.stack}); throw error;}
                            finally {window.__lateConformanceDone = true;}
                        }
                        return analyze(ref, options);
                    };
                })()`);
                const input = await PDFDocument.load(readFileSync(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf')));
                await input.attach(randomBytes(4 * 1024 * 1024 + 64 * 1024), 'public-padding.bin');
                await (await chooser).setFiles({
                    name: 'pending-save.pdf',
                    mimeType: 'application/pdf',
                    buffer: Buffer.from(await input.save()),
                });
                await page.locator('.page_container--rendered canvas').first().waitFor();
                await page.evaluate(`(async () => {
                    const {browserDocumentStore: store} = await import('/_nuxt/platform/browser/browserDocumentRepository.ts');
                    const create = store.createStoredDocument.bind(store);
                    store.createStoredDocument = async (name, bytes, options) => {
                        const ref = await create(name, bytes, options);
                        if (options.kind === 'source') {
                            window.__pendingTargetRef = ref;
                            await new Promise(resolve => {window.__resumeTarget = resolve;});
                        }
                        return ref;
                    };
                })()`);
                await page.waitForFunction(() => Boolean(Reflect.get(window, '__resumeLateConformance')));
                const download = page.waitForEvent('download');
                await page.getByRole('button', {
                    name: 'Save options',
                    exact: true,
                }).click();
                await page.getByRole('menuitem', {name: /^Save As/u}).click();
                const savedPath = await (await download).path();
                const savedBytes = readFileSync(savedPath!);
                savedDigest = Array.from(createHash('sha256').update(savedBytes).digest());
                expect((await PDFDocument.load(savedBytes)).getPageCount()).toBe(1);
            }
            await page.waitForFunction(() => Boolean(Reflect.get(window, '__resumeTarget')));
            const ref: string = await page.evaluate(() => Reflect.get(window, '__pendingTargetRef'));
            const before = await readPersistedDocumentBytes(peer, ref, operation === 'save-as');
            if (operation === 'conversion') expect(before.slice(0, 5)).toEqual([
                37,
                80,
                68,
                70,
                45,
            ]);
            else {
                expect(before).toEqual(savedDigest);
                expect(await peer.evaluate(`(async () => {
                    const {loadRecord} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
                    const row = await loadRecord(${JSON.stringify(ref)});
                    return {mode: row?.storageMode, chunks: row?.chunkCount};
                })()`)).toEqual({
                    mode: 'chunked',
                    chunks: 2,
                });
            }
            await peer.getByRole('button', {
                name: 'Clear Recent Files',
                exact: true,
            }).click();
            await peer.getByRole('button', {
                name: 'Clear History',
                exact: true,
            }).click();
            await peer.waitForFunction(() => Reflect.get(window, '__peerClearCompleted') === true);
            const after = await readPersistedDocumentBytes(peer, ref, operation === 'save-as');
            await page.evaluate(() => Reflect.get(window, '__resumeTarget')());
            expect(createHash('sha256').update(Uint8Array.from(after)).digest('hex'),
                'Committed target bytes survive collection before adoption')
                .toBe(createHash('sha256').update(Uint8Array.from(before)).digest('hex'));
            if (operation === 'conversion') expect((await PDFDocument.load(Uint8Array.from(after))).getPageCount()).toBe(2);
            await page.locator('.page_container--rendered .page_canvas canvas').first().waitFor({timeout: 60_000});
            await expect.poll(async () => await page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').getAttribute('aria-description') ?? '', {timeout: 30_000}).not.toMatch(/unsaved/iu);
            if (operation === 'save-as') {
                await expect.poll(() => page.getByRole('button', {
                    name: 'Save options',
                    exact: true,
                }).isEnabled(), {timeout: 30_000}).toBe(true);
            }
            await page.getByRole('button', {name: 'Close tab'}).last().click();
            if (operation === 'save-as') {
                await page.evaluate(() => Reflect.get(window, '__resumeLateConformance')());
                await page.waitForFunction(() => Reflect.get(window, '__lateConformanceDone') === true);
            }
            const recentOpen = page.locator('[data-recent-open-actionable="true"] .recent-open')
                .filter({hasText: operation === 'conversion' ? 'bitonal-faint-pencil.pdf' : 'pending-save.pdf'});
            // Recent registration and Close finish asynchronously. Wait for the
            // saved document on Start before navigation can interrupt either.
            await recentOpen.waitFor({state: 'visible'});
            await page.reload({waitUntil: 'domcontentloaded'});
            await recentOpen.click();
            await page.locator('.page_container--rendered .page_canvas canvas').first().waitFor({timeout: 60_000});
            if (operation === 'save-as') {
                await expect.poll(() => page.locator('.textLayer').first().innerText()).toContain('Hello Arabic world');
            }
            await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-pending-${operation}-reloaded.png`)});
            expect(problems).toEqual([]);
        } finally {
            await browser.close();
        }
    }, 120_000);

    // R4: with "Reopen documents where I left off" off, a document opened in
    // the tab that closing the last tab leaves starts at page 1 with the
    // default zoom and no view rotation, whatever the closed document showed.
    it('opens the next PDF in the emptied last tab at its defaults, not the closed view', async () => {
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        const readView = () => readReadingView(page);
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            await openReadingBook(page, 'First', 'first.pdf');
            const opened = await readView();
            expect(opened).toMatchObject({
                indicator: '1',
                landscape: false,
            });

            await page.locator('.page-controls-display').click();
            await page.locator('.page-controls-inline-input').fill('4');
            await page.keyboard.press('Enter');
            await page.locator('#editor-global-toolbar-host button[aria-label^="Zoom In"]:not([disabled])').first().click();
            await expect.poll(async () => (await readView()).zoom, {timeout: 15_000}).not.toBe(opened.zoom);
            // The browser shows no view-rotation control yet (desktop has it in its View menu).
            await page.evaluate(() => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!testApi?.callActiveWorkspaceSyncCommand?.('handleViewRotationCw').called) throw new Error('View rotation is unavailable');
            });
            await expect.poll(readView, {timeout: 15_000}).toMatchObject({
                indicator: '4',
                visibleText: 'First page 4',
                landscape: true,
            });

            await page.getByRole('button', {name: 'Close Tab'}).click();
            await expect.poll(() => page.locator('[data-tab-list] [role="tab"]').count()).toBe(1);
            await waitForOpenFileReady(page);
            await openReadingBook(page, 'Second', 'second.pdf');
            await page.screenshot({path: resolve(process.cwd(), '.devkit/browser-last-tab-next-open.png')});
            await expect.poll(readView, {timeout: 15_000}).toEqual({
                ...opened,
                visibleText: 'Second page 1',
            });
            expect(problems).toEqual([]);
        } finally {
            await context.close();
        }
    }, 120_000);

    // R4: with "Reopen documents where I left off" on, a Recent PDF reopens at
    // the page, zoom and view rotation it was closed at, also after a Save; a
    // file of the same name and page count with other bytes opens at its start.
    it.each([
        'download',
        'file-handle',
    ] as const)('reopens a Recent PDF where the reader left it, and other bytes of that name at their start (%s)', async (saveMode) => {
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        const readView = () => readReadingView(page);
        const settle = () => settleActiveOpen(page);
        const openFile = (label: string) => openReadingBook(page, label, 'reading-view.pdf');
        try {
            await page.addInitScript((mode) => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                if (mode === 'download') {
                    Reflect.set(window, 'showSaveFilePicker', undefined);
                    return;
                }
                // A File is a structured-cloneable picker-handle fixture. Its
                // prototype methods survive an IndexedDB round trip and reload,
                // and the actual bytes and writes live in a real OPFS file.
                // Chromium 153 traps when deserializing native OPFS handles.
                Object.defineProperties(File.prototype, {
                    kind: {get: () => 'file'},
                    getFile: {value: async function (this: File) {
                        const root = await navigator.storage.getDirectory();
                        const handle = await root.getFileHandle(this.name, {create: true});
                        const file = await handle.getFile();
                        return new File([await file.arrayBuffer()], file.name, {
                            type: file.type,
                            lastModified: file.lastModified,
                        });
                    }},
                    createWritable: {value: async function (this: File) {
                        const root = await navigator.storage.getDirectory();
                        return (await root.getFileHandle(this.name, {create: true})).createWritable();
                    }},
                    isSameEntry: {value: async function (this: File, other: FileSystemHandle) {
                        return this.name === other.name;
                    }},
                });
                Reflect.set(window, 'showSaveFilePicker', async () => new File([], 'reading-view.pdf'));
            }, saveMode);
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            await page.locator('.rail-item', {hasText: 'Settings'}).click();
            await page.getByRole('switch', {name: 'Reopen documents where I left off'}).click();
            await expect.poll(() => page.getByRole('switch', {name: 'Reopen documents where I left off'}).getAttribute('aria-checked')).toBe('true');
            await page.locator('.rail-item', {hasText: 'Recent Files'}).click();
            await openFile('Reading');
            const opened = await readView();

            await page.locator('.page-controls-display').click();
            await page.locator('.page-controls-inline-input').fill('4');
            await page.keyboard.press('Enter');
            await page.locator('#editor-global-toolbar-host button[aria-label^="Zoom In"]:not([disabled])').first().click();
            await expect.poll(async () => (await readView()).zoom, {timeout: 15_000}).not.toBe(opened.zoom);
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {
                name: 'View',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {
                name: 'Rotate View Clockwise',
                exact: true,
            }).click();
            // An ordinary Save of a note writes the reader's own bytes; the view stays theirs.
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            await page.locator('.workspace-host[data-workspace-active="true"] .page_container[data-page="4"]').first().click({position: {
                x: 80,
                y: 80,
            }});
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).fill('Saved where I left off');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            // The button's name is its tooltip, which changes once nothing is left to save.
            const save = page.locator('.save-split-primary').first();
            const download = saveMode === 'download' ? page.waitForEvent('download') : null;
            await save.click();
            if (download) {
                expect(noteTexts(await PDFDocument.load(readFileSync(await (await download).path())))).toEqual(new Set(['Saved where I left off']));
            }
            await expect.poll(async () => [
                await save.getAttribute('aria-busy'),
                await save.isDisabled(),
            ], {timeout: 15_000}).toEqual([
                'false',
                true,
            ]);
            if (saveMode === 'file-handle') {
                const bytes = await page.evaluate(async () => {
                    const root = await navigator.storage.getDirectory();
                    const handle = await root.getFileHandle('reading-view.pdf');
                    return Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
                });
                expect(noteTexts(await PDFDocument.load(Uint8Array.from(bytes)))).toEqual(new Set(['Saved where I left off']));
            }
            await expect.poll(readView, {timeout: 15_000}).toMatchObject({
                indicator: '4',
                visibleText: 'Reading page 4',
                landscape: true,
            });
            const left = await readView();
            await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-recent-reading-view-${saveMode}-left.png`)});
            // A reload leaves nothing of the closed view but what Recent stored.
            // Close remembers the view before its tab goes, so the reload waits for that.
            const closeAndReload = async () => {
                await page.getByRole('button', {name: 'Close Tab'}).click();
                await expect.poll(() => page.locator('[data-tab-list] [role="tab"]').filter({hasText: '.pdf'}).count(), {timeout: 15_000}).toBe(0);
                await page.reload({waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(page);
            };
            const reopenFromRecent = async (name: string) => {
                await page.locator('[data-recent-open-actionable="true"] .recent-open').filter({hasText: name}).click();
                await page.locator('.workspace-host[data-workspace-active="true"] .page_container--rendered').first().waitFor({timeout: 30_000});
                await settle();
            };
            await closeAndReload();

            await reopenFromRecent('reading-view.pdf');
            await expect.poll(readView, {timeout: 15_000}).toEqual(left);
            await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-recent-reading-view-${saveMode}-restored.png`)});
            await closeAndReload();

            await openFile('Changed');
            await expect.poll(readView, {timeout: 15_000}).toEqual({
                ...opened,
                visibleText: 'Changed page 1',
            });
            await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-recent-reading-view-${saveMode}-changed-bytes.png`)});
            expect(problems).toEqual([]);
        } finally {
            await context.close();
        }
    }, 120_000);

    it('renders an externally replaced PDF and reopens that persisted Recent file', async () => {
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            // A previous PDF can remain painted before the incoming open claims
            // the workspace. Readiness must belong to the requested document.
            const waitForDocument = (fileName: string, expectedText: string) => page.waitForFunction(({
                fileName, expectedText,
            }) => {
                const tab = document.querySelector('[data-tab-list] [role="tab"][aria-selected="true"]');
                const container = document.querySelector('.page_container--rendered[data-page="1"]');
                const canvas = container?.querySelector<HTMLCanvasElement>('.page_canvas canvas');
                const layer = container?.querySelector('.textLayer');
                const rect = canvas?.getBoundingClientRect();
                return tab?.textContent?.includes(fileName)
                    && canvas && canvas.width > 0 && canvas.height > 0
                    && rect && rect.width > 0 && rect.height > 0
                    && getComputedStyle(canvas).visibility === 'visible'
                    && layer?.getAttribute('data-pdf-text-layer-ready') === 'true'
                    && layer.textContent?.includes(expectedText);
            }, {
                fileName,
                expectedText,
            }, {timeout: 60_000});
            let openCount = 0;
            const openWithFile = async (filePath: string, expectedText: string) => {
                const chooserPromise = page.waitForEvent('filechooser');
                if (openCount === 0) {
                    await page.getByRole('button', {
                        name: 'Open File',
                        exact: true,
                    }).first().click();
                } else {
                    await page.keyboard.press('Control+O');
                }
                await (await chooserPromise).setFiles(filePath);
                openCount += 1;
                await waitForDocument(basename(filePath), expectedText);
                await page.evaluate(async () => {
                    const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                    if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                        throw new Error('PDF viewer open did not settle');
                    }
                });
            };

            await openWithFile(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ), 'Hello Arabic world');
            await expect.poll(() => page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent()).toContain('generated-text.pdf');

            await openWithFile(resolve(
                process.cwd(),
                'tests/fixtures/electron/interop/synthetic-annotation-interoperability.pdf',
            ), 'EVB annotation interoperability corpus');
            const replacementTab = page.locator('[data-tab-list] [role="tab"][aria-selected="true"]');
            await expect.poll(() => replacementTab.textContent()).toContain('synthetic-annotation-interoperability.pdf');
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-pdf-replacement-rendered.png'),
                fullPage: true,
            });

            await page.getByRole('button', {name: 'Close tab'}).last().click();
            await page.reload({waitUntil: 'domcontentloaded'});
            const recentReplacement = page.locator(
                '[data-recent-open-actionable="true"] .recent-open',
            ).filter({hasText: 'synthetic-annotation-interoperability.pdf'});
            await recentReplacement.waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await recentReplacement.click();
            await waitForDocument('synthetic-annotation-interoperability.pdf', 'EVB annotation interoperability corpus');
            await expect.poll(() => page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent()).toContain('synthetic-annotation-interoperability.pdf');
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-pdf-recent-reopen-rendered.png'),
                fullPage: true,
            });
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    it.each([
        'clean-open',
        'two-window-move',
        'two-window-move-source-stays-open',
        'clear-recent',
    ])('keeps the saved copy source and both notes after Clear Recent Files and Save (mode=%s)', async (mode) => {
        try {
            const context=await lifecycle.browser.newContext({
                viewport:{
                    width:1280,
                    height:900,
                },
                acceptDownloads:true,
            });
            let page=await context.newPage();
            const creator = page;
            const problems = [collectConsoleProblems(page)];
            await openPdfFromChooser(page, {
                name: 'review-saved.pdf',
                mimeType: 'application/pdf',
                buffer: readFileSync(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf')),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout:30000});
            await addNote(page,'review first saved note',{
                x:160,
                y:180,
            });
            const recoveryCount = () => page.evaluate(async () => {
                const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
                    const request = indexedDB.open('evb-viewer-browser-documents');
                    request.onsuccess = () => resolveDb(request.result);
                    request.onerror = () => rejectDb(request.error);
                });
                try {
                    return await new Promise<number>((resolveCount, rejectCount) => {
                        const request = db.transaction('workspace-recovery').objectStore('workspace-recovery').count();
                        request.onsuccess = () => resolveCount(request.result);
                        request.onerror = () => rejectCount(request.error);
                    });
                } finally { db.close(); }
            });
            await expect.poll(recoveryCount, {timeout: 30_000}).toBe(1);
            const firstDownload=page.waitForEvent('download');
            await page.getByRole('button',{
                name:'Save options',
                exact:true,
            }).click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            const firstPath = await (await firstDownload).path();
            expect(firstPath).not.toBeNull();
            expect(Array.from(noteTexts(await PDFDocument.load(readFileSync(firstPath!)))))
                .toContain('review first saved note');
            await page.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                await api.waitForActiveDocumentOpenSettled?.();
            });
            await expect.poll(recoveryCount, {timeout: 30_000}).toBe(0);
            if (mode === 'clear-recent') {
                const sourceRef = await page.evaluate(() => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    return api.readActiveWorkspaceStateValues?.<{originalPath: string}>(['originalPath']).originalPath;
                });
                const tabId=await page.locator('.tab.is-active[data-tab-id]').first().getAttribute('data-tab-id');
                await page.getByRole('button',{
                    name:'New Tab',
                    exact:true,
                }).click();
                await page.getByRole('button',{
                    name:'Clear Recent Files',
                    exact:true,
                }).click();
                await page.getByRole('button',{
                    name:'Clear History',
                    exact:true,
                }).click();
                await expect.poll(()=>page.getByRole('button',{
                    name:'Remove from Recent',
                    exact:true,
                }).count()).toBe(0);
                expect(await page.evaluate(`(async () => {
                    const {loadRecord} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
                    return Boolean(await loadRecord(${JSON.stringify(sourceRef)}));
                })()`)).toBe(true);
                await page.locator(`.tab[data-tab-id="${tabId}"]`).click();
                await page.locator('.page_container--rendered canvas').first().waitFor({timeout:30000});
            }
            if (mode.startsWith('two-window-move')) {
                const target = await context.newPage();
                problems.push(collectConsoleProblems(target));
                await target.addInitScript(() => {
                    Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                    Reflect.set(window, 'showSaveFilePicker', undefined);
                    window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                });
                await target.goto(`${lifecycle.origin}?evbWindowId=2`, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(target);
                await expect.poll(() => page.evaluate(async () => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    return (await api.listTargetWindows?.())?.some(info => info.windowId === 2);
                }), {timeout: 30_000}).toBe(true);
                expect(await page.evaluate(async () => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    return api.transferActiveTabToWindow?.(2);
                })).toMatchObject({success: true});
                await target.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
                if (mode === 'two-window-move-source-stays-open') {
                    // The test bridge transfers the payload. Complete the departing
                    // tab's close through trusted UI while keeping its context alive.
                    await page.locator('.tab.is-active .tab-close').click();
                    await page.getByRole('button', {
                        name: 'Open File',
                        exact: true,
                    }).first().waitFor();
                }
                if (mode === 'two-window-move') await page.close();
                page = target;
            }
            await addNote(page,'review second saved note',{
                x:260,
                y:280,
            });
            const downloads: Download[] = [];
            page.on('download', download => downloads.push(download));
            await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).click();
            const workingRef = await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{workingCopyPath: string}>(['workingCopyPath']).workingCopyPath;
            });
            const savedSource = await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{originalPath: string}>(['originalPath']).originalPath;
            });
            await expect.poll(async () => Array.from(noteTexts(await PDFDocument.load(Uint8Array.from(
                await readPersistedDocumentBytes(page, savedSource!),
            )))), {timeout: 15_000}).toEqual(expect.arrayContaining([
                'review first saved note',
                'review second saved note',
            ]));
            await expect.poll(() => downloads.length, {timeout: 15_000}).toBe(1);
            const downloadedPath = await downloads[0]!.path();
            expect(downloadedPath).not.toBeNull();
            expect(Array.from(noteTexts(await PDFDocument.load(readFileSync(downloadedPath!))))).toEqual(expect.arrayContaining([
                'review first saved note',
                'review second saved note',
            ]));
            const savedBytes = await readPersistedDocumentBytes(page, workingRef!);
            const savedTexts = Array.from(noteTexts(await PDFDocument.load(Uint8Array.from(savedBytes))));
            expect(savedTexts).toEqual(expect.arrayContaining([
                'review first saved note',
                'review second saved note',
            ]));
            if (mode === 'two-window-move-source-stays-open') {
                expect(creator.isClosed()).toBe(false);
                // Keep the creator context alive through the receiver's final close.
                await page.locator('.tab.is-active .tab-close').click();
                await page.getByRole('button', {
                    name: 'Clear Recent Files',
                    exact: true,
                }).click();
                await page.getByRole('button', {
                    name: 'Clear History',
                    exact: true,
                }).click();
                // Terminal transfer protection lasts 60 seconds. Observe collection
                // after it expires and a normal lifecycle event publishes the graph.
                const expiredAt = Date.now() + 61_000;
                await Promise.all([
                    page,
                    creator,
                ].map(participant => participant.clock.setFixedTime(expiredAt)));
                await page.getByRole('button', {
                    name: 'New Tab',
                    exact: true,
                }).click();
                expect(creator.isClosed()).toBe(false);
                await expect.poll(() => readBrowserPayloadCounts(page), {timeout: 15_000}).toEqual({
                    records: 0,
                    chunks: 0,
                    recovery: 0,
                });
            }
            expect(await page.locator('.app-toast-failure').count()).toBe(0);
            expect(problems.flat()).toEqual([]);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 240_000);
});
