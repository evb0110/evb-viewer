import {spawnSync} from 'node:child_process';
import {
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';

const oraclePath = resolve('scripts/diagnostics/stroke-weight-oracle/stroke_weight_oracle.py');
const specimenPath = resolve(
    'native/scan-cleanup/tests/fixtures/rescue/luther-p5-diyarbakir-line.png',
);
const python = process.env.EVB_PYTHON ?? 'python3';
const temporaryDirectories: string[] = [];

const runOracle = (args: string[]) => spawnSync(python, [
    oraclePath,
    ...args,
], {encoding: 'utf8'});

/**
 * The measurement helper needs OpenCV, NumPy and Pillow. Only the Pillow lane
 * is installed in CI today; wiring the full dependency set into a gate is
 * S5(d), so the measuring case declares itself skipped rather than failing a
 * machine that cannot run it.
 */
const measurementDependenciesInstalled = spawnSync(python, [
    '-c',
    'import cv2, numpy, PIL',
], {encoding: 'utf8'}).status === 0;

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
        force: true,
        recursive: true,
    })));
});

describe('stroke weight oracle CLI', () => {
    it.skipIf(!measurementDependenciesInstalled)(
        'measures the committed Vorwort specimen and emits the report schema',
        async () => {
            const directory = await mkdtemp(join(tmpdir(), 'evb-stroke-weight-oracle-'));
            temporaryDirectories.push(directory);
            const reportPath = join(directory, 'report.json');
            const result = runOracle([
                '--image',
                specimenPath,
                '--dpi',
                '300',
                '--label',
                'specimen-invocation-test',
                '--out',
                reportPath,
            ]);
            expect(result.stderr).toBe('');
            expect([
                0,
                1,
            ]).toContain(result.status);
            const report = JSON.parse(await readFile(reportPath, 'utf8'));
            expect(report.schemaVersion).toBe(3);
            expect(report.oracle).toBe('component-ridge-width-local-line-median');
            expect(report.label).toBe('specimen-invocation-test');
            expect(report.calibration).toMatchObject({
                connectivity: 8,
                localWindowMinComponents: 7,
                localWindowMm: 32,
                minimumLineComponents: 8,
                offenderRatio: 1.6,
            });
            expect(report.summary).toMatchObject({
                gatePass: expect.any(Boolean),
                offenderCount: expect.any(Number),
                pageCountMeasured: 1,
                pageCountRequested: 1,
                pageCountUnmeasured: 0,
            });
            const [page] = report.pages;
            expect(page).toMatchObject({
                source: 'image',
                status: 'measured',
            });
            expect(page.measuredLineCount).toBeGreaterThan(0);
            expect(page.lines[0]).toMatchObject({
                componentCount: expect.any(Number),
                offenderCount: expect.any(Number),
                p50WidthMm: expect.any(Number),
                p95P50Ratio: expect.any(Number),
            });
            expect(JSON.parse(result.stdout)).toEqual(report.summary);
        },
    );

    it.skipIf(!measurementDependenciesInstalled)(
        'stabilizes a sparse-line denominator against a population-only median collapse',
        async () => {
            const directory = await mkdtemp(join(tmpdir(), 'evb-stroke-weight-sparse-'));
            temporaryDirectories.push(directory);
            const sparsePath = join(directory, 'sparse-line.png');
            const reportPath = join(directory, 'report.json');
            const createImage = spawnSync(python, [
                '-c',
                [
                    'from PIL import Image, ImageDraw',
                    'import sys',
                    'image = Image.new("L", (1500, 240), 255)',
                    'draw = ImageDraw.Draw(image)',
                    'for i in range(53): draw.rectangle((10 + i * 22, 20, 17 + i * 22, 50), fill=0)',
                    'for i in range(37): draw.rectangle((10 + i * 30, 100, 13 + i * 30 if i < 19 else 17 + i * 30, 130), fill=0)',
                    'for i in range(53): draw.rectangle((10 + i * 22, 180, 13 + i * 22 if i < 19 else 17 + i * 22, 210), fill=0)',
                    'image.save(sys.argv[1])',
                ].join('\n'),
                sparsePath,
            ], {encoding: 'utf8'});
            expect(createImage.status).toBe(0);

            const result = runOracle([
                '--image',
                sparsePath,
                '--dpi',
                '300',
                '--out',
                reportPath,
            ]);
            expect(result.status).toBe(0);
            const report = JSON.parse(await readFile(reportPath, 'utf8'));
            expect(report.summary).toMatchObject({
                gatePass: true,
                offenderCount: 0,
                pageCountMeasured: 1,
                pageCountUnmeasured: 0,
            });
            expect(report.pages[0]).toMatchObject({
                status: 'measured',
                sparseLineCount: 1,
                sparseLinePopulationFloor: 40,
                pageFallbackMeasuredLineCount: 3,
                pageFallbackTrusted: true,
                lines: [
                    {
                        componentCount: 53,
                        status: 'measured',
                    },
                    {
                        comparison: 'page-median-fallback',
                        status: 'measured-sparse-line-fallback',
                        componentCount: 37,
                        offenderCount: 0,
                    },
                    {
                        comparison: 'line-local',
                        status: 'measured',
                        componentCount: 53,
                        offenderCount: 0,
                    },
                ],
            });
            const [
                , sparseLine,
                expandedLine,
            ] = report.pages[0].lines;
            expect(sparseLine.p50WidthMm).toBeCloseTo(
                sparseLine.referenceP50WidthMm / 2,
                5,
            );
            expect(sparseLine.referenceP50WidthMm).toBe(expandedLine.referenceP50WidthMm);
            expect(sparseLine.referenceP95P50Ratio).toBe(expandedLine.referenceP95P50Ratio);
        },
    );

    it.skipIf(!measurementDependenciesInstalled)(
        'does not trust page fallback when populated lines have no measurable local window',
        async () => {
            const directory = await mkdtemp(join(tmpdir(), 'evb-stroke-weight-dispersed-'));
            temporaryDirectories.push(directory);
            const imagePath = join(directory, 'dispersed-lines.png');
            const reportPath = join(directory, 'report.json');
            const createImage = spawnSync(python, [
                '-c',
                [
                    'from PIL import Image, ImageDraw',
                    'import sys',
                    'image = Image.new("L", (18000, 180), 255)',
                    'draw = ImageDraw.Draw(image)',
                    'for y in (25, 105):',
                    '    for i in range(40):',
                    '        x = 20 + i * 430',
                    '        draw.rectangle((x, y, x + 7, y + 28), fill=0)',
                    'image.save(sys.argv[1])',
                ].join('\n'),
                imagePath,
            ], {encoding: 'utf8'});
            expect(createImage.status).toBe(0);

            const result = runOracle([
                '--image',
                imagePath,
                '--dpi',
                '300',
                '--out',
                reportPath,
            ]);
            expect(result.status).toBe(0);
            const report = JSON.parse(await readFile(reportPath, 'utf8'));
            expect(report.pages[0]).toMatchObject({
                pageFallbackMeasuredLineCount: 0,
                pageFallbackTrusted: false,
            });
        },
    );
});
