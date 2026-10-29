import type {
    TTranslateFn,
    TTranslationKey,
} from '@i18n-app';
import type {
    IScanCleanupContentAcceptedTrim,
    IScanCleanupContentBlockEvidence,
    IScanCleanupPageOutputDiagnostics,
    IScanCleanupPageOverride,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewPageMetadata,
    IScanCleanupTextAxis,
    TScanCleanupOutputMode,
    TScanCleanupOutputModeRecommendationReason,
    TScanCleanupOutputModeSetting,
} from '@contracts/scan-cleanup/electronApiScanCleanup';

const LOW_LAYOUT_CONFIDENCE = 0.6;

type TLayoutClassification = IScanCleanupPreviewMetadata['layoutClassification'];

/** What detection and the user's edits say about one source page. */
export interface IScanCleanupPageFacts {
    classification: TLayoutClassification | undefined;
    diagnostics: IScanCleanupPreviewPageMetadata | undefined;
    layoutConfidence: number | undefined;
    override: IScanCleanupPageOverride;
    recommendedOutputMode: TScanCleanupOutputMode | undefined;
    recommendedOutputModeConfidence: number | undefined;
    recommendedOutputModeReason: TScanCleanupOutputModeRecommendationReason | undefined;
    textAxis: IScanCleanupTextAxis | undefined;
}

export interface IScanCleanupPageDiagnosticGroup {
    notes: string[];
    rows: Array<{
        label: string;
        value: string;
    }>;
    title: string;
}

const OUTPUT_MODE_LABEL_KEYS = {
    bw: 'scanCleanup.output.bw',
    color: 'scanCleanup.output.color',
    grayscale: 'scanCleanup.output.grayscale',
    mixed: 'scanCleanup.output.mixed',
} as const satisfies Record<TScanCleanupOutputMode, TTranslationKey>;

const OUTPUT_MODE_SHORT_LABEL_KEYS = {
    bw: 'scanCleanup.output.bwShort',
    color: 'scanCleanup.output.colorShort',
    grayscale: 'scanCleanup.output.grayscaleShort',
    mixed: 'scanCleanup.output.mixedShort',
} as const satisfies Record<TScanCleanupOutputMode, TTranslationKey>;

export function scanCleanupOutputModeLabel(t: TTranslateFn, mode: TScanCleanupOutputMode) {
    return t(OUTPUT_MODE_LABEL_KEYS[mode]);
}

export function scanCleanupOutputModeShortLabel(t: TTranslateFn, mode: TScanCleanupOutputMode | undefined) {
    return mode === undefined ? '' : t(OUTPUT_MODE_SHORT_LABEL_KEYS[mode]);
}

function classificationLabel(t: TTranslateFn, classification: TLayoutClassification | undefined) {
    if (classification === 'two-page-spread') {
        return t('scanCleanup.pages.classification.spread');
    }
    if (classification === 'page-with-offcut') {
        return t('scanCleanup.pages.classification.offcut');
    }
    if (classification === 'single-uncut-page') {
        return t('scanCleanup.pages.classification.single');
    }
    return '—';
}

/**
 * The layout a page will actually be cut with: an explicit override wins over
 * what detection reported, and a page detection has not reached yet has
 * nothing truthful to say.
 */
export function scanCleanupLayoutLabel(
    t: TTranslateFn,
    override: IScanCleanupPageOverride,
    classification: TLayoutClassification | undefined,
) {
    const layoutOverride = override.layoutOverride;
    if (layoutOverride === 'single') {
        return t('scanCleanup.pages.override.single');
    }
    if (layoutOverride === 'spread') {
        return t('scanCleanup.pages.override.spread');
    }
    if (layoutOverride === 'keep-left') {
        return t('scanCleanup.pages.override.keepLeft');
    }
    if (layoutOverride === 'keep-right') {
        return t('scanCleanup.pages.override.keepRight');
    }
    return classification === undefined ? null : classificationLabel(t, classification);
}

