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
import { normalizePossiblyEncodedExistingPath } from '@electron/utils/normalizePossiblyEncodedExistingPath';
import { isSupportedOpenPath } from '@electron/image/pdfConversion';
import { isAllowedOriginalSavePath } from '@electron/file-access/isAllowedOriginalSavePath';

let tempRoot = '';

describe('path encoding recovery', () => {
    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-path-encoding-test-'));
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('recovers URI-encoded Unicode file paths', () => {
        const filePath = join(tempRoot, 'Гиргас.djvu');
        writeFileSync(filePath, new Uint8Array([1]));

        expect(normalizePossiblyEncodedExistingPath(encodeURI(filePath))).toBe(realpathSync.native(filePath));
    });

    it('recovers percent-encoded UTF-8 bytes decoded as Latin-1', () => {
        const fileName = 'Гиргас - Словарь.djvu';
        const filePath = join(tempRoot, fileName);
        writeFileSync(filePath, new Uint8Array([1]));
        const mojibakePath = join(tempRoot, Buffer.from(fileName, 'utf8').toString('latin1'));

        expect(normalizePossiblyEncodedExistingPath(encodeURIComponent(mojibakePath))).toBe(realpathSync.native(filePath));
    });

    it('tries the exact physical path before trimming or repairing it', () => {
        const fileName = '100% Гиргас .pdf ';
        const filePath = join(tempRoot, fileName);
        writeFileSync(filePath, new Uint8Array([1]));

        expect(normalizePossiblyEncodedExistingPath(filePath)).toBe(realpathSync.native(filePath));
        expect(normalizePossiblyEncodedExistingPath(encodeURI(filePath))).toBe(realpathSync.native(filePath));
    });

    it('classifies a supported file while preserving trailing filename whitespace', () => {
        expect(isSupportedOpenPath('/tmp/report.pdf ')).toBe(true);
        expect(isSupportedOpenPath('/tmp/report.pdf\t')).toBe(true);
        expect(isAllowedOriginalSavePath('/tmp/report.pdf ')).toBe(true);
    });
});
