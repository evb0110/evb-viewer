import {
    describe,
    expect,
    it,
} from 'vitest';
import { parseBrowserSearchWorkerRequest } from '@app/platform/browser-api/browserSearchWorker.types';
import { parseBrowserPdfCombineWorkerRequest } from '@app/platform/browser-api/browserPdfCombineWorker.types';
import { parseBrowserPageOpsWorkerRequest } from '@app/platform/browser-api/browserPageOpsWorker.types';

describe('browser worker request parsers', () => {
    it('parses and rejects browser search worker requests', () => {
        expect(parseBrowserSearchWorkerRequest({
            id: 1,
            type: 'extractDocumentText',
            payload: {pdfPath: '/tmp/file.pdf'},
        })).toEqual({
            id: 1,
            type: 'extractDocumentText',
            payload: {pdfPath: '/tmp/file.pdf'},
        });

        expect(parseBrowserSearchWorkerRequest({
            id: 2,
            type: 'cancel',
            payload: {requestId: 1},
        })).toEqual({
            id: 2,
            type: 'cancel',
            payload: {requestId: 1},
        });

        expect(parseBrowserSearchWorkerRequest({
            id: 3,
            type: 'streamDocumentText',
            payload: {pdfPath: '/tmp/stream.pdf'},
        })).toEqual({
            id: 3,
            type: 'streamDocumentText',
            payload: {pdfPath: '/tmp/stream.pdf'},
        });

        expect(parseBrowserSearchWorkerRequest({
            id: 4,
            type: 'acknowledgePage',
            payload: {requestId: 3},
        })).toEqual({
            id: 4,
            type: 'acknowledgePage',
            payload: {requestId: 3},
        });

        expect(parseBrowserSearchWorkerRequest({
            id: 5,
            type: 'extractDocumentText',
            payload: {pdfPath: ''},
        })).toBeNull();
    });

    it('parses and rejects browser PDF combine worker requests', () => {
        const data = new Uint8Array([
            1,
            2,
            3,
        ]);
        expect(parseBrowserPdfCombineWorkerRequest({
            id: 4,
            type: 'combinePdfs',
            payload: {
                inputs: [{
                    fileName: 'a.pdf',
                    data,
                }],
                wasmImagePreprocessing: {
                    jpegQuality: 75,
                    ppiCap: 300,
                    pageSpecs: [{
                        kind: 'layered-color',
                        pageSize: {
                            widthPoints: 310.32,
                            heightPoints: 471.84,
                        },
                        background: {
                            fileName: 'background.ppm',
                            data,
                        },
                        mask: {
                            fileName: 'mask.pbm',
                            data,
                        },
                        foregroundColor: [
                            128,
                            16,
                            16,
                        ],
                    }],
                },
            },
        })).toEqual({
            id: 4,
            type: 'combinePdfs',
            payload: {
                inputs: [{
                    fileName: 'a.pdf',
                    data,
                }],
                wasmImagePreprocessing: {
                    jpegQuality: 75,
                    ppiCap: 300,
                    pageSpecs: [{
                        kind: 'layered-color',
                        pageSize: {
                            widthPoints: 310.32,
                            heightPoints: 471.84,
                        },
                        background: {
                            fileName: 'background.ppm',
                            data,
                        },
                        mask: {
                            fileName: 'mask.pbm',
                            data,
                        },
                        foregroundColor: [
                            128,
                            16,
                            16,
                        ],
                    }],
                },
            },
        });

        expect(parseBrowserPdfCombineWorkerRequest({
            id: 5,
            type: 'combinePdfs',
            payload: {inputs: [{
                fileName: 'a.pdf',
                data: [
                    1,
                    2,
                    3,
                ],
            }]},
        })).toBeNull();

        expect(parseBrowserPdfCombineWorkerRequest({
            id: 6,
            type: 'combinePdfs',
            payload: {
                inputs: [{
                    fileName: 'a.pdf',
                    data,
                }],
                wasmImagePreprocessing: {pageSpecs: [{
                    kind: 'layered-color',
                    pageSize: {
                        widthPoints: 72,
                        heightPoints: 72,
                    },
                    background: {
                        fileName: 'background.ppm',
                        data,
                    },
                    mask: {
                        fileName: 'mask.pbm',
                        data,
                    },
                }]},
            },
        })).toBeNull();
    });

    it('parses and rejects browser page operation worker requests', () => {
        const data = new Uint8Array([
            1,
            2,
            3,
        ]);
        expect(parseBrowserPageOpsWorkerRequest({
            id: 6,
            type: 'rotate',
            payload: {
                data,
                pages: [
                    1,
                    2,
                ],
                angle: 90,
            },
        })).toEqual({
            id: 6,
            type: 'rotate',
            payload: {
                data,
                pages: [
                    1,
                    2,
                ],
                angle: 90,
            },
        });

        expect(parseBrowserPageOpsWorkerRequest({
            id: 7,
            type: 'crop',
            payload: {
                data,
                pages: [1],
                margins: {
                    top: 1,
                    bottom: 2,
                    left: 3,
                    right: 4,
                },
            },
        })).toEqual({
            id: 7,
            type: 'crop',
            payload: {
                data,
                pages: [1],
                margins: {
                    top: 1,
                    bottom: 2,
                    left: 3,
                    right: 4,
                },
            },
        });

        expect(parseBrowserPageOpsWorkerRequest({
            id: 8,
            type: 'rotate',
            payload: {
                data,
                pages: [1],
                angle: 45,
            },
        })).toBeNull();

        expect(parseBrowserPdfCombineWorkerRequest({
            id: 13,
            type: 'combinePdfs',
            payload: {
                inputs: [{
                    fileName: 'page.ppm',
                    data,
                }],
                wasmImagePreprocessing: {
                    pageSpecs: [{
                        kind: 'image',
                        pageSize: {
                            widthPoints: 72,
                            heightPoints: 72,
                        },
                        image: {
                            fileName: 'page.ppm',
                            data,
                        },
                    }],
                    catalog: {
                        bookmarks: [{
                            title: 'Chapter 1',
                            pageIndex: 0,
                            namedDest: null,
                            bold: false,
                            italic: false,
                            color: null,
                            items: [],
                        }],
                        pageLabels: [{
                            pageIndex: 0,
                            style: 'D',
                            prefix: 'Page ',
                            start: 1,
                        }],
                    },
                },
            },
        })).toMatchObject({
            id: 13,
            type: 'combinePdfs',
            payload: {wasmImagePreprocessing: {catalog: {
                bookmarks: [{title: 'Chapter 1'}],
                pageLabels: [{
                    pageIndex: 0,
                    prefix: 'Page ',
                }],
            }}},
        });

        expect(parseBrowserPageOpsWorkerRequest({
            id: 9,
            type: 'readCatalog',
            payload: {data},
        })).toEqual({
            id: 9,
            type: 'readCatalog',
            payload: {data},
        });
        expect(parseBrowserPageOpsWorkerRequest({
            id: 10,
            type: 'conformance',
            payload: {data},
        })).toEqual({
            id: 10,
            type: 'conformance',
            payload: {data},
        });
        expect(parseBrowserPageOpsWorkerRequest({
            id: 11,
            type: 'mergePages',
            payload: {documents: [
                data,
                new Uint8Array([
                    4,
                    5,
                ]),
            ]},
        })).toEqual({
            id: 11,
            type: 'mergePages',
            payload: {documents: [
                data,
                new Uint8Array([
                    4,
                    5,
                ]),
            ]},
        });
        expect(parseBrowserPageOpsWorkerRequest({
            id: 12,
            type: 'mergePages',
            payload: {documents: []},
        })).toBeNull();
    });
});
