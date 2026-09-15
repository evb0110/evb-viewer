import type { IOracleResult } from '@scripts/windows-test/oracles/oracleResult';
import {
    GENERATED_PDF_VERIFIER_ORACLE_ID,
    GENERATED_PDF_VERIFIER_VERSION,
} from '@scripts/windows-test/oracles/verifyGeneratedPdfWrapper';
import {
    HUMAN_REVIEW_ORACLE_ID,
    HUMAN_REVIEW_ORACLE_VERSION,
} from '@scripts/windows-test/oracles/humanReviewObligation';
import {
    PAGE_MARKER_ORACLE_ID,
    PAGE_MARKER_ORACLE_VERSION,
} from '@scripts/windows-test/oracles/pageMarkerOracle';
import {
    PAGE_COUNT_ORACLE_ID,
    PDF_STRUCTURE_ORACLE_ID,
    PDF_STRUCTURE_ORACLE_VERSION,
} from '@scripts/windows-test/oracles/pdfStructureOracle';
import {
    RENDER_BLANK_ORACLE_ID,
    RENDER_BLANK_ORACLE_VERSION,
} from '@scripts/windows-test/oracles/renderBlankOracle';
import {
    SOURCE_ISOLATION_ORACLE_ID,
    SOURCE_ISOLATION_ORACLE_VERSION,
} from '@scripts/windows-test/oracles/sourceIsolationOracle';

export const oracleSides = [
    'host',
    'guest',
] as const;

export type TOracleSide = typeof oracleSides[number];

export interface IOracleDescriptor {
    id: string;
    version: string;
    /**
     * `host` oracles run on macOS against artifacts pulled back from the guest.
     * `guest` oracles are judgements the Windows worker records in evidence; the
     * host only replays them, so it must never claim to have measured them.
     */
    side: TOracleSide;
    /** Module path or evidence field the verdict comes from. */
    provenance: string;
    description: string;
}

const HOST_ORACLES: readonly IOracleDescriptor[] = [
    {
        id: PDF_STRUCTURE_ORACLE_ID,
        version: PDF_STRUCTURE_ORACLE_VERSION,
        side: 'host',
        provenance: '@scripts/windows-test/oracles/pdfStructureOracle#evaluatePdfStructure',
        description: 'Parses the artifact and compares page geometry, annotation count and metadata.',
    },
    {
        id: PAGE_COUNT_ORACLE_ID,
        version: PDF_STRUCTURE_ORACLE_VERSION,
        side: 'host',
        provenance: '@scripts/windows-test/oracles/pdfStructureOracle#evaluatePageCount',
        description: 'Compares the artifact page count with the expected count.',
    },
    {
        id: PAGE_MARKER_ORACLE_ID,
        version: PAGE_MARKER_ORACLE_VERSION,
        side: 'host',
        provenance: '@scripts/windows-test/oracles/pageMarkerOracle#evaluatePageMarkers',
        description: 'Extracts page text and checks the per-page fixture markers and their order.',
    },
    {
        id: RENDER_BLANK_ORACLE_ID,
        version: RENDER_BLANK_ORACLE_VERSION,
        side: 'host',
        provenance: '@scripts/windows-test/oracles/renderBlankOracle#evaluateRenderNonBlank',
        description: 'Rasterises every page and measures the non-white ratio and content mask coverage.',
    },
    {
        id: GENERATED_PDF_VERIFIER_ORACLE_ID,
        version: GENERATED_PDF_VERIFIER_VERSION,
        side: 'host',
        provenance: '@scripts/windows-test/oracles/verifyGeneratedPdfWrapper#runVerifyGeneratedPdf',
        description: 'Runs the tracked diagnostics verifier; a missing python3 or Pillow yields inconclusive.',
    },
    {
        id: SOURCE_ISOLATION_ORACLE_ID,
        version: SOURCE_ISOLATION_ORACLE_VERSION,
        side: 'host',
        provenance: '@scripts/windows-test/oracles/sourceIsolationOracle#evaluateSourceIsolation',
        description: 'Confirms the source hash is unchanged and that sidecars and residue match expectations.',
    },
    {
        id: HUMAN_REVIEW_ORACLE_ID,
        version: HUMAN_REVIEW_ORACLE_VERSION,
        side: 'host',
        provenance: '@scripts/windows-test/oracles/humanReviewObligation#createHumanReviewObligation',
        description: 'Emits a contact-sheet review obligation that only a person can close.',
    },
];

interface IGuestOracleSeed {
    id: string;
    evidenceField: string;
    description: string;
}

