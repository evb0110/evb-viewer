import { sumBy } from 'es-toolkit/math';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
import {
    crc32,
    DOCUMENT_XML_PREFIX,
    DocxBodyWriter,
    encodeUtf8,
    escapeXml,
    makeCentralHeader,
    makeEndOfCentralDirectory,
    makeLocalHeader,
    type TDocxParagraphDirection,
    type TDocxTextPage,
} from '@app/utils/docxStreaming';

function concatBytes(parts: Uint8Array[]) {
    const total = sumBy(parts, part => part.length);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }
    return output;
}

function createZip(entries: Array<{
    name: string;
    data: Uint8Array;
}>) {
    const fileParts: Uint8Array[] = [];
    const centralParts: Uint8Array[] = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBytes = encodeUtf8(entry.name);
        const crc = crc32(entry.data);
        const header = makeLocalHeader(nameBytes, crc, entry.data.length);
        fileParts.push(header, entry.data);

        const central = makeCentralHeader(nameBytes, crc, entry.data.length, offset);
        centralParts.push(central);

        offset += header.length + entry.data.length;
    }

    const centralOffset = offset;
    const centralSize = sumBy(centralParts, part => part.length);
    const footer = makeEndOfCentralDirectory(entries.length, centralSize, centralOffset);

    return concatBytes([
        ...fileParts,
        ...centralParts,
        footer,
    ]);
}

async function buildDocumentXmlCooperative(pages: readonly TDocxTextPage[], direction: TDocxParagraphDirection, signal?: AbortSignal) {
    const body = new DocxBodyWriter(direction);
    const parts = [DOCUMENT_XML_PREFIX];
    let count = 0;
    for (const page of pages) {
        for (const part of body.page(page)) {
            signal?.throwIfAborted();
            if (part.kind === 'markup') {
                parts.push(part.xml);
            } else if (part.rtl) {
                parts.push(`<w:p><w:pPr><w:bidi/></w:pPr><w:r><w:rPr><w:rtl/></w:rPr><w:t xml:space="preserve">${escapeXml(part.text)}</w:t></w:r></w:p>`);
            } else {
                parts.push(`<w:p><w:r><w:t xml:space="preserve">${escapeXml(part.text)}</w:t></w:r></w:p>`);
            }
            if (++count % 200 === 0) {
                await yieldToBrowser();
            }
        }
    }
    signal?.throwIfAborted();
    await yieldToBrowser();
    signal?.throwIfAborted();
    parts.push(body.end());
    return parts.join('');
}

/** Builds a DOCX in memory; a string is one page. */
export async function createDocxFromTextAsync(
    content: string | readonly TDocxTextPage[],
    direction: TDocxParagraphDirection = false,
    signal?: AbortSignal,
) {
    signal?.throwIfAborted();
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>';

    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>';

    const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

    const docXml = await buildDocumentXmlCooperative(typeof content === 'string' ? [content] : content, direction, signal);

    return createZip([
        {
            name: '[Content_Types].xml',
            data: encodeUtf8(contentTypes),
        },
        {
            name: '_rels/.rels',
            data: encodeUtf8(rels),
        },
        {
            name: 'word/document.xml',
            data: encodeUtf8(docXml),
        },
        {
            name: 'word/_rels/document.xml.rels',
            data: encodeUtf8(docRels),
        },
    ]);
}
