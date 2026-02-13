import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolve } from 'path';
import {
    allowDocxWritePath,
    consumeAllowedDocxWritePath,
    normalizeDocxPath,
} from '@electron/ipc/docxExportPaths';

describe('docxExportPaths', () => {
    it('allows consuming a path that was provided by save dialog', () => {
        const filePath = './tmp-test-export.docx';
        const absolutePath = resolve(filePath);

        allowDocxWritePath(filePath);

        expect(consumeAllowedDocxWritePath(absolutePath)).toBe(true);
        expect(consumeAllowedDocxWritePath(absolutePath)).toBe(false);
    });

    it('rejects paths that were never allowed', () => {
        const filePath = resolve('./tmp-never-allowed.docx');
        expect(consumeAllowedDocxWritePath(filePath)).toBe(false);
    });

    it('validates docx extension', () => {
        expect(() => normalizeDocxPath('report.txt')).toThrow('Invalid file type: only DOCX files are allowed');
    });
});
