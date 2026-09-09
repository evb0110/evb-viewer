import { sumBy } from 'es-toolkit/math';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
import {
    crc32,
    encodeUtf8,
    escapeXml,
    makeCentralHeader,
    makeEndOfCentralDirectory,
    makeLocalHeader,
    resolveDocxParagraphDirection,
    type TDocxParagraphDirection,
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

function buildDocumentXml(text: string, direction: TDocxParagraphDirection = false) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const paragraphs = lines.map((line) => {
        const safe = escapeXml(line);
        const isRtl = typeof direction === 'function'
            ? direction(line)
            : resolveDocxParagraphDirection(line, direction);
        if (isRtl) {
            return `<w:p><w:pPr><w:bidi/></w:pPr><w:r><w:rPr><w:rtl/></w:rPr><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
        }
        return `<w:p><w:r><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
    }).join('');

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:body>' +
        `${paragraphs}` +
        '<w:sectPr>' +
        '<w:pgSz w:w="12240" w:h="15840"/>' +
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
        '</w:sectPr>' +
        '</w:body>' +
        '</w:document>';
}

async function buildDocumentXmlCooperative(text: string, direction: TDocxParagraphDirection = false, signal?: AbortSignal) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const paragraphs: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
        signal?.throwIfAborted();
        const line = lines[index] ?? '';
        const safe = escapeXml(line);
        const isRtl = typeof direction === 'function'
            ? direction(line)
            : resolveDocxParagraphDirection(line, direction);
        if (isRtl) {
            paragraphs.push(`<w:p><w:pPr><w:bidi/></w:pPr><w:r><w:rPr><w:rtl/></w:rPr><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`);
        } else {
            paragraphs.push(`<w:p><w:r><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`);
        }

        if (index > 0 && index % 200 === 0) {
            await yieldToBrowser();
        }
    }

    signal?.throwIfAborted();
    await yieldToBrowser();
    signal?.throwIfAborted();
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:body>' +
        `${paragraphs.join('')}` +
        '<w:sectPr>' +
        '<w:pgSz w:w="12240" w:h="15840"/>' +
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
        '</w:sectPr>' +
        '</w:body>' +
        '</w:document>';
}

export function createDocxFromText(text: string, direction: TDocxParagraphDirection = false) {
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

    const docXml = buildDocumentXml(text, direction);

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

export async function createDocxFromTextAsync(text: string, direction: TDocxParagraphDirection = false, signal?: AbortSignal) {
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

    const docXml = await buildDocumentXmlCooperative(text, direction, signal);
    signal?.throwIfAborted();
    await yieldToBrowser();
    signal?.throwIfAborted();

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
