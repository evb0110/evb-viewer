import {
    crossResolutionModeEvidence,
    pagePlanParityFailures,
    reusablePagePlan,
} from '@scripts/diagnostics/scan-cleanup-corpus-plan.mjs';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    readFileSync,
    readdirSync,
} from 'node:fs';

function rustPaleCollapseWarning(pageNumber: number, half: string) {
    const stageDirectory = new URL('../../../native/scan-cleanup/src/engine/render/', import.meta.url);
    const sourcePaths = [
        new URL('../../../native/scan-cleanup/src/engine/render.rs', import.meta.url),
        ...readdirSync(stageDirectory, {withFileTypes: true})
            .filter(entry => (
                entry.isFile()
                && entry.name.endsWith('.rs')
                && !/(?:^|[._-])tests?(?:[._-]|$)/iu.test(entry.name)
            ))
            .map(entry => new URL(entry.name, stageDirectory)),
    ];
    const source = sourcePaths.map(path => readFileSync(path, 'utf8')).join('\n');
    const templates = [...source.matchAll(
        /conservation_warnings\.push\(format!\(\s*"([^"]+)"\s*,\s*source_page_index \+ 1,\s*page_half_label\(half\)\s*\)\);/g,
    )].map(match => match[1]);
    const uniqueTemplates = [...new Set(templates)];
    const template = uniqueTemplates[0];
    if (template === undefined || uniqueTemplates.length !== 1) {
        throw new Error(`Expected one shared Rust pale-collapse warning, found ${JSON.stringify(uniqueTemplates)}`);
    }
    return template
        .replace('{}', String(pageNumber))
        .replace('{}', half);
}

const tone = {
    applied: true,
    rule: 'applied',
    inkAnchor: 112,
};

function analysis() {
    return {
        cutterXPx: 400,
        layoutClassification: 'two-page-spread',
        recommendedOutputMode: 'grayscale',
        rotationDegrees: 0,
    };
}

function previewOutput() {
    return {
        contentBox: {
            xPx: 20,
            yPx: 10,
            widthPx: 300,
            heightPx: 420,
        },
        detectedSkewDegrees: -0.2,
        half: 'left',
        inputHeightPx: 500,
        inputWidthPx: 1_000,
        manualSkew: false,
        outputMode: 'grayscale',
        rotationDegrees: 0,
        skewApplied: true,
        sourceRegion: {
            xPx: 0,
            yPx: 0,
            widthPx: 400,
            heightPx: 500,
        },
        textToneDiagnostics: tone,
    };
}