const GUEST_ORACLE_SEEDS: readonly IGuestOracleSeed[] = [
    {
        id: 'reopen',
        evidenceField: 'reopen',
        description: 'The guest reopened the produced artifact in the application and reported the outcome.',
    },
    {
        id: 'native-dialog-observed',
        evidenceField: 'nativeUi',
        description: 'The native UI adapter observed the expected Windows dialog or common control.',
    },
    {
        id: 'process-tree',
        evidenceField: 'processTree',
        description: 'The guest recorded the process tree around the operation under test.',
    },
    {
        id: 'filesystem-state',
        evidenceField: 'filesystem',
        description: 'The guest recorded the on-disk state of the target directory after the operation.',
    },
    {
        id: 'spooler-state',
        evidenceField: 'spooler',
        description: 'The guest recorded print queue and spooler job state.',
    },
    {
        id: 'error-message',
        evidenceField: 'errorMessage',
        description: 'The guest captured the user-facing error text for a deliberately failing operation.',
    },
    {
        id: 'window-state',
        evidenceField: 'windowState',
        description: 'The guest recorded window placement, DPI scaling or restore state.',
    },
    {
        id: 'package-identity',
        evidenceField: 'packageIdentity',
        description: 'The guest recorded installed package identity, version and shell registration.',
    },
    {
        id: 'resource-bounds',
        evidenceField: 'resourceBounds',
        description: 'The guest sampled memory, handle and CPU usage against the declared bounds.',
    },
    {
        id: 'performance',
        evidenceField: 'performance',
        description: 'The guest recorded save latency, read volume, memory and timer-gap measurements.',
    },
    {
        id: 'network-policy',
        evidenceField: 'networkPolicy',
        description: 'The guest recorded outbound network attempts against the allowed policy.',
    },
    {
        id: 'input-fidelity',
        evidenceField: 'inputFidelity',
        description: 'The guest replayed keyboard, mouse or IME input and recorded what the application received.',
    },
    {
        id: 'accessibility-tree',
        evidenceField: 'accessibilityTree',
        description: 'The guest captured the UI Automation tree for the window under test.',
    },
    {
        id: 'hash-identity',
        evidenceField: 'hashIdentity',
        description: 'The guest hashed the file before and after the operation to prove identity or change.',
    },
    {
        id: 'annotation-state',
        evidenceField: 'annotationState',
        description: 'The guest recorded annotation, form field or outline state after the operation.',
    },
    {
        id: 'hardware-observation',
        evidenceField: 'hardwareObservation',
        description: 'A hardware lane recorded an observation that no virtual machine can produce.',
    },
];

const GUEST_ORACLES: readonly IOracleDescriptor[] = GUEST_ORACLE_SEEDS.map(seed => ({
    id: seed.id,
    version: 'guest-evidence@1',
    side: 'guest',
    provenance: `guest evidence field ${seed.evidenceField}`,
    description: seed.description,
}));

export const windowsOracleDescriptors: readonly IOracleDescriptor[] = [
    ...HOST_ORACLES,
    ...GUEST_ORACLES,
];

const DESCRIPTORS_BY_ID = new Map(
    windowsOracleDescriptors.map(descriptor => [
        descriptor.id,
        descriptor,
    ]),
);

export const windowsOracleIds: readonly string[] = windowsOracleDescriptors
    .map(descriptor => descriptor.id)
    .sort((left, right) => left.localeCompare(right));

export const windowsHostOracleIds: readonly string[] = HOST_ORACLES.map(descriptor => descriptor.id);

export const windowsGuestOracleIds: readonly string[] = GUEST_ORACLES.map(descriptor => descriptor.id);

export function findOracleDescriptor(oracleId: string) {
    return DESCRIPTORS_BY_ID.get(oracleId) ?? null;
}

export function isKnownOracleId(oracleId: string) {
    return DESCRIPTORS_BY_ID.has(oracleId);
}

export function unknownOracleIds(oracleIds: readonly string[]) {
    return oracleIds.filter(oracleId => !DESCRIPTORS_BY_ID.has(oracleId));
}

export interface IOracleProvenanceRecord {
    oracleId: string;
    oracleVersion: string;
    status: IOracleResult['status'];
    detail: string;
    side: TOracleSide | 'unknown';
    provenance: string;
}

/**
 * Every reported oracle verdict carries the implementation it came from, so a
 * report reader can tell a host measurement from a guest self-report.
 */
export function describeOracleProvenance(result: IOracleResult): IOracleProvenanceRecord {
    const descriptor = findOracleDescriptor(result.oracleId);
    return {
        oracleId: result.oracleId,
        oracleVersion: result.oracleVersion,
        status: result.status,
        detail: result.detail,
        side: descriptor?.side ?? 'unknown',
        provenance: descriptor?.provenance ?? 'unregistered oracle',
    };
}

export function describeOracleProvenanceList(results: readonly IOracleResult[]) {
    return results.map(describeOracleProvenance);
}
