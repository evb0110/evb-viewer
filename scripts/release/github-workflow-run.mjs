import {
    errorMessage,
    run,
    sleep,
} from './shared.mjs';

const DEFAULT_START_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5 * 1000;
const TRANSIENT_GITHUB_CLI_ERROR_PATTERNS = [
    /TLS handshake timeout/i,
    /context deadline exceeded/i,
    /connection reset/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /EAI_AGAIN/i,
    /502 Bad Gateway/i,
    /503 Service Unavailable/i,
    /504 Gateway Timeout/i,
];

/** @typedef {{createdAt?: string, databaseId?: number, displayTitle?: string, headBranch?: string, headSha?: string, status?: string, conclusion?: string | null, url: string}} IWorkflowRun */
/** @typedef {(command: string, args: string[], options?: object) => string} TCommandRunner */
/** @typedef {{write: (chunk: string) => unknown}} IWritable */
/** @typedef {{createdAfter?: string, displayTitles?: string[], runCommand?: TCommandRunner, targetSha?: string, workflow: string}} IFindWorkflowRunOptions */
/** @typedef {{createdAfter?: string, displayTitles?: string[], findWorkflowRunFn?: (options: IFindWorkflowRunOptions) => IWorkflowRun | null, label?: string, nowFn?: () => number, readStartTimeoutMsFn?: (env?: NodeJS.ProcessEnv) => number, sleepFn?: (milliseconds: number) => Promise<void>, stderr?: IWritable, targetSha?: string, workflow?: string}} IWaitForWorkflowRunOptions */

/** @param {unknown} value @returns {value is IWorkflowRun} */
function isWorkflowRun(value) {
    return typeof value === 'object'
        && value !== null
        && 'url' in value
        && typeof value.url === 'string';
}

/** @param {NodeJS.ProcessEnv} [env] */
export function readWorkflowStartTimeoutMs(env = process.env) {
    const raw = env.EVB_GITHUB_WORKFLOW_START_TIMEOUT_MS?.trim();
    if (!raw) {
        return DEFAULT_START_TIMEOUT_MS;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(
            `EVB_GITHUB_WORKFLOW_START_TIMEOUT_MS must be a positive integer, received "${raw}"`,
        );
    }

    return parsed;
}

/** @param {unknown} error */
export function isTransientGitHubCliError(error) {
    const message = errorMessage(error);

    return TRANSIENT_GITHUB_CLI_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

/** @param {unknown} error */
export function briefErrorMessage(error) {
    return errorMessage(error).split('\n')[0] ?? String(error);
}

/** @param {string} workflow @param {{runCommand?: TCommandRunner}} [options] @returns {IWorkflowRun[]} */
export function listWorkflowRuns(workflow, {runCommand = run} = {}) {
    const payload = runCommand('gh', [
        'run',
        'list',
        '--workflow',
        workflow,
        '--limit',
        '20',
        '--json',
        'createdAt,databaseId,displayTitle,event,headBranch,headSha,name,status,conclusion,url,workflowName',
    ]);
    const parsed = JSON.parse(payload);
    if (!Array.isArray(parsed)) {
        throw new Error(`Unexpected GitHub CLI response while listing ${workflow} runs`);
    }

    return parsed.filter(isWorkflowRun);
}

/** @param {IWorkflowRun} runInfo @param {string} createdAfter */
export function isAtOrAfterCreatedAfter(runInfo, createdAfter) {
    if (!createdAfter) {
        return true;
    }

    const createdAtMs = Date.parse(String(runInfo.createdAt ?? ''));
    const createdAfterMs = Date.parse(createdAfter);

    if (!Number.isFinite(createdAtMs) || !Number.isFinite(createdAfterMs)) {
        return true;
    }

    // Allow a little clock skew between the local machine and GitHub's event timestamp.
    return createdAtMs >= createdAfterMs - 60_000;
}

/** @param {IWorkflowRun} runInfo @param {string[]} displayTitles */
function matchesDisplayTitle(runInfo, displayTitles) {
    if (displayTitles.length === 0) {
        return true;
    }

    return displayTitles.includes(String(runInfo.displayTitle ?? ''));
}

/** @param {IFindWorkflowRunOptions} options @returns {IWorkflowRun | null} */
export function findWorkflowRun({
    createdAfter = '',
    displayTitles = [],
    runCommand = run,
    targetSha = '',
    workflow,
}) {
    return listWorkflowRuns(workflow, {runCommand}).find(runInfo => {
        if (!runInfo || typeof runInfo !== 'object') {
            return false;
        }

        const matchesTarget = !targetSha
            || !runInfo.headSha
            || runInfo.headSha === targetSha;

        return matchesDisplayTitle(runInfo, displayTitles)
            && matchesTarget
            && isAtOrAfterCreatedAfter(runInfo, createdAfter);
    }) ?? null;
}

/** @param {{error: unknown, label: string, stderr: IWritable, transientPollFailures: number}} options */
function writeTransientPollingFailure({
    error,
    label,
    stderr,
    transientPollFailures,
}) {
    stderr.write(
        `Transient GitHub polling failure while locating ${label} `
        + `(attempt ${transientPollFailures}); retrying: ${briefErrorMessage(error)}\n`,
    );
}

/** @param {IWaitForWorkflowRunOptions} [options] @returns {Promise<IWorkflowRun>} */
export async function waitForWorkflowRunStart({
    createdAfter = '',
    displayTitles = [],
    findWorkflowRunFn = findWorkflowRun,
    label = '',
    nowFn = Date.now,
    readStartTimeoutMsFn = readWorkflowStartTimeoutMs,
    sleepFn = sleep,
    stderr = process.stderr,
    targetSha = '',
    workflow,
} = {}) {
    const deadline = nowFn() + readStartTimeoutMsFn();
    const workflowLabel = label || workflow || 'workflow';
    let transientPollFailures = 0;

    while (nowFn() < deadline) {
        try {
            const runInfo = findWorkflowRunFn({
                createdAfter,
                displayTitles,
                targetSha,
                workflow: workflow ?? '',
            });
            transientPollFailures = 0;

            if (runInfo) {
                return runInfo;
            }
        } catch (error) {
            if (!isTransientGitHubCliError(error)) {
                throw error;
            }

            transientPollFailures += 1;
            writeTransientPollingFailure({
                error,
                label: workflowLabel,
                stderr,
                transientPollFailures,
            });
        }

        await sleepFn(POLL_INTERVAL_MS);
    }

    throw new Error(
        `Timed out while locating ${workflowLabel}. `
        + 'Set EVB_GITHUB_WORKFLOW_START_TIMEOUT_MS to a larger value if needed.',
    );
}

/** @param {string} runUrl */
export function getRunArtifactsUrl(runUrl) {
    return `${runUrl}#artifacts`;
}

/** @param {string} runUrl */
export function getRepositoryUrlFromRunUrl(runUrl) {
    const match = String(runUrl).match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/actions\/runs\/\d+/u);

    return match?.[1] ?? '';
}
