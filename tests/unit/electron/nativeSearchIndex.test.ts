import {
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    NATIVE_SEARCH_INDEX_MAGIC,
    NATIVE_SEARCH_INDEX_SCHEMA_VERSION,
    getNativeSearchIndexPath,
    persistNativeSearchIndex,
} from '@electron/features/search/nativeSearchIndex';
import type { IPdfSearchIndex } from '@electron/features/search/indexBuilder';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

const DOCUMENT_REVISION = requireDocumentRevisionToken('revision-token');

describe('native search index sidecar', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-native-search-index-'));
    });

    afterEach(async () => {
        await rm(tempDir, {
            force: true,
            recursive: true,
        });
    });

    it('persists page text in the binary format consumed by evb-pdf-search', async () => {
        const pdfPath = join(tempDir, 'sample.pdf');
        const index: IPdfSearchIndex = {
            schemaVersion: 7,
            documentRevision: {token: DOCUMENT_REVISION},
            pdfPath,
            createdAt: 1,
            pageCount: 2,
            pages: [
                {
                    pageNumber: 1,
                    text: 'alpha',
                },
                {
                    pageNumber: 2,
                    text: '\u{1F600} needle',
                },
            ],
        };

        await persistNativeSearchIndex(pdfPath, index, DOCUMENT_REVISION);

        const payload = await readFile(getNativeSearchIndexPath(pdfPath));
        expect(payload.toString('ascii', 0, 8)).toBe(NATIVE_SEARCH_INDEX_MAGIC);
        expect(payload.readUInt32LE(8)).toBe(NATIVE_SEARCH_INDEX_SCHEMA_VERSION);
        expect(payload.readUInt32LE(12)).toBe(64);
        expect(payload.readUInt32LE(16)).toBe(2);
        expect(payload.readUInt32LE(20)).toBe(2);

        const firstRecordOffset = 64 + Buffer.byteLength(DOCUMENT_REVISION, 'utf8');
        const firstTextOffset = Number(payload.readBigUInt64LE(firstRecordOffset + 8));
        const firstTextLength = Number(payload.readBigUInt64LE(firstRecordOffset + 16));
        const secondRecordOffset = firstRecordOffset + 24;
        const secondTextOffset = Number(payload.readBigUInt64LE(secondRecordOffset + 8));
        const secondTextLength = Number(payload.readBigUInt64LE(secondRecordOffset + 16));

        expect(payload.readUInt32LE(firstRecordOffset)).toBe(1);
        expect(payload.readUInt32LE(firstRecordOffset + 4)).toBe('alpha'.length);
        expect(payload.subarray(firstTextOffset, firstTextOffset + firstTextLength).toString('utf8')).toBe('alpha');
        expect(payload.readUInt32LE(secondRecordOffset)).toBe(2);
        expect(payload.readUInt32LE(secondRecordOffset + 4)).toBe('\u{1F600} needle'.length);
        expect(payload.subarray(secondTextOffset, secondTextOffset + secondTextLength).toString('utf8')).toBe('\u{1F600} needle');
    });
});
