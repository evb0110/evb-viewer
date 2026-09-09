import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {
    chmod,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type {IScanCleanupOptions} from '@contracts/electronApiScanCleanup';
import {createScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import {resolveCliNativeToolPath} from '@scripts/scanCleanupCliAdapters';
import {rotateBitmapValues} from '@scripts/diagnostics/scan-cleanup-word-loss-audit.mjs';
import {
    SCAN_CLEANUP_CORE_BUILD_ID,
    SCAN_CLEANUP_STAMP_SCHEMA_ID_V1,
    buildScanCleanupPagePlanDigest,
    buildScanCleanupProvenanceStamp,
    encodeScanCleanupProvenanceStampHex,
    materializeScanCleanupStampOptions,
    resolveEffectiveScanCleanupOptions,
    sha256ScanCleanupFile,
} from '@evb/scan-cleanup/core/index';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const auditScript = join(projectRoot, 'scripts/diagnostics/scan-cleanup-word-loss-audit.mjs');
const qpdfBinary = resolveCliNativeToolPath('qpdf', 'qpdf', projectRoot) ?? 'qpdf';
const pdfimagesBinary = resolveCliNativeToolPath('pdfimages', 'poppler', projectRoot) ?? 'pdfimages';

function buildMinimalPdf() {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 32 32] /Resources << >> >>',
        '<< /Producer (evb-viewer-test) >>',
    ];
    let body = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((content, index) => {
        offsets.push(body.length);
        body += `${String(index + 1)} 0 obj\n${content}\nendobj\n`;
    });
    const xrefOffset = body.length;
    body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
    for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
    body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
    return Buffer.from(body, 'latin1');
}

interface ISyntheticRaster {
    bitsPerComponent: number;
    color?: 'gray' | 'rgb';
    height: number;
    imageMask?: boolean;
    pixels: Uint8Array;
    width: number;
}

type TSyntheticCleanedVariant =
    | 'attached-fringe'
    | 'equal'
    | 'invented'
    | 'sparse-invented'
    | 'scaled-islands'
    | 'scaled-local-shift'
    | 'thick'
    | 'unrelated';

