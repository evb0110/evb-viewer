import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    AVAILABLE_OCR_LANGUAGES,
    BUNDLED_OCR_LANGUAGE_CODES,
    BUNDLED_OCR_LANGUAGE_CODE_SET,
} from '@contracts/ocrLanguages';
import {
    createElectronBuilderResourcePlan,
    renderElectronBuilderResources,
} from '@scripts/generateElectronBuilderResources';
import { generateBuildArtifacts } from '@scripts/generateBuildArtifacts';
import {
    generateReleaseTargetManifest,
    renderReleaseTargetManifest,
} from '@scripts/generateReleaseTargetManifest';
import { NATIVE_TOOL_RESOURCE_FAMILIES } from '@scripts/nativeResourceManifest';

describe('build artifact generation', () => {
    it('honors the explicit once-only preparation boundary', async () => {
        await expect(generateBuildArtifacts({
            env: {EVB_BUILD_ARTIFACTS_PREPARED: '1'},
            projectRoot: path.join(tmpdir(), `evb-prepared-artifacts-${process.pid}`),
        })).resolves.toBe(false);
    });

    it('generates only web artifacts when Vercel omits desktop resources', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-vercel-artifacts-'));
        try {
            await expect(generateBuildArtifacts({
                env: {VERCEL: '1'},
                projectRoot: root,
            })).resolves.toBe(false);
            await expect(readFile(
                path.join(root, '.tmp/generated-electron-builder-resources.yml'),
                'utf8',
            )).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('generates Electron Builder OCR and native resource manifests from their registries', async () => {
        const plan = await createElectronBuilderResourcePlan();
        const rendered = renderElectronBuilderResources();
        const builderConfig = await readFile(path.join(process.cwd(), 'electron-builder.yml'), 'utf8');

        expect(plan).toEqual({
            content: rendered,
            relativePath: '.tmp/generated-electron-builder-resources.yml',
        });
        expect(builderConfig).toContain('extends: ./.tmp/generated-electron-builder-resources.yml');
        for (const code of BUNDLED_OCR_LANGUAGE_CODES) {
            expect(rendered).toContain(`      - ${code}.traineddata`);
        }
        expect(rendered).toContain('      - pdf.ttf');
        for (const {code} of AVAILABLE_OCR_LANGUAGES) {
            if (!BUNDLED_OCR_LANGUAGE_CODE_SET.has(code)) {
                expect(rendered).not.toContain(`      - ${code}.traineddata`);
            }
        }
        for (const family of NATIVE_TOOL_RESOURCE_FAMILIES) {
            expect(family.packagedEntries, family.id).not.toHaveLength(0);
            for (const platform of [
                'darwin',
                'linux',
                'win32',
            ] as const) {
                const sourcePath = `${family.sourceRootSegments.join('/')}/${platform}-\${arch}`;
                const isPackagedForPlatform = family.packagedEntries.some(entry => (
                    !entry.platforms || entry.platforms.includes(platform)
                ));

                expect(rendered.includes(sourcePath), `${family.id} on ${platform}`).toBe(
                    isPackagedForPlatform,
                );
            }
        }
        expect(rendered).toContain('!share/poppler/CMakeLists.txt');
    });

    it('writes the release target manifest byte-stably and repairs generated drift', async () => {
        await expect(readFile(
            path.join(process.cwd(), 'scripts/release/generated-release-targets.cjs'),
            'utf8',
        )).resolves.toBe(renderReleaseTargetManifest());

        const root = await mkdtemp(path.join(tmpdir(), 'evb-release-targets-'));
        try {
            await expect(generateReleaseTargetManifest({projectRoot: root})).resolves.toBe(true);
            await expect(generateReleaseTargetManifest({projectRoot: root})).resolves.toBe(false);

            const outputPath = path.join(root, 'scripts/release/generated-release-targets.cjs');
            await writeFile(outputPath, '{"families":[]}\n', 'utf8');
            await expect(generateReleaseTargetManifest({projectRoot: root})).resolves.toBe(true);
            await expect(readFile(outputPath, 'utf8')).resolves.toBe(renderReleaseTargetManifest());
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });
});
