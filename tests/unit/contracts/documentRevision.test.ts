import {describe, expect, it} from 'vitest';
import type {TBrand} from '@contracts/brand';
import {requireDocumentRef, type TDocumentRef} from '@contracts/documentRef';
import {
    decodeDocumentRevisionChangedEvent,
    isDocumentRevisionInfo,
    parseDocumentRevisionToken,
    requireDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {requireEpochMs} from '@contracts/timestamps';

describe('documentRevision contracts', () => {
    it('parses and trims valid revision tokens while rejecting blank or oversized values', () => {
        expect(parseDocumentRevisionToken('  rev-1  ')).toBe('rev-1');
        expect(requireDocumentRevisionToken('rev-2')).toBe('rev-2');
        expect(parseDocumentRevisionToken('')).toBeNull();
        expect(parseDocumentRevisionToken('   ')).toBeNull();
        expect(parseDocumentRevisionToken('x'.repeat(513))).toBeNull();
        expect(parseDocumentRevisionToken(42)).toBeNull();
        expect(() => requireDocumentRevisionToken('   ')).toThrow(TypeError);
    });

    it('validates revision info and decodes revision changed events', () => {
        const info = {
            version: 1 as const,
            token: requireDocumentRevisionToken('rev-10'),
            documentRef: requireDocumentRef('/tmp/paper.pdf'),
            authority: 'electron-working-copy' as const,
            contentRevision: 3,
            mintedAt: requireEpochMs(1_700_000_000_000),
        };
        expect(isDocumentRevisionInfo(info)).toBe(true);
        expect(
            decodeDocumentRevisionChangedEvent({
                ...info,
                previousToken: '  rev-9  ',
                reason: 'write',
            }),
        ).toEqual({
            ...info,
            previousToken: 'rev-9',
            reason: 'write',
        });
        expect(
            decodeDocumentRevisionChangedEvent({
                ...info,
                previousToken: '   ',
                reason: 'write',
            }),
        ).toBeNull();
    });

    it('keeps TDocumentRevisionToken nominally isolated via TBrand', () => {
        const acceptToken = (token: TDocumentRevisionToken) => token;
        const token = requireDocumentRevisionToken('rev-1');
        const asBrand: TBrand<string, 'DocumentRevisionToken'> = token;
        const fromBrand: TDocumentRevisionToken = asBrand;
        const ref: TDocumentRef = requireDocumentRef('/tmp/paper.pdf');

        expect(acceptToken(fromBrand)).toBe('rev-1');

        // @ts-expect-error raw strings must not satisfy TDocumentRevisionToken
        const _fromRaw: TDocumentRevisionToken = 'rev-1';
        // @ts-expect-error distinct TBrand strings must not be interchangeable
        const _fromDocumentRef: TDocumentRevisionToken = ref;

        expect([_fromRaw, _fromDocumentRef]).toEqual(['rev-1', '/tmp/paper.pdf']);
    });
});
