import {
    describe,
    expect,
    it,
} from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {PACKAGED_ENTRY_FIELD_SEPARATOR} from '@scripts/generateReleaseTargetManifest';
import {GENERATED_RUST_NATIVE_TOOL_PROTOCOLS} from '@contracts/nativeToolProtocols';
import type {
    ELECTRON_BUILDER_PLATFORM_KEYS,
    GLOBAL_PACKAGED_RESOURCES,
    getPackagedNativeToolFamilies,
} from '@scripts/nativeResourceManifest';

const requireScript = createRequire(import.meta.url);
const {
    renderPackagedEntries,
    validateReleaseTargetManifest,
} = requireScript(
    resolve(process.cwd(), 'scripts/release/generated-release-targets.cjs'),
) as {
    renderPackagedEntries: (tag: string) => string;
    validateReleaseTargetManifest: (value: unknown) => unknown;
};

const {
    assertPackagedToolSmoke,
    getPackagedToolSmokePolicy,
    RELEASE_TARGET_MANIFEST,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/release/native-tool-smoke-policy.mjs')).href
) as {
    assertPackagedToolSmoke: (toolName: string, exitCode: number, output: string) => void;
    getPackagedToolSmokePolicy: (toolName: string) => {
        expectedOutputTokens: readonly string[];
        requiredOutputTokens?: readonly string[];
    };
    RELEASE_TARGET_MANIFEST: {
        families: ReturnType<typeof getPackagedNativeToolFamilies>;
        globalResources: typeof GLOBAL_PACKAGED_RESOURCES;
        platformArches: readonly string[];
        schemaVersion: number;
        electronBuilderPlatformKeys: typeof ELECTRON_BUILDER_PLATFORM_KEYS;
        signing: {
            entitlementsPathSegments: readonly string[];
            executableRoots: ReadonlyArray<readonly string[]>;
            platforms: readonly string[];
        };
    };
};

function manifestWithMutation(path: ReadonlyArray<number | string>, value: unknown) {
    const manifest: unknown = structuredClone(RELEASE_TARGET_MANIFEST);
    let cursor = manifest;
    for (const segment of path.slice(0, -1)) {
        if (typeof cursor !== 'object' || cursor === null) {
            throw new Error(`Cannot mutate manifest path: ${path.join('.')}`);
        }
        cursor = Reflect.get(cursor, String(segment));
    }
    if (typeof cursor !== 'object' || cursor === null) {
        throw new Error(`Cannot mutate manifest path: ${path.join('.')}`);
    }
    Reflect.set(cursor, String(path.at(-1)), value);
    return manifest;
}

