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
import {
    renderFirstUnsupportedAnnotationCharacter,
    unicodeRanges,
} from '@scripts/generateFirstUnsupportedAnnotationCharacter';

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

const bundledFontPath = path.join(process.cwd(), 'public/fonts/annotation/DejaVuSans.ttf');
const checkedInTablePath = path.join(process.cwd(), 'packages/contracts/firstUnsupportedAnnotationCharacter.ts');

function u16(...values: number[]) {
    const buffer = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => buffer.writeUInt16BE(value, index * 2));
    return buffer;
}

function format12(groups: ReadonlyArray<readonly [number, number, number]>) {
    const buffer = Buffer.alloc(16 + groups.length * 12);
    buffer.writeUInt16BE(12, 0);
    buffer.writeUInt32BE(buffer.length, 4);
    buffer.writeUInt32BE(groups.length, 12);
    groups.forEach(([
        start,
        end,
        startGlyph,
    ], index) => {
        buffer.writeUInt32BE(start, 16 + index * 12);
        buffer.writeUInt32BE(end, 20 + index * 12);
        buffer.writeUInt32BE(startGlyph, 24 + index * 12);
    });
    return buffer;
}

// Segments: 0x20-0x22 direct, 0x50-0x51 through a glyph array (0x50 maps to glyph 0), sentinel.
function format4() {
    return Buffer.concat([
        u16(4, 44, 0, 6, 4, 1, 2),
        u16(0x22, 0x51, 0xffff, 0),
        u16(0x20, 0x50, 0xffff),
        u16(0, 0, 1),
        u16(0, 4, 0),
        u16(0, 7),
    ]);
}

function sfnt(subtables: ReadonlyArray<{
    platform: number;
    encoding: number;
    body: Buffer
}>) {
    const cmapHeaderLength = 4 + subtables.length * 8;
    let offset = cmapHeaderLength;
    const records = subtables.map(({
        platform, encoding, body,
    }) => {
        const record = u16(platform, encoding);
        const offsetBuffer = Buffer.alloc(4);
        offsetBuffer.writeUInt32BE(offset, 0);
        offset += body.length;
        return Buffer.concat([
            record,
            offsetBuffer,
        ]);
    });
    const cmap = Buffer.concat([
        u16(0, subtables.length),
        ...records,
        ...subtables.map(({body}) => body),
    ]);
    const header = Buffer.alloc(12);
    header.writeUInt32BE(0x00010000, 0);
    header.writeUInt16BE(1, 4);
    const tableRecord = Buffer.alloc(16);
    tableRecord.write('cmap', 0, 'latin1');
    tableRecord.writeUInt32BE(28, 8);
    tableRecord.writeUInt32BE(cmap.length, 12);
    return Buffer.concat([
        header,
        tableRecord,
        cmap,
    ]);
}

describe('first unsupported annotation character table generation', () => {
    it('reproduces the checked-in table from the bundled DejaVu Sans font', async () => {
        const font = await readFile(bundledFontPath);
        const checkedIn = await readFile(checkedInTablePath, 'utf8');

        expect(renderFirstUnsupportedAnnotationCharacter(font)).toBe(checkedIn);
    });

    it('reads the full-repertoire format 12 subtable over a BMP format 4 subtable and drops glyph 0 mappings', () => {
        const font = sfnt([
            {
                platform: 3,
                encoding: 1,
                body: format4(),
            },
            {
                platform: 3,
                encoding: 10,
                body: format12([
                    [
                        0x41,
                        0x41,
                        1,
                    ],
                    [
                        0x42,
                        0x44,
                        0,
                    ],
                    [
                        0x1f600,
                        0x1f600,
                        5,
                    ],
                ]),
            },
        ]);

        expect(unicodeRanges(font)).toEqual([
            [
                0x41,
                0x41,
            ],
            [
                0x43,
                0x44,
            ],
            [
                0x1f600,
                0x1f600,
            ],
        ]);
    });

    it('ignores variation-sequence records when choosing the codepoint subtable', () => {
        const font = sfnt([
            {
                platform: 3,
                encoding: 1,
                body: format4(),
            },
            {
                platform: 0,
                encoding: 5,
                body: format12([[
                    0x41,
                    0x41,
                    1,
                ]]),
            },
        ]);

        expect(unicodeRanges(font)).toEqual([
            [
                0x20,
                0x22,
            ],
            [
                0x51,
                0x51,
            ],
        ]);
    });

    it('reads a format 4 subtable through idRangeOffset glyph arrays and drops glyph 0 mappings', () => {
        const font = sfnt([{
            platform: 3,
            encoding: 1,
            body: format4(),
        }]);

        expect(unicodeRanges(font)).toEqual([
            [
                0x20,
                0x22,
            ],
            [
                0x51,
                0x51,
            ],
        ]);
    });

    it('refuses a symbol subtable because its codepoint mapping differs from the Unicode table', () => {
        const font = sfnt([{
            platform: 3,
            encoding: 0,
            body: format4(),
        }]);

        expect(() => unicodeRanges(font)).toThrow(/unsupported cmap subtable/);
    });

    it('changes the rendered table and source digest when the font bytes change', () => {
        const original = sfnt([{
            platform: 3,
            encoding: 10,
            body: format12([[
                0x41,
                0x41,
                1,
            ]]),
        }]);
        const changed = sfnt([{
            platform: 3,
            encoding: 10,
            body: format12([[
                0x41,
                0x42,
                1,
            ]]),
        }]);

        const originalTable = renderFirstUnsupportedAnnotationCharacter(original);
        const changedTable = renderFirstUnsupportedAnnotationCharacter(changed);

        expect(changedTable).not.toBe(originalTable);
        expect(changedTable).toContain('        0x41,\n        0x42,');
    });
});
