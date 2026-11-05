import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises';
import {
    createServer,
    type Server,
} from 'node:http';
import {
    join,
    resolve,
} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {clickCenter} from './clickCenter';
import {
    createAnnotationFidelityFixtureBytes,
    readAnnotationFidelitySnapshot,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    PDFDocument, PDFArray, PDFDict, PDFName, PDFString, PDFHexString,
} from 'pdf-lib';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';

let server: Server;
let origin = '';
let bundlePath = '';
let pageOpsWorkerBundlePath = '';
let temporaryDirectory = '';
let wasmBytes: Buffer;

beforeAll(async () => {
    await mkdir(join(process.cwd(), '.devkit'), {recursive: true});
    temporaryDirectory = await mkdtemp(join(process.cwd(), '.devkit/browser-annotation-save-'));
    bundlePath = join(temporaryDirectory, 'browser-annotation-save-acceptance.js');
    pageOpsWorkerBundlePath = join(temporaryDirectory, 'browser-page-ops.worker.js');
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'tests/integration/browser/browserAnnotationSaveAcceptanceEntry.ts')],
        format: 'esm',
        outfile: bundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'app/platform/browser-api/browserPageOps.worker.ts')],
        format: 'esm',
        outfile: pageOpsWorkerBundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    wasmBytes = await readFile(resolve(process.cwd(), 'public/wasm/evb-pdf-page-ops.wasm'));
    const pageOpsWorkerBytes = await readFile(pageOpsWorkerBundlePath);
    server = createServer((_request, response) => {
        if (_request.url === '/wasm/evb-pdf-page-ops.wasm') {
            response.writeHead(200, {'content-type': 'application/wasm'});
            response.end(wasmBytes);
            return;
        }
        if (_request.url === '/browserPageOps.worker.ts') {
            response.writeHead(200, {'content-type': 'text/javascript'});
            response.end(pageOpsWorkerBytes);
            return;
        }
        response.writeHead(200, {'content-type': 'text/html'});
        response.end('<!doctype html><title>Browser annotation save acceptance</title>');
    });
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Browser annotation save acceptance harness did not bind a TCP port');
    }
    origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    if (server) {
        await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
    await rm(temporaryDirectory, {
        force: true,
        recursive: true,
    });
});