describe('native tool smoke policy', () => {
    it('requires the generated v10 capability names in packaged scan-cleanup output', () => {
        const scanCleanup = GENERATED_RUST_NATIVE_TOOL_PROTOCOLS.find(
            protocol => protocol.binaryName === 'evb-scan-cleanup',
        );
        const policy = getPackagedToolSmokePolicy('evb-scan-cleanup-protocol');
        const releaseFamily = RELEASE_TARGET_MANIFEST.families.find(
            family => family.binaryName === scanCleanup?.binaryName,
        );
        const expectedCapabilities: readonly string[] = releaseFamily?.protocolCapabilities ?? [];
        const expectedVersion = releaseFamily?.protocolVersion;

        expect(scanCleanup?.capabilities?.map(capability => capability.name)).toEqual(expectedCapabilities);
        expect(policy.requiredOutputTokens).toEqual([
            `"protocolVersion":${String(expectedVersion)}`,
            '"capabilities"',
            ...expectedCapabilities.map(capability => `"${capability}"`),
        ]);
        const structuredOutput = JSON.stringify({
            protocolVersion: expectedVersion,
            capabilities: expectedCapabilities,
        });
        expect(() => assertPackagedToolSmoke(
            'evb-scan-cleanup-protocol',
            0,
            structuredOutput,
        )).not.toThrow();
        expect(() => assertPackagedToolSmoke(
            'evb-scan-cleanup-protocol',
            0,
            '10\n',
        )).toThrow('required token');
    });

    it.each([
        {
            branch: 'root schema',
            error: 'Invalid root',
            path: ['schemaVersion'],
            value: 2,
        },
        {
            branch: 'platform targets',
            error: 'Invalid platformArches',
            path: ['platformArches'],
            value: ['darwin-sparc'],
        },
        {
            branch: 'Electron Builder platform mapping',
            error: 'Invalid electronBuilderPlatformKeys',
            path: [
                'electronBuilderPlatformKeys',
                'darwin',
            ],
            value: 'win',
        },
        {
            branch: 'family identity',
            error: 'Invalid family',
            path: [
                'families',
                0,
                'id',
            ],
            value: '',
        },
        {
            branch: 'family label',
            error: 'Invalid family',
            path: [
                'families',
                0,
                'label',
            ],
            value: '',
        },
        {
            branch: 'family path',
            error: 'Invalid family',
            path: [
                'families',
                0,
                'sourceRootSegments',
            ],
            value: ['..'],
        },
        {
            branch: 'family protocol',
            error: 'Invalid family protocol',
            path: [
                'families',
                4,
                'protocolVersion',
            ],
            value: 1.5,
        },
        {
            branch: 'family binary name',
            error: 'Invalid family protocol',
            path: [
                'families',
                4,
                'binaryName',
            ],
            value: 42,
        },
        {
            branch: 'package filters',
            error: 'Invalid package filters',
            path: [
                'families',
                1,
                'packageFiltersByPlatform',
                'win32',
            ],
            value: [''],
        },
        {
            branch: 'entry identity',
            error: 'Invalid packaged entry',
            path: [
                'families',
                0,
                'packagedEntries',
                0,
                'id',
            ],
            value: '',
        },
        {
            branch: 'entry label',
            error: 'Invalid packaged entry',
            path: [
                'families',
                0,
                'packagedEntries',
                0,
                'label',
            ],
            value: '',
        },
        {
            branch: 'entry type',
            error: 'Invalid packaged entry',
            path: [
                'families',
                0,
                'packagedEntries',
                0,
                'type',
            ],
            value: 'pipe',
        },
        {
            branch: 'entry path',
            error: 'Invalid packaged entry',
            path: [
                'families',
                0,
                'packagedEntries',
                0,
                'pathSegments',
            ],
            value: ['../binary'],
        },
        {
            branch: 'entry platforms',
            error: 'Invalid packaged entry platforms',
            path: [
                'families',
                0,
                'packagedEntries',
                1,
                'platforms',
            ],
            value: ['android'],
        },
        {
            branch: 'entry skip reasons',
            error: 'Invalid packaged entry skip',
            path: [
                'families',
                0,
                'packagedEntries',
                1,
                'skip',
            ],
            value: {android: 'not packaged'},
        },
        {
            branch: 'global identity',
            error: 'Invalid global resource',
            path: [
                'globalResources',
                0,
                'id',
            ],
            value: '',
        },
        {
            branch: 'global label',
            error: 'Invalid global resource',
            path: [
                'globalResources',
                0,
                'label',
            ],
            value: '',
        },
        {
            branch: 'global type',
            error: 'Invalid global resource',
            path: [
                'globalResources',
                0,
                'type',
            ],
            value: 'pipe',
        },
        {
            branch: 'global path',
            error: 'Invalid global resource',
            path: [
                'globalResources',
                0,
                'stagedSegments',
            ],
            value: ['../tessdata'],
        },
        {
            branch: 'global filters',
            error: 'Invalid global resource',
            path: [
                'globalResources',
                0,
                'filters',
            ],
            value: [''],
        },
        {
            branch: 'signing platforms',
            error: 'Invalid signing inputs',
            path: [
                'signing',
                'platforms',
            ],
            value: ['android'],
        },
        {
            branch: 'signing entitlement path',
            error: 'Invalid signing inputs',
            path: [
                'signing',
                'entitlementsPathSegments',
            ],
            value: ['..'],
        },
        {
            branch: 'signing executable roots',
            error: 'Invalid signing inputs',
            path: [
                'signing',
                'executableRoots',
            ],
            value: [['other-root']],
        },
    ])('rejects invalid $branch at the disk trust boundary', ({
        error,
        path,
        value,
    }) => {
        expect(() => validateReleaseTargetManifest(
            manifestWithMutation(path, value),
        )).toThrow(error);
    });

    it('renders every manifest entry for each supported verifier target', () => {
        for (const tag of RELEASE_TARGET_MANIFEST.platformArches) {
            const platform = tag.split('-')[0] as 'darwin' | 'linux' | 'win32';
            const suffix = platform === 'win32' ? '.exe' : '';
            const expectedRows = RELEASE_TARGET_MANIFEST.families.flatMap(family => (
                family.packagedEntries
                    .filter(entry => !entry.skip?.[platform]
                        && (!entry.platforms || entry.platforms.includes(platform)))
                    .map(entry => [
                        'native',
                        family.stagedRootSegments.join('/'),
                        entry.pathSegments.join('/').replaceAll('{exeSuffix}', suffix),
                        entry.type,
                        entry.label,
                        entry.id,
                    ].join(PACKAGED_ENTRY_FIELD_SEPARATOR))
            ));
            expectedRows.push(...RELEASE_TARGET_MANIFEST.globalResources.map(resource => [
                'global',
                '',
                resource.stagedSegments.join('/'),
                resource.type,
                resource.label,
                resource.id,
            ].join(PACKAGED_ENTRY_FIELD_SEPARATOR)));

            expect(renderPackagedEntries(tag).split('\n')).toEqual(expectedRows);
        }
        expect(() => renderPackagedEntries('darwin-sparc')).toThrow(
            'Unsupported platform-arch: darwin-sparc',
        );
    });

    it('requires both an allowed exit code and recognizable output', () => {
        expect(() => assertPackagedToolSmoke('qpdf', 0, 'qpdf version 12.0.0')).not.toThrow();
        expect(() => assertPackagedToolSmoke('pdfinfo', 0, 'pdfinfo version 25.0.0')).not.toThrow();
        expect(() => assertPackagedToolSmoke('pdftoppm', 0, 'pdftoppm version 25.0.0')).not.toThrow();
        expect(() => assertPackagedToolSmoke('pdftotext', 0, 'pdftotext version 25.0.0')).not.toThrow();
        expect(() => assertPackagedToolSmoke('tesseract', 0, 'tesseract 5.5.0')).not.toThrow();
        expect(() => assertPackagedToolSmoke('evb-pdf-image-combine-protocol', 0, '4')).not.toThrow();
        expect(() => assertPackagedToolSmoke('evb-pdf-page-ops', 0, 'evb-pdf-page-ops 0.1.0')).not.toThrow();
        expect(() => assertPackagedToolSmoke('evb-pdf-search', 0, 'evb-pdf-search 0.1.0')).not.toThrow();
        expect(() => assertPackagedToolSmoke('evb-scan-cleanup', 0, 'evb-scan-cleanup 0.1.0')).not.toThrow();
        expect(() => assertPackagedToolSmoke(
            'evb-scan-cleanup-protocol',
            0,
            '{"protocolVersion":10,"capabilities":["manifest-v3","structured-warning-events"]}',
        )).not.toThrow();
        expect(() => assertPackagedToolSmoke('evb-pdf-image-combine-compact-manifest', 1, 'Missing --compact-manifest value')).not.toThrow();
        expect(() => assertPackagedToolSmoke('ddjvu', 1, 'ddjvu usage')).not.toThrow();
        expect(() => assertPackagedToolSmoke('djvudump', 1, 'djvudump usage')).not.toThrow();
        expect(() => assertPackagedToolSmoke('unpaper', 0, 'Usage: unpaper [options]')).not.toThrow();
        expect(() => assertPackagedToolSmoke('qpdf', 2, 'qpdf version 12.0.0')).toThrow(
            'Packaged tool smoke test failed (qpdf) with exit code 2',
        );
        expect(() => assertPackagedToolSmoke('qpdf', 0, 'unexpected output')).toThrow(
            'Packaged tool smoke test output for qpdf did not match any expected signature',
        );
        expect(() => assertPackagedToolSmoke('evb-pdf-image-combine-compact-manifest', 1, 'Unknown argument: --compact-manifest')).toThrow(
            'Packaged tool smoke test output for evb-pdf-image-combine-compact-manifest did not match any expected signature',
        );
    });

});
