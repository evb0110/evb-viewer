import {BROWSER_QPDF_MAX_INPUT_BYTES} from '@contracts/browserQpdfEngine';
import type * as TBrowserQpdfEngineClient from '@app/platform/browser-api/browserQpdfEngineClient';
import type * as TViMockOriginalModule from '@app/platform/browser-api/browserYield';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { BROWSER_MAX_FULL_READ_BYTES } from '@app/platform/browser/browserDocumentConstants';
import {
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
    getDocumentRevision: vi.fn(async () => ({token: 'revision-1'})),
    assertDocumentRevisionCurrent: vi.fn(async () => undefined),
}));

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
const runPageOpsInProcess = vi.hoisted(() => vi.fn(async (type: 'conformance', payload: {data: Uint8Array}) => {
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

    it('lets an unsigned signature field force Save As only through the full profile', async () => {
        await stubPageOpsWasmFetch();
        storeDocument(await createPdfConformanceFixture('unsigned-signature-field'));

        const { analyzeBrowserPdfConformance } = await import('@app/platform/browser-api/browserPdfValidation');
        await expect(analyzeBrowserPdfConformance('/tmp/browser.pdf')).resolves.toMatchObject({
            isSigned: true,
            hasAcroForm: true,
        });
        await expect(analyzeBrowserPdfConformance('/tmp/browser.pdf', {purpose: 'save-restrictions'})).resolves.toMatchObject({
            isSigned: false,
            hasAcroForm: true,
            canIncrementalSave: true,
            saveRestrictions: [],
        });
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

    it('refuses a document past the structural worker ceiling before reading it', async () => {
        const {
            analyzeBrowserPdfConformance, BROWSER_PDF_CONFORMANCE_MAX_INPUT_BYTES,
        } = await import('@app/platform/browser-api/browserPdfValidation');
        browserDocumentStoreMock.stat.mockResolvedValue({size: BROWSER_PDF_CONFORMANCE_MAX_INPUT_BYTES + 1});

        await expect(analyzeBrowserPdfConformance('/tmp/browser.pdf')).rejects.toMatchObject({code: 'browser-byte-limit'});
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
        expect(qpdfRun).toHaveBeenCalledWith('page-count', expect.any(Uint8Array), {timeoutMs: 10_000});
        expect(browserDocumentStoreMock.read).toHaveBeenCalledWith('browser://documents/input', {maxBytes: BROWSER_QPDF_MAX_INPUT_BYTES});
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

    it('admits the conformance payload only after accounting for its generated framing', async () => {
        const {
            analyzeBrowserPdfConformanceData, BROWSER_PDF_CONFORMANCE_MAX_INPUT_BYTES,
        } = await import('@app/platform/browser-api/browserPdfValidation');
        expect(BROWSER_PDF_CONFORMANCE_MAX_INPUT_BYTES).toBe(2147483627);
        const data = Uint8Array.of(1);
        Object.defineProperty(data, 'byteLength', {value: BROWSER_PDF_CONFORMANCE_MAX_INPUT_BYTES + 1});
        await expect(analyzeBrowserPdfConformanceData(data)).rejects.toMatchObject({code: 'browser-byte-limit'});
        expect(runPageOpsInProcess).not.toHaveBeenCalled();
    });

    it('keeps the above-cap range route with an explicit diagnostic and refuses data before copying', async () => {
        const {BROWSER_QPDF_MAX_INPUT_BYTES} = await import('@contracts/browserQpdfEngine');
        browserDocumentStoreMock.stat.mockResolvedValue({size: BROWSER_QPDF_MAX_INPUT_BYTES + 1});
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
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
        expect(qpdfRun).not.toHaveBeenCalled();
    });
});
