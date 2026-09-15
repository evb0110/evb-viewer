import {
    readFile,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DIAGNOSTIC_EVENT_DEFINITIONS} from '../../packages/contracts/diagnostics/diagnosticEventDefinitions.js';
import {
    assertSameSentryBuildIdentity,
    assertSentryBuildIdentity,
} from '../../packages/contracts/diagnostics/releaseIdentity.js';
import {getErrorMessage} from '../../packages/contracts/getErrorMessage.js';
import {
    CANARY_RECEIPT_SCHEMA_VERSION,
    findCanaryMapping,
    getCanaryEventId,
    getCanaryCodeFile,
} from './send-sentry-sourcemap-canaries.mjs';
import {getPrivateSourcemapManifestPath} from './stage-private-sourcemaps.mjs';

export const SENTRY_EU_API_ORIGIN = 'https://de.sentry.io';
export const SENTRY_CANARY_VERIFICATION_SCHEMA_VERSION = 1;

const SAFE_CONFIGURATION_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const VERIFY_ATTEMPTS = 12;
const VERIFY_RETRY_BASE_MS = 1_000;
const VERIFY_RETRY_MAX_MS = 5_000;
const VERIFY_REQUEST_TIMEOUT_MS = 30_000;
// Eight release lanes share the verification token. Keep aggregate request
// concurrency below Sentry's 25-request limit while retaining parallelism
// within each lane.
const VERIFY_CONCURRENCY = 2;
const DEBUG_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const SOURCE_MAP_CANARY = DIAGNOSTIC_EVENT_DEFINITIONS.SENTRY_SOURCE_MAP_CANARY;

class SentryApiError extends Error {
    constructor(kind, status, cause) {
        super(
            `Sentry ${kind} verification request failed`
            + (status === 'network' ? ' because of a network error' : ` with HTTP ${String(status)}`),
            {cause},
        );
        this.kind = kind;
        this.status = status;
    }
}

function readIdentity(environment) {
    return assertSentryBuildIdentity({
        target: environment.EVB_SENTRY_TARGET,
        release: environment.EVB_SENTRY_RELEASE,
        dist: environment.EVB_SENTRY_DIST,
        environment: environment.EVB_SENTRY_ENVIRONMENT,
    });
}

function requiredPrivateConfiguration(environment, key, label) {
    const value = environment[key];
    if (typeof value !== 'string' || !SAFE_CONFIGURATION_VALUE.test(value)) {
        throw new Error(`Missing or invalid private Sentry ${label} configuration`);
    }
    return value;
}

function requiredVerificationToken(environment) {
    const value = environment.SENTRY_VERIFICATION_TOKEN;
    if (typeof value !== 'string' || value.trim().length === 0 || /[\r\n]/u.test(value)) {
        throw new Error('Missing or invalid private Sentry verification credential');
    }
    return value;
}

function projectEnvironmentKey(target) {
    return target === 'desktop'
        ? 'SENTRY_DESKTOP_PROJECT'
        : 'SENTRY_WEB_PROJECT';
}

function apiPath({
    organization,
    project,
    eventId,
    kind,
}) {
    const encodedOrganization = encodeURIComponent(organization);
    const encodedProject = encodeURIComponent(project);
    const encodedEventId = encodeURIComponent(eventId);
    const suffix = kind === 'source-map-debug'
        ? `/events/${encodedEventId}/source-map-debug/`
        : `/events/${encodedEventId}/`;
    return `${SENTRY_EU_API_ORIGIN}/api/0/projects/${encodedOrganization}/${encodedProject}${suffix}`;
}

async function requestJson(url, kind, {
    fetchImpl,
    token,
}) {
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'GET',
            headers: {
                accept: 'application/json',
                authorization: `Bearer ${token}`,
            },
            redirect: 'error',
            signal: AbortSignal.timeout(VERIFY_REQUEST_TIMEOUT_MS),
        });
    } catch (error) {
        throw new SentryApiError(kind, 'network', error);
    }
    if (!response.ok) {
        throw new SentryApiError(kind, response.status);
    }
    let payload;
    try {
        payload = JSON.parse(await response.text());
    } catch (error) {
        throw new Error(`Sentry ${kind} verification returned invalid JSON`, {cause: error});
    }
    return payload;
}

