import {
    crc32 as zlibCrc32,
    inflateRawSync,
} from 'node:zlib';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {createDocxFromTextAsync} from '@app/utils/createDocxFromTextAsync';
import {
    createDocxFromTextChunks,
    DOCUMENT_XML_PREFIX,
    DOCX_STREAM_CHUNK_BYTES,
    resolveDocxParagraphDirection,
} from '@app/utils/docxStreaming';

describe('createDocxFromTextAsync', () => {
    it('builds a DOCX package while checking the caller signal', async () => {
        const controller = new AbortController();
        const output = await createDocxFromTextAsync('catalog text', false, controller.signal);

        expect(output.byteLength).toBeGreaterThan(0);
        expect(new TextDecoder().decode(output.slice(0, 2))).toBe('PK');
    });

    it('preserves mixed paragraph direction in the async builder', async () => {
        const output = await createDocxFromTextAsync('אבג 123\nLatin 456\n123');
        const xml = new TextDecoder().decode(output);

        expect(xml).toContain('<w:p><w:pPr><w:bidi/></w:pPr>');
        expect(xml).toContain('<w:p><w:r><w:t xml:space="preserve">Latin 456');
        expect(xml).toContain('<w:p><w:r><w:t xml:space="preserve">123');
    });

    it('rejects before building when its signal is already canceled', async () => {
        const controller = new AbortController();
        controller.abort(new DOMException('DOCX export was canceled.', 'AbortError'));

        await expect(createDocxFromTextAsync('catalog text', false, controller.signal))
            .rejects.toMatchObject({name: 'AbortError'});
    });
});

async function collectDocxBytes(pages: Parameters<typeof createDocxFromTextChunks>[0]) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of createDocxFromTextChunks(pages)) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
}

interface IZipEntry {
    localFlags: number;
    centralFlags: number;
    method: number;
    crc: number;
    compressedSize: number;
    size: number;
    /** The entry's stored bytes, and the offset just past them. */
    compressed: Buffer;
    dataEnd: number;
}

/**
 * Walks the central directory. For each entry, reads the central record and the
 * local header it points at, then the stored bytes that follow the local header.
 */
