import {createHash} from 'node:crypto';
import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IScanCleanupOptions} from '@contracts/electronApiScanCleanup';
import {createScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import type {TScanCleanupStampBuildIds} from '@evb/scan-cleanup/core/index';
import {
    SCAN_CLEANUP_CORE_BUILD_ID,
    SCAN_CLEANUP_STAMP_SCHEMA_ID,
    SCAN_CLEANUP_STAMP_SCHEMA_ID_V1,
    SCAN_CLEANUP_STAMP_SCHEMA_VERSION,
    SCAN_CLEANUP_STAMP_SCHEMA_VERSION_V1,
    ScanCleanupPageScopeError,
    assertScanCleanupProvenanceStamp,
    buildScanCleanupPagePlanDigest,
    buildScanCleanupProvenanceStamp,
    buildScanCleanupStampBuildIds,
    canonicalScanCleanupJson,
    decodeScanCleanupProvenanceStampHex,
    encodeScanCleanupProvenanceStampHex,
    materializeScanCleanupStampOptions,
    readScanCleanupStampGitSha,
    sha256ScanCleanupFile,
    resolveEffectiveScanCleanupOptions,
    resolveScanCleanupPageScope,
    verifyScanCleanupProvenanceStampHex,
} from '@evb/scan-cleanup/core/index';

const FROZEN_V1_STAMP_HEX = '7b226275696c64496473223a7b22617373656d626c65724261636b656e64223a22736f757263652d707265736572766564222c22636f72654275696c644964223a226576622d7669657765722d7363616e2d636c65616e75702d636f72652d7631222c22636f7265536368656d614964223a2275726e3a6576623a7363616e2d636c65616e75703a7374616d703a7631222c226e617469766542696e61727953686132353673223a7b227363616e436c65616e7570223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262227d2c227472616e73706f72744d6f6465223a22736f757263652d707265736572766564227d2c226566666563746976654f7074696f6e73223a7b22706572536f7572636550616765223a5b7b226f7074696f6e73223a7b226175746f6d61746963436f6e74656e74426f786573223a7b7d2c226175746f6d61746963536b657744656772656573223a7b7d2c226175746f6d6174696353706c6974223a6e756c6c2c2262696e6172697a6174696f6e223a226175746f222c2263726f70436f6e74656e74223a747275652c226465737065636b6c65223a747275652c226465737065636b6c654c6576656c223a226e6f726d616c222c22647069223a3330302c226578636c75646564223a66616c73652c226578706572696d656e74616c223a7b226175746f446577617270223a66616c73652c226175746f4465776172704465707468223a6e756c6c7d2c226c61796f7574223a226175746f222c226c61796f75744d6f6465223a226175746f222c226d616e75616c436f6e74656e74426f786573223a7b7d2c226d616e75616c536b657744656772656573223a6e756c6c2c226d616e75616c53706c6974223a6e756c6c2c226d616e75616c5a6f6e6573223a7b2266696c6c223a5b5d2c2270696374757265223a5b5d7d2c226d617267696e73223a7b22626f74746f6d4d6d223a352c226c6566744d6d223a352c2272696768744d6d223a352c22746f704d6d223a357d2c226d617463685061676553697a65223a747275652c226d617844696d656e73696f6e5078223a34303030302c226d6178506978656c73223a3136303030303030302c226e6f726d616c697a65496c6c756d696e6174696f6e223a747275652c226f63724d6f6465223a66616c73652c226f75747075744d6f6465223a226175746f222c2270616765416c69676e6d656e74223a22746f702d63656e746572222c22706c6163656d656e744f7665727269646573223a7b7d2c22707265666572536f6674416c706861466f726567726f756e64223a6e756c6c2c2270726573657276654f726967696e616c5175616c697479223a66616c73652c227175616c69747950617468223a22726173746572222c2272656164696e674f72646572223a226c7472222c2272656e64657243726f70223a6e756c6c2c2272657175657374656452656e646572447069223a3330302c227265736f6c76656454657874546f6e65446961676e6f7374696373223a6e756c6c2c22726f746174696f6e44656772656573223a302c22736b6970426c616e6b5061676573223a66616c73652c22736f757263654261636b67726f756e64447069223a6e756c6c2c22736f75726365447069223a3330302c22736f7572636548617342696c6576656c4c61796572223a66616c73652c22746869636b6e657373223a307d2c22736f7572636550616765223a317d5d7d2c226f75747075744d617070696e6773223a5b7b22626c616e6b223a66616c73652c226578636c75646564223a66616c73652c2268616c66223a2266756c6c222c226f75747075744f7264696e616c223a312c22726f746174696f6e44656772656573223a302c22736f7572636550616765223a317d5d2c2270616765506c616e44696765737473223a5b7b2265766964656e6365536861323536223a2234343133366661333535623336373861313134366164313666376538363439653934666234666332316665373765383331306330363066363163616166663861222c22706c616e536861323536223a2262383864343432623434383534313163303437356139386530313437343438393436343833396231326336313966646331356364366430313666313735303233222c22736f7572636550616765223a317d5d2c227265736f6c766564506c616e536861323536223a2234393138366561633563373231323964393032393936383565636335383863633731326435666636636162356636373936393862393264336465613665353462222c22736368656d6156657273696f6e223a312c22736f75726365536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161227d';

const options: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'auto',
    binarization: 'auto',
    normalizeIllumination: true,
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    despeckleLevel: 'normal',
    autoDewarp: false,
    readingOrder: 'ltr',
    skipBlankPages: false,
    pageOverrides: {},
};

