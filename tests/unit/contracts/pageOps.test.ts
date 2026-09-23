import {
    describe,
    expect,
    it,
} from 'vitest';
import { PAGE_OPS_PLATFORM_FEATURE } from '@contracts/pageOpsPlatformFeature';

describe('page ops platform feature schemas', () => {
    const channels = PAGE_OPS_PLATFORM_FEATURE.invokeChannels;
    const codecs = PAGE_OPS_PLATFORM_FEATURE.ipcCodecs;

    it('preserves every async channel without an event layer', () => {
        expect(channels).toEqual({
            delete: 'page-ops:delete',
            deleteRanges: 'page-ops:delete-ranges',
            extract: 'page-ops:extract',
            reorder: 'page-ops:reorder',
            move: 'page-ops:move',
            moveRanges: 'page-ops:move-ranges',
            insert: 'page-ops:insert',
            insertFile: 'page-ops:insert-file',
            rotate: 'page-ops:rotate',
            crop: 'page-ops:crop',
            removeCrop: 'page-ops:remove-crop',
            cancelActive: 'page-ops:cancel-active',
            getPageGeometry: 'page-ops:get-page-geometry',
        });
        expect(PAGE_OPS_PLATFORM_FEATURE.eventChannels).toEqual({});
        expect(PAGE_OPS_PLATFORM_FEATURE.platformDescriptors.methods).toHaveLength(13);
    });

    it('round-trips the compact native move tuple', () => {
        const input = [
            '/tmp/work.pdf',
            2,
            4,
            0,
            12,
            undefined,
        ] as const;
        const codec = codecs[channels.move]!;

        expect(codec.decodeArgs(codec.encodeArgs([...input]))).toEqual([...input]);
    });

    it('round-trips compact native delete ranges', () => {
        const input = [
            '/tmp/work.pdf',
            [{
                startPage: 2,
                endPage: 4,
            }],
            12,
            undefined,
        ] as const;
        const codec = codecs[channels.deleteRanges]!;

        expect(codec.decodeArgs(codec.encodeArgs([...input]))).toEqual([...input]);
    });

    it.each([
        'delete',
        'extract',
    ] as const)('decodes 100,001 valid pages for %s transport', (method) => {
        const pages = Array.from({length: 100_001}, (_, index) => index + 1);
        const channel = channels[method];
        const codec = codecs[channel]!;
        const input = method === 'delete'
            ? [
                '/tmp/work.pdf',
                pages,
                100_002,
                undefined,
            ]
            : [
                '/tmp/work.pdf',
                pages,
            ];

        expect(codec.decodeArgs(codec.encodeArgs(input))[1]).toEqual(pages);
    });

    it('round-trips compact non-contiguous move ranges', () => {
        const input = [
            '/tmp/work.pdf',
            [
                {
                    startPage: 2,
                    endPage: 2,
                },
                {
                    startPage: 4,
                    endPage: 5,
                },
            ],
            0,
            12,
            undefined,
        ] as const;
        const codec = codecs[channels.moveRanges]!;

        expect(codec.decodeArgs(codec.encodeArgs([...input]))).toEqual([...input]);
    });

    it('round-trips mutation tuples and normalizes revision options', () => {
        const input = [
            '/tmp/work.pdf',
            [1],
            3,
            90,
            {
                expectedDocumentRevisionToken: ' drt1:test ',
                metadataSnapshot: {
                    pageLabels: ['i'],
                    pageLabelRanges: [{
                        startPage: 1,
                        style: 'r',
                        prefix: '',
                        startNumber: 1,
                    }],
                    bookmarks: [],
                    untitledBookmarkLabel: 'Untitled',
                },
            },
        ];
        const codec = codecs[channels.rotate]!;

        const decoded = codec.decodeArgs(codec.encodeArgs(input));
        expect(decoded.slice(0, 4)).toEqual([
            '/tmp/work.pdf',
            [1],
            3,
            90,
        ]);
        expect(decoded[4]).toMatchObject({
            expectedDocumentRevisionToken: 'drt1:test',
            metadataSnapshot: {
                pageLabels: ['i'],
                pageLabelRanges: [{
                    startPage: 1,
                    style: 'r',
                    prefix: '',
                    startNumber: 1,
                }],
            },
        });
    });

    it('rejects unordered compact page-label ranges at the IPC boundary', () => {
        const codec = codecs[channels.rotate]!;
        expect(() => codec.decodeArgs(codec.encodeArgs([
            '/tmp/work.pdf',
            [1],
            3,
            90,
            {metadataSnapshot: {
                pageLabelRanges: [
                    {
                        startPage: 2,
                        style: 'D',
                        prefix: '',
                        startNumber: 1,
                    },
                    {
                        startPage: 2,
                        style: 'D',
                        prefix: '',
                        startNumber: 2,
                    },
                ],
                untitledBookmarkLabel: 'Untitled',
            }},
        ]))).toThrow('pageLabelRanges');
    });

    it('accepts a 10,001-item outline for structural page operations', () => {
        const bookmarks = Array.from({length: 10_001}, (_, index) => ({
            title: `Page ${index + 1}`,
            pageIndex: index,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        }));
        const codec = codecs[channels.reorder]!;

        const decoded = codec.decodeArgs(codec.encodeArgs([
            '/tmp/work.pdf',
            [
                2,
                1,
            ],
            {metadataSnapshot: {
                pageLabels: null,
                bookmarks,
                untitledBookmarkLabel: 'Untitled',
            }},
        ]));

        expect(decoded[2]?.metadataSnapshot?.bookmarks).toHaveLength(10_001);
    });

    it('preserves pageIdentityDelta through mutation and insert result decoders', () => {
        const reorderResult = codecs[channels.reorder]!.decodeResult({
            success: true,
            pageCount: 2,
            pageIdentityDelta: {
                previousPageCount: 2,
                pages: [
                    {fromPageNumber: 2},
                    {fromPageNumber: 1},
                ],
            },
        });
        expect(reorderResult).toEqual({
            success: true,
            pageCount: 2,
            pageIdentityDelta: {
                previousPageCount: 2,
                pages: [
                    {fromPageNumber: 2},
                    {fromPageNumber: 1},
                ],
            },
        });

        const insertResult = codecs[channels.insert]!.decodeResult({
            success: true,
            pageIdentityDelta: {
                previousPageCount: 1,
                pages: [
                    {fromPageNumber: 1},
                    {insertedId: 'inserted:1'},
                ],
            },
        });
        expect(insertResult).toEqual({
            success: true,
            pageIdentityDelta: {
                previousPageCount: 1,
                pages: [
                    {fromPageNumber: 1},
                    {insertedId: 'inserted:1'},
                ],
            },
        });

        expect(() => codecs[channels.delete]!.decodeResult({
            success: true,
            pageIdentityDelta: {
                previousPageCount: 1,
                pages: [{}],
            },
        })).toThrow('pageIdentityDelta.pages entries must carry fromPageNumber or insertedId');

        const moveResult = codecs[channels.move]!.decodeResult({
            success: true,
            pageCount: 1_000_000,
            pageIdentityDelta: {
                previousPageCount: 1_000_000,
                nextPageCount: 1_000_000,
                ranges: [
                    {
                        kind: 'retain',
                        fromPageNumber: 1,
                        toPageNumber: 1,
                        count: 1,
                    },
                    {
                        kind: 'move',
                        fromPageNumber: 2,
                        toPageNumber: 1,
                        count: 1,
                    },
                ],
            },
        });
        expect(moveResult.pageIdentityDelta?.pages).toBeUndefined();
        expect(moveResult.pageIdentityDelta?.nextPageCount).toBe(1_000_000);
    });

    it('carries a user cancel through page operation and cancel results', () => {
        expect(codecs[channels.rotate]!.decodeResult({
            success: false,
            canceled: true,
        })).toEqual({
            success: false,
            canceled: true,
        });
        expect(codecs[channels.cancelActive]!.decodeResult({
            canceled: 1,
            committing: 0,
        })).toEqual({
            canceled: 1,
            committing: 0,
        });
        expect(() => codecs[channels.cancelActive]!.decodeResult({canceled: 1}))
            .toThrow();
    });

    it('keeps malformed tuple and result messages stable', () => {
        expect(() => codecs[channels.rotate]!.decodeArgs([
            '/tmp/work.pdf',
            [1],
            3,
            45,
            undefined,
        ])).toThrow('angle must be 90, 180, or 270');
        expect(() => codecs[channels.delete]!.decodeArgs([
            '/tmp/work.pdf',
            [1],
            3,
        ])).toThrow('expected 4 arguments, received 3');
        expect(() => codecs[channels.rotate]!.decodeResult({success: 'yes'}))
            .toThrow('page operation result must include success');
        expect(() => codecs[channels.getPageGeometry]!.decodeResult({
            mediaBox: {
                x: 0,
                y: 0,
                width: Number.NaN,
                height: 100,
            },
            cropBox: null,
            rotation: 0,
        })).toThrow('page geometry box must contain finite coordinates');
    });
});