function readZipEntries(zip: Buffer) {
    const entries = new Map<string, IZipEntry>();
    const endOfCentralDirectory = zip.lastIndexOf(Buffer.from([
        0x50,
        0x4B,
        0x05,
        0x06,
    ]));
    const entryCount = zip.readUInt16LE(endOfCentralDirectory + 10);
    let central = zip.readUInt32LE(endOfCentralDirectory + 16);
    for (let index = 0; index < entryCount; index += 1) {
        expect(zip.readUInt32LE(central)).toBe(0x02014B50);
        const nameLength = zip.readUInt16LE(central + 28);
        const extraLength = zip.readUInt16LE(central + 30);
        const commentLength = zip.readUInt16LE(central + 32);
        const name = zip.toString('utf8', central + 46, central + 46 + nameLength);
        const local = zip.readUInt32LE(central + 42);
        expect(zip.readUInt32LE(local)).toBe(0x04034B50);
        const compressedSize = zip.readUInt32LE(central + 20);
        const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const dataEnd = dataStart + compressedSize;
        entries.set(name, {
            localFlags: zip.readUInt16LE(local + 6),
            centralFlags: zip.readUInt16LE(central + 8),
            method: zip.readUInt16LE(central + 10),
            crc: zip.readUInt32LE(central + 16),
            compressedSize,
            size: zip.readUInt32LE(central + 24),
            compressed: zip.subarray(dataStart, dataEnd),
            dataEnd,
        });
        central += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

function documentEntry(zip: Buffer) {
    const entry = readZipEntries(zip).get('word/document.xml');
    if (!entry) {
        throw new Error('word/document.xml is missing from the central directory');
    }
    return entry;
}

async function collectDocumentXml(pages: Parameters<typeof createDocxFromTextChunks>[0]) {
    return inflateRawSync(documentEntry(await collectDocxBytes(pages)).compressed).toString('utf8');
}

describe('createDocxFromTextChunks', () => {
    it('gives every central directory entry the general-purpose flags of its local header', async () => {
        const entries = readZipEntries(await collectDocxBytes([
            'preface',
            'appendix',
        ]));

        expect([...entries.keys()]).toEqual([
            '[Content_Types].xml',
            '_rels/.rels',
            'word/document.xml',
            'word/_rels/document.xml.rels',
        ]);
        // The streamed document entry sets the data-descriptor bit locally.
        expect(entries.get('word/document.xml')?.localFlags).toBe(0x0008);
        for (const [
            name,
            entry,
        ] of entries) {
            expect(entry.centralFlags, name).toBe(entry.localFlags);
        }
    });

    it('DEFLATEs the streamed document entry, which inflates to the exact XML', async () => {
        const zip = await collectDocxBytes([
            'preface',
            'appendix',
        ]);
        const entry = documentEntry(zip);
        const xml = inflateRawSync(entry.compressed).toString('utf8');

        expect(entry.method).toBe(8);
        expect(xml).toBe(DOCUMENT_XML_PREFIX
            + '<w:p><w:r><w:t xml:space="preserve">preface</w:t></w:r></w:p>'
            + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
            + '<w:p><w:r><w:t xml:space="preserve">appendix</w:t></w:r></w:p>'
            + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
            + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
            + '</w:sectPr></w:body></w:document>');
        expect(entry.size).toBe(Buffer.byteLength(xml));
        expect(entry.crc).toBe(zlibCrc32(Buffer.from(xml)));
        // The data descriptor follows the compressed bytes and repeats the CRC and sizes.
        const descriptor = zip.subarray(entry.dataEnd, entry.dataEnd + 16);
        expect(descriptor.readUInt32LE(0)).toBe(0x08074B50);
        expect(descriptor.readUInt32LE(4)).toBe(entry.crc);
        expect(descriptor.readUInt32LE(8)).toBe(entry.compressedSize);
        expect(descriptor.readUInt32LE(12)).toBe(entry.size);
    });

    it('records sizes and CRC of a document that streams in several compressed chunks', async () => {
        const lines = Array.from({length: 6000}, (_, index) => `Recognized line ${index} of the scanned page`);
        const zip = await collectDocxBytes([lines.join('\n')]);
        const entry = documentEntry(zip);
        const xml = inflateRawSync(entry.compressed);

        expect(entry.size).toBeGreaterThan(DOCX_STREAM_CHUNK_BYTES);
        expect(entry.compressedSize).toBeLessThan(entry.size);
        expect(xml.byteLength).toBe(entry.size);
        expect(zlibCrc32(xml)).toBe(entry.crc);
        expect(xml.toString('utf8')).toContain('Recognized line 5999 of the scanned page</w:t>');
        const descriptor = zip.subarray(entry.dataEnd, entry.dataEnd + 16);
        expect(descriptor.readUInt32LE(8)).toBe(entry.compressedSize);
        expect(descriptor.readUInt32LE(12)).toBe(entry.size);
    });

    it('keeps paragraph direction local to mixed text and leaves numeric paragraphs neutral', async () => {
        const xml = await collectDocumentXml(['אבג 123\nLatin 456\n123']);
        expect(xml).toContain('<w:p><w:pPr><w:bidi/></w:pPr>');
        expect(xml).toContain('<w:p><w:r><w:t xml:space="preserve">Latin 456');
        expect(xml).toContain('<w:p><w:r><w:t xml:space="preserve">123');
    });

    it('preserves a page break between streamed text pages', async () => {
        const xml = await collectDocumentXml([
            'cover page',
            'inner title page',
        ]);

        expect(xml.match(/<w:br w:type="page"\/>/g)).toHaveLength(1);
        expect(xml.indexOf('cover page')).toBeLessThan(xml.indexOf('<w:br w:type="page"/>'));
        expect(xml.indexOf('<w:br w:type="page"/>')).toBeLessThan(xml.indexOf('inner title page'));
    });

    it('sets a page an OCR layer reads in two columns side by side, a cell per column', async () => {
        const xml = await collectDocumentXml([
            'preface',
            {
                text: 'Title\nleft one\nright one',
                layout: {regions: [
                    {columns: [['Title']]},
                    {columns: [
                        [
                            'left one',
                            'left two',
                        ],
                        ['right one'],
                    ]},
                ]},
            },
            'appendix',
        ]);
        // The body in order: paragraph text, page breaks, and table cells.
        const body = [...xml.matchAll(/<w:t xml:space="preserve">([^<]*)<\/w:t>|<w:br w:type="page"\/>|<w:tc>|<\/w:tbl>/gu)]
            .map(([
                match,
                text,
            ]) => text ?? {
                '<w:br w:type="page"/>': 'page break',
                '<w:tc>': 'cell',
                '</w:tbl>': 'end of columns',
            }[match]);
        expect(body).toEqual([
            'preface',
            'page break',
            'Title',
            'cell',
            'left one',
            'left two',
            'cell',
            'right one',
            'end of columns',
            'page break',
            'appendix',
        ]);
        // The columns have no borders.
        expect(xml).toContain('<w:tblBorders><w:top w:val="nil"/>');
    });

    it('puts a right-to-left page\'s right column first and shows it on the right', async () => {
        const xml = await collectDocumentXml([{
            text: 'שמאל\nימין',
            layout: {regions: [{columns: [
                ['שמאל'],
                ['ימין'],
            ]}]},
        }]);
        expect(xml).toContain('<w:tblPr><w:bidiVisual/>');
        expect(xml.indexOf('ימין')).toBeLessThan(xml.indexOf('שמאל'));
    });

    it('uses an RTL language hint only when text has no detected strong direction', () => {
        expect(resolveDocxParagraphDirection('123', true)).toBe(false);
        expect(resolveDocxParagraphDirection('漢字', true)).toBe(true);
        expect(resolveDocxParagraphDirection('Latin', true)).toBe(false);
    });

    it('coalesces generated bytes into bounded transport chunks', async () => {
        // Pseudo-random letters that DEFLATE cannot shrink much, so the compressed output fills whole chunks.
        let state = 0x9E3779B9;
        const letters = Array.from({length: DOCX_STREAM_CHUNK_BYTES * 2}, () => {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            return String.fromCharCode(97 + ((state >>> 0) % 26));
        });
        const chunks: Uint8Array[] = [];
        for await (const chunk of createDocxFromTextChunks([letters.join('')])) {
            chunks.push(chunk);
        }

        expect(chunks.length).toBeLessThan(20);
        expect(chunks.every(chunk => chunk.byteLength <= DOCX_STREAM_CHUNK_BYTES)).toBe(true);
        expect(chunks.some(chunk => chunk.byteLength === DOCX_STREAM_CHUNK_BYTES)).toBe(true);
    });

    it('rejects before producing output when its signal is already canceled', async () => {
        const controller = new AbortController();
        controller.abort(new DOMException('DOCX export was canceled.', 'AbortError'));

        const stream = createDocxFromTextChunks(['text'], false, controller.signal);

        await expect(stream.next()).rejects.toMatchObject({name: 'AbortError'});
    });

    it('stops between bounded output chunks when its signal is canceled', async () => {
        const controller = new AbortController();
        const stream = createDocxFromTextChunks(['text'], false, controller.signal);

        await expect(stream.next()).resolves.toMatchObject({done: false});
        controller.abort(new DOMException('DOCX export was canceled.', 'AbortError'));

        await expect(stream.next()).rejects.toMatchObject({name: 'AbortError'});
    });
});