function isRetryableApiError(error) {
    return error instanceof SentryApiError
        && (error.status === 'network'
            || error.status === 404
            || error.status === 408
            || error.status === 425
            || error.status === 429
            || error.status >= 500);
}

function retryDelay(attempt) {
    return Math.min(
        VERIFY_RETRY_MAX_MS,
        VERIFY_RETRY_BASE_MS * (2 ** (attempt - 1)),
    );
}

function defaultSleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function normalizePath(value) {
    const withoutScheme = value
        .replaceAll('\\', '/')
        .replace(/^webpack:\/{2,}/u, '')
        .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/{2,}/u, '')
        .replace(/^\/+/, '');
    const segments = [];
    for (const segment of withoutScheme.split('/')) {
        if (!segment || segment === '.') {
            continue;
        }
        if (segment === '..') {
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    return segments.join('/');
}

function sourcePathMatches(frame, expectedSource) {
    const expected = normalizePath(expectedSource);
    if (!expected) {
        return false;
    }
    return [
        frame?.filename,
        frame?.absPath,
        frame?.module,
    ]
        .filter(value => typeof value === 'string')
        .map(normalizePath)
        .some(value => value === expected);
}

function hasSourceContext(frame, expectedLine) {
    return Array.isArray(frame?.context)
        && frame.context.some(entry => (
            Array.isArray(entry)
            && entry[0] === expectedLine
            && typeof entry[1] === 'string'
            && entry[1].length > 0
        ));
}

function debugFrames(payload) {
    return (Array.isArray(payload?.exceptions) ? payload.exceptions : [])
        .flatMap(exception => Array.isArray(exception?.frames) ? exception.frames : []);
}

function inspectDebugPayload(payload, identity, evidence) {
    if (payload?.release !== identity.release || payload?.dist !== identity.dist) {
        return {
            ok: false,
            terminal: true,
            reason: 'release or distribution mismatch in source-map debug response',
        };
    }
    const expectedCodeFile = evidence.codeFile
        ?? getCanaryCodeFile(identity, evidence.bundle);
    const frame = debugFrames(payload).find(candidate => {
        const debugIdProcess = candidate?.debug_id_process;
        const releaseProcess = candidate?.release_process;
        return debugIdProcess?.debug_id === evidence.debugId
            && releaseProcess?.abs_path === expectedCodeFile;
    });
    if (!frame) {
        return {
            ok: false,
            terminal: false,
            reason: 'canary frame is not associated with an uploaded artifact',
        };
    }
    const debugIdProcess = frame.debug_id_process;
    if (
        debugIdProcess?.debug_id !== evidence.debugId
        || debugIdProcess?.uploaded_source_file_with_correct_debug_id !== true
        || debugIdProcess?.uploaded_source_map_with_correct_debug_id !== true
    ) {
        return {
            ok: false,
            terminal: false,
            reason: 'uploaded Debug ID does not match the canary receipt',
        };
    }
    // Sentry can report the Debug ID lookup as complete while its separate
    // release-path lookup still reports no matching map. The processed event
    // is the authoritative second proof in that case. Requiring both release
    // lookup fields to be "found" caused every valid event to retry until the
    // release job timed out, even though Sentry had already symbolicated it.
    // Do not turn this endpoint's release-path result into a false negative.
    return {ok: true};
}

function eventFrames(payload) {
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    return entries
        .filter(entry => entry?.type === 'exception')
        .flatMap(entry => entry?.data?.values ?? [])
        .flatMap(value => value?.stacktrace?.frames ?? [])
        .filter(frame => frame && typeof frame === 'object');
}

function eventEnvironmentMatches(payload, expectedEnvironment) {
    if (typeof payload?.environment === 'string') {
        return payload.environment === expectedEnvironment;
    }
    return Array.isArray(payload?.tags)
        && payload.tags.some(tag => (
            tag?.key === 'environment'
            && tag?.value === expectedEnvironment
        ));
}

function eventTagMatches(payload, key, expectedValue) {
    if (Array.isArray(payload?.tags)) {
        return payload.tags.some(tag => (
            tag?.key === key
            && tag?.value === expectedValue
        ));
    }
    return payload?.tags?.[key] === expectedValue;
}

function eventLoggerMatches(payload, expectedLogger) {
    if (typeof payload?.logger === 'string') {
        return payload.logger === expectedLogger;
    }
    return eventTagMatches(payload, 'logger', expectedLogger);
}

function inspectEventPayload(payload, identity, evidence) {
    if (payload?.eventID !== evidence.eventId) {
        return {
            ok: false,
            terminal: false,
            reason: 'event ID does not match the canary receipt',
        };
    }
    if (payload?.dist !== identity.dist || payload?.release?.version !== identity.release) {
        return {
            ok: false,
            terminal: true,
            reason: 'event release or distribution mismatch',
        };
    }
    if (!eventEnvironmentMatches(payload, identity.environment)) {
        return {
            ok: false,
            terminal: true,
            reason: 'event environment does not match the canary receipt',
        };
    }
    if (
        !eventLoggerMatches(payload, SOURCE_MAP_CANARY.logger)
        || !eventTagMatches(payload, SOURCE_MAP_CANARY.tagKey, SOURCE_MAP_CANARY.tagValue)
        || !eventTagMatches(payload, 'bundle_role', evidence.role)
    ) {
        return {
            ok: false,
            terminal: true,
            reason: 'event is not the expected source-map canary',
        };
    }
    const frame = eventFrames(payload).find(candidate => (
        candidate.inApp === true
        && candidate.lineNo === evidence.expectedLine
        && sourcePathMatches(candidate, evidence.expectedSource)
    ));
    if (!frame) {
        return {
            ok: false,
            terminal: false,
            reason: 'event has no matching symbolicated in-app frame',
        };
    }
    if (!hasSourceContext(frame, evidence.expectedLine)) {
        return {
            ok: false,
            terminal: false,
            reason: 'symbolicated frame has no source context',
        };
    }
    return {ok: true};
}

function assertCanaryReceipt(receipt, identity) {
    if (
        !receipt
        || typeof receipt !== 'object'
        || receipt.schemaVersion !== CANARY_RECEIPT_SCHEMA_VERSION
        || !Array.isArray(receipt.events)
        || !Array.isArray(receipt.skippedBundles)
    ) {
        throw new Error('Private Sentry canary receipt is invalid');
    }
    assertSameSentryBuildIdentity(identity, receipt.identity);
    for (const event of receipt.events) {
        if (
            !event
            || typeof event !== 'object'
            || !/^[0-9a-f]{32}$/u.test(event.eventId ?? '')
            || typeof event.bundle !== 'string'
            || typeof event.codeFile !== 'string'
            || !DEBUG_ID_PATTERN.test(event.debugId ?? '')
            || typeof event.role !== 'string'
            || typeof event.expectedSource !== 'string'
            || !Number.isSafeInteger(event.expectedLine)
            || (event.expectedFunction !== null && typeof event.expectedFunction !== 'string')
        ) {
            throw new Error('Private Sentry canary receipt contains invalid event evidence');
        }
    }
}

function resolveStagePath(stageRoot, relativePath, label) {
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
        throw new Error(`Invalid ${label} in private source-map manifest`);
    }
    const resolvedRoot = path.resolve(stageRoot);
    const resolvedPath = path.resolve(resolvedRoot, relativePath);
    const relative = path.relative(resolvedRoot, resolvedPath);
    if (
        relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
    ) {
        throw new Error(`Unsafe ${label} in private source-map manifest`);
    }
    return resolvedPath;
}

