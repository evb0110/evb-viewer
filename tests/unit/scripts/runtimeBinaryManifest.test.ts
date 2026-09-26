import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    computeRuntimeBinaryManifestSha256,
    validateRuntimeBinaryManifest,
} from '@scripts/runtimeBinaryArchive';
import {
    RUNTIME_BINARY_MANIFEST,
    RUNTIME_BINARY_MANIFEST_ENTRIES,
    TESSDATA_RUNTIME_DATA_ENTRY,
} from '@scripts/runtimeBinaryManifest';
import {assertAllowedRuntimeBinaryDownloadRedirect} from '@scripts/fetchRuntimeBinaries';
import {validateRuntimeBinaryArchivePaths} from '@scripts/validateRuntimeBinaryArchivePaths';

const firstRuntimeEntry = RUNTIME_BINARY_MANIFEST.entries[0];
if (!firstRuntimeEntry) throw new Error('Runtime manifest test requires one binary entry.');

describe('runtime binary manifest', () => {
    it('covers every tracked runtime family on every currently packed target', () => {
        expect(validateRuntimeBinaryManifest(RUNTIME_BINARY_MANIFEST)).toBe(RUNTIME_BINARY_MANIFEST);
        expect(RUNTIME_BINARY_MANIFEST_ENTRIES).toHaveLength(12);
        expect(new Set(RUNTIME_BINARY_MANIFEST_ENTRIES.map(entry => entry.familyId))).toEqual(
            new Set([
                'tesseract',
                'poppler',
                'qpdf',
                'djvulibre',
            ]),
        );
        expect(new Set(RUNTIME_BINARY_MANIFEST_ENTRIES.map(entry => entry.target.platformArch))).toEqual(
            new Set([
                'darwin-arm64',
                'linux-x64',
                'win32-x64',
            ]),
        );
        expect(RUNTIME_BINARY_MANIFEST.dataEntries).toEqual([TESSDATA_RUNTIME_DATA_ENTRY]);
        expect(computeRuntimeBinaryManifestSha256(
            RUNTIME_BINARY_MANIFEST.entries,
            RUNTIME_BINARY_MANIFEST.dataEntries,
        )).toBe(RUNTIME_BINARY_MANIFEST.manifestSha256);
    });

    it('binds every archive to the repository release asset and its staged executable', () => {
        for (const entry of RUNTIME_BINARY_MANIFEST.entries) {
            expect(entry.archiveUrl).toMatch(
                new RegExp(`/${entry.familyId}-${entry.target.platformArch}(?:-\\d+(?:\\.\\d+)*)?\\.tar\\.gz$`, 'u'),
            );
            expect(entry.executableEntry).toBe(
                `${entry.familyId}/${entry.target.platformArch}/bin/${entry.executableEntry.split('/').at(-1)}`,
            );
        }
        expect(TESSDATA_RUNTIME_DATA_ENTRY.archiveUrl).toMatch(/\/tesseract-tessdata\.tar\.gz$/u);
    });

    it('rejects a changed archive URL under the fixed manifest identity', () => {
        expect(() => validateRuntimeBinaryManifest({
            ...RUNTIME_BINARY_MANIFEST,
            entries: [{
                ...firstRuntimeEntry,
                archiveUrl: 'https://example.test/replaced-runtime.tar.gz',
            }],
        })).toThrow('does not match');
    });

    it('rejects unsafe archive paths before extraction', () => {
        expect(validateRuntimeBinaryArchivePaths([
            'qpdf/linux-x64/bin/qpdf',
            'qpdf/linux-x64/lib/libqpdf.so',
        ])).toHaveLength(2);
        expect(() => validateRuntimeBinaryArchivePaths(['qpdf/linux-x64/../../escape'])).toThrow(
            'safe relative path',
        );
    });

    it('keeps redirects constrained to GitHub release assets', () => {
        expect(assertAllowedRuntimeBinaryDownloadRedirect(
            firstRuntimeEntry.archiveUrl,
            'https://release-assets.githubusercontent.com/github-production-release-asset/archive',
        )).toContain('release-assets.githubusercontent.com');
        expect(() => assertAllowedRuntimeBinaryDownloadRedirect(
            firstRuntimeEntry.archiveUrl,
            'https://objects.example.test/runtime.tar.gz',
        )).toThrow('untrusted origin');
    });
});
