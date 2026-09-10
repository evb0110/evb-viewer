import {
    decodeDiagnosticContext,
    type DiagnosticCode,
    type DiagnosticContext,
    type DiagnosticStackPolicy,
} from '@contracts/diagnostics/diagnosticCodes';
import type {CaptureFailureInput} from '@contracts/diagnostics/failureReceipt';
import {
    normalizeCanonicalApplicationFrames,
    type CanonicalAppFrame,
} from '@contracts/diagnostics/canonicalAppFrames';

const SHARED_DIAGNOSTIC_REPORTER_FRAME_SUFFIXES = [
    'packages/contracts/diagnostics/buildDiagnosticRecord.ts',
    'packages/contracts/diagnostics/diagnosticReporterFrames.ts',
] as const;

export function readDiagnosticStack(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    try {
        const stack = (value as {readonly stack?: unknown}).stack;
        return typeof stack === 'string' ? stack : undefined;
    } catch {
        return undefined;
    }
}

export function captureDiagnosticCallSiteStack() {
    try {
        return new Error().stack ?? '';
    } catch {
        return '';
    }
}

export function removeDiagnosticReporterFrames(
    frames: readonly CanonicalAppFrame[],
    internalFrameSuffixes: readonly string[],
) {
    return frames.filter(frame => !internalFrameSuffixes.some(suffix => (
        frame.module === suffix || frame.module.endsWith(`/${suffix}`)
    )));
}

export function buildDiagnosticFrames(
    input: CaptureFailureInput,
    stackPolicy: DiagnosticStackPolicy,
    internalFrameSuffixes: readonly string[],
) {
    const stack = stackPolicy === 'source'
        ? readDiagnosticStack(input.local.cause) ?? captureDiagnosticCallSiteStack()
        : captureDiagnosticCallSiteStack();

    try {
        return removeDiagnosticReporterFrames(
            normalizeCanonicalApplicationFrames(stack).frames,
            [
                ...SHARED_DIAGNOSTIC_REPORTER_FRAME_SUFFIXES,
                ...internalFrameSuffixes,
            ],
        );
    } catch {
        return [];
    }
}

export function fallbackDiagnosticContext(code: DiagnosticCode): DiagnosticContext<DiagnosticCode> {
    return decodeDiagnosticContext(code, {}) ?? {};
}
