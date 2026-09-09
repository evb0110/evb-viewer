import type { THostResourceTier } from '@contracts/hostResourceProfile';

export type TStressHostProfileId =
    | 'baseline'
    | 'slow-a'
    | 'slow-a-gpu'
    | 'slow-b'
    | 'slow-c'
    | 'forced-low';

export type TStressOperatorProfile = 'pixel' | 'semantic' | 'external';

export type TStressScenarioKind = 'deterministic' | 'operator';

export type TStressSeverity =
    | 'critical'
    | 'major'
    | 'minor'
    | 'info';

export type TStressScenarioStatus =
    | 'passed'
    | 'failed'
    | 'infra-failed'
    | 'skipped';

export type TStressFixtureId =
    | 'xlarge-sparse-513mib'
    | 'many-pages-text-4000'
    | 'dense-annotations-2000'
    | 'deep-outline-3000'
    | 'scanned-large-431'
    | 'text-small-12'
    | 'corrupt-truncated'
    | 'djvu-reference';

export type TStressFixtureKind = 'pdf' | 'djvu';

export type TStressWorkspaceCommand =
    | 'handleZoomIn'
    | 'handleZoomOut'
    | 'handleFitWidth'
    | 'handleFitHeight'
    | 'handleActualSize'
    | 'handleToggleContinuousScroll'
    | 'handleToggleSidebar'
    | 'handleRotateCw'
    | 'handleViewRotationCw'
    | 'handleViewModeSingle'
    | 'handleViewModeFacing'
    | 'handleUndo'
    | 'handleRedo';

export interface IStressDeviceMetrics {
    width: number;
    height: number;
    deviceScaleFactor: number;
}

export interface IStressHostConstraintHint {
    platform: NodeJS.Platform;
    commandPrefix: string[];
    description: string;
    /** CPU quota the wrapper must impose, in whole or fractional CPUs. */
    expectedCpus: number;
    /** Memory ceiling the wrapper must impose. */
    expectedMemoryBytes: number;
}

export interface IStressCalibrationExpectation {
    rendererSlowdownMin: number;
    rendererSlowdownMax: number;
    jsHeapSizeLimitMaxBytes: number | null;
    expectedTier: THostResourceTier | null;
}

export interface IStressHostProfile {
    id: TStressHostProfileId;
    label: string;
    description: string;
    chromiumSwitches: string[];
    env: Record<string, string>;
    cpuThrottlingRate: number;
    deviceMetrics: IStressDeviceMetrics;
    hostConstraint: IStressHostConstraintHint | null;
    calibration: IStressCalibrationExpectation;
}

export interface IStressBudgets {
    maxTurns: number;
    maxCostUsd: number;
    deadlineMs: number;
}

export interface IStressThresholds {
    heartbeatMaxGapMs: number;
    longTaskP95Ms: number;
    frameGapP95Ms: number;
    peakRssBytes: number;
    jsHeapGrowthBytes: number;
    stepDurationMaxMs: number;
}

export type TStressStep =
    | {
        kind: 'phase';
        name: string
    }
    | {
        kind: 'open';
        fixture: TStressFixtureId;
        inNewTab?: boolean;
        expect?: 'loaded' | 'open-error'
    }
    | {
        kind: 'goToPage';
        pages: Array<number | 'last' | 'middle'>
    }
    | {
        kind: 'randomPages';
        count: number;
        seed: number
    }
    | {
        kind: 'wheelBurst';
        deltaY: number;
        count: number;
        settleTimeoutMs?: number
    }
    | {
        kind: 'command';
        name: TStressWorkspaceCommand;
        repeat?: number
    }
    | { kind: 'newTab' }
    | {
        kind: 'activateTab';
        index: number
    }
    | {
        kind: 'cycleTabs';
        rounds: number
    }
    | {
        kind: 'split';
        direction: 'right' | 'down'
    }
    | {
        kind: 'freeText';
        count: number;
        text: string
    }
    | { kind: 'save' }
    | {
        kind: 'search';
        query: string
    }
    | {
        kind: 'idle';
        ms: number
    }
    | { kind: 'gc' }
    | {
        kind: 'memoryPolicy';
        policy: 'conservative' | 'aggressive'
    };

