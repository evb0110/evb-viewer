import {
    describe,
    expect,
    it,
} from 'vitest';
import {parseSearchWorkerInboundMessage} from '@electron/features/search/parseSearchWorkerInboundMessage';

const basePayload = {
    documentRevision: 'revision-1',
    pdfPath: '/tmp/document.pdf',
    query: 'needle',
    requestId: 'search-1',
};

describe('search worker inbound validation', () => {
    it.each([
        'matchCase',
        'wholeWord',
        'useRegex',
        'warmup',
    ] as const)(
        'rejects a non-boolean %s field before normalization',
        field => {
            expect(parseSearchWorkerInboundMessage({
                type: 'search',
                payload: {
                    ...basePayload,
                    [field]: 'true',
                },
            })).toBeNull();
        },
    );

    it('accepts valid boolean options and warmup', () => {
        expect(parseSearchWorkerInboundMessage({
            type: 'search',
            payload: {
                ...basePayload,
                matchCase: true,
                wholeWord: false,
                useRegex: true,
                warmup: false,
            },
        })).toEqual({
            type: 'search',
            payload: {
                ...basePayload,
                matchCase: true,
                wholeWord: false,
                useRegex: true,
                warmup: false,
            },
        });
    });
});
