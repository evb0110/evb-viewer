import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    MIXED_OCR_CORPUS_PATH,
    MIXED_OCR_CORPUS_REVISION,
    mixedEmbeddedTextPages,
    mixedEvbPage,
    mixedOcrCorpusExpectedSources,
    mixedOcrManifest,
} from '@tests/fixtures/ocr/mixedDocumentCorpus';

function isMockFile(path: string) {
    return path.endsWith('manifest.json') || path.endsWith('page-0004.json');
}

function mockFileHandle(path: string) {
    const text = path.endsWith('manifest.json')
        ? JSON.stringify(mixedOcrManifest)
        : path.endsWith('page-0004.json')
            ? JSON.stringify(mixedEvbPage)
            : '';
    const contents = Buffer.from(text, 'utf8');
    return {
        close: vi.fn(async () => undefined),
        read: vi.fn(async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number,
        ) => {
            const chunk = contents.subarray(position, position + length);
            chunk.copy(buffer, offset);
            return {
                bytesRead: chunk.byteLength,
                buffer,
            };
        }),
        stat: vi.fn(async () => ({size: contents.byteLength})),
    };
}

const openMock = vi.fn(async (path: string) => mockFileHandle(path));
const lstatMock = vi.fn(async (path: string) => ({
    isDirectory: () => path.endsWith('mixed-ocr-corpus.pdf.ocr'),
    isFile: () => isMockFile(path),
    isSymbolicLink: () => false,
}));
const realpathMock = vi.fn(async (path: string) => path);

vi.mock('node:fs/promises', () => ({
    readFile: vi.fn(async (path: string) => {
        if (path.endsWith('manifest.json')) {
            return JSON.stringify(mixedOcrManifest);
        }
        if (path.endsWith('page-0004.json')) {
            return JSON.stringify(mixedEvbPage);
        }
        throw new Error('ENOENT');
    }),
    lstat: lstatMock,
    open: openMock,
    realpath: realpathMock,
    rename: vi.fn(),
    stat: vi.fn(async () => ({size: 1})),
    writeFile: vi.fn(),
}));
vi.mock('@electron/features/search/loadPdfjsTextExtractor', () => ({loadPdfjsTextExtractor: async () => ({extractTextWithPdfjsWordBoxes: vi.fn(async () => mixedEmbeddedTextPages)})}));
vi.mock('@electron/file-access/documentRevisionSidecar', () => ({assertWorkingCopyRevisionSidecarCurrent: vi.fn(async () => undefined)}));

const {resolveDocumentTextCatalogSnapshot} = await import('@electron/features/ocr/main/documentTextCatalog');

describe('mixed native/scanned/foreign/EVB OCR corpus', () => {
    it('selects exactly one canonical source per text-bearing page', async () => {
        const snapshot = await resolveDocumentTextCatalogSnapshot(
            MIXED_OCR_CORPUS_PATH,
            MIXED_OCR_CORPUS_REVISION,
            4,
        );

        expect(snapshot.pageCount).toBe(4);
        expect(snapshot.pages.map(page => ({
            pageNumber: page.pageNumber,
            source: page.source,
        })))
            .toEqual(mixedOcrCorpusExpectedSources);
        expect(snapshot.pages.find(page => page.pageNumber === 2)).toBeUndefined();
        expect(snapshot.pages.find(page => page.pageNumber === 4)).toMatchObject({
            generation: 'generation-2',
            text: mixedEvbPage.text,
        });
    });
});