const temporaryDirectories: string[] = [];

function effectiveOptions(pageNumber: number) {
    const resolved = resolveEffectiveScanCleanupOptions({
        options,
        pageOverride: createScanCleanupPageOverride(),
        dpi: 300,
        qualityPath: 'raster',
    });
    return {
        sourcePage: pageNumber,
        options: materializeScanCleanupStampOptions({
            nativeOptions: resolved,
            options,
            qualityPath: 'raster',
        }),
    };
}

function buildFixtureBuildIds(gitSha?: string): TScanCleanupStampBuildIds {
    if (gitSha === undefined) {
        return {
            coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID_V1,
            coreBuildId: SCAN_CLEANUP_CORE_BUILD_ID,
            nativeBinarySha256s: {scanCleanup: 'b'.repeat(64)},
            assemblerBackend: 'source-preserved',
            transportMode: 'source-preserved',
        };
    }
    return {
        coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID,
        coreBuildId: SCAN_CLEANUP_CORE_BUILD_ID,
        nativeBinarySha256s: {scanCleanup: 'b'.repeat(64)},
        assemblerBackend: 'source-preserved',
        transportMode: 'source-preserved',
        gitSha,
    };
}

function buildSinglePageStamp(gitSha?: string) {
    const record = effectiveOptions(1);
    return buildScanCleanupProvenanceStamp({
        sourceSha256: 'a'.repeat(64),
        effectiveOptions: [record],
        outputMappings: [{
            sourcePage: 1,
            half: 'full',
            outputOrdinal: 1,
            rotationDegrees: 0,
            excluded: false,
            blank: false,
        }],
        pagePlanDigests: [buildScanCleanupPagePlanDigest(1, record.options, {})],
        buildIds: buildFixtureBuildIds(gitSha),
    });
}

