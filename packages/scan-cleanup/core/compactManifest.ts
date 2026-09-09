export interface IScanCleanupCompactManifestEnvelope {
    provenanceStampHex?: string;
    pages: string[];
}

export function buildScanCleanupCompactManifest(
    pages: readonly string[],
    provenanceStampHex?: string,
): IScanCleanupCompactManifestEnvelope {
    return {
        ...(provenanceStampHex === undefined ? {} : {provenanceStampHex}),
        pages: [...pages],
    };
}

export function serializeScanCleanupCompactManifest(
    manifest: IScanCleanupCompactManifestEnvelope,
) {
    return JSON.stringify(manifest);
}

export function serializeLegacyScanCleanupCompactManifest(
    manifest: IScanCleanupCompactManifestEnvelope,
) {
    return manifest.pages.join('\n') + (manifest.pages.length === 0 ? '' : '\n');
}

export function parseScanCleanupCompactManifest(serialized: string): string[] {
    const trimmed = serialized.trim();
    if (!trimmed.startsWith('{')) {
        return trimmed.length === 0
            ? []
            : trimmed.split(/\r?\n/u).filter(line => line.trim().length > 0);
    }
    let value: unknown;
    try {
        value = JSON.parse(trimmed);
    } catch {
        throw new Error('compact manifest is not valid JSON');
    }
    if (!isRecord(value) || !isStringArray(value.pages)) {
        throw new Error('compact manifest JSON must contain string pages');
    }
    return [...value.pages];
}

export interface IScanCleanupPageOpsInstruction {
    sourcePageIndex: number;
    rotationQuarterTurns: number;
    outputs: Array<{
        cropRect: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        contentTransform?: {
            scale: number;
            translateX: number;
            translateY: number;
        };
    }>;
}

export interface IScanCleanupPageOpsInstructionEnvelope {
    provenanceStampHex?: string;
    pages: IScanCleanupPageOpsInstruction[];
}

export function buildScanCleanupPageOpsInstructions(
    pages: readonly IScanCleanupPageOpsInstruction[],
    provenanceStampHex?: string,
): IScanCleanupPageOpsInstructionEnvelope {
    return {
        ...(provenanceStampHex === undefined ? {} : {provenanceStampHex}),
        pages: pages.map(page => ({
            ...page,
            outputs: page.outputs.map(output => ({...output})),
        })),
    };
}

export function serializeScanCleanupPageOpsInstructions(
    instructions: IScanCleanupPageOpsInstructionEnvelope,
) {
    return JSON.stringify(instructions);
}

export function serializeLegacyScanCleanupPageOpsInstructions(
    instructions: IScanCleanupPageOpsInstructionEnvelope,
) {
    return JSON.stringify({pages: instructions.pages});
}

export interface IScanCleanupTextLayerInstruction {
    sourcePageIndex: number;
    outputPageIndex: number;
    /** PDF `cm` operands mapping source-page user space to output-page user space. */
    matrix: [number, number, number, number, number, number];
    /**
     * Drop source text whose positioned origin maps outside the output page.
     * Split outputs need this because PDF extractors do not honor page-content
     * clipping consistently and would otherwise expose both source halves.
     */
    filterToOutputPage?: boolean;
}

export interface IScanCleanupTextLayerInstructionEnvelope {pages: IScanCleanupTextLayerInstruction[];}

export function serializeScanCleanupTextLayerInstructions(
    pages: readonly IScanCleanupTextLayerInstruction[],
) {
    return JSON.stringify({pages});
}

export function isScanCleanupCliFallbackSentinel(value: string | undefined) {
    return value !== undefined && /^__scan_cleanup_cli_[a-z_]+__$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}
