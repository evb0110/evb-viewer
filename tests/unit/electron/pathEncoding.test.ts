import {
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import { normalizeExistingPath } from '@electron/utils/normalizeExistingPath';
import { isSupportedOpenPath } from '@electron/image/pdfConversion';
import { isAllowedOriginalSavePath } from '@electron/file-access/isAllowedOriginalSavePath';

let tempRoot = '';

describe('native path identity', () => {
    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-path-encoding-test-'));
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('does not substitute a decoded sibling for an absent native path', () => {
        const sibling = join(tempRoot, 'missing name.pdf');
        writeFileSync(sibling, new Uint8Array([1]));

        expect(normalizeExistingPath(join(tempRoot, 'missing%20name.pdf'))).toBeNull();
    });

    it('does not substitute a repaired Unicode sibling for an absent native path', () => {
        const fileName = 'Гиргас - Словарь.djvu';
        writeFileSync(join(tempRoot, fileName), new Uint8Array([1]));
        const mojibakePath = join(tempRoot, Buffer.from(fileName, 'utf8').toString('latin1'));

        expect(normalizeExistingPath(mojibakePath)).toBeNull();
    });

    it('preserves exact physical paths with percent characters and trailing spaces', () => {
        const filePath = join(tempRoot, '100% Гиргас .pdf ');
        writeFileSync(filePath, new Uint8Array([1]));

        expect(normalizeExistingPath(filePath)).toBe(realpathSync.native(filePath));
        expect(normalizeExistingPath(encodeURI(filePath))).toBeNull();
    });

    it('classifies a supported file while preserving trailing filename whitespace', () => {
        expect(isSupportedOpenPath('/tmp/report.pdf ')).toBe(true);
        expect(isSupportedOpenPath('/tmp/report.pdf\t')).toBe(true);
        expect(isAllowedOriginalSavePath('/tmp/report.pdf ')).toBe(true);
    });
});
