import type * as TBrowserQpdfEngineClient from '@app/platform/browser-api/browserQpdfEngineClient';
import type * as TViMockOriginalModule from '@app/platform/browser-api/browserYield';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import { BROWSER_MAX_FULL_READ_BYTES } from '@app/platform/browser/browserDocumentConstants';
import {
    getPdfLosslessOptimizationSkipReason,
    PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES,
    PDF_CONFORMANCE_MARKER_SCAN_OVERLAP_BYTES,
    scanPdfMarkerEvidence,
} from '@pdf-core/pdfConformanceHelpers';
import {
    createPdfConformanceFixture,
    type TPdfConformanceFixtureKind,
} from '@tests/helpers/createPdfConformanceFixture';

const browserDocumentStoreMock = vi.hoisted(() => ({
    stat: vi.fn(),
    requireEntry: vi.fn(async () => ({fileName: 'User $& file.pdf'})),
    read: vi.fn(),
    readRange: vi.fn(),
    readableBlob: vi.fn(),
    readableRevision: vi.fn(),
    getDocumentRevision: vi.fn(async () => ({token: 'revision-1'})),
    assertDocumentRevisionCurrent: vi.fn(async (_path: string, _token: string, _options?: unknown) => undefined),
}));
/** The store's pair of a Blob and its revision, from the two reads it pairs. */
const readableRevisionOfMocks = async (path: string) => ({
    blob: await browserDocumentStoreMock.readableBlob(path) as Blob,
    token: (await browserDocumentStoreMock.getDocumentRevision()).token,
});

vi.mock('@app/platform/browserDocumentStore', () => ({browserDocumentStore: browserDocumentStoreMock}));
vi.mock('@app/platform/browser-api/browserPdfjsDocumentInit', () => ({
    createPdfjsDocumentInit: vi.fn(),
    createPdfjsDocumentInitFromBrowserDocument: vi.fn(),
    getPdfjsLib: vi.fn(),
}));
const pdfjsMock = vi.hoisted(() => ({
    getDocument: vi.fn(),
    loadBrowserPdfjsDocument: vi.fn(),
}));
vi.mock('@app/platform/browser-api/loadBrowserPdfjsDocument', () => ({loadBrowserPdfjsDocument: pdfjsMock.loadBrowserPdfjsDocument}));
vi.mock('@app/platform/browser-api/browserYield', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    yieldToBrowser: vi.fn(async () => {}),
}));
// The worker runs the same page-ops WASM; this runs it in the test process.
const runPageOpsInProcess = vi.hoisted(() => vi.fn(async (type: 'conformance', payload: {source: Blob}) => {
    const {
        isBrowserPageOpsWasmFailure,
        tryRunBrowserPageOpsWithWasm,
    } = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
    const result = await tryRunBrowserPageOpsWithWasm(type, payload);
    if (isBrowserPageOpsWasmFailure(result)) {
        throw new Error(result.error.message);
    }
    return result;
}));
vi.mock('@app/platform/browser-api/browserPageOpsWorkerClient', () => ({runBrowserPageOpsWorkerRequest: runPageOpsInProcess}));

const qpdfRun = vi.hoisted(() => vi.fn());
vi.mock('@app/platform/browser-api/browserQpdfEngineClient', async importOriginal => ({
    ...await importOriginal<typeof TBrowserQpdfEngineClient>(),
    runBrowserQpdfCommand: qpdfRun,
}));

const NativeWebAssembly = WebAssembly;

async function stubPageOpsWasmFetch() {
    const wasmBytes = await readFile(join(process.cwd(), 'public/wasm/evb-pdf-page-ops.wasm'));
    vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
    vi.stubGlobal('WebAssembly', NativeWebAssembly);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.from(wasmBytes).buffer)));
}

function storeDocument(bytes: Uint8Array) {
    browserDocumentStoreMock.stat.mockResolvedValue({size: bytes.byteLength});
    browserDocumentStoreMock.read.mockResolvedValue(bytes);
    browserDocumentStoreMock.readableBlob.mockResolvedValue(new Blob([bytes as BlobPart]));
    browserDocumentStoreMock.readRange.mockImplementation(
        async (_path: string, offset: number, length: number) => bytes.slice(offset, offset + length),
    );
}


