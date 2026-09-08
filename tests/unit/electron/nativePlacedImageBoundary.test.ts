import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('native placed-image IPC boundary', () => {
    it('carries bounded inline raster bytes or a managed binary handle from renderer to main', async () => {
        const [
            contract,
            preload,
            main,
        ] = await Promise.all([
            readFile(resolve('packages/contracts/electronApiDocuments.ts'), 'utf8'),
            readFile(resolve('electron/features/documents/createDocumentsPreloadFileClient.ts'), 'utf8'),
            readFile(resolve('electron/features/documents/main/nativePdfMutationSaveHandlers.ts'), 'utf8'),
        ]);

        const placedImageContract = contract.match(/export interface IPdfNativePlacedImage[\s\S]*?\n\}/u)?.[0] ?? '';
        expect(placedImageContract).toContain('source?: IManagedTempFileHandle');
        expect(placedImageContract).toContain('bytesBase64?: string');
        expect(placedImageContract).not.toMatch(/\bbytes\b|Uint8Array|number\[\]/u);

        const mutationInvokeBlock = preload.match(/savePdfNativeMutations:[\s\S]*?applyPdfNativeMutationsToWorkingCopy:/u)?.[0] ?? '';
        expect(mutationInvokeBlock).not.toMatch(/Array\.from|JSON\.stringify|Uint8Array|numberArray/u);
        expect(main).not.toContain('placedImageBytes: \'numberArray\'');
        expect(main).not.toMatch(/Array\.from\(image\.bytes\)|JSON\.stringify\([^)]*bytes/u);
    });

    it('classifies native failures only by stable machine code', async () => {
        const [
            runner,
            searchErrors,
            nativeSearch,
        ] = await Promise.all([
            readFile(resolve('electron/native-tools/runNativeCommand.ts'), 'utf8'),
            readFile(resolve('electron/features/search/main/searchErrors.ts'), 'utf8'),
            readFile(resolve('native/pdf-search/src/main.rs'), 'utf8'),
        ]);

        expect(runner).toContain('isNativeErrorEnvelope(value)');
        expect(searchErrors).toContain('hasNativeErrorCode(error)');
        expect(`${runner}\n${searchErrors}`).not.toMatch(/message\.(?:includes|startsWith)|(?:includes|startsWith)\([^)]*message/u);
        expect(nativeSearch).not.toContain('search-failed');
        expect(nativeSearch).not.toContain('struct CliError');
    });
});