async function readBundleMap(stageRoot, bundle) {
    const mapPath = resolveStagePath(stageRoot, bundle.stagedMapPath, 'staged map path');
    return JSON.parse(await readFile(mapPath, 'utf8'));
}

async function assertManifestCoverage(receipt, identity, stageRoot) {
    const manifestPath = path.join(stageRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (
        manifest?.schemaVersion !== 1
        || !Array.isArray(manifest.bundles)
        || manifest.bundles.length === 0
    ) {
        throw new Error('Private source-map manifest is invalid');
    }
    assertSameSentryBuildIdentity(identity, manifest.identity);
    const bundles = new Map();
    for (const bundle of manifest.bundles) {
        if (
            !bundle
            || typeof bundle.bundle !== 'string'
            || typeof bundle.role !== 'string'
            || !Array.isArray(bundle.sources)
            || typeof bundle.stagedMapPath !== 'string'
            || bundles.has(bundle.bundle)
        ) {
            throw new Error('Private source-map manifest contains invalid bundles');
        }
        bundles.set(bundle.bundle, bundle);
    }

    const covered = new Set();
    for (const evidence of receipt.events) {
        if (covered.has(evidence.bundle)) {
            throw new Error('Private Sentry canary receipt contains duplicate bundle evidence');
        }
        const bundle = bundles.get(evidence.bundle);
        if (!bundle) {
            throw new Error('Private Sentry canary receipt contains an unknown bundle');
        }
        if (
            evidence.role !== bundle.role
            || evidence.codeFile !== getCanaryCodeFile(identity, bundle.bundle)
            || evidence.eventId !== getCanaryEventId(identity, bundle.bundle)
        ) {
            throw new Error('Private Sentry canary receipt does not match the build manifest');
        }
        const mapPayload = await readBundleMap(stageRoot, bundle);
        const mapDebugId = mapPayload?.debug_id ?? mapPayload?.debugId;
        const mapping = findCanaryMapping(mapPayload, bundle.sources);
        if (
            mapDebugId !== evidence.debugId
            || !mapping
            || evidence.expectedSource !== mapping.originalSource
            || evidence.expectedLine !== mapping.originalLine
            || evidence.expectedFunction !== mapping.originalFunction
        ) {
            throw new Error('Private Sentry canary receipt does not match the staged source map');
        }
        covered.add(evidence.bundle);
    }

    for (const skipped of receipt.skippedBundles) {
        if (
            !skipped
            || typeof skipped.bundle !== 'string'
            || typeof skipped.reason !== 'string'
            || covered.has(skipped.bundle)
        ) {
            throw new Error('Private Sentry canary receipt contains invalid skipped-bundle evidence');
        }
        const bundle = bundles.get(skipped.bundle);
        if (!bundle) {
            throw new Error('Private Sentry canary receipt skips an unknown bundle');
        }
        if (skipped.reason === 'no-project-source') {
            if (bundle.sources.length !== 0) {
                throw new Error('Private Sentry canary receipt misclassifies a mapped bundle');
            }
        } else if (skipped.reason === 'no-project-mapping') {
            const mapping = findCanaryMapping(await readBundleMap(stageRoot, bundle), bundle.sources);
            if (bundle.sources.length === 0 || mapping) {
                throw new Error('Private Sentry canary receipt misclassifies an unmapped bundle');
            }
        } else {
            throw new Error('Private Sentry canary receipt contains an unknown skip reason');
        }
        covered.add(skipped.bundle);
    }

    if (covered.size !== bundles.size) {
        throw new Error('Private Sentry canary receipt does not cover the complete build manifest');
    }
}

async function verifyEvent(evidence, {
    identity,
    organization,
    project,
    token,
    fetchImpl,
    sleep,
}) {
    let lastReason = 'Sentry has not finished processing the event';
    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
        let debugPayload;
        try {
            debugPayload = await requestJson(
                apiPath({
                    organization,
                    project,
                    eventId: evidence.eventId,
                    kind: 'source-map-debug',
                }),
                'source-map-debug',
                {
                    fetchImpl,
                    token,
                },
            );
        } catch (error) {
            if (!isRetryableApiError(error) || attempt === VERIFY_ATTEMPTS) {
                throw error;
            }
            lastReason = error.message;
            await sleep(retryDelay(attempt));
            continue;
        }
        const debugResult = inspectDebugPayload(debugPayload, identity, evidence);
        if (debugResult.terminal) {
            throw new Error(debugResult.reason);
        }
        if (!debugResult.ok) {
            lastReason = debugResult.reason;
            if (attempt < VERIFY_ATTEMPTS) {
                await sleep(retryDelay(attempt));
            }
            continue;
        }

        let eventPayload;
        try {
            eventPayload = await requestJson(
                apiPath({
                    organization,
                    project,
                    eventId: evidence.eventId,
                    kind: 'event',
                }),
                'event',
                {
                    fetchImpl,
                    token,
                },
            );
        } catch (error) {
            if (!isRetryableApiError(error) || attempt === VERIFY_ATTEMPTS) {
                throw error;
            }
            lastReason = error.message;
            await sleep(retryDelay(attempt));
            continue;
        }
        const eventResult = inspectEventPayload(eventPayload, identity, evidence);
        if (eventResult.terminal) {
            throw new Error(eventResult.reason);
        }
        if (eventResult.ok) {
            return {
                bundle: evidence.bundle,
                eventId: evidence.eventId,
                expectedFunction: evidence.expectedFunction,
                expectedLine: evidence.expectedLine,
                expectedSource: evidence.expectedSource,
                role: evidence.role,
                status: 'verified',
            };
        }
        lastReason = eventResult.reason;
        if (attempt < VERIFY_ATTEMPTS) {
            await sleep(retryDelay(attempt));
        }
    }
    throw new Error(lastReason);
}

