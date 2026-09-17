import {isRecord} from '@contracts/runtimeGuards';
import type {TScanCleanupDetectionJobState} from '@contracts/scan-cleanup/ipc';
import {isNativeScanCleanupFoldBandV3} from '@contracts/scan-cleanup/nativeProtocolV3';

type TSplitDiagnostics = NonNullable<
    TScanCleanupDetectionJobState['results'][number]['splitDiagnostics']
>;

export function decodeSplitDiagnostics(value: unknown): TSplitDiagnostics {
    if (!isRecord(value)) throw new Error('invalid scan-cleanup split diagnostics');
    const candidate = value;
    const integerKeys = [
        'leftInkPixels',
        'rightInkPixels',
        'independentSpreadCues',
    ] as const;
    const numberKeys = [
        'analysisDpi',
        'deskewAngleDegrees',
        'deskewConfidence',
        'cutterSlope',
        'leftDeskewAngleDegrees',
        'rightDeskewAngleDegrees',
        'leftDeskewConfidence',
        'rightDeskewConfidence',
        'whitespaceX',
        'foldX',
        'decisionX',
        'whitespaceScore',
        'bilateralScore',
        'leftPageScore',
        'rightPageScore',
        'leftContentScore',
        'rightContentScore',
        'leftSurfaceScore',
        'rightSurfaceScore',
        'outerMarginScore',
        'gutterScore',
        'agreementScore',
        'foldScore',
        'gutterDarknessScore',
        'softGutterScore',
        'softGutterCoverage',
        'softGutterContinuity',
        'softGutterMeanDepression',
        'sparseGutterScore',
        'sparseGutterCoverage',
        'sparseGutterContinuity',
        'sparseGutterMeanDepression',
        'aspectRatio',
        'aspectSpreadScore',
        'aspectSingleScore',
        'offcutBoundaryScore',
        'offcutEmptyScore',
        'offcutPopulatedScore',
        'offcutWidthScore',
        'offcutNoTextRowsScore',
        'alternativeProduct',
        'evidenceProduct',
    ] as const;
    const optionalNumberKeys = [
        'leftOuterMarginScore',
        'rightOuterMarginScore',
    ] as const;
    const booleanKeys = [
        'whitespaceGatePassed',
        'centralPositionGatePassed',
        'bilateralGatePassed',
        'outerMarginGatePassed',
        'gutterGatePassed',
        'independentGutterGatePassed',
        'aspectSupportGatePassed',
        'evidenceAgreementGatePassed',
        'sparseSpreadRecovered',
        'abstained',
    ] as const;
    const optionalBooleanKeys = ['outerMarginRecovery'] as const;
    const optionalStringKeys = ['outerMarginWeakEdge'] as const;
    const allowed = new Set<string>([
        ...integerKeys,
        ...numberKeys,
        ...optionalNumberKeys,
        ...booleanKeys,
        ...optionalBooleanKeys,
        ...optionalStringKeys,
        'foldBand',
    ]);
    const isValid = (
        subject: Record<string, unknown>,
    ): subject is Record<string, unknown> & TSplitDiagnostics =>
        !Object.keys(subject).some(key => !allowed.has(key))
        && integerKeys.every(key => (
            typeof subject[key] === 'number'
            && Number.isSafeInteger(subject[key])
            && subject[key] >= 0
        ))
        && numberKeys.every(key => (
            typeof subject[key] === 'number'
            && Number.isFinite(subject[key])
        ))
        && optionalNumberKeys.every(key => (
            subject[key] === undefined
            || (typeof subject[key] === 'number' && Number.isFinite(subject[key]))
        ))
        && booleanKeys.every(key => typeof subject[key] === 'boolean')
        && optionalBooleanKeys.every(key => (
            subject[key] === undefined || typeof subject[key] === 'boolean'
        ))
        && optionalStringKeys.every(key => (
            subject[key] === undefined
            || subject[key] === null
            || subject[key] === 'left'
            || subject[key] === 'right'
        ))
        && isNativeScanCleanupFoldBandV3(subject.foldBand);
    if (!isValid(candidate)) {
        throw new Error('invalid scan-cleanup split diagnostics');
    }
    return {
        ...candidate,
        foldBand: {...candidate.foldBand},
    };
}