function formatConfidence(t: TTranslateFn, value: number | null | undefined) {
    return value === null || value === undefined
        ? t('scanCleanup.pages.diagnostics.unavailable')
        : `${Math.round(value * 100)}%`;
}

/**
 * The page's open questions for the person cleaning it: a layout detection was
 * unsure about, or text that runs sideways on an unrotated page.
 */
export function scanCleanupPageAttentionHints(
    t: TTranslateFn,
    facts: Pick<IScanCleanupPageFacts, 'classification' | 'layoutConfidence' | 'override' | 'textAxis'>,
) {
    const lowConfidence = facts.layoutConfidence !== undefined && facts.layoutConfidence < LOW_LAYOUT_CONFIDENCE;
    const sideways = facts.override.rotationDegrees === 0 && (facts.textAxis?.sideways ?? false);
    const classification = [
        scanCleanupLayoutLabel(t, facts.override, facts.classification) ?? classificationLabel(t, undefined),
        formatConfidence(t, facts.layoutConfidence),
    ].join(' · ');
    return [
        lowConfidence ? t('scanCleanup.pages.lowConfidenceHint', {classification}) : '',
        sideways ? t('scanCleanup.pages.textAxisHint') : '',
    ].filter(Boolean);
}

/** Which output mode the page gets, and why, in one sentence. */
export function scanCleanupPageOutputModeHint(
    t: TTranslateFn,
    facts: Pick<IScanCleanupPageFacts, 'override' | 'recommendedOutputMode' | 'recommendedOutputModeConfidence'>,
    documentOutputMode: TScanCleanupOutputModeSetting,
    preserveOriginalQuality: boolean,
) {
    if (preserveOriginalQuality) {
        return t('scanCleanup.pages.outputModeLosslessControlHint');
    }
    const override = facts.override.outputModeOverride;
    if (override !== undefined) {
        return t('scanCleanup.pages.outputModeOverrideHint', {mode: scanCleanupOutputModeLabel(t, override)});
    }
    if (documentOutputMode !== 'auto') {
        return t('scanCleanup.pages.outputModeDocumentHint', {mode: scanCleanupOutputModeLabel(t, documentOutputMode)});
    }
    const recommended = facts.recommendedOutputMode;
    if (recommended === undefined) {
        return t('scanCleanup.pages.outputModeRecommendationPending');
    }
    const confidence = facts.recommendedOutputModeConfidence;
    return confidence === undefined
        ? t('scanCleanup.pages.outputModeRecommendationHintUnknown', {mode: scanCleanupOutputModeLabel(t, recommended)})
        : t('scanCleanup.pages.outputModeRecommendationHintKnown', {
            mode: scanCleanupOutputModeLabel(t, recommended),
            confidence: `${Math.round(confidence * 100)}%`,
        });
}

function definedRows(rows: ReadonlyArray<readonly [string, string | null]>) {
    return rows.flatMap(([
        label,
        value,
    ]) => (value === null ? [] : [{
        label,
        value,
    }]));
}

function outputHalfLabel(t: TTranslateFn, half: IScanCleanupPageOutputDiagnostics['half']) {
    return {
        full: t('scanCleanup.preview.outputHalf.full'),
        left: t('scanCleanup.preview.outputHalf.left'),
        right: t('scanCleanup.preview.outputHalf.right'),
    }[half];
}

function trimValue(t: TTranslateFn, trim: IScanCleanupContentAcceptedTrim) {
    return t('scanCleanup.pages.diagnostics.acceptedTrimValue', {
        side: t(`scanCleanup.pages.diagnostics.trimSide.${trim.side}`),
        score: formatConfidence(t, trim.score),
        threshold: formatConfidence(t, trim.threshold),
    });
}

