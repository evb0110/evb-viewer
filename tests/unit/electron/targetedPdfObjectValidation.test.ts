import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {validateTargetedPdfObjects} from '@electron/features/documents/main/validateTargetedPdfObjects';

describe('targeted PDF object validation', () => {
    it('accepts a changed xref object returned by qpdf', async () => {
        const run = vi.fn(async () => {
            return {
                stdout: '<< /Type /Annot >>',
                stderr: '',
                exitCode: 0,
            };
        });

        await expect(validateTargetedPdfObjects(
            '/tmp/staged.pdf',
            '/usr/bin/qpdf',
            ['1 0 R'],
            run,
        )).resolves.toBeUndefined();
    });

    it('rejects a missing changed object', async () => {
        const run = vi.fn(async () => ({
            stdout: 'null\n',
            stderr: '',
            exitCode: 0,
        }));

        await expect(validateTargetedPdfObjects(
            '/tmp/staged.pdf',
            '/usr/bin/qpdf',
            ['12 0 R'],
            run,
        )).rejects.toThrow('12 0 R is missing');
    });
});
