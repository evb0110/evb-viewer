import {
    describe,
    expect,
    it,
} from 'vitest';
import {checkArchitectureBoundaryNode} from '@scripts/architecture/boundary-check.mjs';

describe('retired Electron feature paths', () => {
    it('rejects a recreated legacy shim while allowing feature adapters', () => {
        expect(checkArchitectureBoundaryNode('electron/djvu/convert.ts')).toMatchObject([{
            rule: 'retired-electron-feature-shim-path',
            source: 'electron/djvu/convert.ts',
        }]);
        expect(checkArchitectureBoundaryNode('electron/features/djvu/main/convert.ts')).toEqual([]);
        expect(checkArchitectureBoundaryNode('electron/platform-ipc/featureIpcAdapters.ts')).toEqual([]);
    });

    it('rejects every retired OCR worker path', () => {
        for (const source of [
            'electron/ocr/worker/main.ts',
            'electron/ocr/worker/writeOcrIndexes.ts',
            'electron/ocr/worker/types.ts',
            'electron/ocr/worker/runProductionOcrQualityCase.ts',
            'electron/ocr/worker/indexWriter.ts',
        ]) {
            expect(checkArchitectureBoundaryNode(source), source).toMatchObject([{
                rule: 'retired-electron-feature-shim-path',
                source,
            }]);
        }
    });
});
