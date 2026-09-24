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
