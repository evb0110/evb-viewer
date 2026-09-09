import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    BOUNDARY_EXCEPTION_POLICY,
    getBoundaryExceptionEntries,
    getBoundaryExceptionValues,
    validateBoundaryExceptionEntries,
    validateBoundaryExceptionPolicy,
} from '@scripts/architecture/boundaryExceptionPolicy.mjs';

describe('architecture boundary exception policy', () => {
    it('keeps every registered exception owned and unexpired', () => {
        expect(validateBoundaryExceptionPolicy(
            BOUNDARY_EXCEPTION_POLICY,
            new Date('2026-09-08T00:00:00.000Z'),
        )).toEqual([]);
        expect(getBoundaryExceptionValues(BOUNDARY_EXCEPTION_POLICY, 'scriptsToAppEdges')).toEqual([
            'scripts/diagnostics/pdfTraceEntryGuards.ts -> app/utils/logPdfNav.ts',
            'scripts/diagnostics/pdfTraceEntryGuards.ts -> app/utils/pdfRenderTrace.ts',
            'scripts/diagnostics/runPdfSkeletonNavigationDiagnostics.ts -> app/types/workspaceExpose.ts',
            'scripts/diagnostics/runPdfSkeletonNavigationDiagnostics.ts -> app/utils/logPdfNav.ts',
            'scripts/diagnostics/runPdfSkeletonNavigationDiagnostics.ts -> app/utils/pdfRenderTrace.ts',
            'scripts/diagnostics/pdfNavigationBlinkTrace.ts -> app/types/evbTestApi.ts',
        ]);
    });

    it('rejects a missing or empty exception id', () => {
        expect(validateBoundaryExceptionEntries([
            {
                value: 'missing-id',
                ownerTicket: '#323',
                expiresOn: '2026-12-31',
            },
            {
                id: '',
                value: 'empty-id',
                ownerTicket: '#323',
                expiresOn: '2026-12-31',
            },
        ], new Date('2026-09-08T00:00:00.000Z'))).toEqual([
            '<missing id>: id must be a non-empty string',
            '<missing id>: id must be a non-empty string',
        ]);
    });

    it('rejects an exception with no owner ticket', () => {
        expect(validateBoundaryExceptionEntries([{
            id: 'missing-owner',
            value: 'example',
            expiresOn: '2026-12-31',
        }], new Date('2026-09-08T00:00:00.000Z'))).toEqual(['missing-owner: ownerTicket must reference a GitHub issue such as #323']);
    });

    it('rejects an exception with no expiry', () => {
        expect(validateBoundaryExceptionEntries([{
            id: 'missing-expiry',
            value: 'example',
            ownerTicket: '#323',
        }], new Date('2026-09-08T00:00:00.000Z'))).toEqual(['missing-expiry: expiresOn must be an ISO calendar date']);
    });

    it('rejects expired and duplicate entries', () => {
        expect(validateBoundaryExceptionEntries([
            {
                id: 'expired',
                value: 'one',
                ownerTicket: '#323',
                expiresOn: '2026-09-07',
            },
            {
                id: 'expired',
                value: 'two',
                ownerTicket: '#323',
                expiresOn: '2026-12-31',
            },
        ], new Date('2026-09-08T00:00:00.000Z'))).toEqual([
            'expired: exception expired on 2026-09-07',
            'expired: duplicate exception id',
        ]);
    });

    it('rejects an exception on its expiry date', () => {
        expect(validateBoundaryExceptionEntries([{
            id: 'expires-today',
            value: 'example',
            ownerTicket: '#323',
            expiresOn: '2026-09-08',
        }], new Date('2026-09-08T00:00:00.000Z'))).toEqual(['expires-today: exception expired on 2026-09-08']);
    });

    it('rejects a malformed payload and an invalid policy group', () => {
        expect(validateBoundaryExceptionEntries([{
            id: 'missing-payload',
            ownerTicket: '#323',
            expiresOn: '2026-12-31',
        }], new Date('2026-09-08T00:00:00.000Z'))).toEqual(['missing-payload: exception payload must define a value, specifier/names, or source/targetRoots']);
        expect(() => getBoundaryExceptionEntries({broken: 'not-an-array'}, 'broken')).toThrow(
            'Unknown boundary exception group: broken',
        );
        expect(() => getBoundaryExceptionValues({broken: [{id: 'no-value'}]}, 'broken')).toThrow(
            'Boundary exception group broken entry no-value has no string value',
        );
        expect(validateBoundaryExceptionEntries([{
            id: 'malformed-metadata',
            value: '',
            ownerTicket: 'GH-323',
            expiresOn: '2026-13-31',
        }], new Date('2026-09-08T00:00:00.000Z'))).toEqual([
            'malformed-metadata: ownerTicket must reference a GitHub issue such as #323',
            'malformed-metadata: expiresOn must be an ISO calendar date',
            'malformed-metadata: value must be a non-empty string',
            'malformed-metadata: exception payload must define a value, specifier/names, or source/targetRoots',
        ]);
        expect(validateBoundaryExceptionEntries([{
            id: 'malformed-compatibility-payload',
            specifier: '',
            names: [''],
            ownerTicket: '#323',
            expiresOn: '2026-12-31',
        }], new Date('2026-09-08T00:00:00.000Z'))).toEqual([
            'malformed-compatibility-payload: specifier must be a non-empty string',
            'malformed-compatibility-payload: names must be a non-empty string array',
            'malformed-compatibility-payload: exception payload must define a value, specifier/names, or source/targetRoots',
        ]);
        expect(validateBoundaryExceptionEntries([{
            id: 'malformed-back-edge-payload',
            source: '',
            targetRoots: [],
            ownerTicket: '#323',
            expiresOn: 'tomorrow',
        }], new Date('2026-09-08T00:00:00.000Z'))).toEqual([
            'malformed-back-edge-payload: expiresOn must be an ISO calendar date',
            'malformed-back-edge-payload: source must be a non-empty string',
            'malformed-back-edge-payload: targetRoots must be a non-empty string array',
            'malformed-back-edge-payload: exception payload must define a value, specifier/names, or source/targetRoots',
        ]);
        expect(() => validateBoundaryExceptionPolicy({broken: 'not-an-array'}, new Date('2026-09-08T00:00:00.000Z'))).toThrow(
            'Boundary exception group must be an array: broken',
        );
    });
});
