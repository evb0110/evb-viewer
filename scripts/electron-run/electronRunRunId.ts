import { randomBytes } from 'node:crypto';

const RUN_ID_PREFIX = 'run';
const RUN_ID_MAX_LENGTH = 32;
const RUN_ID_SAFE_CHARS = /[^a-zA-Z0-9_-]+/g;

export const E2E_RUN_ID_ENV = 'EVB_E2E_RUN_ID';

function createRunId() {
    return `${RUN_ID_PREFIX}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export function normalizeE2ERunId(value: string) {
    const normalized = value
        .trim()
        .replace(RUN_ID_SAFE_CHARS, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, RUN_ID_MAX_LENGTH);
    return normalized || createRunId();
}

export function getE2ERunId(env: NodeJS.ProcessEnv = process.env) {
    const existing = env[E2E_RUN_ID_ENV];
    if (existing) {
        const normalized = normalizeE2ERunId(existing);
        env[E2E_RUN_ID_ENV] = normalized;
        return normalized;
    }

    const created = createRunId();
    env[E2E_RUN_ID_ENV] = created;
    return created;
}

export function createE2ERunScopedSessionName(name: string, env: NodeJS.ProcessEnv = process.env) {
    const runId = getE2ERunId(env);
    const normalizedName = name.startsWith('e2e-') ? name.slice(4) : name;
    const prefix = `e2e-${runId}-`;
    return name.startsWith(prefix) ? name : `${prefix}${normalizedName}`;
}

export function isTruthyEnvValue(value: string | undefined) {
    const normalized = value?.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function buildE2ERunEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return {
        [E2E_RUN_ID_ENV]: getE2ERunId(env),
        // Electron E2E runs against the production renderer build.
        EVB_BUILT_RENDERER: '1',
    };
}