describe('scan-cleanup provenance stamp contract', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    afterEach(async () => {
        await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
            force: true,
            recursive: true,
        })));
    });

    it('preserves the SHA-256 digest while hashing a multi-chunk source stream', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'scan-cleanup-provenance-test-'));
        temporaryDirectories.push(directory);
        const source = join(directory, 'source.pdf');
        const bytes = Buffer.concat([
            Buffer.alloc(256 * 1024, 0x61),
            Buffer.alloc(256 * 1024, 0x62),
            Buffer.alloc(256 * 1024, 0x63),
        ]);
        await writeFile(source, bytes);

        const expected = createHash('sha256').update(bytes).digest('hex');
        await expect(sha256ScanCleanupFile(source)).resolves.toBe(expected);
    });

    it('canonicalizes sorted-key JSON and materializes stripped defaults', () => {
        expect(canonicalScanCleanupJson({
            z: 1,
            a: {
                d: 2,
                c: 3,
            },
        })).toBe(
            '{"a":{"c":3,"d":2},"z":1}',
        );
        expect(effectiveOptions(1).options).toMatchObject({
            sourceBackgroundDpi: null,
            renderCrop: null,
            despeckle: true,
            despeckleLevel: 'normal',
            manualZones: {
                picture: [],
                fill: [],
            },
            experimental: {
                autoDewarp: false,
                autoDewarpDepth: null,
            },
        });
    });

    it('round-trips the schema payload and verifies its source and plan', () => {
        const perSourcePage = [
            effectiveOptions(1),
            effectiveOptions(2),
        ];
        const outputMappings = [
            {
                sourcePage: 1,
                half: 'full' as const,
                outputOrdinal: 1,
                rotationDegrees: 0 as const,
                excluded: false,
                blank: false,
            },
            {
                sourcePage: 2,
                half: 'full' as const,
                outputOrdinal: null,
                rotationDegrees: 0 as const,
                excluded: true,
                blank: false,
            },
        ];
        const stamp = buildScanCleanupProvenanceStamp({
            sourceSha256: 'a'.repeat(64),
            effectiveOptions: perSourcePage,
            outputMappings,
            pagePlanDigests: perSourcePage.map(record => buildScanCleanupPagePlanDigest(
                record.sourcePage,
                record.options,
                {sourcePage: record.sourcePage},
            )),
            buildIds: buildFixtureBuildIds(),
        });
        const hex = encodeScanCleanupProvenanceStampHex(stamp);
        expect(stamp.schemaVersion).toBe(SCAN_CLEANUP_STAMP_SCHEMA_VERSION_V1);
        expect(stamp.buildIds.coreSchemaId).toBe(SCAN_CLEANUP_STAMP_SCHEMA_ID_V1);
        expect(stamp.buildIds).not.toHaveProperty('gitSha');
        expect(hex).toMatch(/^[0-9a-f]+$/u);
        expect(decodeScanCleanupProvenanceStampHex(hex)).toEqual(stamp);
        expect(verifyScanCleanupProvenanceStampHex(hex, {expectedSourceSha256: 'a'.repeat(64)})).toMatchObject({status: 'valid'});
        expect(verifyScanCleanupProvenanceStampHex(hex, {expectedSourceSha256: 'c'.repeat(64)})).toMatchObject({status: 'invalid'});
        expect(verifyScanCleanupProvenanceStampHex(null)).toMatchObject({status: 'unstamped'});
        expect(() => decodeScanCleanupProvenanceStampHex(hex.toUpperCase())).toThrow(
            'lowercase hexadecimal',
        );
    });

    it.each([
        'c'.repeat(40),
        'd'.repeat(64),
    ])('round-trips a v2 payload with build git SHA %s', (gitSha) => {
        const stamp = buildSinglePageStamp(gitSha);
        const hex = encodeScanCleanupProvenanceStampHex(stamp);

        expect(stamp.schemaVersion).toBe(SCAN_CLEANUP_STAMP_SCHEMA_VERSION);
        expect(stamp.buildIds.coreSchemaId).toBe(SCAN_CLEANUP_STAMP_SCHEMA_ID);
        expect(decodeScanCleanupProvenanceStampHex(hex)).toEqual(stamp);
        expect(verifyScanCleanupProvenanceStampHex(hex)).toMatchObject({
            status: 'valid',
            payload: {buildIds: {gitSha}},
        });
    });

    it('emits the frozen legacy v1 document byte-for-byte when gitSha is absent', () => {
        const expected = buildSinglePageStamp();
        const encoded = encodeScanCleanupProvenanceStampHex(expected);
        const decoded = decodeScanCleanupProvenanceStampHex(FROZEN_V1_STAMP_HEX);

        expect(encoded).toBe(FROZEN_V1_STAMP_HEX);
        expect(decoded).toEqual(expected);
        expect(verifyScanCleanupProvenanceStampHex(FROZEN_V1_STAMP_HEX)).toMatchObject({status: 'valid'});
        expect(Object.keys(decoded.buildIds).sort()).toEqual([
            'assemblerBackend',
            'coreBuildId',
            'coreSchemaId',
            'nativeBinarySha256s',
            'transportMode',
        ]);
    });

    it('records resolved ink anchors only for the runs that produced them', () => {
        const inkOptions: IScanCleanupOptions = {
            ...options,
            pageAlignment: 'ink',
        };
        const stampOptions = materializeScanCleanupStampOptions({
            nativeOptions: resolveEffectiveScanCleanupOptions({
                options: inkOptions,
                pageOverride: createScanCleanupPageOverride(),
                dpi: 300,
                qualityPath: 'raster',
                placementAnchors: {full: {yNormalized: 0.125}},
            }),
            options: inkOptions,
            qualityPath: 'raster',
        });
        const stamp = buildScanCleanupProvenanceStamp({
            sourceSha256: 'a'.repeat(64),
            effectiveOptions: [{
                sourcePage: 1,
                options: stampOptions,
            }],
            outputMappings: [{
                sourcePage: 1,
                half: 'full',
                outputOrdinal: 1,
                rotationDegrees: 0,
                excluded: false,
                blank: false,
            }],
            pagePlanDigests: [buildScanCleanupPagePlanDigest(1, stampOptions, {})],
            buildIds: buildFixtureBuildIds(),
        });
        const decoded = decodeScanCleanupProvenanceStampHex(
            encodeScanCleanupProvenanceStampHex(stamp),
        );

        expect(decoded).toEqual(stamp);
        expect(decoded.effectiveOptions.perSourcePage[0]?.options.placementAnchors)
            .toEqual({full: {yNormalized: 0.125}});
        // A run that never resolved an anchor keeps the shape every earlier
        // stamp has, so already-stamped documents still verify.
        expect(buildSinglePageStamp().effectiveOptions.perSourcePage[0]?.options)
            .not.toHaveProperty('placementAnchors');
        expect(() => assertScanCleanupProvenanceStamp(JSON.parse(JSON.stringify(stamp).replace(
            '"yNormalized":0.125',
            '"yNormalized":1.5',
        )))).toThrow('placementAnchors');
    });

    it('keeps the resolved plan digest identical with and without gitSha', () => {
        const v1Stamp = buildSinglePageStamp();
        const v2Stamp = buildSinglePageStamp('c'.repeat(40));

        expect(v2Stamp.resolvedPlanSha256).toBe(v1Stamp.resolvedPlanSha256);
    });

    it('reads the optional git SHA through a schema-narrowed typed helper', () => {
        const v1GitSha: string | null = readScanCleanupStampGitSha(buildSinglePageStamp());
        const v2GitSha: string | null = readScanCleanupStampGitSha(buildSinglePageStamp('c'.repeat(40)));

        expect(v1GitSha).toBeNull();
        expect(v2GitSha).toBe('c'.repeat(40));
    });

    it('names schema-version mismatches instead of treating v1 and v2 shapes as interchangeable', () => {
        const v2Stamp = buildSinglePageStamp('c'.repeat(40));
        expect(() => assertScanCleanupProvenanceStamp({
            ...v2Stamp,
            buildIds: {
                ...v2Stamp.buildIds,
                coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID_V1,
            },
        })).toThrow('stamp schema version mismatch: schemaVersion v2 requires coreSchemaId');

        const v1Stamp = buildSinglePageStamp();
        expect(() => assertScanCleanupProvenanceStamp({
            ...v1Stamp,
            buildIds: {
                ...v1Stamp.buildIds,
                coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID,
            },
        })).toThrow('stamp schema version mismatch: schemaVersion v1 requires coreSchemaId');

        expect(() => assertScanCleanupProvenanceStamp({
            ...v1Stamp,
            buildIds: {
                ...v1Stamp.buildIds,
                gitSha: 'c'.repeat(40),
            },
        })).toThrow('stamp schema version mismatch: v1 buildIds must use the legacy exact key set');

        expect(() => assertScanCleanupProvenanceStamp({
            ...v2Stamp,
            schemaVersion: 3,
        })).toThrow('stamp schema version mismatch: expected v1 or v2, received 3');
    });

    it('enforces the v2 top-level exact key set', () => {
        const v2Stamp = buildSinglePageStamp('c'.repeat(40));

        expect(() => assertScanCleanupProvenanceStamp({
            ...v2Stamp,
            unsupported: true,
        })).toThrow('stamp contains an unsupported or missing field');
        const {
            sourceSha256: _sourceSha256,
            ...missingSourceSha256
        } = v2Stamp;
        expect(() => assertScanCleanupProvenanceStamp(missingSourceSha256))
            .toThrow('stamp contains an unsupported or missing field');
    });

    it('rejects a v2 stamp without gitSha (v2 exists only to carry it)', () => {
        const v2Stamp = buildSinglePageStamp('c'.repeat(40));
        const withoutGitSha: Record<string, unknown> = {
            coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID,
            coreBuildId: SCAN_CLEANUP_CORE_BUILD_ID,
            nativeBinarySha256s: {scanCleanup: 'b'.repeat(64)},
            assemblerBackend: 'source-preserved',
            transportMode: 'source-preserved',
        };
        const invalidStamp: Record<string, unknown> = {
            ...v2Stamp,
            buildIds: withoutGitSha,
        };

        expect(() => assertScanCleanupProvenanceStamp(invalidStamp))
            .toThrow('stamp schema v2 buildIds must carry gitSha alongside the legacy key set');
    });

    it('rejects v2 buildIds missing any legacy key', () => {
        const v2Stamp = buildSinglePageStamp('c'.repeat(40));
        const missingCoreBuildId: Record<string, unknown> = {
            coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID,
            nativeBinarySha256s: {scanCleanup: 'b'.repeat(64)},
            assemblerBackend: 'source-preserved',
            transportMode: 'source-preserved',
            gitSha: 'c'.repeat(40),
        };
        const invalidStamp: Record<string, unknown> = {
            ...v2Stamp,
            buildIds: missingCoreBuildId,
        };

        expect(() => assertScanCleanupProvenanceStamp(invalidStamp))
            .toThrow('stamp schema v2 buildIds must carry gitSha alongside the legacy key set');
    });

    it.each([
        'a'.repeat(39),
        'A'.repeat(40),
        'g'.repeat(40),
        'a'.repeat(41),
        'a'.repeat(63),
        'a'.repeat(65),
    ])('rejects malformed v2 build git SHA %s', (gitSha) => {
        const stamp = buildSinglePageStamp('c'.repeat(40));
        expect(() => assertScanCleanupProvenanceStamp({
            ...stamp,
            buildIds: {
                ...stamp.buildIds,
                gitSha,
            },
        })).toThrow('stamp schema v2 buildIds.gitSha must be lowercase 40- or 64-character hex');
    });

    it.each([
        null,
        1,
        true,
        {},
    ])('rejects non-string v2 build git SHA %j', (gitSha) => {
        const stamp = buildSinglePageStamp('c'.repeat(40));
        expect(() => assertScanCleanupProvenanceStamp({
            ...stamp,
            buildIds: {
                ...stamp.buildIds,
                gitSha,
            },
        })).toThrow('stamp schema v2 buildIds.gitSha must be lowercase 40- or 64-character hex');
    });

    it.each([
        undefined,
        'invalid',
        `  ${'AB'.repeat(20)}\n`,
        'b'.repeat(64),
    ])('cannot spoof the dedicated build-time git SHA through process.env with %s', async (embedded) => {
        vi.stubEnv('EVB_BUILD_GIT_SHA', embedded);
        const buildIds = await buildScanCleanupStampBuildIds({
            paths: {
                qpdfBinary: 'unused',
                pdftoppmBinary: 'unused',
                scanCleanupBinary: '__scan_cleanup_cli_test__',
                pdfImageCombineBinary: '__scan_cleanup_cli_test__',
                tempDir: 'unused',
            },
            assemblerBackend: 'source-preserved',
            transportMode: 'source-preserved',
        });

        expect(buildIds).not.toHaveProperty('gitSha');
        expect(buildIds.coreSchemaId).toBe(SCAN_CLEANUP_STAMP_SCHEMA_ID_V1);
    });

    it('centralizes page-scope errors and rejects malformed mapping ordinals', () => {
        expect(resolveScanCleanupPageScope(undefined, 3)).toEqual([
            1,
            2,
            3,
        ]);
        expect(resolveScanCleanupPageScope([
            3,
            1,
            2,
        ], 3)).toEqual([
            1,
            2,
            3,
        ]);
        let error: unknown;
        try {
            resolveScanCleanupPageScope([
                1,
                2,
                2,
            ], 3);
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(ScanCleanupPageScopeError);
        expect((error as ScanCleanupPageScopeError).code).toBe('SCAN_CLEANUP_INVALID_PAGE_SCOPE');

        const record = effectiveOptions(1);
        const malformed = buildScanCleanupProvenanceStamp({
            sourceSha256: 'a'.repeat(64),
            effectiveOptions: [record],
            outputMappings: [{
                sourcePage: 1,
                half: 'full',
                outputOrdinal: 1,
                rotationDegrees: 0,
                excluded: false,
                blank: false,
            }],
            pagePlanDigests: [buildScanCleanupPagePlanDigest(1, record.options, {})],
            buildIds: buildFixtureBuildIds(),
        });
        expect(() => assertScanCleanupProvenanceStamp({
            ...malformed,
            outputMappings: [{
                ...malformed.outputMappings[0]!,
                outputOrdinal: 2,
            }],
        })).toThrow('out-of-order output ordinals');
        expect(() => resolveScanCleanupPageScope([0], 3)).toThrow(ScanCleanupPageScopeError);
    });

    it('rejects non-simple manual-zone polygons in provenance options', () => {
        const record = effectiveOptions(1);
        record.options.manualZones.fill = [{
            points: [
                {
                    xNormalized: 0,
                    yNormalized: 0,
                },
                {
                    xNormalized: 1,
                    yNormalized: 1,
                },
                {
                    xNormalized: 0,
                    yNormalized: 1,
                },
                {
                    xNormalized: 0.8,
                    yNormalized: 0,
                },
            ],
            rotationDegrees: 0,
        }];

        expect(() => buildScanCleanupProvenanceStamp({
            sourceSha256: 'a'.repeat(64),
            effectiveOptions: [record],
            outputMappings: [{
                sourcePage: 1,
                half: 'full',
                outputOrdinal: 1,
                rotationDegrees: 0,
                excluded: false,
                blank: false,
            }],
            pagePlanDigests: [buildScanCleanupPagePlanDigest(1, record.options, {})],
            buildIds: buildFixtureBuildIds(),
        })).toThrow('intersecting');
    });

    it('rejects non-finite and internally inconsistent nested provenance diagnostics', () => {
        const nonFiniteRecord = effectiveOptions(1);
        nonFiniteRecord.options.automaticSkewDegrees = {full: Number.POSITIVE_INFINITY};
        expect(() => buildScanCleanupProvenanceStamp({
            sourceSha256: 'a'.repeat(64),
            effectiveOptions: [nonFiniteRecord],
            outputMappings: [{
                sourcePage: 1,
                half: 'full',
                outputOrdinal: 1,
                rotationDegrees: 0,
                excluded: false,
                blank: false,
            }],
            pagePlanDigests: [buildScanCleanupPagePlanDigest(1, nonFiniteRecord.options, {})],
            buildIds: buildFixtureBuildIds(),
        })).toThrow('Cannot canonicalize non-finite number');

        const inconsistentRecord = effectiveOptions(1);
        inconsistentRecord.options.resolvedTextToneDiagnostics = {full: {
            applied: false,
            rule: 'applied',
            textLineCount: 1,
            textInkPixels: 10,
            pictureFraction: 0,
            outsideMidtoneFraction: 0,
            outsideMidtoneLargestComponentFraction: 0,
            outsideMidtoneLargestComponentWidthFraction: 0,
            outsideMidtoneLargestComponentHeightFraction: 0,
            inkAnchor: 120,
            blackPoint: null,
            slope: null,
        }};
        expect(() => buildScanCleanupProvenanceStamp({
            sourceSha256: 'a'.repeat(64),
            effectiveOptions: [inconsistentRecord],
            outputMappings: [{
                sourcePage: 1,
                half: 'full',
                outputOrdinal: 1,
                rotationDegrees: 0,
                excluded: false,
                blank: false,
            }],
            pagePlanDigests: [buildScanCleanupPagePlanDigest(1, inconsistentRecord.options, {})],
            buildIds: buildFixtureBuildIds(),
        })).toThrow('resolvedTextToneDiagnostics is invalid');
    });
});