describe('browser annotation save acceptance in Chromium', () => {
    it('preserves imported shape threads, a closed arrow and skewed markup when saving their sibling', async () => {
        const source = await createAnnotationFidelityFixtureBytes();
        const before = await readAnnotationFidelitySnapshot(source);
        const sourcePdf = await PDFDocument.load(source);
        const annots = sourcePdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
        const refFor = (name: string) => {
            const index = before.findIndex(row => row.name === name);
            return annots.get(index).toString();
        };
        const mutations = {
            shapes: {
                totalPages: 1,
                rewriteShapeState: false,
                shapes: [{
                    type: 'rectangle',
                    pageIndex: 0,
                    annotationId: refFor('evb-shape:sibling'),
                    stableKey: 'evb-shape:sibling',
                    x: 0.51,
                    y: 0.725,
                    width: 0.275,
                    height: 0.175,
                    color: '#0000ff',
                    opacity: 1,
                    strokeWidth: 2,
                }],
                deletedAnnotationIds: [],
                deletedStableKeys: [],
            },
            markup: {hints: [{
                subtype: 'Highlight',
                pageIndex: 0,
                annotationId: refFor('skewed-markup'),
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.5,
                    height: 0.15,
                },
                markupGeometry: [{
                    left: 0.1,
                    top: 0.2,
                    width: 0.5,
                    height: 0.15,
                }],
                color: '#ff0000',
                opacity: 1,
                contents: 'Browser edited skewed comment',
            }]},
        };
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            const [download] = await Promise.all([
                page.waitForEvent('download'),
                page.evaluate(async ({
                    bytes, mutation,
                }) => {
                    const save = Reflect.get(globalThis, '__evbSaveAnnotationFidelity');
                    if (typeof save !== 'function') throw new Error('Missing browser fidelity entry');
                    return save(bytes, mutation);
                }, {
                    bytes: Array.from(source),
                    mutation: mutations,
                }),
            ]);
            const evidence = resolve(process.cwd(), '.devkit/checks/browser-fidelity.pdf');
            await download.saveAs(evidence);
            const after = await readAnnotationFidelitySnapshot(await readFile(evidence));
            expect(after).toHaveLength(before.length);
            for (const name of [
                'foreign-dashed',
                'evb-shape:closed-arrow',
            ]) {
                expect(after.find(row => row.name === name), name).toEqual(before.find(row => row.name === name));
            }
            for (const thread of before.filter(row => row.name === null)) {
                expect(after.find(row => row.ref === thread.ref)).toEqual(thread);
            }
            const oldMarkup = before.find(row => row.name === 'skewed-markup')!;
            const newMarkup = after.find(row => row.name === 'skewed-markup')!;
            for (const key of [
                'quads',
                'rect',
                'appearance',
                'appearanceStream',
                'appearanceDictionary',
                'resources',
            ] as const) {
                expect(newMarkup[key], key).toEqual(oldMarkup[key]);
            }
            expect(newMarkup.contents).toBe('Browser edited skewed comment');
            expect(after.find(row => row.name === 'evb-shape:sibling')?.rect).not.toEqual(before.find(row => row.name === 'evb-shape:sibling')?.rect);
        } finally {
            await browser.close();
        }
    });

    it('saves and reopens annotations in small PDFs and in PDFs above the 16 MiB full-read default', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            const savedDownload = page.waitForEvent('download');
            const result = await page.evaluate(async () => {
                const run = Reflect.get(globalThis, '__evbRunBrowserAnnotationSaveAcceptance');
                if (typeof run !== 'function') {
                    throw new Error('Browser annotation save acceptance entry point was not installed');
                }
                return run();
            });
            const savedPath = resolve(process.cwd(), '.devkit/browser-annotation-acceptance-saved.pdf');
            await (await savedDownload).saveAs(savedPath);
            const savedPdf = await PDFDocument.load(await readFile(savedPath));
            const annots = savedPdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
            expect(Array.from({length: annots.size()}, (_value, index) => annots.lookup(index, PDFDict)
                .lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText()))
                .toContain('после Привет café');
            const saved = {
                rangeReadsPreserved: true,
                openedWithAnnotations: true,
                canonicalWriterVerified: true,
                savedAndReopened: true,
            };
            expect(result).toEqual({
                underCap: {
                    ...saved,
                    inputBytes: expect.any(Number),
                },
                overFullReadDefault: {
                    ...saved,
                    inputBytes: expect.any(Number),
                },
            });
            expect(result.overFullReadDefault.inputBytes).toBeGreaterThan(16 * 1024 * 1024);
        } finally {
            await browser.close();
        }
    }, 120_000);
    it('prepares an admitted facing print without a UI-thread long task and preserves the input', async () => {
        // Supply file bytes without leaving fixture-construction work in the measured renderer.
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        for (let index = 0; index < 4_000; index += 1) {
            pdf.addPage([
                200,
                100,
            ]).drawText(`Page ${index + 1}`, {
                x: 10,
                y: 30,
                size: 12,
            });
        }
        const input = new Uint8Array(await pdf.save());
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({
                path: bundlePath,
                type: 'module',
            });
            await page.evaluate(async (bytes) => {
                const prepare = Reflect.get(globalThis, '__evbPreparePrintResponsivenessAcceptance');
                if (typeof prepare !== 'function') throw new Error('Missing print acceptance entry');
                await prepare(new Uint8Array(bytes));
            }, Array.from(input));
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Emulation.setCPUThrottlingRate', {rate: 6});
            // Trusted CDP input without Playwright's injected hit-target
            // listeners becoming part of the main-thread measurement.
            await clickCenter(page, 'button');
            const result = await page.evaluate(() => Reflect.get(globalThis, '__evbPrintResponsivenessResult'));
            expect(result).toEqual({
                pageCount: 2_000,
                inputPreserved: true,
                longTasks: [],
            });
        } finally {
            await browser.close();
        }
    }, 120_000);

});
