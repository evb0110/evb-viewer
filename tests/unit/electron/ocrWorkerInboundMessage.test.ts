import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    parseInvalidOcrWorkerStartMessage,
    parseOcrWorkerInboundMessage,
    parseOcrWorkerStartPayload,
} from '@electron/features/ocr/worker/inboundMessage';

const documentRevision = {
    version: 1 as const,
    documentRef: '/tmp/source.pdf',
    authority: 'electron-working-copy' as const,
    token: 'revision-token',
    contentRevision: 1,
    mintedAt: 1,
};

describe('OCR worker inbound message parsing', () => {
    it('parses start payloads with normalized source path and optional render DPI', () => {
        expect(parseOcrWorkerStartPayload({
            sourcePdfPath: ' /tmp/source.pdf ',
            documentRevision,
            pages: [{
                pageNumber: 2,
                languages: ['eng'],
            }],
            renderDpi: 240,
        })).toEqual({
            sourcePdfPath: '/tmp/source.pdf',
            documentRevision,
            pages: [{
                pageNumber: 2,
                languages: ['eng'],
            }],
            renderDpi: 240,
        });
    });

    it('accepts page numbers above the former million-page product cap', () => {
        expect(parseOcrWorkerStartPayload({
            sourcePdfPath: '/tmp/very-large-document.pdf',
            documentRevision,
            pages: [{
                pageNumber: 1_000_001,
                languages: ['eng'],
            }],
        })).toMatchObject({pages: [{pageNumber: 1_000_001}]});
    });

    it('parses searchable PDF options while keeping render DPI compatibility', () => {
        expect(parseOcrWorkerStartPayload({
            sourcePdfPath: '/tmp/source.pdf',
            documentRevision,
            pages: [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            options: {
                renderDpi: 360,
                qualityProfile: 'poor-scan',
                preprocessingMode: 'clean',
                pageSegmentationMode: 6,
                supersessionPolicy: 'replace-all',
                replaceAllAcknowledged: true,
            },
        })).toEqual({
            sourcePdfPath: '/tmp/source.pdf',
            documentRevision,
            pages: [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            renderDpi: 360,
            options: {
                renderDpi: 360,
                qualityProfile: 'poor-scan',
                preprocessingMode: 'clean',
                pageSegmentationMode: 6,
                supersessionPolicy: 'replace-all',
                replaceAllAcknowledged: true,
            },
        });
    });

    it('rejects malformed start payloads', () => {
        expect(parseOcrWorkerStartPayload({
            sourcePdfPath: '',
            pages: [],
        })).toBeNull();
        expect(parseOcrWorkerStartPayload({
            sourcePdfPath: '/tmp/source.pdf',
            pages: [{
                pageNumber: 1,
                languages: [1],
            }],
        })).toBeNull();
        expect(parseOcrWorkerStartPayload({
            sourcePdfPath: '/tmp/source.pdf',
            pages: [{
                pageNumber: 0,
                languages: ['eng'],
            }],
        })).toBeNull();
        expect(parseOcrWorkerStartPayload({
            sourcePdfPath: '/tmp/source.pdf',
            pages: [{
                pageNumber: 1,
                languages: ['not-a-real-language'],
            }],
        })).toBeNull();
        expect(parseOcrWorkerStartPayload({
            sourcePdfPath: '/tmp/source.pdf',
            pages: [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            renderDpi: 10_000,
        })).toBeNull();
        expect(parseOcrWorkerStartPayload({
            sourcePdfPath: '/tmp/source.pdf',
            documentRevision,
            pages: [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            options: {
                supersessionPolicy: 'replace-all',
                replaceAllAcknowledged: false,
            },
        })).toBeNull();
    });

    it('parses worker control messages', () => {
        expect(parseOcrWorkerInboundMessage({
            type: 'cancel',
            jobId: 'job-1',
        })).toEqual({
            type: 'cancel',
            jobId: 'job-1',
        });
        expect(parseOcrWorkerInboundMessage({
            type: 'resource-acquired',
            jobId: 'job-1',
            requestId: 'resource-1',
            token: 'token',
            effectiveDpi: 180,
        })).toEqual({
            type: 'resource-acquired',
            jobId: 'job-1',
            requestId: 'resource-1',
            token: 'token',
            effectiveDpi: 180,
        });
        expect(parseOcrWorkerInboundMessage({
            type: 'resource-acquired',
            jobId: 'job-1',
            requestId: 'resource-low-dpi',
            token: 'token',
            effectiveDpi: 12,
        })).toEqual({
            type: 'resource-acquired',
            jobId: 'job-1',
            requestId: 'resource-low-dpi',
            token: 'token',
            effectiveDpi: 12,
        });
        expect(parseOcrWorkerInboundMessage({
            type: 'resource-denied',
            jobId: 'job-1',
            requestId: 'resource-2',
            reason: 'job is no longer active',
        })).toEqual({
            type: 'resource-denied',
            jobId: 'job-1',
            requestId: 'resource-2',
            reason: 'job is no longer active',
        });
    });

    it('rejects unknown or incomplete worker messages', () => {
        expect(parseOcrWorkerInboundMessage({
            type: 'start',
            jobId: 'job-1',
        })).toBeNull();
        expect(parseOcrWorkerInboundMessage({
            type: 'resource-acquired',
            jobId: 'job-1',
        })).toBeNull();
        expect(parseOcrWorkerInboundMessage({
            type: 'resource-acquired',
            jobId: 'job-1',
            requestId: 'resource-1',
            token: 'token',
            effectiveDpi: 0,
        })).toBeNull();
        expect(parseOcrWorkerInboundMessage({
            type: 'resource-denied',
            jobId: 'job-1',
            requestId: 'resource-1',
            reason: '',
        })).toBeNull();
        expect(parseOcrWorkerInboundMessage({
            type: 'unknown',
            jobId: 'job-1',
        })).toBeNull();
    });

    it('detects invalid start payloads that still have a valid job id', () => {
        expect(parseInvalidOcrWorkerStartMessage({
            type: 'start',
            jobId: 'job-1',
            data: {
                sourcePdfPath: '/tmp/source.pdf',
                pages: [{
                    pageNumber: 1,
                    languages: ['not-a-real-language'],
                }],
            },
        })).toEqual({
            jobId: 'job-1',
            error: 'Invalid OCR worker start payload',
        });

        expect(parseInvalidOcrWorkerStartMessage({
            type: 'start',
            jobId: 'job-1',
            data: {
                sourcePdfPath: '/tmp/source.pdf',
                documentRevision,
                pages: [{
                    pageNumber: 1,
                    languages: ['eng'],
                }],
            },
        })).toBeNull();
    });
});