function blockValue(t: TTranslateFn, block: IScanCleanupContentBlockEvidence) {
    const evidence = [
        block.pictureMaskOverlapPixels > 0 ? t('scanCleanup.pages.diagnostics.pictureEvidence') : '',
        block.headingEvidence ? t('scanCleanup.pages.diagnostics.headingEvidence') : '',
        block.grayscaleEvidence ? t('scanCleanup.pages.diagnostics.grayscaleEvidence') : '',
        block.textEvidence ? t('scanCleanup.pages.diagnostics.textEvidence') : '',
    ].filter(Boolean).join(', ') || t('scanCleanup.pages.diagnostics.noProtectedEvidence');
    return t('scanCleanup.pages.diagnostics.boundsValue', {
        x: Math.round(block.bounds.xPx),
        y: Math.round(block.bounds.yPx),
        width: Math.round(block.bounds.widthPx),
        height: Math.round(block.bounds.heightPx),
        evidence,
    });
}

function trimRows(t: TTranslateFn, outputs: readonly IScanCleanupPageOutputDiagnostics[]) {
    return outputs.flatMap(output => {
        const prefix = outputs.length > 1 ? `${outputHalfLabel(t, output.half)} · ` : '';
        const trims = output.contentDiagnostics?.acceptedTrims ?? [];
        const rows = [
            ...trims.map(trim => ({
                label: `${prefix}${t('scanCleanup.pages.diagnostics.acceptedTrim')}`,
                value: trimValue(t, trim),
            })),
            ...trims.flatMap(trim => trim.removedBlocks).map(block => ({
                label: `${prefix}${t('scanCleanup.pages.diagnostics.removedBounds')}`,
                value: blockValue(t, block),
            })),
            ...(output.contentDiagnostics?.protectedBlocks ?? []).map(block => ({
                label: `${prefix}${t('scanCleanup.pages.diagnostics.protectedBounds')}`,
                value: blockValue(t, block),
            })),
        ];
        return rows.length > 0
            ? rows
            : [{
                label: `${prefix}${t('scanCleanup.pages.diagnostics.trimResult')}`,
                value: t('scanCleanup.pages.diagnostics.noTrim'),
            }];
    });
}

/**
 * Only rows the analysis actually produced: an engineering dump three quarters
 * of which reads "Unavailable" teaches nothing about this page.
 */
