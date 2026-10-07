import {
    describe,
    expect,
    it,
} from 'vitest';
import { parseBrowserSearchWorkerRequest } from '@app/platform/browser-api/browserSearchWorker.types';
import { parseBrowserPdfCombineWorkerRequest } from '@app/platform/browser-api/browserPdfCombineWorker.types';
import { parseBrowserPageOpsWorkerRequest } from '@contracts/browserPageOpsWorker';

describe('browser worker request parsers', () => {
    it('parses and rejects browser search worker requests', () => {
        const request = {
            id: 1,
            type: 'matchPageText',
            payload: {
                text: 'alpha beta',
                query: 'beta',
                options: {
                    matchCase: false,
                    wholeWord: false,
                    useRegex: false,
                },
                maxMatches: 2,
            },
        };
        expect(parseBrowserSearchWorkerRequest(request)).toEqual(request);

        expect(parseBrowserSearchWorkerRequest({
            ...request,
            payload: {
                ...request.payload,
                maxMatches: 0,
            },
        })).toBeNull();
        // The worker opens no documents.
        expect(parseBrowserSearchWorkerRequest({
            id: 3,
            type: 'streamDocumentText',
            payload: {pdfPath: '/tmp/stream.pdf'},
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
                wasmImagePreprocessing: {pageSpecs: [{
                    kind: 'image',
                    pageSize: {
                        widthPoints: 72,
                        heightPoints: 72,
                    },
                    image: {
                        fileName: 'page.ppm',
                        data,
                    },
                }]},
            },
        })).toMatchObject({
            id: 13,
            type: 'combinePdfs',
            payload: {wasmImagePreprocessing: {pageSpecs: [{kind: 'image'}]}},
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
    it('validates save, password, and print inputs with the shared native contracts', () => {
        const data = new Uint8Array([1]);
        const request = {
            id: 90,
            type: 'saveMutations',
            payload: {
                data,
                mutations: {updates: [{
                    objectNumber: 1,
                    generationNumber: 0,
                    text: 'Saved',
                }]},
                modifiedAt: 'D:20260102000000Z',
            },
        };
        expect(parseBrowserPageOpsWorkerRequest(request)).toEqual(request);
        expect(parseBrowserPageOpsWorkerRequest({
            ...request,
            payload: {
                ...request.payload,
                mutations: {updates: [{
                    objectNumber: -1,
                    generationNumber: 0,
                    text: 'Invalid',
                }]},
            },
        })).toBeNull();
        expect(parseBrowserPageOpsWorkerRequest({
            id: 91,
            type: 'decrypt',
            payload: {
                data,
                password: '秘密'.repeat(4096),
            },
        })).toBeNull();
        expect(parseBrowserPageOpsWorkerRequest({
            id: 92,
            type: 'printLayout',
            payload: {
                data,
                pageNumbers: [0],
                viewMode: 'facing',
                orientation: 'landscape',
            },
        })).toBeNull();
    });

});
