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
import { cast } from '@tests/helpers/cast';
import {
    createPdfConformanceFixture,
    type TPdfConformanceFixtureKind,
} from '@tests/helpers/createPdfConformanceFixture';

const browserDocumentStoreMock = vi.hoisted(() => ({
    stat: vi.fn(),
    read: vi.fn(),
    readRange: vi.fn(),
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
const runPageOpsInProcess = vi.hoisted(() => async (type: 'conformance', payload: {data: Uint8Array}) => {
    const {
        isBrowserPageOpsWasmFailure,
        tryRunBrowserPageOpsWithWasm,
    } = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
    const result = await tryRunBrowserPageOpsWithWasm(type, payload);
    if (isBrowserPageOpsWasmFailure(result)) {
        throw new Error(result.error.message);
    }
    return result;
});
vi.mock('@app/platform/browser-api/browserPageOpsWorkerClient', () => ({runBrowserPageOpsWorkerRequest: runPageOpsInProcess}));

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

const CONSERVATIVE_RESTRICTION = 'incremental_save_not_supported';

describe('browserPdfValidation', () => {
    beforeEach(() => {
        vi.resetModules();
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
                    CONSERVATIVE_RESTRICTION,
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

    it('keeps the conservative marker profile when the structure cannot be read', async () => {
        await stubPageOpsWasmFetch();
        storeDocument(new TextEncoder().encode('%PDF-1.7\n/ByteRange [0 1 2 3]\nnot a PDF body\n%%EOF\n'));

        const { analyzeBrowserPdfConformance } = await import('@app/platform/browser-api/browserPdfValidation');
        await expect(analyzeBrowserPdfConformance('/tmp/browser.pdf', {purpose: 'save-restrictions'})).resolves.toEqual({
            isSigned: true,
            isEncrypted: false,
            isTagged: false,
            pdfaLevel: null,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: false,
            saveRestrictions: [
                'signed_original_requires_save_as',
                CONSERVATIVE_RESTRICTION,
            ],
        });
    });

    it('judges a PDF beyond the 16 MiB full-read budget by its edge markers alone', async () => {
        const size = BROWSER_MAX_FULL_READ_BYTES + 1;
        const marker = new TextEncoder().encode('trailer << /Encrypt 9 0 R >>');
        browserDocumentStoreMock.stat.mockResolvedValue({size});
        browserDocumentStoreMock.readRange.mockImplementation(async (_path: string, offset: number, length: number) => {
            const bytes = new Uint8Array(length);
            if (offset + length === size) bytes.set(marker, length - marker.byteLength);
            return bytes;
        });

        const { analyzeBrowserPdfConformance } = await import('@app/platform/browser-api/browserPdfValidation');
        await expect(analyzeBrowserPdfConformance('/tmp/browser.pdf')).resolves.toMatchObject({
            isEncrypted: true,
            canIncrementalSave: false,
        });
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
    });

    it('reports loaded data as valid when its teardown fails', async () => {
        const {getPdfjsLib} = await import('@app/platform/browser-api/browserPdfjsDocumentInit');
        vi.mocked(getPdfjsLib).mockResolvedValue(cast<Awaited<ReturnType<typeof getPdfjsLib>>>({getDocument: pdfjsMock.getDocument}));
        const destroy = vi.fn(async () => {
            throw new Error('PDF.js worker already terminated');
        });
        pdfjsMock.getDocument.mockReturnValue({
            promise: Promise.resolve({numPages: 1}),
            destroy,
        });

        const {validateBrowserPdfData} = await import('@app/platform/browser-api/browserPdfValidation');
        await expect(validateBrowserPdfData(Uint8Array.of(1, 2, 3))).resolves.toMatchObject({
            isValid: true,
            errors: [],
        });
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('reports the load failure of data, not its teardown', async () => {
        const {getPdfjsLib} = await import('@app/platform/browser-api/browserPdfjsDocumentInit');
        vi.mocked(getPdfjsLib).mockResolvedValue(cast<Awaited<ReturnType<typeof getPdfjsLib>>>({getDocument: pdfjsMock.getDocument}));
        pdfjsMock.getDocument.mockReturnValue({
            promise: Promise.reject(new Error('Invalid PDF structure.')),
            destroy: vi.fn(async () => {
                throw new Error('PDF.js worker already terminated');
            }),
        });

        const {validateBrowserPdfData} = await import('@app/platform/browser-api/browserPdfValidation');
        await expect(validateBrowserPdfData(Uint8Array.of(1, 2, 3))).resolves.toMatchObject({
            isValid: false,
            errors: ['Invalid PDF structure.'],
        });
    });

    it('reports a loaded stored document as valid when its teardown fails', async () => {
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        const destroy = vi.fn(async () => {
            throw new Error('PDF.js worker already terminated');
        });
        pdfjsMock.loadBrowserPdfjsDocument.mockResolvedValue({loadingTask: {destroy}});

        const {validateBrowserPdfPath} = await import('@app/platform/browser-api/browserPdfValidation');
        await expect(validateBrowserPdfPath('/tmp/browser.pdf')).resolves.toMatchObject({
            isValid: true,
            errors: [],
        });
        expect(destroy).toHaveBeenCalledOnce();
    });
});
