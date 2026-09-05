import { resolve } from 'node:path';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import type { IRealWorkerProtocolHarness } from '@tests/unit/electron/helpers/createRealWorkerProtocolHarness';
import { createRealWorkerProtocolHarness } from '@tests/unit/electron/helpers/createRealWorkerProtocolHarness';

const malformedFrames: unknown[] = [
    null,
    undefined,
    [],
    'message',
    1,
    Number.NaN,
    {type: 'unknown'},
];

function protocolModulePath(relativePath: string) {
    return resolve(process.cwd(), relativePath);
}

describe('real search worker protocol', () => {
    let harness: IRealWorkerProtocolHarness;

    beforeAll(async () => {
        harness = await createRealWorkerProtocolHarness({
            decoders: ['parseSearchWorkerInboundMessage'],
            modulePath: protocolModulePath('electron/search/parseSearchWorkerInboundMessage.ts'),
        });
    });

    afterAll(async () => {
        await harness.close();
    });

    it('decodes cancellation, shutdown, and a complete search request across a real worker boundary', async () => {
        await expect(harness.decode('parseSearchWorkerInboundMessage', {
            type: 'cancel',
            requestId: 'search-1',
        })).resolves.toEqual({
            type: 'cancel',
            requestId: 'search-1',
        });
        await expect(harness.decode('parseSearchWorkerInboundMessage', {
            type: 'shutdown',
            reason: 'app shutdown',
        })).resolves.toEqual({
            type: 'shutdown',
            reason: 'app shutdown',
        });
        await expect(harness.decode('parseSearchWorkerInboundMessage', {
            type: 'search',
            payload: {
                documentRevision: 'revision-1',
                matchCase: true,
                pageCount: 3,
                pdfPath: '/tmp/document.pdf',
                query: 'needle',
                requestId: 'search-2',
                unexpected: true,
            },
        })).resolves.toEqual({
            type: 'search',
            payload: {
                documentRevision: 'revision-1',
                matchCase: true,
                pageCount: 3,
                pdfPath: '/tmp/document.pdf',
                query: 'needle',
                requestId: 'search-2',
            },
        });
    });

    it.each([
        ...malformedFrames,
        {
            type: 'cancel',
            requestId: '',
        },
        {
            type: 'shutdown',
            reason: '',
        },
        {
            type: 'search',
            payload: null,
        },
        {
            type: 'search',
            payload: {
                documentRevision: 'revision-1',
                pageCount: 0,
                pdfPath: '/tmp/document.pdf',
                query: 'needle',
                requestId: 'search-3',
            },
        },
        {
            type: 'search',
            payload: {
                documentRevision: 'revision-1',
                matchCase: 'yes',
                pdfPath: '/tmp/document.pdf',
                query: 'needle',
                requestId: 'search-4',
            },
        },
    ])('rejects malformed frames without killing the worker (%j)', async (frame) => {
        await expect(harness.decode('parseSearchWorkerInboundMessage', frame)).resolves.toBeNull();
    });

    it('receives transferred malformed binary frames without copying them', async () => {
        const buffer = new ArrayBuffer(32);

        const decoded = harness.decode('parseSearchWorkerInboundMessage', buffer, [buffer]);

        expect(buffer.byteLength).toBe(0);
        await expect(decoded).resolves.toBeNull();
    });
});

describe('real OCR worker protocol', () => {
    let harness: IRealWorkerProtocolHarness;

    beforeAll(async () => {
        harness = await createRealWorkerProtocolHarness({
            decoders: ['parseOcrWorkerInboundMessage'],
            modulePath: protocolModulePath('electron/ocr/worker/inboundMessage.ts'),
        });
    });

    afterAll(async () => {
        await harness.close();
    });

    it('decodes cancellation across a real worker boundary', async () => {
        await expect(harness.decode('parseOcrWorkerInboundMessage', {
            type: 'cancel',
            jobId: 'ocr-job-1',
        })).resolves.toEqual({
            type: 'cancel',
            jobId: 'ocr-job-1',
        });
    });

    it.each([
        ...malformedFrames,
        {
            type: 'cancel',
            jobId: '',
        },
        {
            type: 'start',
            jobId: 'ocr-job-2',
            data: null,
        },
        {
            type: 'resource-acquired',
            jobId: 'ocr-job-3',
            requestId: 'resource-1',
            token: 'lease-1',
            effectiveDpi: Number.POSITIVE_INFINITY,
        },
        {
            type: 'resource-denied',
            jobId: 'ocr-job-4',
            requestId: 'resource-2',
            reason: '',
        },
    ])('rejects malformed frames without killing the worker (%j)', async (frame) => {
        await expect(harness.decode('parseOcrWorkerInboundMessage', frame)).resolves.toBeNull();
    });
});

describe('real crop worker protocol', () => {
    let harness: IRealWorkerProtocolHarness;

    beforeAll(async () => {
        harness = await createRealWorkerProtocolHarness({
            decoders: [
                'decodeCropWorkerControlMessage',
                'decodeCropWorkerInput',
            ],
            modulePath: protocolModulePath('electron/features/page-ops/main/cropWorkerProtocol.ts'),
        });
    });

    afterAll(async () => {
        await harness.close();
    });

    it('decodes cancellation and strips untrusted crop fields across a real worker boundary', async () => {
        await expect(harness.decode('decodeCropWorkerControlMessage', {
            type: 'cancel',
            unexpected: true,
        })).resolves.toEqual({type: 'cancel'});
        await expect(harness.decode('decodeCropWorkerInput', {
            type: 'crop',
            workingCopyPath: '/tmp/document.pdf',
            pages: [1],
            margins: {
                top: 1,
                bottom: 2,
                left: 3,
                right: 4,
                unexpected: true,
            },
        })).resolves.toEqual({
            type: 'crop',
            workingCopyPath: '/tmp/document.pdf',
            pages: [1],
            margins: {
                top: 1,
                bottom: 2,
                left: 3,
                right: 4,
            },
        });
    });

    it.each([
        ...malformedFrames,
        {
            type: 'crop',
            workingCopyPath: '/tmp/document.pdf',
            pages: [0],
            margins: {},
        },
        {
            type: 'removeCrop',
            workingCopyPath: '/tmp/document.pdf',
            pages: [Number.NaN],
        },
    ])('rejects malformed frames without killing the worker (%j)', async (frame) => {
        await expect(harness.decode('decodeCropWorkerInput', frame)).resolves.toBeNull();
    });
});
