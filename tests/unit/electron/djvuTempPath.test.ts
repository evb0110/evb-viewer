import {
    describe,
    expect,
    it,
} from 'vitest';
import { isAllowedDjvuTempPdfPath } from '@electron/djvu/temp-path';

describe('isAllowedDjvuTempPdfPath', () => {
    const tempDir = '/tmp';

    it('allows djvu prefixed pdf inside temp directory', () => {
        expect(isAllowedDjvuTempPdfPath('/tmp/djvu-1234.pdf', tempDir)).toBe(true);
    });

    it('rejects path outside temp directory', () => {
        expect(isAllowedDjvuTempPdfPath('/var/tmp/djvu-1234.pdf', tempDir)).toBe(false);
    });

    it('rejects path traversal outside temp directory', () => {
        expect(isAllowedDjvuTempPdfPath('/tmp/../etc/djvu-1234.pdf', tempDir)).toBe(false);
    });

    it('rejects non-djvu filenames', () => {
        expect(isAllowedDjvuTempPdfPath('/tmp/random.pdf', tempDir)).toBe(false);
    });

    it('rejects non-pdf files', () => {
        expect(isAllowedDjvuTempPdfPath('/tmp/djvu-1234.tmp', tempDir)).toBe(false);
    });
});
