import {
    mkdtemp,
    readFile,
    rm,
    stat,
} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {rebindDocumentTextCatalogRevision} from '@electron/features/ocr/main/documentTextCatalog';
import {openCatalog} from '@electron/features/ocr/main/ocrCatalogV4';
import {writeOcrIndexV4} from '@electron/features/ocr/pipeline/indexWriterV4';

const OLD_TOKEN = requireDocumentRevisionToken('drt1:rebind:old');
const NEW_TOKEN = requireDocumentRevisionToken('drt1:rebind:new');

let root = '';

afterEach(async () => {
    await rm(root, {
        recursive: true,
        force: true,
    });
});

async function seedV4Catalog() {
    root = await mkdtemp(join(tmpdir(), 'evb-ocr-rebind-v4-'));
    const path = join(root, 'working.pdf');
    await writeOcrIndexV4({
        catalogRoot: `${path}.ocr`,
        sourcePdfPath: path,
        documentRevision: OLD_TOKEN,
        pageCount: 1,
        pageBatches: [[{
            pageNumber: 1,
            text: 'page one',
            words: [],
            imageWidth: 1200,
            imageHeight: 1600,
        }]],
        assertRevisionCurrent: async () => {},
    });
    return {
        path,
        catalogPath: `${path}.ocr`,
    };
}

describe('OCR catalog revision rebind', () => {
    it('refuses to re-key a catalog that is not on the expected revision', async () => {
        const {path} = await seedV4Catalog();

        await expect(rebindDocumentTextCatalogRevision(path, NEW_TOKEN, NEW_TOKEN))
            .rejects.toThrow('OCR DocumentTextCatalog is missing or stale');
    });

    it('re-keys a v4 catalog by publishing a new generation without rewriting its page', async () => {
        const {
            path,
            catalogPath,
        } = await seedV4Catalog();
        const pagePath = join(catalogPath, 'gen-00000001', 'pages', '000000', 'p00000001.json');
        const before = (await stat(pagePath)).ino;

        await rebindDocumentTextCatalogRevision(path, OLD_TOKEN, NEW_TOKEN);

        expect((await stat(pagePath)).ino).toBe(before);
        const handle = await openCatalog(catalogPath, {expectedDocumentRevision: NEW_TOKEN});
        await expect(handle?.readPage(1)).resolves.toMatchObject({text: 'page one'});
        expect(handle?.header.generation).toBe(2);
        await handle?.close?.();
        const generation = JSON.parse(await readFile(join(catalogPath, 'gen-00000002', 'generation.json'), 'utf8')) as {
            documentRevision: {token: string};
            source: {pdfPath: string};
        };
        expect(generation).toMatchObject({
            documentRevision: {token: NEW_TOKEN},
            source: {pdfPath: path},
        });
    });
});
