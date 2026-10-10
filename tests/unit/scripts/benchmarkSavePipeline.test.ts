import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    assertSemanticParity,
    buildSavePipelineBenchmarkReport,
    normalizeSemanticReopenSummary,
    parseSavePipelineBenchmarkArgs,
    validateSavePipelineBenchmarkOptions,
} from '@scripts/benchmark-save-pipeline.mjs';

describe('benchmark-save-pipeline', () => {
    it('treats popup companions as structural rather than semantic annotations', () => {
        expect(normalizeSemanticReopenSummary({
            total: 2,
            bySubtype: {
                FreeText: 1,
                Popup: 1,
            },
        })).toEqual({
            total: 1,
            bySubtype: {FreeText: 1},
        });
    });

    it('rejects malformed or internally inconsistent semantic summaries', () => {
        expect(() => normalizeSemanticReopenSummary({
            total: 1,
            bySubtype: {FreeText: -1},
        })).toThrow('Invalid semantic reopen subtype count');
        expect(() => normalizeSemanticReopenSummary({
            total: 1,
            bySubtype: {FreeText: '1'},
        })).toThrow('Invalid semantic reopen subtype count');
        expect(() => normalizeSemanticReopenSummary({
            total: 2,
            bySubtype: {FreeText: 1},
        })).toThrow('Semantic reopen total does not match subtype counts');
    });

    it('requires every scenario to persist exactly one additional FreeText annotation', () => {
        expect(assertSemanticParity([
            {
                scenario: 'native-freetext-high',
                sourceSemanticReopen: {
                    total: 0,
                    bySubtype: {},
                },
                semanticReopen: {
                    total: 2,
                    bySubtype: {
                        FreeText: 1,
                        Popup: 1,
                    },
                },
            },
            {
                scenario: 'serialized-fallback-low',
                sourceSemanticReopen: {
                    total: 0,
                    bySubtype: {},
                },
                semanticReopen: {
                    total: 1,
                    bySubtype: {FreeText: 1},
                },
            },
        ])).toEqual({
            total: 1,
            bySubtype: {FreeText: 1},
        });
        expect(() => assertSemanticParity([{
            scenario: 'serialized-fallback-high',
            sourceSemanticReopen: {
                total: 0,
                bySubtype: {},
            },
            semanticReopen: {
                total: 0,
                bySubtype: {},
            },
        }])).toThrow('exactly one additional FreeText annotation');
    });

    it('parses the documented benchmark options', () => {
        expect(parseSavePipelineBenchmarkArgs([
            '--fixture',
            '/tmp/input.pdf',
            '--iterations',
            '7',
            '--output',
            '.devkit/analysis/save.json',
            '--warmups',
            '3',
        ])).toEqual({
            fixture: '/tmp/input.pdf',
            help: false,
            iterations: 7,
            output: '.devkit/analysis/save.json',
            warmups: 3,
        });
    });

    it('accepts the wp6 diagnostic input and output aliases', () => {
        expect(parseSavePipelineBenchmarkArgs([
            '--pdf',
            '/tmp/input.pdf',
            '--out',
            '.devkit/analysis/save.json',
        ])).toEqual({
            fixture: '/tmp/input.pdf',
            help: false,
            iterations: 10,
            output: '.devkit/analysis/save.json',
            warmups: 5,
        });
    });

    it('ignores the leading -- separator that pnpm forwards for both alias forms', () => {
        expect(parseSavePipelineBenchmarkArgs([
            '--',
            '--fixture',
            '/tmp/input.pdf',
            '--output',
            '.devkit/analysis/save.json',
        ])).toEqual({
            fixture: '/tmp/input.pdf',
            help: false,
            iterations: 10,
            output: '.devkit/analysis/save.json',
            warmups: 5,
        });
        expect(parseSavePipelineBenchmarkArgs([
            '--',
            '--pdf',
            '/tmp/input.pdf',
            '--out',
            '.devkit/analysis/save.json',
        ])).toEqual({
            fixture: '/tmp/input.pdf',
            help: false,
            iterations: 10,
            output: '.devkit/analysis/save.json',
            warmups: 5,
        });
    });

    it('pins the report contract the e2e scenarios feed into', () => {
        const scenario = {
            schemaVersion: 1,
            scenario: 'native-freetext-high',
            mode: 'native-freetext',
            annotationAction: 'page-note',
            tier: 'high',
            hostProfile: {tier: 'high'},
            fixturePath: '/tmp/input.pdf',
            inputPath: '/tmp/input.pdf',
            outputPath: '/tmp/out.json.native-freetext-high.pdf',
            warmups: 5,
            iterations: 10,
            iterationMeasurements: [{
                iteration: 1,
                afterBytes: 2048,
                beforeBytes: 1024,
                durationMs: 12.5,
                peakRssBytes: 4096,
                timestamp: '2026-07-25T00:00:00.000Z',
            }],
            totalMs: {
                p50: 12.5,
                p95: 18.5,
                samples: [
                    12.5,
                    18.5,
                ],
            },
            peakRssBytes: 4096,
            inputBytes: 1024,
            outputBytes: 2048,
            outputSha256: 'a'.repeat(64),
            sourceSemanticReopen: {
                total: 0,
                bySubtype: {},
            },
            semanticReopen: {
                total: 2,
                bySubtype: {
                    FreeText: 1,
                    Popup: 1,
                },
            },
            semanticReopenComparable: {
                total: 1,
                bySubtype: {FreeText: 1},
            },
        };
        const report = buildSavePipelineBenchmarkReport(
            {
                fixture: '/tmp/input.pdf',
                iterations: 10,
                output: '/tmp/out.json',
                warmups: 5,
            },
            [scenario],
            {
                fixtureBytes: 1024,
                fixtureSha256: 'b'.repeat(64),
                generatedAt: '2026-07-25T00:00:00.000Z',
            },
        );
        expect(report).toEqual({
            schemaVersion: 1,
            generatedAt: '2026-07-25T00:00:00.000Z',
            fixturePath: '/tmp/input.pdf',
            fixtureBytes: 1024,
            fixtureSha256: 'b'.repeat(64),
            inputPath: '/tmp/input.pdf',
            outputPath: '/tmp/out.json',
            warmups: 5,
            iterations: 10,
            hostProfile: {tier: 'high'},
            hostTier: 'high',
            cloneMode: {
                measured: 'auto',
                forcedNoClone: 'unavailable',
            },
            semanticParity: null,
            scenarios: [scenario],
        });
        const [reportedScenario] = report.scenarios;
        expect(reportedScenario.totalMs).toEqual({
            p50: 12.5,
            p95: 18.5,
            samples: [
                12.5,
                18.5,
            ],
        });
        expect(reportedScenario.iterationMeasurements).toHaveLength(1);
        expect(reportedScenario.iterationMeasurements[0]?.peakRssBytes).toBe(4096);
        expect(reportedScenario.peakRssBytes).toBe(4096);
        expect(reportedScenario.outputBytes).toBe(2048);
        expect(reportedScenario.outputSha256).toHaveLength(64);
        expect(reportedScenario.semanticReopenComparable).toEqual({
            total: 1,
            bySubtype: {FreeText: 1},
        });
    });

    it('falls back to the applied scenario tier when the host profile is unavailable', () => {
        const report = buildSavePipelineBenchmarkReport(
            {
                fixture: '/tmp/input.pdf',
                iterations: 10,
                output: '/tmp/out.json',
                warmups: 5,
            },
            [{
                hostProfile: null,
                tier: 'low',
            }],
            {
                fixtureBytes: 1024,
                fixtureSha256: 'b'.repeat(64),
                generatedAt: '2026-07-25T00:00:00.000Z',
            },
        );
        expect(report.hostProfile).toBeNull();
        expect(report.hostTier).toBe('low');
    });

    it('resolves the documented relative alias paths from the caller cwd', () => {
        expect(validateSavePipelineBenchmarkOptions({
            fixture: 'relative.pdf',
            iterations: 10,
            output: 'result.json',
            warmups: 5,
        }, '/workspace')).toEqual({
            fixture: resolve('/workspace', 'relative.pdf'),
            iterations: 10,
            output: resolve('/workspace', 'result.json'),
            warmups: 5,
        });
    });

    it('requires a fixture and positive run counts', () => {
        expect(() => validateSavePipelineBenchmarkOptions({
            fixture: null,
            iterations: 10,
            output: 'result.json',
            warmups: 5,
        })).toThrow('--fixture is required');
        expect(() => validateSavePipelineBenchmarkOptions({
            fixture: '/tmp/input.pdf',
            iterations: 0,
            output: 'result.json',
            warmups: 5,
        })).toThrow('--iterations must be a positive integer');
    });

    it('rejects unknown options and missing option values', () => {
        expect(() => parseSavePipelineBenchmarkArgs(['--unknown']))
            .toThrow('Unknown benchmark option: --unknown');
        expect(() => parseSavePipelineBenchmarkArgs([
            '--fixture',
            '--help',
        ]))
            .toThrow('--fixture requires a value');
        expect(() => parseSavePipelineBenchmarkArgs(['--out']))
            .toThrow('--out requires a value');
    });

    it('rejects fractional and partially numeric run counts', () => {
        const fractional = parseSavePipelineBenchmarkArgs([
            '--fixture',
            'input.pdf',
            '--output',
            'output.json',
            '--iterations',
            '1.5',
        ]);
        expect(() => validateSavePipelineBenchmarkOptions(fractional))
            .toThrow('--iterations must be a positive integer');
        const partial = parseSavePipelineBenchmarkArgs([
            '--fixture',
            'input.pdf',
            '--output',
            'output.json',
            '--warmups',
            '10garbage',
        ]);
        expect(() => validateSavePipelineBenchmarkOptions(partial))
            .toThrow('--warmups must be a positive integer');
    });
});