describe('scan cleanup corpus preview-plan replay', () => {
    it('normalizes half-local content geometry against the full rotated input', () => {
        expect(reusablePagePlan(
            analysis(),
            [previewOutput()],
            {
                width: 1_000,
                height: 500,
            },
        )).toEqual({
            automaticSplit: {
                xNormalized: 0.4,
                rotationDegrees: 0,
            },
            automaticContentBoxes: {left: {
                xNormalized: 0.02,
                yNormalized: 0.02,
                widthNormalized: 0.3,
                heightNormalized: 0.84,
                rotationDegrees: 0,
            }},
            automaticSkewDegrees: {left: -0.2},
            resolvedTextToneDiagnostics: {left: tone},
            layout: 'force-two-page',
        });
    });

    it('accepts a scaled final replay only when mode, crop, skew, and tone identity match', () => {
        const preview = previewOutput();
        const final = {
            ...preview,
            contentBox: {
                xPx: 40,
                yPx: 20,
                widthPx: 600,
                heightPx: 840,
            },
            inputHeightPx: 1_000,
            inputWidthPx: 2_000,
            sourceRegion: {
                xPx: 0,
                yPx: 0,
                widthPx: 800,
                heightPx: 1_000,
            },
        };
        expect(pagePlanParityFailures(analysis(), [preview], final)).toEqual([]);
        expect(pagePlanParityFailures(analysis(), [preview], {
            ...final,
            outputMode: 'color',
        })).toEqual(['mode color != grayscale']);
    });

    it('allows only a warned pale-collapse grayscale fallback from a B&W recommendation', () => {
        const bwAnalysis = {
            ...analysis(),
            recommendedOutputMode: 'bw',
        };
        const preview = {
            ...previewOutput(),
            outputMode: 'bw',
        };
        const warning = rustPaleCollapseWarning(126, 'left half');
        const final = {
            ...preview,
            outputMode: 'grayscale',
            warnings: [warning],
        };
        expect(pagePlanParityFailures(bwAnalysis, [preview], final)).toEqual([]);
        expect(pagePlanParityFailures(bwAnalysis, [preview], {
            ...final,
            warnings: [],
        })).toEqual(['mode grayscale != bw']);
        expect(pagePlanParityFailures(bwAnalysis, [preview], {
            ...final,
            warnings: ['grayscale fallback was used'],
        })).toEqual(['mode grayscale != bw']);
        expect(pagePlanParityFailures(analysis(), [previewOutput()], {
            ...final,
            outputMode: 'bw',
        })).toEqual(['mode bw != grayscale']);
    });

    it('allows only the unavoidable half-pixel quantization of a replayed split boundary', () => {
        const preview = {
            ...previewOutput(),
            contentBox: {
                xPx: -5.08,
                yPx: -3.72,
                widthPx: 941.16,
                heightPx: 1_274.45,
            },
            inputHeightPx: 1_267,
            inputWidthPx: 1_666,
            sourceRegion: {
                xPx: 0,
                yPx: 0,
                widthPx: 931,
                heightPx: 1_267,
            },
        };
        const final = {
            ...preview,
            contentBox: {
                xPx: 0,
                yPx: 0,
                widthPx: 1_861,
                heightPx: 2_534,
            },
            inputHeightPx: 2_534,
            inputWidthPx: 3_331,
            sourceRegion: {
                xPx: 0,
                yPx: 0,
                widthPx: 1_861,
                heightPx: 2_534,
            },
        };
        expect(pagePlanParityFailures(analysis(), [preview], final)).toEqual([]);
        expect(pagePlanParityFailures(analysis(), [preview], {
            ...final,
            contentBox: {
                ...final.contentBox,
                widthPx: 1_860,
            },
            sourceRegion: {
                ...final.sourceRegion,
                widthPx: 1_860,
            },
        })).toEqual(['content box {"height":1,"width":0.5583908736115281,"x":0,"y":0}'
            + ' != canonical {"height":1,"width":0.5588235294117647,"x":0,"y":0}']);
    });

    it('always serializes rotation on normalized content boxes', () => {
        const rotated = {
            ...analysis(),
            cutterXPx: null,
            layoutClassification: 'single-uncut-page',
            rotationDegrees: 90,
        };
        const output = {
            ...previewOutput(),
            contentBox: {
                xPx: 25,
                yPx: 50,
                widthPx: 200,
                heightPx: 400,
            },
            half: 'full',
            inputHeightPx: 1_000,
            inputWidthPx: 500,
            rotationDegrees: 90,
            sourceRegion: {
                xPx: 0,
                yPx: 0,
                widthPx: 1_000,
                heightPx: 500,
            },
        };
        expect(reusablePagePlan(rotated, [output], {
            width: 500,
            height: 1_000,
        }).automaticContentBoxes).toEqual({full: {
            xNormalized: 0.025,
            yNormalized: 0.1,
            widthNormalized: 0.2,
            heightNormalized: 0.8,
            rotationDegrees: 90,
        }});
    });

    it('clips preview content to its source half before native replay', () => {
        const output = {
            ...previewOutput(),
            contentBox: {
                xPx: -40,
                yPx: -5,
                widthPx: 1_100,
                heightPx: 520,
            },
        };
        expect(reusablePagePlan(analysis(), [output], {
            width: 1_000,
            height: 500,
        }).automaticContentBoxes).toEqual({left: {
            xNormalized: 0,
            yNormalized: 0,
            widthNormalized: 0.4,
            heightNormalized: 1,
            rotationDegrees: 0,
        }});
    });

    it('keeps edge-touching decimal boxes strictly inside the native normalized domain', () => {
        const output = {
            ...previewOutput(),
            contentBox: {
                xPx: 55,
                yPx: 20,
                widthPx: 945,
                heightPx: 450,
            },
            half: 'full',
            sourceRegion: {
                xPx: 0,
                yPx: 0,
                widthPx: 1_000,
                heightPx: 500,
            },
        };
        const plan = reusablePagePlan({
            ...analysis(),
            cutterXPx: null,
            layoutClassification: 'single-uncut-page',
        }, [output], {
            width: 1_000,
            height: 500,
        });
        expect(plan).toBeDefined();
        if (!plan) {
            throw new Error('Expected a reusable page plan');
        }
        const boxes = plan.automaticContentBoxes;
        expect(boxes).toBeDefined();
        if (!boxes) {
            throw new Error('Expected reusable automatic content boxes');
        }
        const box = boxes.full;
        expect(box).toBeDefined();
        if (!box) {
            throw new Error('Expected a reusable full-page content box');
        }
        expect(box.xNormalized + box.widthNormalized).toBeLessThan(1);
        expect(1 - (box.xNormalized + box.widthNormalized)).toBeLessThan(1e-14);
    });

    it('does not apply a right-half source origin to a half-local content box', () => {
        const output = {
            ...previewOutput(),
            contentBox: {
                xPx: 47,
                yPx: 35,
                widthPx: 777,
                heightPx: 1_162,
            },
            half: 'right',
            inputHeightPx: 1_224,
            inputWidthPx: 1_632,
            sourceRegion: {
                xPx: 801,
                yPx: 0,
                widthPx: 831,
                heightPx: 1_224,
            },
        };
        expect(reusablePagePlan(analysis(), [output], {
            width: 1_632,
            height: 1_224,
        }).automaticContentBoxes).toEqual({right: {
            xNormalized: 47 / 1_632,
            yNormalized: 35 / 1_224,
            widthNormalized: 777 / 1_632,
            heightNormalized: 1_162 / 1_224,
            rotationDegrees: 0,
        }});
    });

    it('fails destructive decisions only when final input has material preservation evidence', () => {
        const page = (
            pageNumber: number,
            previewMode: string,
            finalMode: string,
            significantColor = false,
            coherentOutsideTonalRegion = false,
        ) => ({
            analysis: {
                recommendedOutputMode: previewMode,
                outputModeDiagnostics: {
                    coherentOutsideTonalRegion: false,
                    significantColor: false,
                },
            },
            finalInputAnalysis: {
                recommendedOutputMode: finalMode,
                outputModeDiagnostics: {
                    coherentOutsideTonalRegion,
                    significantColor,
                },
            },
            pageNumber,
        });
        expect(crossResolutionModeEvidence([
            page(1, 'bw', 'grayscale'),
            page(2, 'bw', 'grayscale', false, true),
            page(3, 'grayscale', 'mixed'),
            page(4, 'grayscale', 'mixed', true),
        ])).toEqual({
            destructivePages: [
                'p2 bw->grayscale',
                'p4 grayscale->mixed',
            ],
            unstablePages: [
                'p1 bw->grayscale',
                'p2 bw->grayscale',
                'p3 grayscale->mixed',
                'p4 grayscale->mixed',
            ],
        });
    });
});