export interface IStressTaskCard {
    goal: string;
    steps: string[];
    pace: string;
    doneWhen: string;
    doNot: string[];
}

interface IStressScenarioBase {
    id: string;
    title: string;
    description: string;
    tags: string[];
    fixtures: TStressFixtureId[];
    /** Fixtures the scenario mutates (save flows) are copied into the run dir first. */
    workingCopies: TStressFixtureId[];
    defaultProfile: TStressHostProfileId;
    budgets: IStressBudgets;
    thresholds: Partial<IStressThresholds>;
}

export interface IStressDeterministicScenario extends IStressScenarioBase {
    kind: 'deterministic';
    steps: TStressStep[];
}

export interface IStressOperatorScenario extends IStressScenarioBase {
    kind: 'operator';
    taskCard: IStressTaskCard;
}

export type TStressScenario = IStressDeterministicScenario | IStressOperatorScenario;

export interface IStressFinding {
    severity: TStressSeverity;
    oracle: string;
    message: string;
    evidence?: Record<string, unknown>;
}

export interface IStressAppState {
    tabIds: string[];
    activeTabId: string | null;
    fileName: string | null;
    currentPage: number | null;
    totalPages: number | null;
    zoomPercent: number | null;
    viewMode: string | null;
    activeTool: string | null;
    isDirty: boolean;
    isOpeningDocument: boolean;
    hasOpenError: boolean;
    readiness: 'ready' | 'busy' | 'no-document';
    viewerInteractionReady: boolean;
    visibleDialogs: string[];
    visibleToasts: string[];
}

/** `null` gaps mean the probe could not be installed (no Worker, no longtask observer), not "no gap". */
export interface IStressProbeTotals {
    timerMaxGapMs: number;
    channelMaxGapMs: number;
    workerMaxGapMs: number | null;
    longTaskCount: number;
    longTaskMaxMs: number | null;
    longTaskTotalMs: number;
    longTaskDurationsMs: number[];
    frameCount: number;
    frameMaxGapMs: number;
    frameGapsMs: number[];
}

export interface IStressMetricSample {
    tOffsetMs: number;
    epochMs: number;
    rssBytesTotal: number;
    rssBytesByPid: Record<string, number>;
    jsHeapUsedBytes: number | null;
    jsHeapTotalBytes: number | null;
    probe: IStressProbeTotals | null;
    consoleErrorCount: number;
    pageErrorCount: number;
}

export interface IStressMetricsSummary {
    sampleCount: number;
    durationMs: number;
    peakRssBytes: number;
    peakRssPid: string | null;
    peakJsHeapUsedBytes: number | null;
    firstJsHeapUsedBytes: number | null;
    lastJsHeapUsedBytes: number | null;
    heartbeatMaxGapMs: number;
    workerHeartbeatMaxGapMs: number | null;
    longTaskCount: number;
    longTaskP95Ms: number;
    longTaskMaxMs: number | null;
    frameGapP95Ms: number;
    frameGapMaxMs: number;
    droppedFrameRatio: number;
    consoleErrors: string[];
    pageErrors: string[];
    rendererCrashed: boolean;
    crashReason: string | null;
}

export interface IStressStepRecord {
    index: number;
    step: TStressStep;
    startedAt: string;
    durationMs: number;
    status: 'succeeded' | 'failed' | 'skipped';
    error: string | null;
    detail: Record<string, unknown>;
}

export interface IStressUsageRecord {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number | null;
}

export interface IStressActionEvidence {
    screenshotSha256: string | null;
    screenshotPath: string | null;
    width: number | null;
    height: number | null;
    appStateSha256: string | null;
    appState: IStressAppState | null;
    consoleErrorCount: number;
    pageErrorCount: number;
    rendererCrashed: boolean;
    rssBytes: number | null;
    jsHeapUsedBytes: number | null;
    maxFrameGapMs: number | null;
}

export type TStressActionStatus =
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'interrupted';

export interface IStressActionRecord {
    seq: number;
    turn: number;
    batchIndex: number;
    runId: string;
    scenarioId: string;
    toolUseId: string;
    toolsetName: string | null;
    tool: string;
    input: Record<string, unknown>;
    status: TStressActionStatus;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
    tOffsetMs: number;
    error: string | null;
    evidence: IStressActionEvidence | null;
    usage?: IStressUsageRecord;
}