describe('browserPdfValidation', () => {
    beforeEach(() => {
        vi.resetModules();
        qpdfRun.mockReset();
        qpdfRun.mockImplementation(async command => ({
            exitCode: 0,
            stdout: command === 'page-count' ? '1' : '',
            stderr: '',
            output: null,
        }));
        runPageOpsInProcess.mockClear();
        vi.unstubAllGlobals();
        browserDocumentStoreMock.stat.mockReset();
        browserDocumentStoreMock.read.mockReset();
        browserDocumentStoreMock.readableBlob.mockReset();
        browserDocumentStoreMock.readableRevision.mockReset();
        browserDocumentStoreMock.readableRevision.mockImplementation(readableRevisionOfMocks);
        browserDocumentStoreMock.readRange.mockReset();
        browserDocumentStoreMock.readRange.mockImplementation(
            async (_path: string, _offset: number, length: number) => new Uint8Array(length),
        );
        browserDocumentStoreMock.read.mockResolvedValue(new Uint8Array([
            0x25,
            0x50,
            0x44,
            0x46,
        ]));
    });

    // Desktop's profile for the same structure: pdfConformancePathAnalysis.ts
    // composes the native facts and byte markers with the shared policy.
    it.each<{
        kind: TPdfConformanceFixtureKind;
        expected: Record<string, unknown>;
    }>([
        {
            kind: 'plain',
            expected: {
                isSigned: false,
                isTagged: false,
                hasAcroForm: false,
                canIncrementalSave: true,
                saveRestrictions: [],
            },
        },
        {
            kind: 'tagged',
            expected: {
                isTagged: true,
                canIncrementalSave: true,
                saveRestrictions: ['tagged_pdf_requires_structure_preservation'],
            },
        },
        {
            kind: 'acroform',
            expected: {
                hasAcroForm: true,
                hasXfa: false,
                canIncrementalSave: true,
                saveRestrictions: [],
            },
        },
        {
            kind: 'xfa',
            expected: {
                hasAcroForm: true,
                hasXfa: true,
                canIncrementalSave: false,
                saveRestrictions: [
                    'xfa_forms_are_not_supported_for_rewrite',
                    'incremental_save_not_supported',
                ],
            },
        },
        {
            kind: 'signed',
            expected: {
                isSigned: true,
                hasAcroForm: true,
                canIncrementalSave: true,
                saveRestrictions: ['signed_original_requires_save_as'],
            },
        },
        {
            kind: 'signed-object-stream',
            expected: {
                isSigned: true,
                hasAcroForm: true,
                canIncrementalSave: true,
                saveRestrictions: ['signed_original_requires_save_as'],
            },
        },
    ])('reports the structure of a $kind PDF', async ({
        kind,
        expected,
    }) => {
        await stubPageOpsWasmFetch();
        storeDocument(await createPdfConformanceFixture(kind));

        const { analyzeBrowserPdfConformance } = await import('@app/platform/browser-api/browserPdfValidation');
        await expect(analyzeBrowserPdfConformance('/tmp/browser.pdf')).resolves.toMatchObject(expected);
    });

    it('reads an unsigned signature field as unsigned for Save and Optimize alike', async () => {
        await stubPageOpsWasmFetch();
        const bytes = await createPdfConformanceFixture('unsigned-signature-field');
        storeDocument(bytes);

        const {
            analyzeBrowserPdfConformance, analyzeBrowserPdfConformanceData,
        } = await import('@app/platform/browser-api/browserPdfValidation');
        const unsigned = {
            isSigned: false,
            hasAcroForm: true,
            canIncrementalSave: true,
            saveRestrictions: [],
        };
        await expect(analyzeBrowserPdfConformance('/tmp/browser.pdf')).resolves.toMatchObject(unsigned);
        await expect(analyzeBrowserPdfConformance('/tmp/browser.pdf', {purpose: 'save-restrictions'})).resolves.toMatchObject(unsigned);
        expect(getPdfLosslessOptimizationSkipReason(await analyzeBrowserPdfConformanceData(bytes))).toBeNull();
    });

    it('rejects a document whose structure cannot be read instead of guessing its facts', async () => {
        await stubPageOpsWasmFetch();
        storeDocument(new TextEncoder().encode('%PDF-1.7\n/ByteRange [0 1 2 3]\nnot a PDF body\n%%EOF\n'));

        const { analyzeBrowserPdfConformance } = await import('@app/platform/browser-api/browserPdfValidation');
        await expect(analyzeBrowserPdfConformance('/tmp/browser.pdf', {purpose: 'save-restrictions'})).rejects.toThrow();
        await expect(analyzeBrowserPdfConformance('/tmp/browser.pdf')).rejects.toThrow();
    });

    it('reads the structure of a compressed signature past the 16 MiB full-read budget', async () => {
        await stubPageOpsWasmFetch();
        const bytes = await createPdfConformanceFixture('signed-object-stream', {padding: new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1)});
        expect(bytes.byteLength).toBeGreaterThan(BROWSER_MAX_FULL_READ_BYTES);
        storeDocument(bytes);

        const { analyzeBrowserPdfConformance } = await import('@app/platform/browser-api/browserPdfValidation');
        // No byte marker shows this signature: only its structure does.
        for (const purpose of [
            undefined,
            'save-restrictions',
        ] as const) {
            await expect(analyzeBrowserPdfConformance('/tmp/browser.pdf', purpose ? {purpose} : {})).resolves.toMatchObject({
                isSigned: true,
                hasAcroForm: true,
                saveRestrictions: ['signed_original_requires_save_as'],
            });
        }
    });

    it('finds a PDF/A claim in the middle of a large document', async () => {
        await stubPageOpsWasmFetch();
        const claim = new TextEncoder().encode('<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>');
        const padding = new Uint8Array(2 * BROWSER_MAX_FULL_READ_BYTES);
        padding.set(claim, BROWSER_MAX_FULL_READ_BYTES);
        storeDocument(await createPdfConformanceFixture('plain', {padding}));

        const { analyzeBrowserPdfConformance } = await import('@app/platform/browser-api/browserPdfValidation');
        await expect(analyzeBrowserPdfConformance('/tmp/browser.pdf')).resolves.toMatchObject({pdfaLevel: 'PDF/A-2B'});
    });

    it('reads marker evidence across a slice boundary as desktop\'s whole-file scan does', async () => {
        await stubPageOpsWasmFetch();
        // The analysis scans 16 of the shared scanner's windows per slice.
        const slice = 16 * (PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES - PDF_CONFORMANCE_MARKER_SCAN_OVERLAP_BYTES);
        const claim = new TextEncoder().encode('<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>');
        const paddingBytes = slice + 4096;
        // The padding stream is the first stream written; place the claim so
        // the file's first slice boundary falls inside it.
        const probe = await createPdfConformanceFixture('plain', {padding: new Uint8Array(paddingBytes)});
        const paddingStart = Buffer.from(probe).indexOf('stream\n') + 'stream\n'.length;
        const padding = new Uint8Array(paddingBytes);
        padding.set(claim, slice - paddingStart - claim.byteLength / 2);
        const bytes = await createPdfConformanceFixture('plain', {padding});
        const claimStart = Buffer.from(bytes).indexOf(Buffer.from(claim));
        expect(claimStart).toBeLessThan(slice);
        expect(claimStart + claim.byteLength).toBeGreaterThan(slice);
        storeDocument(bytes);

        const { analyzeBrowserPdfConformance } = await import('@app/platform/browser-api/browserPdfValidation');
        expect(scanPdfMarkerEvidence(bytes).pdfaLevel).toBe('PDF/A-2B');
        await expect(analyzeBrowserPdfConformance('/tmp/browser.pdf')).resolves.toMatchObject({pdfaLevel: 'PDF/A-2B'});
    });

    it('refuses a profile for a document that changed while it was read', async () => {
        await stubPageOpsWasmFetch();
        storeDocument(await createPdfConformanceFixture('plain'));
        browserDocumentStoreMock.assertDocumentRevisionCurrent.mockRejectedValueOnce(new Error('The document changed'));

        const { analyzeBrowserPdfConformance } = await import('@app/platform/browser-api/browserPdfValidation');
        await expect(analyzeBrowserPdfConformance('/tmp/browser.pdf')).rejects.toThrow('The document changed');
    });

    it.each([
        0,
        3,
    ])('accepts full checks with exit %s and preserves caller bytes and display names', async exitCode => {
        const data = Uint8Array.of(1, 2, 3);
        qpdfRun.mockImplementation(async (_command, input) => {
            structuredClone(input, {transfer: [input.buffer]});
            return {
                exitCode,
                stdout: 'checking /work/input.pdf\ninformation',
                stderr: 'warning /work/output.pdf',
                output: null,
            };
        });
        const {validateBrowserPdfData} = await import('@app/platform/browser-api/browserPdfValidation');
        await expect(validateBrowserPdfData(data, {fileName: 'My $& file.pdf'})).resolves.toEqual({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [
                'information',
                'warning My $& file.pdf',
            ],
        });
        expect(data).toEqual(Uint8Array.of(1, 2, 3));
    });

    it.each([
        '0',
        '-1',
        '1.2',
        '9007199254740992',
        '1\nwarning',
    ])('refuses invalid page counts: %s', async stdout => {
        storeDocument(Uint8Array.of(1));
        qpdfRun.mockResolvedValue({
            exitCode: 3,
            stdout,
            stderr: 'warning',
            output: null,
        });
        const {validateBrowserPdfPath} = await import('@app/platform/browser-api/browserPdfValidation');
        await expect(validateBrowserPdfPath('browser://documents/input', {purpose: 'opening'})).resolves.toMatchObject({
            isValid: false,
            errors: ['PDF structural validation returned an invalid page count'],
            warnings: [],
        });
    });

    it.each([
        'opening',
        'save',
    ] as const)('uses the page tree for %s with stderr-only warnings', async purpose => {
        storeDocument(Uint8Array.of(1));
        qpdfRun.mockResolvedValue({
            exitCode: 3,
            stdout: '2',
            stderr: 'warning /work/input.pdf',
            output: null,
        });
        const {validateBrowserPdfPath} = await import('@app/platform/browser-api/browserPdfValidation');
        await expect(validateBrowserPdfPath('browser://documents/input', {purpose})).resolves.toMatchObject({
            isValid: true,
            warnings: ['warning User $& file.pdf'],
        });
        // The engine's worker reads the document's own file by range; the window never reads it whole.
        expect(qpdfRun).toHaveBeenCalledWith('page-count', expect.any(Blob), {timeoutMs: 10_000});
        expect(new Uint8Array(await (qpdfRun.mock.calls[0]![1] as Blob).arrayBuffer())).toEqual(Uint8Array.of(1));
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
    });

    it.each([
        2,
        9,
    ])('refuses qpdf exit %s without a structural fallback', async exitCode => {
        qpdfRun.mockResolvedValue({
            exitCode,
            stdout: 'useful stdout',
            stderr: '  ',
            output: null,
        });
        const {validateBrowserPdfData} = await import('@app/platform/browser-api/browserPdfValidation');
        await expect(validateBrowserPdfData(Uint8Array.of(1))).resolves.toMatchObject({
            isValid: false,
            errors: [`qpdf(validate-pdf) failed with exit code ${exitCode}. No process output was captured.`],
            warnings: [],
        });
        expect(runPageOpsInProcess).not.toHaveBeenCalled();
    });

    it('uses actual structure only after a full-check timeout', async () => {
        await stubPageOpsWasmFetch();
        const {BrowserQpdfEngineTimeoutError} = await import('@app/platform/browser-api/browserQpdfEngineClient');
        const {validateBrowserPdfData} = await import('@app/platform/browser-api/browserPdfValidation');
        qpdfRun.mockRejectedValue(new BrowserQpdfEngineTimeoutError(30_000));
        await expect(validateBrowserPdfData(await createPdfConformanceFixture('plain'))).resolves.toMatchObject({
            isValid: true,
            warnings: ['qpdf validation timed out after 30000ms; fallback PDF structure validation succeeded.'],
        });
        await expect(validateBrowserPdfData(Uint8Array.of(1, 2, 3))).resolves.toMatchObject({
            isValid: false,
            warnings: [],
        });
    });

    it('reports no result for a stored revision that changed while its full check timed out', async () => {
        await stubPageOpsWasmFetch();
        const {BrowserQpdfEngineTimeoutError} = await import('@app/platform/browser-api/browserQpdfEngineClient');
        const {validateBrowserPdfPath} = await import('@app/platform/browser-api/browserPdfValidation');
        // Revision 1 is damaged; revision 2, saved while qpdf ran on revision 1, is sound.
        storeDocument(Uint8Array.of(1, 2, 3));
        const stale = Object.assign(new Error('The document changed'), {code: 'stale-revision'});
        const current = browserDocumentStoreMock.assertDocumentRevisionCurrent.getMockImplementation()!;
        onTestFinished(() => void browserDocumentStoreMock.assertDocumentRevisionCurrent.mockImplementation(current));
        qpdfRun.mockImplementationOnce(async () => {
            storeDocument(await createPdfConformanceFixture('plain'));
            browserDocumentStoreMock.assertDocumentRevisionCurrent.mockRejectedValue(stale);
            throw new BrowserQpdfEngineTimeoutError(30_000);
        });
        await expect(validateBrowserPdfPath('browser://documents/input')).rejects.toBe(stale);
        expect(browserDocumentStoreMock.readableBlob).toHaveBeenCalledOnce();
        expect(new Uint8Array(await (runPageOpsInProcess.mock.calls[0]![1].source).arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
    });

    it('reports no result for an edit validated while the document was undone to the revision before it', async () => {
        await stubPageOpsWasmFetch();
        const {validateBrowserPdfPath} = await import('@app/platform/browser-api/browserPdfValidation');
        // Revision A is damaged; B, an edit of it, is sound. The edit lands before validation reads the document,
        // and is undone while qpdf checks it.
        const revisions = {A: Uint8Array.of(1, 2, 3), B: await createPdfConformanceFixture('plain')};
        let current: keyof typeof revisions = 'A';
        const stale = Object.assign(new Error('The document changed'), {code: 'stale-revision'});
        storeDocument(revisions.A);
        browserDocumentStoreMock.getDocumentRevision.mockImplementation(async () => ({token: current}));
        browserDocumentStoreMock.readableBlob.mockImplementation(async () => {
            current = 'B';
            return new Blob([revisions[current] as BlobPart]);
        });
        browserDocumentStoreMock.readableRevision.mockImplementation(async () => {
            current = 'B';
            return {blob: new Blob([revisions[current] as BlobPart]), token: current};
        });
        browserDocumentStoreMock.assertDocumentRevisionCurrent.mockImplementation(async (_path, token) => {
            if (token !== current) {throw stale;}
        });
        onTestFinished(() => {
            browserDocumentStoreMock.getDocumentRevision.mockImplementation(async () => ({token: 'revision-1'}));
            browserDocumentStoreMock.assertDocumentRevisionCurrent.mockImplementation(async () => undefined);
        });
        qpdfRun.mockImplementationOnce(async (_command: string, input: Blob) => {
            const sound = new Uint8Array(await input.arrayBuffer()).byteLength === revisions.B.byteLength;
            current = 'A';
            return {exitCode: sound ? 0 : 2, stdout: '', stderr: sound ? '' : 'damaged', output: null};
        });

        // B's result is not A's: A is current again, and its check has not run.
        await expect(validateBrowserPdfPath('browser://documents/input')).rejects.toBe(stale);
        expect(qpdfRun).toHaveBeenCalledOnce();
    });

    it('does not fall back on a page-count timeout or a worker reset', async () => {
        storeDocument(Uint8Array.of(1));
        const {BrowserQpdfEngineTimeoutError} = await import('@app/platform/browser-api/browserQpdfEngineClient');
        const {
            validateBrowserPdfPath, validateBrowserPdfData,
        } = await import('@app/platform/browser-api/browserPdfValidation');
        qpdfRun.mockRejectedValueOnce(new BrowserQpdfEngineTimeoutError(10_000));
        await expect(validateBrowserPdfPath('browser://documents/input', {purpose: 'save'})).resolves.toMatchObject({isValid: false});
        qpdfRun.mockRejectedValueOnce(new DOMException('reset', 'AbortError'));
        await expect(validateBrowserPdfData(Uint8Array.of(1))).rejects.toMatchObject({name: 'AbortError'});
        expect(runPageOpsInProcess).not.toHaveBeenCalled();
    });

    it('keeps the above-cap range route with an explicit diagnostic and refuses data before copying', async () => {
        const {BROWSER_QPDF_MAX_INPUT_BYTES} = await import('@contracts/browserQpdfEngine');
        const large = Object.defineProperty(new Blob(), 'size', {value: BROWSER_QPDF_MAX_INPUT_BYTES + 1});
        browserDocumentStoreMock.readableBlob.mockResolvedValue(large);
        const destroy = vi.fn(async () => {});
        pdfjsMock.loadBrowserPdfjsDocument.mockResolvedValue({loadingTask: {destroy}});
        const {
            validateBrowserPdfPath, validateBrowserPdfData,
        } = await import('@app/platform/browser-api/browserPdfValidation');
        await expect(validateBrowserPdfPath('browser://documents/large')).resolves.toMatchObject({
            isValid: true,
            tool: 'browser',
            warnings: [expect.stringContaining(`${Math.round(BROWSER_QPDF_MAX_INPUT_BYTES / (1024 * 1024))} MiB`)],
        });
        // No oversized allocation is needed to prove admission happens before slice/transfer.
        const data = Uint8Array.of(1);
        Object.defineProperty(data, 'byteLength', {value: BROWSER_QPDF_MAX_INPUT_BYTES + 1});
        await expect(validateBrowserPdfData(data)).rejects.toMatchObject({code: 'browser-byte-limit'});
        // PDF.js reads the revision the result is for, by range.
        expect(pdfjsMock.loadBrowserPdfjsDocument).toHaveBeenCalledExactlyOnceWith(large);
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
        expect(qpdfRun).not.toHaveBeenCalled();
    });
});

/** A Blob whose slices a test can read synchronously, as `FileReaderSync` reads a Blob in a worker; Node has no such reader. */
class SyncReadableBlob extends Blob {
    public constructor(public readonly content: Uint8Array) {
        super([content as BlobPart]);
    }

    public override slice(start = 0, end = this.size) {
        return new SyncReadableBlob(this.content.subarray(start, end));
    }
}

// The pinned qpdf engine in its worker: a Blob input is mounted read-only and read by range, and answers exactly as
// the same bytes in the engine's memory file system do.
describe('browser qpdf engine worker', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.doUnmock('https://viewer.test/wasm/evb-qpdf.mjs');
    });

    async function startEngine() {
        vi.resetModules();
        const moduleUrl = pathToFileURL(join(process.cwd(), 'public/wasm/evb-qpdf.mjs')).href;
        vi.doMock('https://viewer.test/wasm/evb-qpdf.mjs', () => import(/* @vite-ignore */ moduleUrl));
        let listener: ((event: MessageEvent<unknown>) => Promise<void>) | undefined;
        const posted: unknown[] = [];
        vi.stubGlobal('self', {
            location: {href: 'https://viewer.test/workspace'},
            addEventListener: (_type: string, handler: typeof listener) => {
                listener = handler;
            },
            postMessage: (message: unknown) => posted.push(message),
        });
        const qpdfWasm = await readFile(join(process.cwd(), 'public/wasm/evb-qpdf.wasm'));
        const pageOpsWasm = await readFile(join(process.cwd(), 'public/wasm/evb-pdf-page-ops.wasm'));
        const fetchedUrls: string[] = [];
        vi.stubGlobal('fetch', async (input: string | URL | Request) => {
            const url = typeof input === 'string'
                ? input
                : input instanceof URL
                    ? input.href
                    : input.url;
            fetchedUrls.push(url);
            const bytes = url.includes('evb-pdf-page-ops.wasm') ? pageOpsWasm : qpdfWasm;
            return new Response(Uint8Array.from(bytes), {headers: {'content-type': 'application/wasm'}});
        });
        const reads: number[] = [];
        vi.stubGlobal('FileReaderSync', class {
            public readAsArrayBuffer(blob: Blob) {
                if (!(blob instanceof SyncReadableBlob)) {throw new TypeError('The engine read a Blob it was not given');}
                reads.push(blob.size);
                return blob.content.slice().buffer;
            }
        });
        await import('@app/platform/browser-api/browserQpdfEngine.worker');
        const qpdfListener = listener!;
        listener = undefined;
        await import('@app/platform/browser-api/browserPageOps.worker');
        const pageOpsListener = listener!;
        let nextId = 1;
        const run = async (command: string, input: Uint8Array | Blob) => {
            await qpdfListener({data: {id: nextId++, type: 'run', payload: {command, input}}} as MessageEvent<unknown>);
            return posted.at(-1) as {ok: boolean; data: {exitCode: number; stdout: string; stderr: string; output: Uint8Array | null}};
        };
        const judgeAdmission = async (source: Blob) => {
            await pageOpsListener({data: {id: nextId++, type: 'appendAdmission', payload: {source}}} as MessageEvent<unknown>);
            return posted.at(-1) as {ok: boolean; data: {verdict: string}};
        };
        return {
            run,
            judgeAdmission,
            reads,
            fetchedUrls,
        };
    }

    it('checks and rewrites a mounted Blob read by bounded ranges, with the result its bytes give', async () => {
        const pdf = new Uint8Array(await readFile(join(process.cwd(), 'tests/fixtures/optimize-typeset-photo.pdf')));
        const {run, reads} = await startEngine();

        const checkedBytes = await run('check', pdf.slice());
        const checkedBlob = await run('check', new SyncReadableBlob(pdf));
        expect(checkedBytes.ok && checkedBlob.ok).toBe(true);
        expect(checkedBlob.data).toEqual(checkedBytes.data);
        expect(checkedBlob.data.exitCode).toBe(0);

        reads.length = 0;
        const rewrittenBlob = await run('rewrite', new SyncReadableBlob(pdf));
        const rewrittenBytes = await run('rewrite', pdf.slice());
        expect(rewrittenBlob.data.exitCode).toBe(0);
        expect(rewrittenBlob.data.output).toEqual(rewrittenBytes.data.output);
        // The input was read in blocks, never whole, and about twice at most for a rewrite.
        expect(Math.max(...reads)).toBeLessThanOrEqual(256 * 1024);
        expect(Math.max(...reads)).toBeLessThan(pdf.byteLength);
        expect(reads.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(3 * pdf.byteLength);
    });

    it('fails a damaged Blob as qpdf\'s own exit and runs the next command on a fresh mount', async () => {
        const pdf = new Uint8Array(await readFile(join(process.cwd(), 'tests/fixtures/optimize-typeset-photo.pdf')));
        const {run} = await startEngine();

        const damaged = await run('check', new SyncReadableBlob(new TextEncoder().encode('not a PDF at all')));
        expect(damaged.ok).toBe(true);
        expect(damaged.data.exitCode).toBe(2);
        expect(damaged.data.stderr).toContain('/work/input.pdf');
        expect((await run('page-count', new SyncReadableBlob(pdf))).data).toMatchObject({exitCode: 0, stdout: expect.stringMatching(/^\d+\n?$/u)});
    });

    it('judges append admission in browserPageOps.worker by bounded ranges without loading qpdf or calling Blob.arrayBuffer()', async () => {
        const pdf = new Uint8Array(await readFile(join(process.cwd(), 'tests/fixtures/optimize-typeset-photo.pdf')));
        const {
            run,
            judgeAdmission,
            reads,
            fetchedUrls,
        } = await startEngine();

        const blob = new SyncReadableBlob(pdf);
        const arrayBufferSpy = vi.spyOn(blob, 'arrayBuffer').mockImplementation(() => {
            throw new Error('appendAdmission must not copy a Blob whole via arrayBuffer()');
        });
        const admittedBlob = await judgeAdmission(blob);
        expect(arrayBufferSpy).not.toHaveBeenCalled();
        expect(admittedBlob.ok).toBe(true);
        expect(admittedBlob.data).toEqual({verdict: 'appendable'});
        expect(fetchedUrls.some(url => url.includes('evb-qpdf.wasm'))).toBe(false);
        expect(reads.length).toBeGreaterThan(0);
        expect(Math.max(...reads)).toBeLessThanOrEqual(64 * 1024);
        expect(reads.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(pdf.byteLength);

        const latin1 = Buffer.from(pdf).toString('latin1');
        const damaged = new Uint8Array(Buffer.from(
            `${latin1.slice(0, latin1.lastIndexOf('startxref'))}startxref\n9\n%%EOF\n`,
            'latin1',
        ));
        reads.length = 0;
        const damagedBlob = new SyncReadableBlob(damaged);
        vi.spyOn(damagedBlob, 'arrayBuffer').mockImplementation(() => {
            throw new Error('appendAdmission must not copy a damaged Blob whole via arrayBuffer()');
        });
        expect((await judgeAdmission(damagedBlob)).data).toEqual({verdict: 'repairable'});
        // qpdf derives a repaired file's identifier from the clock; both repairs read one instant.
        vi.useFakeTimers({
            toFake: ['Date'],
            now: 1_800_000_000_000,
        });
        let repairedBytes;
        let repairedBlob;
        try {
            repairedBytes = await run('rewrite', damaged.slice());
            repairedBlob = await run('rewrite', damagedBlob);
        } finally {
            vi.useRealTimers();
        }
        expect(repairedBytes.ok && repairedBlob.ok).toBe(true);
        // qpdf exits 3 (succeeded with warnings) when repairing a damaged xref table.
        expect(repairedBlob.data.exitCode).toBe(3);
        expect(repairedBlob.data.output).toEqual(repairedBytes.data.output);
    });
});
