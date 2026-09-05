import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDF_DECRYPT_PASSWORD_MAX_BYTES,
    PDF_DECRYPT_OUTCOMES,
    isPdfDecryptOutcome,
    isPdfDecryptPassword,
    isPdfDecryptRequest,
    isPdfDecryptResult,
} from '@contracts/pdfDecryptSchemas';

const DECRYPT_FIXTURE_PATH = 'native/protocol-fixtures/pdf-page-ops-decrypt.json';

describe('pdf decrypt outcome guard', () => {
    it.each(PDF_DECRYPT_OUTCOMES)('accepts the stable %s outcome', (outcome) => {
        expect(isPdfDecryptOutcome(outcome)).toBe(true);
    });

    it('rejects unknown outcomes', () => {
        expect(isPdfDecryptOutcome('encrypted')).toBe(false);
        expect(isPdfDecryptOutcome(1)).toBe(false);
        expect(isPdfDecryptOutcome(null)).toBe(false);
    });

    it('accepts optional and malformed decrypt requests', () => {
        expect(isPdfDecryptRequest(undefined)).toBe(true);
        expect(isPdfDecryptRequest({})).toBe(true);
        expect(isPdfDecryptRequest({password: 'secret'})).toBe(true);
        expect(isPdfDecryptPassword('x'.repeat(PDF_DECRYPT_PASSWORD_MAX_BYTES))).toBe(true);
        expect(isPdfDecryptPassword('x'.repeat(PDF_DECRYPT_PASSWORD_MAX_BYTES + 1))).toBe(false);
        expect(isPdfDecryptRequest({password: 'x'.repeat(PDF_DECRYPT_PASSWORD_MAX_BYTES + 1)})).toBe(false);
        const maxMultibytePassword = `${'🔒'.repeat(1023)}€`;
        expect(new TextEncoder().encode(maxMultibytePassword)).toHaveLength(
            PDF_DECRYPT_PASSWORD_MAX_BYTES,
        );
        expect(isPdfDecryptPassword(maxMultibytePassword)).toBe(true);
        expect(isPdfDecryptRequest({password: 3})).toBe(false);
        expect(isPdfDecryptRequest(null)).toBe(false);
    });

    it('validates well-formed decrypt results', () => {
        expect(isPdfDecryptResult({
            outcome: 'rewritten',
            wasEncrypted: true,
            revision: 6,
        })).toBe(true);
        expect(isPdfDecryptResult({
            outcome: 'opened',
            wasEncrypted: false,
            revision: null,
        })).toBe(true);
    });

    it.each([
        {
            outcome: 'encrypted',
            wasEncrypted: true,
            revision: null,
        },
        {
            outcome: 'rewritten',
            wasEncrypted: 'yes',
            revision: null,
        },
        {
            outcome: 'rewritten',
            wasEncrypted: true,
            revision: -1,
        },
        {
            outcome: 'rewritten',
            wasEncrypted: true,
            revision: 0,
        },
        {
            outcome: 'rewritten',
            wasEncrypted: true,
            revision: '6',
        },
        {
            outcome: 'opened',
            wasEncrypted: true,
            revision: null,
        },
        {
            outcome: 'opened',
            wasEncrypted: false,
            revision: 6,
        },
        {
            outcome: 'needs-password',
            wasEncrypted: false,
            revision: null,
        },
        {
            outcome: 'unsupported-encryption',
            wasEncrypted: true,
            revision: 6,
        },
        {
            outcome: 'rewritten',
            wasEncrypted: true,
        },
        'rewritten',
    ])('rejects malformed decrypt results %#', (value) => {
        expect(isPdfDecryptResult(value)).toBe(false);
    });

    it('keeps the shared protocol fixture aligned with the contract types', async () => {
        const fixturePath = resolve(process.cwd(), DECRYPT_FIXTURE_PATH);
        const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>;

        expect(fixture.format).toBe('evb-pdf-decrypt');
        expect(fixture.schemaVersion).toBe(1);
        expect(Object.keys(fixture).sort()).toEqual([
            'format',
            'outcome',
            'revision',
            'schemaVersion',
            'wasEncrypted',
        ]);
        expect(isPdfDecryptOutcome(fixture.outcome)).toBe(true);
        expect(fixture.outcome).toBe('rewritten');
        expect(isPdfDecryptResult({
            outcome: fixture.outcome,
            wasEncrypted: fixture.wasEncrypted,
            revision: fixture.revision,
        })).toBe(true);
    });
});