function buildRasterPdf(input: ISyntheticRaster | readonly ISyntheticRaster[]) {
    const rasters = Array.isArray(input) ? input : [input];
    const pageObjectStart = 3;
    const contentObjectStart = pageObjectStart + rasters.length;
    const imageObjectStart = contentObjectStart + rasters.length;
    const producerObject = imageObjectStart + rasters.length;
    const pageKids = rasters
        .map((_, index) => `${String(pageObjectStart + index)} 0 R`)
        .join(' ');
    const pageObjects = rasters.map((raster, index) => Buffer.from([
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(raster.width)} ${String(raster.height)}]`,
        `/Resources << /XObject << /Im0 ${String(imageObjectStart + index)} 0 R >> >> /Contents ${String(contentObjectStart + index)} 0 R >>`,
    ].join(' '), 'ascii'));
    const contentObjects = rasters.map(raster => {
        const content = Buffer.from(`q\n${raster.width} 0 0 ${raster.height} 0 0 cm\n/Im0 Do\nQ\n`, 'ascii');
        return Buffer.concat([
            Buffer.from(`<< /Length ${String(content.length)} >>\nstream\n`, 'ascii'),
            content,
            Buffer.from('endstream', 'ascii'),
        ]);
    });
    const imageObjects = rasters.map(raster => {
        const imageDictionary = raster.imageMask
            ? [
                `<< /Type /XObject /Subtype /Image /Width ${String(raster.width)} /Height ${String(raster.height)}`,
                `/ImageMask true /BitsPerComponent 1 /Decode [1 0] /Length ${String(raster.pixels.length)} >>`,
            ].join(' ')
            : raster.color === 'rgb'
                ? [
                    `<< /Type /XObject /Subtype /Image /Width ${String(raster.width)} /Height ${String(raster.height)}`,
                    `/ColorSpace /DeviceRGB /BitsPerComponent ${String(raster.bitsPerComponent)} /Length ${String(raster.pixels.length)} >>`,
                ].join(' ')
                : [
                    `<< /Type /XObject /Subtype /Image /Width ${String(raster.width)} /Height ${String(raster.height)}`,
                    `/ColorSpace /DeviceGray /BitsPerComponent ${String(raster.bitsPerComponent)} /Length ${String(raster.pixels.length)} >>`,
                ].join(' ');
        return Buffer.concat([
            Buffer.from(`${imageDictionary}\nstream\n`, 'ascii'),
            Buffer.from(raster.pixels),
            Buffer.from('\nendstream', 'ascii'),
        ]);
    });
    const objects = [
        Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
        Buffer.from(`<< /Type /Pages /Kids [${pageKids}] /Count ${String(rasters.length)} >>`, 'ascii'),
        ...pageObjects,
        ...contentObjects,
        ...imageObjects,
        Buffer.from('<< /Producer (evb-stage26-synthetic) >>', 'ascii'),
    ];
    const chunks = [Buffer.from('%PDF-1.4\n', 'ascii')];
    const offsets: number[] = [];
    for (const [
        index,
        object,
    ] of objects.entries()) {
        offsets.push(chunks.reduce((total, chunk) => total + chunk.length, 0));
        chunks.push(
            Buffer.from(`${String(index + 1)} 0 obj\n`, 'ascii'),
            object,
            Buffer.from('\nendobj\n', 'ascii'),
        );
    }
    const xrefOffset = chunks.reduce((total, chunk) => total + chunk.length, 0);
    chunks.push(Buffer.from(`xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`, 'ascii'));
    for (const offset of offsets) {
        chunks.push(Buffer.from(`${String(offset).padStart(10, '0')} 00000 n \n`, 'ascii'));
    }
    chunks.push(Buffer.from([
        `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R /Info ${String(producerObject)} 0 R >>`,
        `startxref\n${String(xrefOffset)}\n%%EOF\n`,
    ].join('\n'), 'ascii'));
    return Buffer.concat(chunks);
}

function packBilevelRaster(width: number, height: number, isBlack: (x: number, y: number) => boolean) {
    const rowBytes = Math.ceil(width / 8);
    const packed = new Uint8Array(rowBytes * height).fill(255);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (isBlack(x, y)) {
                const byteIndex = y * rowBytes + (x >> 3);
                packed[byteIndex] = (packed[byteIndex] ?? 0) & ~(1 << (7 - (x & 7)));
            }
        }
    }
    return packed;
}

function buildSyntheticSourceRaster(
    bitsPerComponent = 8,
    variant: TSyntheticCleanedVariant = 'equal',
): ISyntheticRaster {
    const width = 160;
    const height = 160;
    const pixels = new Uint8Array(width * height).fill(255);
    if (variant === 'attached-fringe') {
        for (const left of [
            20,
            65,
            110,
        ]) {
            for (let y = 30; y < 70; y += 1) {
                for (let x = left; x < left + 30; x += 1) {
                    pixels[y * width + x] = 40;
                }
            }
        }
    } else if (variant !== 'unrelated') {
        for (const left of [
            24,
            76,
            128,
        ]) {
            for (let y = 32; y < 56; y += 1) {
                for (let x = left; x < left + 10; x += 1) {
                    pixels[y * width + x] = 40;
                }
            }
        }
    }
    return {
        bitsPerComponent,
        height,
        pixels: bitsPerComponent === 1
            ? packBilevelRaster(width, height, (x, y) => pixels[y * width + x]! < 128)
            : pixels,
        width,
    };
}

function buildSyntheticRgbSourceRaster(): ISyntheticRaster {
    const width = 160;
    const height = 160;
    const pixels = new Uint8Array(width * height * 3);
    let state = 0x42a17d31;
    const nextNoise = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state >>> 24;
    };
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const noise = nextNoise() % 7 - 3;
            const base = 224 + noise + Math.floor(x / 80);
            const offset = (y * width + x) * 3;
            pixels[offset] = base + 2;
            pixels[offset + 1] = base;
            pixels[offset + 2] = base - 2;
        }
    }
    for (const left of [
        24,
        76,
        128,
    ]) {
        for (let y = 32; y < 56; y += 1) {
            for (let x = left; x < left + 10; x += 1) {
                const offset = (y * width + x) * 3;
                pixels[offset] = 18;
                pixels[offset + 1] = 20;
                pixels[offset + 2] = 24;
            }
        }
    }
    // These are isolated, darker texture pixels. A source mask that treats
    // every RGB sample as ink would turn them into false components.
    for (const [
        x,
        y,
    ] of ([
            [
                15,
                18,
            ],
            [
                51,
                90,
            ],
            [
                109,
                20,
            ],
            [
                145,
                130,
            ],
        ] as const)) {
        const offset = (y * width + x) * 3;
        pixels[offset] = 112;
        pixels[offset + 1] = 114;
        pixels[offset + 2] = 116;
    }
    return {
        bitsPerComponent: 8,
        color: 'rgb',
        height,
        pixels,
        width,
    };
}

function buildSyntheticCleanedRaster(
    source: ISyntheticRaster,
    variant: TSyntheticCleanedVariant,
    scale = 1,
    imageMask = true,
) {
    const width = source.width * scale;
    const height = source.height * scale;
    const pixels = new Uint8Array(width * height);
    const setPixel = (x: number, y: number) => {
        if (x >= 0 && x < width && y >= 0 && y < height) {
            pixels[y * width + x] = 1;
        }
    };
    const sourceLefts = [
        24,
        76,
        128,
    ];
    if (variant === 'attached-fringe') {
        for (const [
            index,
            left,
        ] of [
                20,
                65,
                110,
            ].entries()) {
            for (let y = 30 * scale; y < 70 * scale; y += 1) {
                const extra = index === 0 ? 8 * scale : 0;
                for (let x = left * scale; x < (left + 30) * scale + extra; x += 1) {
                    setPixel(x, y);
                }
            }
        }
    } else {
        for (const [
            index,
            sourceLeft,
        ] of sourceLefts.entries()) {
            const thickness = variant === 'thick' ? 2 : 0;
            const localShift = variant === 'scaled-local-shift' && index === 0 ? 14 : 0;
            const left = sourceLeft * scale - thickness + localShift;
            const top = 32 * scale - thickness;
            const right = (sourceLeft + 10) * scale + thickness + localShift;
            const bottom = 56 * scale + thickness;
            for (let y = top; y < bottom; y += 1) {
                for (let x = left; x < right; x += 1) {
                    setPixel(x, y);
                }
            }
        }
    }
    if (variant === 'invented') {
        for (let y = 86 * scale; y < 106 * scale; y += 1) {
            for (let x = 72 * scale; x < 136 * scale; x += 1) {
                setPixel(x, y);
            }
        }
    }
    if (variant === 'sparse-invented' || variant === 'unrelated') {
        const left = 35 * scale;
        const top = 80 * scale;
        const right = 130 * scale;
        const bottom = 145 * scale;
        const thickness = 2 * scale;
        for (let y = top; y < bottom; y += 1) {
            for (let x = left; x < right; x += 1) {
                if (
                    x < left + thickness
                    || x >= right - thickness
                    || y < top + thickness
                    || y >= bottom - thickness
                ) {
                    setPixel(x, y);
                }
            }
        }
    }
    if (variant === 'scaled-islands') {
        const islands = [
            [
                100,
                180,
                20,
                30,
            ],
            [
                200,
                180,
                30,
                30,
            ],
        ] as const;
        for (const [
            left,
            top,
            islandWidth,
            islandHeight,
        ] of islands) {
            for (let y = top; y < top + islandHeight; y += 1) {
                for (let x = left; x < left + islandWidth; x += 1) {
                    setPixel(x, y);
                }
            }
        }
    }
    return {
        bitsPerComponent: 1,
        height,
        imageMask,
        pixels: packBilevelRaster(width, height, (x, y) => pixels[y * width + x] === 1),
        width,
    };
}

function buildNonlinearCleanedRaster(
    source: ISyntheticRaster,
    removeFirstComponent = false,
) {
    const pixels = new Uint8Array(source.width * source.height);
    const warp = (y: number) => 8 * Math.sin(Math.PI * y / Math.max(1, source.height - 1));
    for (const [
        index,
        left,
    ] of [
            24,
            76,
            128,
        ].entries()) {
        if (removeFirstComponent && index === 0) continue;
        for (let y = 32; y < 56; y += 1) {
            const mappedLeft = Math.round(left + warp(y));
            for (let x = mappedLeft; x < mappedLeft + 10; x += 1) {
                if (x >= 0 && x < source.width) pixels[y * source.width + x] = 1;
            }
        }
    }
    return {
        bitsPerComponent: 1,
        height: source.height,
        imageMask: true,
        pixels: packBilevelRaster(source.width, source.height, (x, y) => pixels[y * source.width + x] === 1),
        width: source.width,
    };
}

function buildSplitSourceRaster(): ISyntheticRaster {
    const width = 320;
    const height = 160;
    const pixels = new Uint8Array(width * height).fill(255);
    for (const half of [
        0,
        160,
    ]) {
        for (const left of [
            24,
            76,
            128,
        ]) {
            for (let y = 32; y < 56; y += 1) {
                for (let x = half + left; x < half + left + 10; x += 1) {
                    pixels[y * width + x] = 40;
                }
            }
        }
    }
    return {
        bitsPerComponent: 8,
        height,
        pixels,
        width,
    };
}

function buildSplitDewarpGeometry(sourceX: number) {
    const mapping = buildNonlinearMapping();
    mapping.outputToSource = mapping.outputToSource.map(point => ({
        ...point,
        x: point.x + sourceX,
    }));
    return {
        canvasHeightPx: 160,
        canvasWidthPx: 160,
        cropRect: {
            heightPx: 160,
            widthPx: 160,
            xPx: 0,
            yPx: 0,
        },
        dewarped: true,
        dewarpMapping: mapping,
        inputHeightPx: 160,
        inputWidthPx: 320,
        matchedCanvasContentHeightPx: 160,
        matchedCanvasContentWidthPx: 160,
        outputHeightPx: 160,
        outputWidthPx: 160,
        placementOffsetXPx: 0,
        placementOffsetYPx: 0,
        sourceRegion: {
            heightPx: 160,
            widthPx: 160,
            xPx: sourceX,
            yPx: 0,
        },
    };
}

function buildNonlinearMapping(
    variant: 'folded' | 'loss' | 'noninvertible' | 'out-of-bounds' | 'valid' = 'valid',
) {
    const columns = 3;
    const rows = 3;
    const sourceToOutput = [];
    const outputToSource = [];
    for (let row = 0; row < rows; row += 1) {
        const y = row * 80;
        const warp = 8 * Math.sin(Math.PI * y / 160);
        for (let column = 0; column < columns; column += 1) {
            const x = column * 80;
            sourceToOutput.push({
                x: x + warp,
                y,
            });
            outputToSource.push({
                x: x - warp,
                y,
            });
        }
    }
    const mapping = {
        columns,
        rows,
        outputOrigin: {
            x: 0,
            y: 0,
        },
        outputWidth: 160,
        outputHeight: 160,
        outputToSource,
        sourceToOutput,
    };
    if (variant === 'folded') {
        mapping.sourceToOutput[3] = {
            x: 160,
            y: 80,
        };
        mapping.sourceToOutput[4] = {
            x: 80,
            y: 80,
        };
        mapping.sourceToOutput[5] = {
            x: 0,
            y: 80,
        };
    } else if (variant === 'out-of-bounds') {
        mapping.sourceToOutput[4] = {
            x: 1_000,
            y: 80,
        };
    } else if (variant === 'noninvertible') {
        mapping.sourceToOutput[1] = {...mapping.sourceToOutput[0]!};
    }
    return mapping;
}

interface ISplitAuditAlignment {
    attemptedScales?: string[];
    reliable?: boolean;
}

interface ISplitOutputAudit {
    alignment?: ISplitAuditAlignment;
    status?: string;
}

interface ISplitAuditReport {
    pages: Array<{outputAudits?: ISplitOutputAudit[]}>;
    summary?: {suppressedCount?: number};
}

interface IQpdfJsonEntry {[key: string]: unknown;}

interface IQpdfJson {qpdf: IQpdfJsonEntry[];}

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

interface IRunAuditOptions {
    failOn?: 'any' | 'invented-ink' | 'none' | 'silhouette' | 'text-loss';
    pdfimagesPath?: string;
    verifyStamp?: boolean;
}

async function runAudit(
    source: string,
    cleaned: string,
    output: string,
    {
        failOn = 'none',
        pdfimagesPath,
        verifyStamp = true,
    }: IRunAuditOptions = {},
) {
    try {
        const args = [
            auditScript,
            '--source',
            source,
            '--cleaned',
            cleaned,
            '--out',
            output,
            '--fail-on',
            failOn,
            '--workers',
            '1',
            ...(verifyStamp ? ['--verify-stamp'] : []),
        ];
        await execFileAsync(process.execPath, args, {
            cwd: projectRoot,
            env: pdfimagesPath === undefined
                ? process.env
                : {
                    ...process.env,
                    EVB_PDFIMAGES_PATH: pdfimagesPath,
                },
            maxBuffer: 2 * 1024 * 1024,
        });
        return 0;
    } catch (error) {
        return (error as {code?: number}).code ?? 1;
    }
}

async function injectStamp(source: string, output: string, stampHex: string, updatePath: string) {
    const qpdfJson = JSON.parse(
        (await execFileAsync(qpdfBinary, [
            '--json',
            '--object-streams=disable',
            source,
            '-',
        ])).stdout,
    ) as IQpdfJson;
    const trailerEntry = qpdfJson.qpdf.find(entry => entry.trailer !== undefined);
    const trailer = trailerEntry?.trailer as IQpdfJsonEntry | undefined;
    const trailerValue = trailer?.value as IQpdfJsonEntry | undefined;
    const infoReference = trailerValue?.['/Info'];
    if (typeof infoReference !== 'string') throw new Error('test PDF has no qpdf Info reference');
    const infoEntry = qpdfJson.qpdf.find(entry => Object.hasOwn(entry, `obj:${infoReference}`));
    const infoObject = infoEntry?.[`obj:${infoReference}`] as IQpdfJsonEntry | undefined;
    const infoValue = infoObject?.value as IQpdfJsonEntry | undefined;
    if (infoValue === undefined) throw new Error('test PDF has no qpdf Info object');
    infoValue['/EVBScanCleanup'] = `u:${stampHex}`;
    await writeFile(updatePath, JSON.stringify(qpdfJson));
    await execFileAsync(qpdfBinary, [
        `--update-from-json=${updatePath}`,
        source,
        output,
    ]);
}

describe('scan-cleanup word-loss audit stamp verification', () => {
    it('reports an unstamped baseline and accepts a qpdf-injected core stamp', async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'scan-cleanup-stamp-audit-'));
        try {
            const source = join(temporaryDirectory, 'source.pdf');
            const cleaned = join(temporaryDirectory, 'cleaned.pdf');
            const update = join(temporaryDirectory, 'update.json');
            const baselineReport = join(temporaryDirectory, 'baseline.json');
            const stampedReport = join(temporaryDirectory, 'stamped.json');
            await writeFile(source, buildMinimalPdf());

            expect(await runAudit(source, source, baselineReport)).toBe(1);
            expect(JSON.parse(await readFile(baselineReport, 'utf8')).stampVerification).toMatchObject({status: 'unstamped'});

            const resolved = resolveEffectiveScanCleanupOptions({
                options,
                pageOverride: createScanCleanupPageOverride(),
                dpi: 300,
                qualityPath: 'raster',
            });
            const effectiveRecord = {
                sourcePage: 1,
                options: materializeScanCleanupStampOptions({
                    nativeOptions: resolved,
                    options,
                    qualityPath: 'raster',
                }),
            };
            const stamp = buildScanCleanupProvenanceStamp({
                sourceSha256: await sha256ScanCleanupFile(source),
                effectiveOptions: [effectiveRecord],
                outputMappings: [{
                    sourcePage: 1,
                    half: 'full',
                    outputOrdinal: 1,
                    rotationDegrees: 0,
                    excluded: false,
                    blank: false,
                }],
                pagePlanDigests: [buildScanCleanupPagePlanDigest(
                    1,
                    effectiveRecord.options,
                    {sourcePage: 1},
                )],
                buildIds: {
                    coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID_V1,
                    coreBuildId: SCAN_CLEANUP_CORE_BUILD_ID,
                    nativeBinarySha256s: {scanCleanup: 'b'.repeat(64)},
                    assemblerBackend: 'source-preserved',
                    transportMode: 'source-preserved',
                },
            });
            await injectStamp(
                source,
                cleaned,
                encodeScanCleanupProvenanceStampHex(stamp),
                update,
            );

            expect(await runAudit(source, cleaned, stampedReport)).toBe(0);
            expect(JSON.parse(await readFile(stampedReport, 'utf8')).stampVerification).toMatchObject({status: 'valid'});
        } finally {
            await rm(temporaryDirectory, {
                force: true,
                recursive: true,
            });
        }
    }, 30_000);
});

describe('scan-cleanup word-loss bitmap transforms', () => {
    it('preserves a non-square bitmap for normalized zero rotation', () => {
        const values = new Uint8Array([
            1,
            2,
            3,
            4,
            5,
            6,
        ]);
        const rotated = rotateBitmapValues({
            height: 2,
            width: 3,
        }, 4, values);

        expect(rotated).toMatchObject({
            height: 2,
            width: 3,
        });
        expect(rotated.values).toBe(values);
        expect([...rotated.values]).toEqual([
            1,
            2,
            3,
            4,
            5,
            6,
        ]);
    });
});

describe('scan-cleanup word-loss audit coverage', () => {
    it('fails an enforced audit when a requested page is skipped', async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'scan-cleanup-coverage-audit-'));
        try {
            const source = join(temporaryDirectory, 'source.pdf');
            const cleaned = join(temporaryDirectory, 'cleaned.pdf');
            const reportPath = join(temporaryDirectory, 'report.json');
            const sourceRaster = buildSyntheticSourceRaster();
            await writeFile(source, buildRasterPdf(sourceRaster));
            await writeFile(cleaned, buildRasterPdf({
                bitsPerComponent: 8,
                height: sourceRaster.height,
                imageMask: false,
                pixels: new Uint8Array(sourceRaster.width * sourceRaster.height).fill(255),
                width: sourceRaster.width,
            }));

            expect(await runAudit(source, cleaned, reportPath, {
                failOn: 'text-loss',
                verifyStamp: false,
            })).toBe(1);
            expect(JSON.parse(await readFile(reportPath, 'utf8')).summary).toMatchObject({
                analyzedOutputPages: 0,
                auditCoverageComplete: false,
                errorPages: [],
                expectedOutputPages: 1,
                incompletePages: [1],
                skippedPages: [1],
            });
        } finally {
            await rm(temporaryDirectory, {
                force: true,
                recursive: true,
            });
        }
    }, 30_000);

    it('fails an enforced audit when a requested page errors during extraction', async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'scan-cleanup-error-audit-'));
        try {
            const source = join(temporaryDirectory, 'source.pdf');
            const cleaned = join(temporaryDirectory, 'cleaned.pdf');
            const failingPdfimages = join(temporaryDirectory, 'pdfimages-fail-extraction.mjs');
            const reportPath = join(temporaryDirectory, 'report.json');
            const sourceRaster = buildSyntheticSourceRaster();
            const cleanedRaster = buildSyntheticCleanedRaster(sourceRaster, 'equal');
            await writeFile(source, buildRasterPdf(sourceRaster));
            await writeFile(cleaned, buildRasterPdf(cleanedRaster));
            await writeFile(failingPdfimages, [
                '#!/usr/bin/env node',
                'import {spawnSync} from \'node:child_process\';',
                'if (!process.argv.includes(\'-list\')) {',
                '    process.stderr.write(\'intentional extraction failure\\n\');',
                '    process.exit(72);',
                '}',
                `const result = spawnSync(${JSON.stringify(pdfimagesBinary)}, process.argv.slice(2), {stdio: 'inherit'});`,
                'process.exit(result.status ?? 1);',
                '',
            ].join('\n'));
            await chmod(failingPdfimages, 0o755);

            expect(await runAudit(source, cleaned, reportPath, {
                failOn: 'text-loss',
                pdfimagesPath: failingPdfimages,
                verifyStamp: false,
            })).toBe(1);
            expect(JSON.parse(await readFile(reportPath, 'utf8')).summary).toMatchObject({
                analyzedOutputPages: 0,
                auditCoverageComplete: false,
                errorPages: [1],
                expectedOutputPages: 1,
                incompletePages: [1],
                skippedPages: [],
            });
        } finally {
            await rm(temporaryDirectory, {
                force: true,
                recursive: true,
            });
        }
    }, 30_000);
});

describe('scan-cleanup RGB source support', () => {
    async function runRgbCase(cleanedPixels: Uint8Array) {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'scan-cleanup-rgb-audit-'));
        try {
            const source = join(temporaryDirectory, 'source.pdf');
            const cleaned = join(temporaryDirectory, 'cleaned.pdf');
            const reportPath = join(temporaryDirectory, 'report.json');
            const sourceRaster = buildSyntheticRgbSourceRaster();
            await writeFile(source, buildRasterPdf(sourceRaster));
            await writeFile(cleaned, buildRasterPdf({
                bitsPerComponent: 1,
                height: sourceRaster.height,
                imageMask: true,
                pixels: cleanedPixels,
                width: sourceRaster.width,
            }));
            const exitCode = await runAudit(source, cleaned, reportPath, {
                failOn: 'text-loss',
                verifyStamp: false,
            });
            const report = JSON.parse(await readFile(reportPath, 'utf8')) as {pages: Array<{
                flagged?: boolean;
                ignoredDustCount?: number;
                lossFlagged?: boolean;
                lostCount?: number;
                sourceImage?: {
                    color?: string;
                    support?: {kind?: string};
                };
                status?: string;
                totalTextComponents?: number;
            }>};
            return {
                exitCode,
                page: report.pages[0],
            };
        } finally {
            await rm(temporaryDirectory, {
                force: true,
                recursive: true,
            });
        }
    }

    it('analyzes an unchanged RGB camera page', async () => {
        const result = await runRgbCase(packBilevelRaster(160, 160, (x, y) =>
            (x >= 24 && x < 34 || x >= 76 && x < 86 || x >= 128 && x < 138)
            && y >= 32
            && y < 56,
        ));

        expect(result.exitCode).toBe(0);
        expect(result.page).toMatchObject({
            flagged: false,
            lossFlagged: false,
            sourceImage: {
                color: 'rgb',
                support: {kind: 'conservative-rgb'},
            },
            status: 'analyzed',
        });
    }, 30_000);

    it('flags removed RGB text while ignoring isolated paper texture', async () => {
        const result = await runRgbCase(packBilevelRaster(160, 160, () => false));

        expect(result.exitCode).toBe(1);
        expect(result.page).toMatchObject({
            flagged: true,
            lossFlagged: true,
            status: 'analyzed',
        });
        if (result.page === undefined) {
            throw new Error('Expected the RGB audit to report its analyzed page');
        }
        expect(result.page.lostCount).toBeGreaterThanOrEqual(3);
        expect(result.page.totalTextComponents).toBeGreaterThan(0);
        expect(result.page.ignoredDustCount ?? 0).toBeLessThan(result.page.totalTextComponents ?? 0);
    }, 30_000);

    it('does not flag an RGB page whose camera texture remains unchanged', async () => {
        const result = await runRgbCase(packBilevelRaster(160, 160, (x, y) =>
            ((x >= 24 && x < 34 || x >= 76 && x < 86 || x >= 128 && x < 138)
                && y >= 32
                && y < 56)
            || (x === 15 && y === 18)
            || (x === 51 && y === 90)
            || (x === 109 && y === 20)
            || (x === 145 && y === 130),
        ));

        expect(result.exitCode).toBe(0);
        expect(result.page?.lostCount ?? 0).toBe(0);
        expect(result.page?.flagged).toBe(false);
    }, 30_000);

    it('fails when the generated CI RGB fixture loses its text', async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'scan-cleanup-rgb-fixture-audit-'));
        try {
            const source = join(temporaryDirectory, 'source.pdf');
            const cleaned = join(temporaryDirectory, 'cleaned.pdf');
            const reportPath = join(temporaryDirectory, 'report.json');
            const {generateScanCleanupRgbFixture} = await import(
                '@scripts/diagnostics/generate-scan-cleanup-rgb-fixture.mjs'
            );
            await generateScanCleanupRgbFixture(source);
            await writeFile(cleaned, buildRasterPdf({
                bitsPerComponent: 1,
                height: 240,
                imageMask: true,
                pixels: packBilevelRaster(320, 240, () => false),
                width: 320,
            }));
            const exitCode = await runAudit(source, cleaned, reportPath, {
                failOn: 'text-loss',
                verifyStamp: false,
            });
            const report = JSON.parse(await readFile(reportPath, 'utf8')) as {pages: Array<{
                ignoredDustCount?: number;
                lostCount?: number;
                totalTextComponents?: number;
            }>};

            expect(exitCode).toBe(1);
            expect(report.pages[0]).toMatchObject({
                ignoredDustCount: 0,
                totalTextComponents: 17,
            });
            expect(report.pages[0]?.lostCount ?? 0).toBeGreaterThanOrEqual(3);
        } finally {
            await rm(temporaryDirectory, {
                force: true,
                recursive: true,
            });
        }
    }, 30_000);
});

describe('scan-cleanup nonlinear split audit', () => {
    it('composes the right leaf local coordinates with the full source page', async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'scan-cleanup-split-dewarp-'));
        try {
            const source = join(temporaryDirectory, 'source.pdf');
            const cleaned = join(temporaryDirectory, 'cleaned.pdf');
            const reportPath = join(temporaryDirectory, 'report.json');
            const sourceRaster = buildSplitSourceRaster();
            const leafRaster = buildNonlinearCleanedRaster({
                bitsPerComponent: 8,
                height: 160,
                pixels: new Uint8Array(160 * 160),
                width: 160,
            });
            await writeFile(source, buildRasterPdf(sourceRaster));
            await writeFile(cleaned, buildRasterPdf([
                leafRaster,
                leafRaster,
            ]));
            await writeFile(`${cleaned}.summary.json`, JSON.stringify({
                perPageStreamSizes: [
                    {
                        outputPageNumber: 1,
                        renderGeometry: buildSplitDewarpGeometry(0),
                        sourcePageNumber: 1,
                    },
                    {
                        outputPageNumber: 2,
                        renderGeometry: buildSplitDewarpGeometry(160),
                        sourcePageNumber: 1,
                    },
                ],
                sourcePageToOutputPages: {'1': [
                    1,
                    2,
                ]},
            }));
            const exitCode = await runAudit(source, cleaned, reportPath, {
                failOn: 'text-loss',
                verifyStamp: false,
            });
            const report = JSON.parse(await readFile(reportPath, 'utf8')) as ISplitAuditReport;
            expect(exitCode).toBe(0);
            expect(report.pages[0]?.outputAudits).toHaveLength(2);
            for (const audit of report.pages[0]?.outputAudits ?? []) {
                expect(audit).toMatchObject({
                    alignment: {
                        attemptedScales: ['canonical-dewarp-grid(3x3)'],
                        reliable: true,
                    },
                    status: 'analyzed',
                });
            }
            expect(report.summary).toMatchObject({suppressedCount: 0});
        } finally {
            await rm(temporaryDirectory, {
                force: true,
                recursive: true,
            });
        }
    }, 30_000);
});

describe('scan-cleanup invented-ink audit', () => {
    async function runSyntheticCase(
        variant: TSyntheticCleanedVariant,
        {
            canonicalGeometry = false,
            cleanedImageMask = true,
            failOn = 'any' as 'any' | 'invented-ink' | 'none' | 'silhouette' | 'text-loss',
            mapped = false,
            nonlinear = null as 'folded' | 'loss' | 'malformed' | 'missing' | 'noninvertible' | 'out-of-bounds' | 'valid' | null,
            scale = 1,
            sourceBitsPerComponent = 8,
        } = {},
    ) {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), `scan-cleanup-invented-${variant}-`));
        const source = join(temporaryDirectory, 'source.pdf');
        const cleaned = join(temporaryDirectory, 'cleaned.pdf');
        const reportPath = join(temporaryDirectory, 'report.json');
        const sourceRaster = buildSyntheticSourceRaster(sourceBitsPerComponent, variant);
        await writeFile(source, buildRasterPdf(sourceRaster));
        const cleanedRaster = nonlinear === null
            ? buildSyntheticCleanedRaster(
                sourceRaster,
                variant,
                scale,
                cleanedImageMask,
            )
            : buildNonlinearCleanedRaster(sourceRaster, nonlinear === 'loss');
        await writeFile(cleaned, buildRasterPdf(cleanedRaster));
        if (mapped || nonlinear !== null) {
            const renderGeometry = nonlinear === 'missing'
                ? {
                    canvasHeightPx: sourceRaster.height,
                    canvasWidthPx: sourceRaster.width,
                    cropRect: {
                        heightPx: sourceRaster.height,
                        widthPx: sourceRaster.width,
                        xPx: 0,
                        yPx: 0,
                    },
                    dewarped: true,
                    inputHeightPx: sourceRaster.height,
                    inputWidthPx: sourceRaster.width,
                    matchedCanvasContentHeightPx: sourceRaster.height,
                    matchedCanvasContentWidthPx: sourceRaster.width,
                    outputHeightPx: sourceRaster.height,
                    outputWidthPx: sourceRaster.width,
                    placementOffsetXPx: 0,
                    placementOffsetYPx: 0,
                }
                : nonlinear === 'malformed'
                    ? {
                        canvasHeightPx: sourceRaster.height,
                        canvasWidthPx: sourceRaster.width,
                        dewarped: true,
                        dewarpMapping: {
                            columns: 2,
                            rows: 2,
                            outputOrigin: {
                                x: 0,
                                y: 0,
                            },
                            outputWidth: sourceRaster.width,
                            outputHeight: sourceRaster.height,
                            outputToSource: [],
                            sourceToOutput: [],
                        },
                        inputHeightPx: sourceRaster.height,
                        inputWidthPx: sourceRaster.width,
                        matchedCanvasContentHeightPx: sourceRaster.height,
                        matchedCanvasContentWidthPx: sourceRaster.width,
                        outputHeightPx: sourceRaster.height,
                        outputWidthPx: sourceRaster.width,
                        placementOffsetXPx: 0,
                        placementOffsetYPx: 0,
                    }
                    : nonlinear === 'valid'
                        || nonlinear === 'folded'
                        || nonlinear === 'loss'
                        || nonlinear === 'noninvertible'
                        || nonlinear === 'out-of-bounds'
                        || canonicalGeometry
                        ? {
                            canvasHeightPx: sourceRaster.height * scale,
                            canvasWidthPx: sourceRaster.width * scale,
                            cropRect: {
                                heightPx: sourceRaster.height,
                                widthPx: sourceRaster.width,
                                xPx: 0,
                                yPx: 0,
                            },
                            dewarped: nonlinear === 'valid'
                                || nonlinear === 'folded'
                                || nonlinear === 'loss'
                                || nonlinear === 'noninvertible'
                                || nonlinear === 'out-of-bounds',
                            ...(nonlinear === 'valid'
                                || nonlinear === 'folded'
                                || nonlinear === 'loss'
                                || nonlinear === 'noninvertible'
                                || nonlinear === 'out-of-bounds'
                                ? {dewarpMapping: buildNonlinearMapping(nonlinear)}
                                : {}),
                            forwardTransform: {matrix: [
                                [
                                    1,
                                    0,
                                    0,
                                ],
                                [
                                    0,
                                    1,
                                    0,
                                ],
                                [
                                    0,
                                    0,
                                    1,
                                ],
                            ]},
                            inputHeightPx: sourceRaster.height,
                            inputWidthPx: sourceRaster.width,
                            matchedCanvasContentHeightPx: sourceRaster.height * scale,
                            matchedCanvasContentWidthPx: sourceRaster.width * scale,
                            outputHeightPx: sourceRaster.height * scale,
                            outputWidthPx: sourceRaster.width * scale,
                            placementOffsetXPx: 0,
                            placementOffsetYPx: 0,
                        }
                        : null;
            const mapping = {
                sourcePageToOutputPages: {'1': [1]},
                ...(renderGeometry === null
                    ? {}
                    : {perPageStreamSizes: [{
                        outputPageNumber: 1,
                        renderGeometry,
                    }]}),
            };
            await writeFile(`${cleaned}.summary.json`, JSON.stringify(mapping));
        }
        const exitCode = await runAudit(source, cleaned, reportPath, {
            failOn,
            verifyStamp: false,
        });
        const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
            pages: Array<{
                alignment?: {
                    attemptedScales?: string[];
                    reliable?: boolean;
                    scale?: string;
                    scaleX?: number;
                    scaleY?: number;
                };
                auditDilationRadius?: number;
                components?: Array<{
                    area?: number;
                    bbox?: {
                        height?: number;
                        width?: number;
                    };
                    classification?: string;
                    unsupportedFraction?: number;
                }>;
                damagedCount?: number;
                comparisonSuppressed?: string;
                flagged?: boolean;
                inventedCount?: number;
                inventedFlagged?: boolean;
                inventedInkFraction?: number;
                inventedSourceSupport?: {
                    alignmentRadiusPx?: number;
                    minimumComponentArea?: number;
                    minimumUnsupportedComponentArea?: number;
                };
                localRealignment?: {
                    improvedComponents?: number;
                    maxShiftDistance?: number;
                    radiusPx?: number;
                };
                lostCount?: number;
            }>;
            summary?: {
                suppressedCount?: number;
                suppressedPages?: number[]
            }
        };
        await rm(temporaryDirectory, {
            force: true,
            recursive: true,
        });
        const page = report.pages[0];
        if (!page) {
            throw new Error('Synthetic audit did not return a page row');
        }
        return {
            exitCode,
            page,
            summary: report.summary,
        };
    }

    it('uses a declared nonlinear grid for an unchanged page', async () => {
        const result = await runSyntheticCase('equal', {nonlinear: 'valid'});

        expect(result.exitCode).toBe(0);
        expect(result.page).toMatchObject({
            alignment: {
                attemptedScales: ['canonical-dewarp-grid(3x3)'],
                reliable: true,
            },
            flagged: false,
            lostCount: 0,
        });
    }, 30_000);

    it('detects loss through a declared nonlinear grid', async () => {
        const result = await runSyntheticCase('equal', {nonlinear: 'loss'});

        expect(result.exitCode).toBe(1);
        expect(result.page).toMatchObject({
            alignment: {
                attemptedScales: ['canonical-dewarp-grid(3x3)'],
                reliable: true,
            },
            flagged: true,
            lossFlagged: true,
        });
        expect(result.page.lostCount).toBeGreaterThan(0);
    }, 30_000);

    it('fails closed when a dewarped page omits its mapping', async () => {
        const result = await runSyntheticCase('equal', {nonlinear: 'missing'});

        expect(result.exitCode).toBe(1);
        expect(result.page).toMatchObject({
            reason: 'dewarped output has no declared dewarpMapping',
            status: 'skipped',
        });
        expect(result.summary).toMatchObject({
            auditCoverageComplete: false,
            skippedPages: [1],
        });
    }, 30_000);

    it('keeps report-only mode non-failing for incomplete dewarp coverage', async () => {
        const result = await runSyntheticCase('equal', {
            failOn: 'none',
            nonlinear: 'missing',
        });

        expect(result.exitCode).toBe(0);
        expect(result.summary).toMatchObject({
            auditCoverageComplete: false,
            skippedPages: [1],
        });
    }, 30_000);

    it('reports malformed dewarp mappings as errors', async () => {
        const result = await runSyntheticCase('equal', {nonlinear: 'malformed'});

        expect(result.exitCode).toBe(1);
        expect(result.page).toMatchObject({
            error: 'dewarpMapping grid points or output dimensions are invalid',
            status: 'error',
        });
        expect(result.summary).toMatchObject({
            auditCoverageComplete: false,
            errorPages: [1],
        });
    }, 30_000);

    it.each([
        [
            'folded',
            'dewarpMapping is folded or non-invertible',
        ],
        [
            'noninvertible',
            'dewarpMapping is folded or non-invertible',
        ],
        [
            'out-of-bounds',
            'dewarpMapping contains out-of-bounds coordinates',
        ],
    ] as const)('rejects a semantically invalid %s grid', async (variant, reason) => {
        const result = await runSyntheticCase('equal', {nonlinear: variant});

        expect(result.exitCode).toBe(1);
        expect(result.page).toMatchObject({
            error: reason,
            status: 'error',
        });
        expect(result.summary).toMatchObject({
            auditCoverageComplete: false,
            errorPages: [1],
        });
    }, 30_000);

    it('flags a solid cleaned-page bar with no source-raw support', async () => {
        const result = await runSyntheticCase('invented');

        expect(result.exitCode).toBe(1);
        expect(result.page.alignment).toMatchObject({reliable: true});
        expect(result.page).toMatchObject({
            flagged: true,
            inventedCount: 1,
            inventedFlagged: true,
        });
        expect(result.page.inventedInkFraction).toBeGreaterThan(0);
        expect(result.page.components).toEqual(expect.arrayContaining([expect.objectContaining({
            bbox: expect.objectContaining({
                height: 20,
                width: 64,
            }),
            classification: 'invented',
            unsupportedFraction: 1,
        })]));
    }, 30_000);

    it('flags a sparse connected invention without requiring a dense bounding box', async () => {
        const result = await runSyntheticCase('sparse-invented');

        expect(result.exitCode).toBe(1);
        expect(result.page).toMatchObject({
            flagged: true,
            inventedCount: 1,
            inventedFlagged: true,
        });
        expect(result.page.components).toEqual(expect.arrayContaining([expect.objectContaining({
            bbox: expect.objectContaining({
                height: 65,
                width: 95,
            }),
            classification: 'invented',
            unsupportedFraction: 1,
        })]));
    }, 30_000);

    it('makes fail-on any fail closed when comparison alignment is unreliable', async () => {
        const result = await runSyntheticCase('unrelated');

        expect(result.exitCode).toBe(1);
        expect(result.page).toMatchObject({
            alignment: {reliable: false},
            comparisonSuppressed: 'alignment overlap below reliable threshold',
        });
        expect(result.summary).toMatchObject({
            suppressedCount: 1,
            suppressedPages: [1],
        });
    }, 30_000);

    it('makes enforced text-loss fail when comparison alignment is suppressed', async () => {
        const result = await runSyntheticCase('unrelated', {failOn: 'text-loss'});

        expect(result.exitCode).toBe(1);
        expect(result.page).toMatchObject({
            alignment: {reliable: false},
            comparisonSuppressed: 'alignment overlap below reliable threshold',
        });
        expect(result.summary).toMatchObject({
            suppressedCount: 1,
            suppressedPages: [1],
        });
    }, 30_000);

    it('keeps a cleaned page that only thickens existing strokes clean', async () => {
        const result = await runSyntheticCase('thick');

        expect(result.exitCode).toBe(0);
        expect(result.page).toMatchObject({
            flagged: false,
            inventedCount: 0,
            inventedFlagged: false,
            inventedInkFraction: 0,
        });
    }, 30_000);

    it('does not call a mostly supported component with a resampled fringe invented', async () => {
        const result = await runSyntheticCase('attached-fringe', {
            canonicalGeometry: true,
            mapped: true,
        });

        expect(result.exitCode).toBe(0);
        expect(result.page).toMatchObject({
            flagged: false,
            inventedCount: 0,
            inventedFlagged: false,
        });
        expect(result.page.components).toBeUndefined();
    }, 30_000);

    it('keeps a cleaned page equal to source clean', async () => {
        const result = await runSyntheticCase('equal');

        expect(result.exitCode).toBe(0);
        expect(result.page).toMatchObject({
            flagged: false,
            inventedCount: 0,
            inventedFlagged: false,
            inventedInkFraction: 0,
        });
    }, 30_000);

    it('normalizes 2x mapped bilevel tolerances without hiding an invented physical bar', async () => {
        const mappedOptions = {
            mapped: true,
            scale: 2,
            sourceBitsPerComponent: 1,
        };
        for (const variant of [
            'equal',
            'thick',
        ] as const) {
            const result = await runSyntheticCase(variant, mappedOptions);
            expect(result.exitCode).toBe(0);
            expect(result.page).toMatchObject({
                alignment: {
                    attemptedScales: expect.arrayContaining(['uniform-fit(2.000000)']),
                    scaleX: 2,
                },
                auditDilationRadius: 2,
                damagedCount: 0,
                flagged: false,
                inventedCount: 0,
                inventedFlagged: false,
                inventedSourceSupport: {
                    alignmentRadiusPx: 16,
                    minimumUnsupportedComponentArea: 800,
                },
                lostCount: 0,
            });
        }

        const invented = await runSyntheticCase('invented', mappedOptions);
        expect(invented.exitCode).toBe(1);
        expect(invented.page.alignment).toMatchObject({reliable: true});
        expect(invented.page).toMatchObject({
            alignment: {
                attemptedScales: expect.arrayContaining(['uniform-fit(2.000000)']),
                scaleX: 2,
            },
            auditDilationRadius: 2,
            flagged: true,
            inventedCount: 1,
            inventedFlagged: true,
        });
        expect(invented.page.components).toEqual(expect.arrayContaining([expect.objectContaining({
            bbox: expect.objectContaining({
                height: 40,
                width: 128,
            }),
            classification: 'invented',
        })]));
    }, 30_000);

    it('uses canonical geometry and bit depth for a mapped 1-bit image', async () => {
        const result = await runSyntheticCase('equal', {
            canonicalGeometry: true,
            cleanedImageMask: false,
            mapped: true,
            scale: 2,
            sourceBitsPerComponent: 1,
        });

        expect(result.exitCode).toBe(0);
        expect(result.page).toMatchObject({
            alignment: {
                attemptedScales: ['canonical-geometry(2.000000x2.000000)'],
                scaleX: 2,
                scaleY: 2,
            },
            auditDilationRadius: 2,
            flagged: false,
            inventedCount: 0,
            lostCount: 0,
        });
    }, 30_000);

    it('uses output-grid areas so only the larger unsupported 2x island flags', async () => {
        const result = await runSyntheticCase('scaled-islands', {
            mapped: true,
            scale: 2,
        });

        expect(result.exitCode).toBe(1);
        expect(result.page).toMatchObject({
            alignment: {
                scaleX: 2,
                scaleY: 2,
            },
            inventedCount: 1,
            inventedFlagged: true,
            inventedSourceSupport: {
                alignmentRadiusPx: 16,
                minimumComponentArea: 96,
                minimumUnsupportedComponentArea: 800,
            },
        });
        expect(result.page.components).toEqual(expect.arrayContaining([
            expect.objectContaining({
                area: 600,
                bbox: expect.objectContaining({
                    height: 30,
                    width: 20,
                }),
                classification: 'ignored-dust',
            }),
            expect.objectContaining({
                area: 900,
                bbox: expect.objectContaining({
                    height: 30,
                    width: 30,
                }),
                classification: 'invented',
            }),
        ]));
    }, 30_000);

    it('scales local component tolerance and dilation on a fitted 2x grid', async () => {
        const result = await runSyntheticCase('scaled-local-shift', {
            mapped: true,
            scale: 2,
        });

        expect(result.exitCode).toBe(0);
        expect(result.page).toMatchObject({
            alignment: {
                scaleX: 2,
                scaleY: 2,
            },
            auditDilationRadius: 2,
            flagged: false,
            inventedCount: 0,
            localRealignment: {radiusPx: 16},
        });
        expect(result.page.localRealignment?.improvedComponents).toBeGreaterThan(0);
        expect(result.page.localRealignment?.maxShiftDistance).toBeGreaterThan(8);
    }, 30_000);
});