async function mapWithConcurrency(items, callback, concurrency = VERIFY_CONCURRENCY) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await callback(items[index]);
        }
    };
    await Promise.all(
        Array.from({length: Math.min(concurrency, Math.max(items.length, 1))}, worker),
    );
    return results;
}

/**
 * Verifies every event in the latest credential-free canary receipt against
 * Sentry's source-map debug and processed-event APIs. The verification receipt
 * contains only build identity and sanitized pass/fail evidence.
 *
 * @param {{
 *   environment?: NodeJS.ProcessEnv,
 *   projectRoot?: string,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (milliseconds: number) => Promise<void>,
 * }} options
 */
export async function verifySentrySourcemapCanaries({
    environment = process.env,
    projectRoot = process.cwd(),
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
} = {}) {
    const identity = readIdentity(environment);
    const root = path.resolve(projectRoot);
    const stageRoot = path.dirname(getPrivateSourcemapManifestPath({
        projectRoot: root,
        identity,
    }));
    const receiptPath = path.join(stageRoot, 'canary-receipt.json');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    assertCanaryReceipt(receipt, identity);
    await assertManifestCoverage(receipt, identity, stageRoot);
    if (receipt.events.length === 0) {
        throw new Error('Private Sentry canary receipt contains no verifiable events');
    }

    const organization = requiredPrivateConfiguration(
        environment,
        'SENTRY_ORG',
        'organization',
    );
    const project = requiredPrivateConfiguration(
        environment,
        projectEnvironmentKey(identity.target),
        'project',
    );
    const token = requiredVerificationToken(environment);
    const results = await mapWithConcurrency(receipt.events, async evidence => {
        try {
            return {
                ok: true,
                value: await verifyEvent(evidence, {
                    identity,
                    organization,
                    project,
                    token,
                    fetchImpl,
                    sleep,
                }),
            };
        } catch (error) {
            return {
                error: getErrorMessage(error),
                ok: false,
                value: {
                    bundle: evidence.bundle,
                    eventId: evidence.eventId,
                    role: evidence.role,
                    status: 'failed',
                },
            };
        }
    });
    const verified = results
        .filter(result => result.ok)
        .map(result => result.value);
    const failures = results
        .flatMap((result, index) => result.ok ? [] : [{
            bundle: result.value.bundle,
            eventId: result.value.eventId,
            reason: result.error,
            role: result.value.role,
            receiptIndex: index,
        }]);
    const verificationReceipt = {
        events: verified,
        failureCount: failures.length,
        failures,
        identity,
        schemaVersion: SENTRY_CANARY_VERIFICATION_SCHEMA_VERSION,
        verifiedCount: verified.length,
    };
    await writeFile(
        path.join(stageRoot, 'canary-verification-receipt.json'),
        `${JSON.stringify(verificationReceipt, null, 2)}\n`,
        {mode: 0o600},
    );
    if (failures.length > 0) {
        throw new Error(
            `Sentry source-map verification failed for ${String(failures.length)}`
            + ` of ${String(receipt.events.length)} canary event(s): `
            + `${failures[0]?.reason ?? 'unknown failure'}`,
        );
    }
    process.stdout.write(
        `Sentry verified ${String(verified.length)} source-map canary event(s) for `
        + `${identity.release}, ${identity.dist}.\n`,
    );
    return verificationReceipt;
}

function isDirectInvocation() {
    return process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectInvocation()) {
    await verifySentrySourcemapCanaries();
}
