import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    GENERATED_NATIVE_TOOL_RESOURCES,
    getGeneratedNativeToolResource,
    NATIVE_RESOURCE_PLATFORM_ARCHES,
    NATIVE_TOOL_RESOURCE_FAMILIES,
} from '@scripts/nativeResourceManifest';

describe('native resource manifest', () => {
    it('enumerates supported resource target tags', () => {
        expect(NATIVE_RESOURCE_PLATFORM_ARCHES).toEqual([
            'darwin-x64',
            'darwin-arm64',
            'linux-x64',
            'linux-arm64',
            'win32-x64',
            'win32-arm64',
        ]);
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
});
