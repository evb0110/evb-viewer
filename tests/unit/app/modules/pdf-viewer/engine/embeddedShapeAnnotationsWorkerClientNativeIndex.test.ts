import type * as TViMockOriginalModule from '@app/utils/platformDocuments';
import type * as TViMockOriginalModule2 from '@app/utils/documentBytes';

import { requireEpochMs } from '@contracts/timestamps';
import { requireSessionId } from '@contracts/shared';
import { requireDocumentRef } from '@contracts/documentRef';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IPdfEmbeddedShapeIndexChunk,
    IPdfEmbeddedShapeIndexEntry,
    IPdfEmbeddedShapeIndexSession,
} from '@contracts/electronApiDocuments';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requirePageIndex} from '@contracts/pageNumbers';
import {
    EmbeddedShapeImportCapabilityError,
    importEmbeddedShapeAnnotationsFromNativePath,
    importEmbeddedShapeAnnotationsFromNativePathResult,
    importEmbeddedShapeAnnotationsFromPathInWorker,
} from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeAnnotationsWorkerClient';
import {readDocumentBytes} from '@app/utils/documentBytes';

const mocks = vi.hoisted(() => ({
    capabilityOverride: null as Record<string, unknown> | null,
    files: {
        beginPdfEmbeddedShapeIndex: vi.fn(),
        readPdfEmbeddedShapeIndexChunk: vi.fn(),
        releasePdfEmbeddedShapeIndex: vi.fn(),
        cancelPdfEmbeddedShapeIndex: vi.fn(),
        getDocumentRevision: vi.fn(),
        readFileRange: vi.fn(),
    },
}));

vi.mock('@app/utils/platform', () => ({isDesktopPlatformActive: () => true}));
vi.mock('@app/utils/platformDocuments', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getDocumentFilesCapability: () => mocks.capabilityOverride ?? mocks.files,
}));
vi.mock('@app/utils/documentBytes', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    readDocumentBytes: vi.fn(),
}));

const path = '/tmp/native-index-large.pdf';
const revision = requireDocumentRevisionToken('drt1:native-index-test');

function createEntry(
    overrides: Partial<IPdfEmbeddedShapeIndexEntry> = {},
): IPdfEmbeddedShapeIndexEntry {
    return {
        pageIndex: requirePageIndex(0),
        objectNumber: 10,
        generationNumber: 0,
        stableKey: 'evb-shape:test',
        pdfSubtype: 'Square',
        type: 'rectangle',
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
        x2: null,
        y2: null,
        color: '#336699',
        fillColor: null,
        opacity: 0.8,
        strokeWidth: 2,
        points: null,
        strokes: null,
        lineStartStyle: null,
        lineEndStyle: null,
        createdAt: requireEpochMs(1_700_000_000),
        modifiedAt: requireEpochMs(1_700_000_001),
        ...overrides,
    };
}

function createSession(overrides: Partial<IPdfEmbeddedShapeIndexSession> = {}) {
    return {
        sessionId: requireSessionId('native-shape-session'),
        documentRef: requireDocumentRef(path),
        documentRevisionToken: revision,
        pageCount: 2_147_483_648,
        entryCount: 1,
        totalBytes: 3_000_000_000,
        ...overrides,
    } satisfies IPdfEmbeddedShapeIndexSession;
}

function createDoneChunk(entries: IPdfEmbeddedShapeIndexEntry[]): IPdfEmbeddedShapeIndexChunk {
    return {
        offset: 0,
        nextOffset: null,
        byteLength: 1,
        done: true,
        entries,
    };
}