export interface IStressOperatorReport {
    outcome: 'completed' | 'blocked' | 'app_broken';
    stepsDone: string[];
    problem: string | null;
    slowestAction: string | null;
    finalPage: number | null;
}

export interface IStressCalibrationProbe {
    mainThreadLoopMs: number;
    workerLoopMs: number | null;
    rafP50Ms: number | null;
    rafP95Ms: number | null;
    jsHeapSizeLimitBytes: number | null;
    diskRead64MiBMs: number | null;
    /** Legacy artifact field name; this is the effective tier reported by the app. */
    detectedTier: THostResourceTier | null;
}

export type TStressCalibrationVerdict =
    | 'met'
    | 'constraint-not-effective'
    | 'constraint-excessive'
    | 'unverifiable';

export interface IStressCalibrationCheck {
    check: string;
    verdict: TStressCalibrationVerdict;
    detail: string;
}

export interface IStressCalibrationRecord {
    profileId: TStressHostProfileId;
    unthrottled: IStressCalibrationProbe | null;
    throttled: IStressCalibrationProbe;
    checks: IStressCalibrationCheck[];
    hostConstraint: IStressHostConstraintVerification;
}

export interface IStressIntegrityCheck {
    path: string;
    status: 'passed' | 'failed' | 'skipped';
    detail: string;
}

export interface IStressCgroupLimits {
    /** `null` when cpu.max is `max` (unlimited). */
    cpus: number | null;
    /** `null` when memory.max is `max` (unlimited). */
    memoryBytes: number | null;
}

export interface IStressHostConstraintVerification {
    verified: boolean;
    detail: string;
}

export interface IStressScenarioResult {
    id: string;
    kind: TStressScenarioKind;
    status: TStressScenarioStatus;
    startedAt: string;
    durationMs: number;
    profileId: TStressHostProfileId;
    findings: IStressFinding[];
    metrics: IStressMetricsSummary | null;
    steps: IStressStepRecord[];
    operator: {
        model: string;
        operatorProfile: TStressOperatorProfile;
        turns: number;
        actions: number;
        costUsd: number | null;
        report: IStressOperatorReport | null;
        stopReason: string;
    } | null;
    artifacts: Record<string, string>;
    infraError: string | null;
}

export interface IStressRun {
    schemaVersion: 1;
    runId: string;
    startedAt: string;
    finishedAt: string | null;
    gitSha: string;
    hostProfile: TStressHostProfileId;
    platform: string;
    calibration: IStressCalibrationRecord | null;
    scenarios: IStressScenarioResult[];
    totals: {
        passed: number;
        failed: number;
        infraFailed: number;
        skipped: number;
        costUsd: number;
    };
    verdict: 'passed' | 'failed' | 'incomplete';
}

export interface IStressBaselineDuration {
    p50: number;
    p95: number;
    /** Newest last; capped so the file stays small and old runs age out. */
    samples: number[];
}

export interface IStressBaselineScenario {
    updatedAt: string;
    iterations: number;
    durations: Record<string, IStressBaselineDuration>;
    memory: {
        peakRssBytes: number;
        peakJsHeapUsedBytes: number | null;
    };
    responsiveness: {
        heartbeatMaxGapMs: number;
        heartbeatObservedMaxGapMs: number;
        longTaskP95Ms: number;
        frameTimeP95Ms: number;
        droppedFrameRatioMax: number;
    };
    hardCeilings: {
        crashCount: number;
        unresponsiveCount: number;
        pageErrorCount: number;
        leakedProcessCount: number;
        leakedWorkingCopyCount: number;
        peakElectronRssBytes: number;
    };
    notes: string;
}

export interface IStressBaseline {
    schemaVersion: 1;
    hostProfile: TStressHostProfileId;
    tier: THostResourceTier | null;
    calibration: {
        cpuLoopMs: number | null;
        diskRead64MiBMs: number | null;
        maxCalibrationDriftPercent: number;
    };
    defaults: {
        maxRegressionPercent: number;
        minRegressionMs: number;
        improvementRecordPercent: number;
        minIterations: number;
    };
    scenarios: Record<string, IStressBaselineScenario>;
}
