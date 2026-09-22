import {
    describe,
    expect,
    it,
} from 'vitest';
import type {TScanCleanupProgress} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {createScanCleanupProgressEtaEstimator} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import type {TTranslateFn} from '@i18n-app';
import {
    formatScanCleanupDuration,
    formatScanCleanupEta,
    formatScanCleanupProgress,
    resolveScanCleanupTimeWidestText,
} from '@app/modules/scan-cleanup/runtime/formatScanCleanupProgress';
import {
    type IScanCleanupDetectionActivityInput,
    resolveScanCleanupActivity,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupActivity';

const t: TTranslateFn = (key, ...args) => {
    const parameter = args[0];
    const parameters = typeof parameter === 'object' && parameter !== null
        ? parameter
        : {};
    return Object.entries(parameters).reduce<string>(
        (value, [
            name,
            replacement,
        ]) => `${value} ${name}=${String(replacement)}`,
        String(key),
    );
};

function progress(overrides: Partial<TScanCleanupProgress>): TScanCleanupProgress {
    return {
        stage: 'detecting',
        completedUnits: 0,
        totalUnits: 148,
        percent: 0,
        ...overrides,
    };
}

function analysis(overrides: Partial<IScanCleanupDetectionActivityInput>): IScanCleanupDetectionActivityInput {
    return {
        pending: true,
        progress: null,
        analyzedPages: 0,
        totalPages: 148,
        calibrating: false,
        ...overrides,
    };
}

describe('scan cleanup progress ETA', () => {
    it('estimates from the average rate so a burst after a slow read does not promise seconds', () => {
        const estimator = createScanCleanupProgressEtaEstimator();

        expect(estimator.update('detecting', 0, 148, 0)).toBeUndefined();
        // The first batch of page images took 22 s; its sixteen verdicts then
        // arrive within two seconds.
        expect(estimator.update('detecting', 16, 148, 24_000)).toBe(198);
    });

    it('lets the estimate grow when the work slows down', () => {
        const estimator = createScanCleanupProgressEtaEstimator();
        estimator.update('rendering', 0, 100, 0);
        const early = estimator.update('rendering', 50, 100, 10_000);
        const later = estimator.update('rendering', 51, 100, 30_000);

        expect(early).toBe(10);
        expect(later).toBeGreaterThan(early!);
    });

    it('resets the estimate when the progress stage changes', () => {
        const estimator = createScanCleanupProgressEtaEstimator();
        estimator.update('detecting', 0, 10, 0);
        estimator.update('detecting', 5, 10, 10_000);

        expect(estimator.update('rendering', 0, 10, 11_000)).toBeUndefined();
    });
});

describe('scan cleanup time captions', () => {
    it('states the time left in plain units', () => {
        expect(formatScanCleanupEta(1, t)).toBe('scanCleanup.activity.etaSeconds seconds=5');
        expect(formatScanCleanupEta(41, t)).toBe('scanCleanup.activity.etaSeconds seconds=45');
        expect(formatScanCleanupEta(60, t)).toBe('scanCleanup.activity.etaMinutes minutes=1');
        expect(formatScanCleanupEta(61, t)).toBe('scanCleanup.activity.etaMinutes minutes=2');
    });

    it('reads elapsed time as a clock', () => {
        expect(formatScanCleanupDuration(7_900)).toBe('0:07');
        expect(formatScanCleanupDuration(62_000)).toBe('1:02');
        expect(formatScanCleanupDuration(3_750_000)).toBe('1:02:30');
    });

    it('reserves the widest time caption', () => {
        expect(resolveScanCleanupTimeWidestText(t).length)
            .toBeGreaterThanOrEqual(formatScanCleanupEta(120, t).length);
    });
});

describe('scan cleanup activity', () => {
    it('is absent when neither analysis nor a run is under way', () => {
        expect(resolveScanCleanupActivity({
            detection: analysis({pending: false}),
            run: null,
        })).toBeNull();
    });

    it('names the page-image read that precedes the first verdict instead of an unexplained zero', () => {
        const waiting = resolveScanCleanupActivity({
            detection: analysis({progress: progress({stage: 'rasterizing'})}),
            run: null,
        })!;
        const reading = resolveScanCleanupActivity({
            detection: analysis({progress: progress({
                stage: 'rasterizing',
                completedUnits: 7,
                rasterizedUnits: 7,
            })}),
            run: null,
        })!;

        expect(waiting.detail).toBe('read');
        expect(waiting.fraction).toBeNull();
        expect(reading.detail).toBe('read');
        expect(reading.count).toEqual({
            completed: 0,
            total: 148,
        });
        expect(reading.bufferFraction).toBeCloseTo(7 / 148);
        expect(reading.steps.find(step => step.id === 'read')?.count).toEqual({
            completed: 7,
            total: 148,
        });
    });

    it('keeps one sentence while reading runs ahead of detection and never moves the verdict count backward', () => {
        const detecting = resolveScanCleanupActivity({
            detection: analysis({
                analyzedPages: 16,
                progress: progress({
                    completedUnits: 16,
                    rasterizedUnits: 16,
                    etaSeconds: 198,
                }),
            }),
            run: null,
        })!;
        const readingNextBatch = resolveScanCleanupActivity({
            detection: analysis({
                analyzedPages: 16,
                progress: progress({
                    completedUnits: 16,
                    rasterizedUnits: 21,
                    etaSeconds: 198,
                }),
            }),
            run: null,
        })!;

        expect(detecting.detail).toBe('detect');
        // The sentence stays on the measured work while the next batch is read.
        expect(readingNextBatch.detail).toBe('detect');
        expect(readingNextBatch.steps.filter(step => step.state === 'active').map(step => step.id)).toEqual([
            'read',
            'detect',
        ]);
        expect(readingNextBatch.count).toEqual(detecting.count);
        expect(readingNextBatch.fraction).toBeCloseTo(16 / 148);
        expect(readingNextBatch.bufferFraction).toBeCloseTo(21 / 148);
        expect(readingNextBatch.etaSeconds).toBe(198);
    });

    it('reports the document-wide re-check once every page has a verdict', () => {
        const activity = resolveScanCleanupActivity({
            detection: analysis({
                analyzedPages: 148,
                progress: progress({
                    completedUnits: 148,
                    rasterizedUnits: 148,
                    recheckedUnits: 12,
                }),
            }),
            run: null,
        })!;

        expect(activity.step).toBe('compare');
        expect(activity.detail).toBe('compare');
        expect(activity.etaSeconds).toBeUndefined();
        expect(activity.steps.map(step => [
            step.id,
            step.state,
        ])).toEqual([
            [
                'read',
                'done',
            ],
            [
                'detect',
                'done',
            ],
            [
                'compare',
                'active',
            ],
            [
                'prepare',
                'waiting',
            ],
            [
                'clean',
                'waiting',
            ],
            [
                'build',
                'waiting',
            ],
            [
                'open',
                'waiting',
            ],
        ]);
        expect(activity.steps.find(step => step.id === 'compare')?.count).toEqual({completed: 12});
    });

    it('continues the analysis account when Clean up is clicked during analysis', () => {
        const detection = analysis({
            analyzedPages: 56,
            progress: progress({
                completedUnits: 56,
                rasterizedUnits: 64,
            }),
        });
        const before = resolveScanCleanupActivity({
            detection,
            run: null,
        })!;
        const after = resolveScanCleanupActivity({
            detection,
            run: {
                waitingForDetection: true,
                starting: false,
                progress: null,
                committing: false,
            },
        })!;

        expect(after.run).toBe(true);
        expect({
            ...after,
            run: before.run,
        }).toEqual(before);
    });

    it('maps every run stage onto a named step with earlier steps done', () => {
        const stepFor = (stage: TScanCleanupProgress['stage'], committing = false) => resolveScanCleanupActivity({
            detection: analysis({pending: false}),
            run: {
                waitingForDetection: false,
                starting: false,
                progress: progress({
                    stage,
                    completedUnits: 3,
                    totalUnits: 148,
                    percent: 40,
                }),
                committing,
            },
        })!;

        expect([
            'normalizing',
            'probing',
            'extracting',
            'rasterizing',
            'classifying',
            'rendering',
            'collecting',
            'assembling',
            'handoff',
        ].map(stage => stepFor(stage as TScanCleanupProgress['stage']).step)).toEqual([
            'prepare',
            'prepare',
            'prepare',
            'clean',
            'clean',
            'clean',
            'build',
            'build',
            'open',
        ]);
        expect(stepFor('assembling', true).step).toBe('open');
        const cleaning = stepFor('rendering');
        expect(cleaning.phase).toBe('clean');
        expect(cleaning.count).toEqual({
            completed: 3,
            total: 148,
        });
        expect(cleaning.fraction).toBeCloseTo(0.4);
        expect(cleaning.steps.filter(step => step.phase === 'analyze').every(step => step.state === 'done')).toBe(true);
        const building = stepFor('assembling');
        expect(building.count).toBeNull();
        expect(building.fraction).toBeNull();
    });

    it('describes a run seen from the reader toolbar with the same words', () => {
        expect(formatScanCleanupProgress(progress({
            stage: 'rendering',
            completedUnits: 42,
        }), t).text)
            .toBe('scanCleanup.runStatus phase=scanCleanup.activity.detail.rendering counter=scanCleanup.runCount completed=42 total=148');
        expect(formatScanCleanupProgress(progress({
            stage: 'assembling',
            completedUnits: 2,
            totalUnits: 9,
        }), t).text)
            .toBe('scanCleanup.activity.detail.assembling');
    });
});
