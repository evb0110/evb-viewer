import {describe, expect, it} from 'vitest';
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
        const familyIds = new Set(NATIVE_TOOL_RESOURCE_FAMILIES.map((family) => family.id));
        expect(GENERATED_NATIVE_TOOL_RESOURCES.map((tool) => tool.familyId)).toEqual([
            'windows-job-launcher',
            'pdf-image-combine',
            'scan-cleanup',
        ]);
        for (const tool of GENERATED_NATIVE_TOOL_RESOURCES) {
            expect(familyIds.has(tool.familyId)).toBe(true);
        }
        const supervisorFamily = NATIVE_TOOL_RESOURCE_FAMILIES.find((family) => family.id === 'windows-job-launcher');
        expect(supervisorFamily?.packagedEntries).toEqual([expect.objectContaining({id: 'evb-windows-job-launcher'})]);
        expect(supervisorFamily?.packagedEntries[0]?.platforms).toBeUndefined();

        expect(
            NATIVE_TOOL_RESOURCE_FAMILIES.filter((family) =>
                GENERATED_NATIVE_TOOL_RESOURCES.some((tool) => tool.familyId === family.id),
            ).map((family) => family.sourceRootSegments.join('/')),
        ).toEqual(['.tmp/windows-job-launcher', '.tmp/pdf-image-combine', '.tmp/scan-cleanup']);
    });

    it('resolves generated build tools from the canonical resource rows', () => {
        expect(getGeneratedNativeToolResource('pdf-image-combine')).toMatchObject({
            binaryName: 'evb-pdf-image-combine',
            crateName: 'pdf-image-combine',
            stagingName: 'pdf-image-combine',
        });
        expect(() => getGeneratedNativeToolResource('not-a-tool')).toThrow('Unknown generated native tool: not-a-tool');
    });
});
