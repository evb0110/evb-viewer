const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let j = 0; j < 8; j += 1) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
})();

function crc32(data: Uint8Array) {
    let crc = 0xFFFFFFFF;
    for (const byte of data) {
        crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function encodeUtf8(input: string) {
    return new TextEncoder().encode(input);
}

function concatBytes(parts: Uint8Array[]) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }
    return output;
}

function makeLocalHeader(fileName: Uint8Array, crc: number, size: number) {
    const header = new Uint8Array(30 + fileName.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, fileName.length, true);
    view.setUint16(28, 0, true);
    header.set(fileName, 30);
    return header;
}

function makeCentralHeader(fileName: Uint8Array, crc: number, size: number, offset: number) {
    const header = new Uint8Array(46 + fileName.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, size, true);
    view.setUint32(24, size, true);
    view.setUint16(28, fileName.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, offset, true);
    header.set(fileName, 46);
    return header;
}

function makeEndOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number) {
    const footer = new Uint8Array(22);
    const view = new DataView(footer.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, entryCount, true);
    view.setUint16(10, entryCount, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
    view.setUint16(20, 0, true);
    return footer;
}

function createZip(entries: Array<{ name: string; data: Uint8Array }>) {
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
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const footer = makeEndOfCentralDirectory(entries.length, centralSize, centralOffset);

    return concatBytes([...fileParts, ...centralParts, footer]);
}

function escapeXml(text: string) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildDocumentXml(text: string) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const paragraphs = lines.map((line) => {
        const safe = escapeXml(line);
        return `<w:p><w:r><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
    }).join('');

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:body>` +
        `${paragraphs}` +
        `<w:sectPr>` +
        `<w:pgSz w:w="12240" w:h="15840"/>` +
        `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>` +
        `</w:sectPr>` +
        `</w:body>` +
        `</w:document>`;
}

export function createDocxFromText(text: string) {
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `</Types>`;

    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`;

    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

    const docXml = buildDocumentXml(text);

    return createZip([
        { name: '[Content_Types].xml', data: encodeUtf8(contentTypes) },
        { name: '_rels/.rels', data: encodeUtf8(rels) },
        { name: 'word/document.xml', data: encodeUtf8(docXml) },
        { name: 'word/_rels/document.xml.rels', data: encodeUtf8(docRels) },
    ]);
}