beforeEach(() => {
    mocks.capabilityOverride = null;
    Object.values(mocks.files).forEach(mock => mock.mockReset());
    mocks.files.beginPdfEmbeddedShapeIndex.mockResolvedValue(createSession());
    mocks.files.readPdfEmbeddedShapeIndexChunk.mockResolvedValue(createDoneChunk([]));
    mocks.files.releasePdfEmbeddedShapeIndex.mockResolvedValue(true);
    mocks.files.cancelPdfEmbeddedShapeIndex.mockResolvedValue({canceled: true});
    mocks.files.getDocumentRevision.mockResolvedValue({token: revision});
    vi.mocked(readDocumentBytes).mockReset();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('native embedded shape index import', () => {
    it('maps all six PDF subtypes from bounded metadata without reading document bytes', async () => {
        const entries = [
            createEntry({
                objectNumber: 10,
                stableKey: 'square',
                pdfSubtype: 'Square',
                type: 'rectangle',
            }),
            createEntry({
                objectNumber: 11,
                stableKey: 'circle',
                pdfSubtype: 'Circle',
                type: 'circle',
            }),
            createEntry({
                objectNumber: 12,
                stableKey: 'line',
                pdfSubtype: 'Line',
                type: 'line',
                x2: 0.9,
                y2: 0.8,
                lineStartStyle: 'none',
                lineEndStyle: 'openArrow',
            }),
            createEntry({
                objectNumber: 13,
                stableKey: 'polyline',
                pdfSubtype: 'PolyLine',
                type: 'polyline',
                points: [
                    {
                        x: 0.1,
                        y: 0.2,
                    },
                    {
                        x: 0.3,
                        y: 0.4,
                    },
                ],
            }),
            createEntry({
                objectNumber: 14,
                stableKey: 'polygon',
                pdfSubtype: 'Polygon',
                type: 'polygon',
                fillColor: '#ffffff',
                points: [
                    {
                        x: 0.1,
                        y: 0.2,
                    },
                    {
                        x: 0.3,
                        y: 0.4,
                    },
                    {
                        x: 0.5,
                        y: 0.6,
                    },
                ],
            }),
            createEntry({
                objectNumber: 15,
                stableKey: 'ink',
                pdfSubtype: 'Ink',
                type: 'polyline',
                points: [],
                strokes: [[
                    {
                        x: 0.2,
                        y: 0.3,
                    },
                    {
                        x: 0.4,
                        y: 0.5,
                    },
                ]],
            }),
        ];
        mocks.files.readPdfEmbeddedShapeIndexChunk.mockResolvedValue(createDoneChunk(entries));
        vi.mocked(readDocumentBytes).mockRejectedValue(new Error('whole-document reads are forbidden'));

        const shapes = await importEmbeddedShapeAnnotationsFromNativePath(requireDocumentRef(path), {expectedDocumentRevisionToken: revision});

        expect(shapes).toHaveLength(6);
        expect(shapes.map(shape => shape.pdfSubtype)).toEqual([
            'Square',
            'Circle',
            'Line',
            'PolyLine',
            'Polygon',
            'Ink',
        ]);
        expect(shapes.map(shape => shape.type)).toEqual([
            'rectangle',
            'circle',
            'line',
            'polyline',
            'polygon',
            'polyline',
        ]);
        expect(shapes[2]).toMatchObject({
            annotationId: '12R',
            x2: 0.9,
            y2: 0.8,
            lineStartStyle: 'none',
            lineEndStyle: 'openArrow',
        });
        expect(shapes[5]).toMatchObject({
            points: [],
            strokes: [[
                {
                    x: 0.2,
                    y: 0.3,
                },
                {
                    x: 0.4,
                    y: 0.5,
                },
            ]],
        });
        expect(mocks.files.beginPdfEmbeddedShapeIndex).toHaveBeenCalledWith(
            path,
            {expectedDocumentRevisionToken: revision},
        );
        expect(mocks.files.readPdfEmbeddedShapeIndexChunk).toHaveBeenCalledWith(
            'native-shape-session',
            0,
            {chunkBytes: 512 * 1024},
        );
        expect(mocks.files.releasePdfEmbeddedShapeIndex).toHaveBeenCalledWith('native-shape-session');
        expect(mocks.files.cancelPdfEmbeddedShapeIndex).not.toHaveBeenCalled();
        expect(readDocumentBytes).not.toHaveBeenCalled();
        expect(mocks.files.readFileRange).not.toHaveBeenCalled();
    });

    it('uses the revision capability when the caller has no token', async () => {
        await importEmbeddedShapeAnnotationsFromNativePath(requireDocumentRef(path));

        expect(mocks.files.getDocumentRevision).toHaveBeenCalledWith(path);
        expect(mocks.files.beginPdfEmbeddedShapeIndex).toHaveBeenCalledWith(
            path,
            {expectedDocumentRevisionToken: revision},
        );
    });

    it('returns typed incomplete state when the native index capability is absent', async () => {
        mocks.capabilityOverride = {
            ...mocks.files,
            beginPdfEmbeddedShapeIndex: undefined,
        };

        const result = await importEmbeddedShapeAnnotationsFromNativePathResult(requireDocumentRef(path), {expectedDocumentRevisionToken: revision});

        expect(result).toEqual({
            status: 'incomplete',
            reason: 'native-index-capability-unavailable',
        });
        expect(readDocumentBytes).not.toHaveBeenCalled();
    });

    it('does not fall back to bytes when a native index chunk is malformed', async () => {
        mocks.files.readPdfEmbeddedShapeIndexChunk.mockResolvedValueOnce({
            offset: 0,
            nextOffset: 0,
            byteLength: 1,
            done: false,
            entries: [],
        });
        vi.mocked(readDocumentBytes).mockRejectedValue(new Error('whole-document reads are forbidden'));

        await expect(importEmbeddedShapeAnnotationsFromPathInWorker(requireDocumentRef(path), {signal: new AbortController().signal})).rejects.toBeInstanceOf(EmbeddedShapeImportCapabilityError);
        expect(mocks.files.cancelPdfEmbeddedShapeIndex).toHaveBeenCalledWith('native-shape-session');
        expect(mocks.files.releasePdfEmbeddedShapeIndex).toHaveBeenCalledWith('native-shape-session');
        expect(readDocumentBytes).not.toHaveBeenCalled();
    });
});
