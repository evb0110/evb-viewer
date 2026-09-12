import {
    describe,
    expect,
    it,
} from 'vitest';
import {readFileSync} from 'fs';
import {
    decodeNativeScanCleanupEnvelope,
    parseNativeScanCleanupStderr,
} from '@electron/features/scan-cleanup/native/protocolCodec';

describe('scan-cleanup native protocol codec', () => {
    it('does not classify an earlier diagnostic as the native error envelope', () => {
        expect(parseNativeScanCleanupStderr([
            JSON.stringify({
                code: 'too-large',
                message: 'diagnostic',
            }),
            'third-party failure',
        ].join('\n'))).toBeNull();

        expect(parseNativeScanCleanupStderr([
            'third-party diagnostic',
            JSON.stringify({
                code: 'invalid-request',
                message: 'native failure',
            }),
        ].join('\n'))).toEqual({
            code: 'invalid-request',
            message: 'native failure',
        });
    });

    it('decodes incremental analysis progress with an optional provisional classification', () => {
        const golden = readFileSync(
            'native/scan-cleanup/tests/fixtures/protocol/analysis-progress-v3.json',
            'utf8',
        );
        expect(decodeNativeScanCleanupEnvelope(golden)).toEqual({
            version: 3,
            type: 'progress',
            progress: {
                stage: 'page-analyzed',
                completedPages: 2,
                totalPages: 4,
                pageNumber: 3,
                classification: 'single-uncut-page',
                confidence: 0.91,
                tier1Verdict: 'single-uncut-page',
                reconciled: false,
                clusterAgreement: 0,
                recommendedOutputMode: 'mixed',
                recommendedOutputModeConfidence: 0.9,
                recommendedOutputModeReason: 'text-with-pictures',
            },
        });

        expect(decodeNativeScanCleanupEnvelope(JSON.stringify({
            version: 3,
            type: 'progress',
            progress: {
                stage: 'page-analyzed',
                completedPages: 2,
                totalPages: 4,
                pageNumber: 3,
                classification: 'single-uncut-page',
                confidence: 0.9,
            },
        }))).toMatchObject({progress: {
            stage: 'page-analyzed',
            classification: 'single-uncut-page',
            confidence: 0.9,
        }});
    });

    it('decodes reconciliation diagnostics and the reusable document prior', () => {
        const golden = readFileSync(
            'native/scan-cleanup/tests/fixtures/protocol/page-complete-progress-v3.json',
            'utf8',
        );
        const documentPrior = {
            dominantLayout: 'two-page-spread',
            cutterRatioMedian: 0.535,
            clusterDims: {
                widthPx: 2203,
                heightPx: 1600,
            },
            agreementStrength: 0.885,
        };
        const decoded = decodeNativeScanCleanupEnvelope(golden);

        expect(decoded).toMatchObject({
            type: 'progress',
            progress: {
                tier1Verdict: 'single-uncut-page',
                reconciled: true,
                clusterAgreement: 0.885,
                documentPrior,
                textAxis: {
                    sideways: true,
                    confidence: 0.97,
                },
                recommendedOutputMode: 'mixed',
                recommendedOutputModeConfidence: 0.91,
                recommendedOutputModeReason: 'text-with-pictures',
            },
        });
    });

    it('rejects malformed auto output-mode recommendations', () => {
        expect(() => decodeNativeScanCleanupEnvelope(JSON.stringify({
            version: 3,
            type: 'progress',
            progress: {
                stage: 'page-complete',
                completedPages: 1,
                totalPages: 1,
                pageNumber: 1,
                classification: 'single-uncut-page',
                confidence: 0.9,
                recommendedOutputMode: 'auto',
                recommendedOutputModeConfidence: 0.9,
            },
        }))).toThrow('recommended output mode');

        expect(() => decodeNativeScanCleanupEnvelope(JSON.stringify({
            version: 3,
            type: 'progress',
            progress: {
                stage: 'page-complete',
                completedPages: 1,
                totalPages: 1,
                pageNumber: 1,
                classification: 'single-uncut-page',
                confidence: 0.9,
                recommendedOutputMode: 'bw',
                recommendedOutputModeConfidence: 1.1,
            },
        }))).toThrow('output mode confidence');

        expect(() => decodeNativeScanCleanupEnvelope(JSON.stringify({
            version: 3,
            type: 'progress',
            progress: {
                stage: 'page-complete',
                completedPages: 1,
                totalPages: 1,
                pageNumber: 1,
                classification: 'single-uncut-page',
                confidence: 0.9,
                recommendedOutputMode: 'bw',
                recommendedOutputModeConfidence: 0.9,
                recommendedOutputModeReason: 'empty',
            },
        }))).toThrow('recommendation reason');
    });

    it('omits an absent text axis and rejects malformed axis confidence', () => {
        const withoutAxis = decodeNativeScanCleanupEnvelope(JSON.stringify({
            version: 3,
            type: 'progress',
            progress: {
                stage: 'page-complete',
                completedPages: 1,
                totalPages: 1,
                pageNumber: 1,
                classification: 'single-uncut-page',
                confidence: 0.9,
            },
        }));
        expect(withoutAxis.type === 'progress' && withoutAxis.progress).not.toHaveProperty('textAxis');

        expect(() => decodeNativeScanCleanupEnvelope(JSON.stringify({
            version: 3,
            type: 'progress',
            progress: {
                stage: 'page-complete',
                completedPages: 1,
                totalPages: 1,
                pageNumber: 1,
                classification: 'single-uncut-page',
                confidence: 0.9,
                textAxis: {
                    sideways: true,
                    confidence: 1.1,
                },
            },
        }))).toThrow('text axis');
    });

    it('decodes the staged-input lease frames the sidecar emits for a bounded window', () => {
        const golden = readFileSync(
            'native/scan-cleanup/tests/fixtures/protocol/staged-input-lease-progress-v3.json',
            'utf8',
        );
        expect(decodeNativeScanCleanupEnvelope(golden)).toEqual({
            version: 3,
            type: 'progress',
            progress: {
                stage: 'page-input-required',
                completedPages: 0,
                totalPages: 148,
                pageNumber: 147,
            },
        });

        expect(decodeNativeScanCleanupEnvelope(JSON.stringify({
            version: 3,
            type: 'progress',
            progress: {
                stage: 'page-input-released',
                completedPages: 0,
                totalPages: 148,
                pageNumber: 147,
            },
        }))).toMatchObject({progress: {
            stage: 'page-input-released',
            pageNumber: 147,
        }});

        // A lease is about one page, so a frame without page identity is not a
        // lease the producer could answer. Both ends of the lease say which
        // page they mean, or the producer would not know which slot to free.
        for (const stage of [
            'page-input-required',
            'page-input-released',
        ]) {
            expect(() => decodeNativeScanCleanupEnvelope(JSON.stringify({
                version: 3,
                type: 'progress',
                progress: {
                    stage,
                    completedPages: 0,
                    totalPages: 148,
                },
            }))).toThrow('page number');
        }
    });

    it('accepts global source page numbers in bounded batch progress', () => {
        expect(decodeNativeScanCleanupEnvelope(JSON.stringify({
            version: 3,
            type: 'progress',
            progress: {
                stage: 'page-input-required',
                completedPages: 0,
                totalPages: 1_024,
                pageNumber: 1_025,
            },
        }))).toMatchObject({progress: {
            stage: 'page-input-required',
            pageNumber: 1_025,
            totalPages: 1_024,
        }});
    });

    it('rejects an invalid spread prior without a cutter median', () => {
        expect(() => decodeNativeScanCleanupEnvelope(JSON.stringify({
            version: 3,
            type: 'progress',
            progress: {
                stage: 'page-complete',
                completedPages: 1,
                totalPages: 1,
                pageNumber: 1,
                classification: 'two-page-spread',
                confidence: 0.9,
                documentPrior: {
                    dominantLayout: 'two-page-spread',
                    cutterRatioMedian: null,
                    clusterDims: {
                        widthPx: 1200,
                        heightPx: 871,
                    },
                    agreementStrength: 0.8,
                },
            },
        }))).toThrow('document prior');
    });
});
