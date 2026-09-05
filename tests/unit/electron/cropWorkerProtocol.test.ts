import {
    describe,
    expect,
    it,
} from 'vitest';
import { decodeCropWorkerInput } from '@electron/features/page-ops/main/cropWorkerProtocol';

describe('decodeCropWorkerInput', () => {
    it('reconstructs every crop worker input variant', () => {
        expect(decodeCropWorkerInput({
            type: 'crop',
            workingCopyPath: '/tmp/work.pdf',
            pages: [
                1,
                3,
            ],
            margins: {
                top: 1,
                bottom: 2,
                left: 3,
                right: 4,
                ignored: true,
            },
            senderWebContentsId: 9,
            ignored: true,
        })).toEqual({
            type: 'crop',
            workingCopyPath: '/tmp/work.pdf',
            pages: [
                1,
                3,
            ],
            margins: {
                top: 1,
                bottom: 2,
                left: 3,
                right: 4,
            },
            senderWebContentsId: 9,
        });
        expect(decodeCropWorkerInput({
            type: 'removeCrop',
            workingCopyPath: '/tmp/work.pdf',
            pages: [2],
        })).toEqual({
            type: 'removeCrop',
            workingCopyPath: '/tmp/work.pdf',
            pages: [2],
        });
    });

    it.each([
        null,
        {},
        {
            type: 'crop',
            workingCopyPath: '',
            pages: [1],
            margins: {
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
            },
        },
        {
            type: 'crop',
            workingCopyPath: '/tmp/work.pdf',
            pages: [0],
            margins: {
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
            },
        },
        {
            type: 'crop',
            workingCopyPath: '/tmp/work.pdf',
            pages: [1.5],
            margins: {
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
            },
        },
        {
            type: 'crop',
            workingCopyPath: '/tmp/work.pdf',
            pages: [1],
            margins: {
                top: -1,
                bottom: 0,
                left: 0,
                right: 0,
            },
        },
        {
            type: 'removeCrop',
            workingCopyPath: '/tmp/work.pdf',
            pages: '1',
        },
        {
            type: 'getPageGeometry',
            workingCopyPath: '/tmp/work.pdf',
            pageNumber: 1,
        },
    ])('rejects malformed worker payloads (%j)', (value) => {
        expect(decodeCropWorkerInput(value)).toBeNull();
    });
});