export function scanCleanupPageDiagnosticGroups(
    t: TTranslateFn,
    facts: Pick<IScanCleanupPageFacts, 'diagnostics' | 'recommendedOutputMode'
        | 'recommendedOutputModeConfidence' | 'recommendedOutputModeReason'>,
): IScanCleanupPageDiagnosticGroup[] {
    const diagnostics = facts.diagnostics;
    if (!diagnostics) {
        return [];
    }
    const recommended = facts.recommendedOutputMode ?? diagnostics.recommendedOutputMode;
    const reason = facts.recommendedOutputModeReason ?? diagnostics.recommendedOutputModeReason;
    const route = diagnostics.binarizationMode ?? diagnostics.binarizationDiagnostics?.route;
    const evidence = diagnostics.binarizationDiagnostics;
    const outputs = diagnostics.outputDiagnostics ?? [];
    const sideConfidence = outputs[0]?.contentDiagnostics?.sideConfidence;
    const deskew = diagnostics.detectedSkewDegrees === undefined
        ? null
        : diagnostics.manualSkew === true
            ? t('scanCleanup.pages.diagnostics.deskewManualValue', {angle: diagnostics.detectedSkewDegrees.toFixed(2)})
            // The detector's skew score is a peak-to-average ratio, not a
            // probability, so it is not shown as a percentage.
            : t('scanCleanup.settings.rotationDegrees', {value: diagnostics.detectedSkewDegrees.toFixed(2)});
    return [
        {
            title: t('scanCleanup.pages.diagnostics.modeDecision'),
            notes: [],
            rows: definedRows([
                [
                    t('scanCleanup.pages.diagnostics.recommendedMode'),
                    recommended === undefined
                        ? null
                        : t('scanCleanup.pages.diagnostics.recommendedModeValue', {
                            mode: scanCleanupOutputModeLabel(t, recommended),
                            confidence: formatConfidence(t, facts.recommendedOutputModeConfidence
                                ?? diagnostics.recommendedOutputModeConfidence),
                        }),
                ],
                [
                    t('scanCleanup.pages.diagnostics.reason'),
                    reason === undefined ? null : t(`scanCleanup.pages.diagnostics.modeReason.${reason}`),
                ],
                [
                    t('scanCleanup.pages.diagnostics.binarization'),
                    route ? t(`scanCleanup.advanced.binarization.${route}`) : null,
                ],
                [
                    t('scanCleanup.pages.diagnostics.contrastIllumination'),
                    evidence
                        ? t('scanCleanup.pages.diagnostics.contrastIlluminationValue', {
                            contrast: evidence.robustContrast.toFixed(1),
                            illumination: evidence.illuminationDeviation.toFixed(1),
                        })
                        : null,
                ],
                [
                    t('scanCleanup.pages.diagnostics.edgeStroke'),
                    evidence
                        ? t('scanCleanup.pages.diagnostics.edgeStrokeValue', {
                            edge: formatConfidence(t, evidence.edgeDensity),
                            stroke: evidence.estimatedStrokeWidthPx.toFixed(1),
                        })
                        : null,
                ],
                [
                    t('scanCleanup.pages.diagnostics.borderAgreement'),
                    evidence
                        ? t('scanCleanup.pages.diagnostics.borderAgreementValue', {
                            border: formatConfidence(t, evidence.darkBorderCoverage),
                            agreement: formatConfidence(t, evidence.otsuAdaptiveAgreement),
                        })
                        : null,
                ],
                [
                    t('scanCleanup.pages.diagnostics.despeckleFallback'),
                    diagnostics.despeckleFallback === undefined
                        ? null
                        : t(diagnostics.despeckleFallback
                            ? 'scanCleanup.pages.diagnostics.fallbackUsed'
                            : 'scanCleanup.pages.diagnostics.fallbackNotUsed'),
                ],
            ]),
        },
        {
            title: t('scanCleanup.pages.diagnostics.contentTrim'),
            notes: [],
            rows: trimRows(t, outputs),
        },
        {
            title: t('scanCleanup.pages.diagnostics.geometry'),
            notes: [
                diagnostics.reconciled === true ? t('scanCleanup.pages.diagnostics.reconciled') : '',
                diagnostics.splitAbstained === true ? t('scanCleanup.pages.diagnostics.splitAbstained') : '',
            ].filter(Boolean),
            rows: definedRows([
                [
                    t('scanCleanup.pages.diagnostics.layout'),
                    t('scanCleanup.pages.diagnostics.layoutValue', {
                        layout: classificationLabel(t, diagnostics.layoutClassification),
                        confidence: formatConfidence(t, diagnostics.layoutConfidence),
                    }),
                ],
                [
                    t('scanCleanup.pages.diagnostics.deskew'),
                    deskew,
                ],
                [
                    t('scanCleanup.pages.diagnostics.sideConfidence'),
                    sideConfidence
                        ? ([
                            'left',
                            'top',
                            'right',
                            'bottom',
                        ] as const).map(side => t('scanCleanup.pages.diagnostics.sideConfidenceValue', {
                            side: t(`scanCleanup.pages.diagnostics.trimSide.${side}`),
                            confidence: formatConfidence(t, sideConfidence[side]),
                        })).join(' · ')
                        : null,
                ],
                [
                    t('scanCleanup.pages.diagnostics.dewarp'),
                    diagnostics.autoDewarpAttempted === true
                        ? t(diagnostics.dewarpApplied
                            ? 'scanCleanup.pages.diagnostics.dewarpApplied'
                            : 'scanCleanup.pages.diagnostics.dewarpGated', {confidence: formatConfidence(t, diagnostics.dewarpConfidence)})
                        : null,
                ],
            ]),
        },
    ].filter(group => group.rows.length > 0 || group.notes.length > 0);
}
