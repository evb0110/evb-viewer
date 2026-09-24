import {
    describe,
    expect,
    it,
} from 'vitest';
import { formatNativeSourceMatrixCliEntry } from '@scripts/nativeResourceManifestCli';
import {
    GENERATED_NATIVE_TOOL_RESOURCES,
    getGeneratedNativeToolResource,
    getNativeSourceMatrixCheckEntries,
    NATIVE_RESOURCE_PLATFORM_ARCHES,
    NATIVE_TOOL_RESOURCE_FAMILIES,
    type INativeSourceMatrixCheckEntry,
} from '@scripts/nativeResourceManifest';

function findRequiredEntry(
    entries: readonly INativeSourceMatrixCheckEntry[],
    label: string,
) {
    const entry = entries.find(candidate => (
        candidate.kind === 'required' && candidate.label === label
    ));

    if (!entry) {
        throw new Error(`Missing required native source matrix entry: ${label}`);
    }

    return entry;
}

describe('native resource manifest', () => {
    it('enumerates the release resource matrix tags', () => {
        expect(NATIVE_RESOURCE_PLATFORM_ARCHES).toEqual([
            'darwin-x64',
            'darwin-arm64',
            'linux-x64',
            'linux-arm64',
            'win32-x64',
            'win32-arm64',
        ]);
    });

    it('renders host-style source matrix paths from the manifest', () => {
        const entries = getNativeSourceMatrixCheckEntries('linux-x64');

        expect(findRequiredEntry(entries, 'tesseract')).toEqual({
            kind: 'required',
            label: 'tesseract',
            path: 'resources/tesseract/linux-x64/bin/tesseract',
            type: 'file',
        });
        expect(entries.some(entry => entry.label === 'pdftocairo')).toBe(false);
    });

    it('renders Windows-only source matrix requirements and skips', () => {
        const entries = getNativeSourceMatrixCheckEntries('win32-arm64');

        expect(findRequiredEntry(entries, 'pdftocairo')).toEqual({
            kind: 'required',
            label: 'pdftocairo',
            path: 'resources/poppler/win32-arm64/bin/pdftocairo.exe',
            type: 'file',
        });
        expect(findRequiredEntry(entries, 'poppler data directory')).toEqual({
            kind: 'required',
            label: 'poppler data directory',
            path: 'resources/poppler/win32-arm64/share/poppler',
            type: 'directory',
        });
    });

    it('keeps the macOS-only print dialog helper out of non-macOS source entries', () => {
        expect(getNativeSourceMatrixCheckEntries('darwin-arm64')).toContainEqual({
            kind: 'required',
            label: 'pdf-print-dialog',
            path: '.tmp/pdf-print-dialog/darwin-arm64/bin/pdf-print-dialog',
            type: 'file',
        });

        for (const tag of [
            'linux-x64',
            'win32-arm64',
        ]) {
            expect(getNativeSourceMatrixCheckEntries(tag).some(entry => (
                entry.label === 'pdf-print-dialog'
            ))).toBe(false);
        }
    });

    it('keeps generated native tools attached to package resource families', () => {
        const familyIds = new Set(NATIVE_TOOL_RESOURCE_FAMILIES.map(family => family.id));
        expect(GENERATED_NATIVE_TOOL_RESOURCES.map(tool => tool.familyId)).toEqual([
            'pdf-image-combine',
            'pdf-page-ops',
            'pdf-search',
            'scan-cleanup',
        ]);
        for (const tool of GENERATED_NATIVE_TOOL_RESOURCES) {
            expect(familyIds.has(tool.familyId)).toBe(true);
        }

        expect(NATIVE_TOOL_RESOURCE_FAMILIES
            .filter(family => GENERATED_NATIVE_TOOL_RESOURCES.some(tool => tool.familyId === family.id))
            .map(family => family.sourceRootSegments.join('/'))).toEqual([
            '.tmp/pdf-image-combine',
            '.tmp/pdf-page-ops',
            '.tmp/pdf-search',
            '.tmp/scan-cleanup',
        ]);
    });

    it('resolves generated build tools from the canonical resource rows', () => {
        expect(getGeneratedNativeToolResource('pdf-search')).toMatchObject({
            binaryName: 'evb-pdf-search',
            crateName: 'pdf-search',
            stagingName: 'pdf-search',
        });
        expect(() => getGeneratedNativeToolResource('not-a-tool')).toThrow(
            'Unknown generated native tool: not-a-tool',
        );
    });

    it('formats source matrix entries for the shell checker', () => {
        const entry = findRequiredEntry(getNativeSourceMatrixCheckEntries('linux-x64'), 'qpdf');

        expect(formatNativeSourceMatrixCliEntry(entry)).toBe('file\tresources/qpdf/linux-x64/bin/qpdf\tqpdf');

    });
});
