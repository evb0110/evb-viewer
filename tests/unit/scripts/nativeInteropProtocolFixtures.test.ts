import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {normalizePdfNativeMutationSet} from '@pdf-core';
import {PDF_ANNOTATION_PARSE_MAX_CHUNK_BYTES} from '@contracts/electronApiDocuments';
import {decodePdfAnnotationParseProtocolFixture} from '@contracts/pdfAnnotationParseSchemas';

describe('native interop golden protocol fixtures', () => {
    it('keeps the TS mutation validator aligned with the Rust sidecar fixture', async () => {
        const fixturePath = resolve(process.cwd(), 'native/protocol-fixtures/pdf-page-ops-save-mutations.json');
        const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as unknown;
        const sidecarFixture = fixture as {
            placedImages: Array<Record<string, unknown>>;
            textBoxes: Array<Record<string, unknown>>;
        };
        expect(sidecarFixture.textBoxes).toHaveLength(1);
        expect(sidecarFixture.textBoxes[0]).toMatchObject({
            stableKey: 'fixture-text-box',
            author: 'Ada Lovelace',
            createdAt: 1780000000000,
            modifiedAt: 1780000060000,
        });
        const [placedImage] = sidecarFixture.placedImages;
        expect(Object.keys(placedImage ?? {}).sort()).toEqual([
            'byteLength',
            'bytesPath',
            'height',
            'mimeType',
            'pageIndex',
            'rotationDegrees',
            'sha256',
            'width',
            'x',
            'y',
        ]);
        const normalized = normalizePdfNativeMutationSet({
            ...sidecarFixture,
            placedImages: sidecarFixture.placedImages.map(({
                bytesPath: _bytesPath,
                ...image
            }) => ({
                ...image,
                source: {
                    path: String(_bytesPath),
                    size: Number(sidecarFixture.placedImages[0]?.byteLength),
                    sha256: String(sidecarFixture.placedImages[0]?.sha256),
                    leaseId: 'golden-sidecar-lease',
                    revision: null,
                },
            })),
        }, 'golden fixture', {errorKind: 'error'});

        expect(normalized.placedImages).toHaveLength(1);
        expect(normalized.textBoxes).toEqual(sidecarFixture.textBoxes);
        expect(normalized.placedImages?.[0]).toMatchObject({
            mimeType: 'image/jpeg',
            pageIndex: 0,
        });
    });

    it('keeps the TS parse guards aligned with the Rust sidecar fixture', async () => {
        const fixturePath = resolve(process.cwd(), 'native/protocol-fixtures/pdf-page-ops-parse-annotations.json');
        const source = await readFile(fixturePath, 'utf8');
        const fixture = decodePdfAnnotationParseProtocolFixture(JSON.parse(source) as unknown);

        expect(fixture.format).toBe('evb-pdf-annotation-parse');
        expect(fixture.schemaVersion).toBe(1);
        expect(fixture.chunkBytes).toBeLessThanOrEqual(PDF_ANNOTATION_PARSE_MAX_CHUNK_BYTES);
        expect(fixture.entries.map(entry => entry.kind)).toEqual([
            'text-box',
            'note',
            'highlight',
            'stamp',
            'shape',
            'foreign',
        ]);
        expect(fixture.entries[0]).toMatchObject({
            kind: 'text-box',
            text: 'Fixture text box',
            createdAt: 1788091200000,
            modifiedAt: 1788091260000,
            color: '#336699',
        });
        expect(fixture.entries[1]).toMatchObject({
            kind: 'note',
            contents: 'Fixture note',
            color: '#ff0000',
        });
        expect(fixture.entries[2]).toMatchObject({
            kind: 'highlight',
            subtype: 'Highlight',
            quadPoints: [{
                left: 0.1,
                top: 0.2,
                width: 0.4,
                height: 0.05,
            }],
            color: '#ffcc00',
            opacity: 0.5,
            contents: 'Fixture highlight',
        });
        expect(fixture.entries[3]).toMatchObject({
            kind: 'stamp',
            rect: {
                left: 0.1,
                top: 0.5,
                width: 0.3,
                height: 0.2,
            },
            rotation: 90,
            image: {
                objectNumber: 22,
                generationNumber: 0,
                byteLength: 128,
                sha256: 'a'.repeat(64),
            },
        });
        expect(fixture.entries[4]).toMatchObject({
            kind: 'shape',
            stableKey: 'shape-fixture',
            pdfSubtype: 'Line',
            type: 'line',
            x2: 0.8,
            y2: 0.9,
            lineStartStyle: 'none',
            lineEndStyle: 'closedArrow',
        });
        expect(fixture.entries[5]).toMatchObject({
            kind: 'foreign',
            subtype: 'Link',
        });

        const withUnknownField = JSON.parse(source) as Record<string, unknown>;
        withUnknownField.unexpected = true;
        expect(() => decodePdfAnnotationParseProtocolFixture(withUnknownField)).toThrow(/unsupported field/iu);

        const oversizedChunk = JSON.parse(source) as Record<string, unknown>;
        oversizedChunk.chunkBytes = PDF_ANNOTATION_PARSE_MAX_CHUNK_BYTES + 1;
        expect(() => decodePdfAnnotationParseProtocolFixture(oversizedChunk)).toThrow(/chunkBytes/iu);
    });
});
