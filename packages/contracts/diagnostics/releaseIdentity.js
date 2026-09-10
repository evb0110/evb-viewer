import {
    DESKTOP_DIAGNOSTIC_DIST_IDENTITIES,
    isDesktopDiagnosticDist,
} from './desktopDiagnosticDists.js';

export const SENTRY_DESKTOP_RELEASE_NAME = 'evb-viewer-desktop';
export const SENTRY_WEB_RELEASE_NAME = 'evb-viewer-web';

export const SENTRY_DIAGNOSTIC_ENVIRONMENTS = Object.freeze([
    'production',
    'preview',
    'development',
    'test',
]);

export const SENTRY_WEB_PRODUCTION_DIST = 'production';

const SAFE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u;
const SAFE_RELEASE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const SAFE_BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_RELEASE_LENGTH = 256;

const DESKTOP_TARGET_PLATFORM_NAMES = new Map([
    [
        'darwin',
        'macos',
    ],
    [
        'mac',
        'macos',
    ],
    [
        'macos',
        'macos',
    ],
    [
        'win32',
        'windows',
    ],
    [
        'win',
        'windows',
    ],
    [
        'windows',
        'windows',
    ],
    [
        'linux',
        'linux',
    ],
]);

const TARGET_PLATFORM_ENV_KEYS = [
    'EVB_RELEASE_TARGET_PLATFORM',
    'EVB_NATIVE_TARGET_PLATFORM',
];
const TARGET_ARCH_ENV_KEYS = [
    'EVB_RELEASE_TARGET_ARCH',
    'EVB_NATIVE_TARGET_ARCH',
];

function firstNonEmpty(environment, keys) {
    for (const key of keys) {
        const rawValue = environment?.[key];
        const value = typeof rawValue === 'string' ? rawValue.trim() : '';
        if (value) {
            return value;
        }
    }
    return '';
}

function consistentNonEmpty(environment, keys, label) {
    const values = keys
        .map(key => environment?.[key])
        .filter(value => typeof value === 'string')
        .map(value => value.trim())
        .filter(Boolean);
    const uniqueValues = [...new Set(values)];
    if (uniqueValues.length > 1) {
        throw new Error(`Conflicting ${label} values: ${uniqueValues.join(', ')}`);
    }
    return uniqueValues[0] ?? '';
}

function consistentArgument(value, environment, keys, label) {
    const explicit = value === undefined
        ? ''
        : assertString(value, label).trim();
    const configured = consistentNonEmpty(environment, keys, label);
    if (explicit && configured && explicit !== configured) {
        throw new Error(`Conflicting ${label} values: ${explicit}, ${configured}`);
    }
    return explicit || configured;
}

function assertString(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} must be a non-empty string`);
    }
    return value;
}

function assertEnvironment(value) {
    assertString(value, 'Sentry environment');
    if (!SENTRY_DIAGNOSTIC_ENVIRONMENTS.includes(value)) {
        throw new Error(
            `Unsupported Sentry environment "${value}". `
            + `Expected one of ${SENTRY_DIAGNOSTIC_ENVIRONMENTS.join(', ')}`,
        );
    }
    return value;
}

function assertRelease(value) {
    assertString(value, 'Sentry release');
    if (value.length > MAX_RELEASE_LENGTH || value === 'latest' || value.includes('@latest')) {
        throw new Error('Sentry release must be immutable and must not use latest');
    }
    if (!/^evb-viewer-(?:desktop|web)@/u.test(value)) {
        throw new Error(`Unsupported Sentry release "${value}"`);
    }
    const token = value.slice(value.indexOf('@') + 1);
    if (!SAFE_RELEASE_TOKEN_PATTERN.test(token)) {
        throw new Error(`Sentry release token is unsafe: "${token}"`);
    }
    return value;
}

function assertReleaseForTarget(target, value) {
    const release = assertRelease(value);
    const expectedPrefix = target === 'desktop'
        ? `${SENTRY_DESKTOP_RELEASE_NAME}@`
        : `${SENTRY_WEB_RELEASE_NAME}@`;
    if (!release.startsWith(expectedPrefix)) {
        throw new Error(`Sentry release does not match target "${target}"`);
    }
    const token = release.slice(expectedPrefix.length);
    return target === 'desktop'
        ? assertDesktopVersion(token)
        : assertWebReleaseToken(token);
}

function assertWebDist(value) {
    assertString(value, 'Sentry web dist');
    if (value === SENTRY_WEB_PRODUCTION_DIST) {
        return value;
    }
    if (
        !value.startsWith('preview-')
        || !SAFE_BUILD_ID_PATTERN.test(value.slice('preview-'.length))
        || value === 'preview-latest'
    ) {
        throw new Error(`Unsupported Sentry web dist "${value}"`);
    }
    return value;
}

function assertDist(target, value) {
    assertString(value, 'Sentry dist');
    if (target === 'desktop') {
        if (!isDesktopDiagnosticDist(value)) {
            throw new Error(
                `Unsupported desktop Sentry dist "${value}". `
                + `Expected one of ${DESKTOP_DIAGNOSTIC_DIST_IDENTITIES.join(', ')}`,
            );
        }
        return value;
    }
    return assertWebDist(value);
}

function desktopDistPlatform(value) {
    if (value.startsWith('macos-')) {
        return 'macos';
    }
    if (
        value.startsWith('windows-')
        || value.startsWith('store-appx-')
        || value.startsWith('win7-legacy-')
    ) {
        return 'windows';
    }
    if (value.startsWith('linux-')) {
        return 'linux';
    }
    return null;
}

function desktopDistArchitecture(value) {
    if (value.endsWith('-x64')) {
        return 'x64';
    }
    if (value.endsWith('-arm64')) {
        return 'arm64';
    }
    return null;
}

function assertTarget(value) {
    if (value !== 'desktop' && value !== 'web') {
        throw new Error(`Unsupported Sentry build target "${value}"`);
    }
    return value;
}

function assertDesktopVersion(version) {
    assertString(version, 'Desktop package version');
    if (!SAFE_VERSION_PATTERN.test(version)) {
        throw new Error(`Desktop package version is not a release version: "${version}"`);
    }
    return version;
}

function assertWebReleaseToken(value) {
    assertString(value, 'Web release version or deployment');
    if (value === 'latest' || !SAFE_RELEASE_TOKEN_PATTERN.test(value)) {
        throw new Error(`Web release token is unsafe: "${value}"`);
    }
    return value;
}

function resolveEnvironment(environment = {}) {
    const explicit = consistentNonEmpty(environment, [
        'EVB_SENTRY_ENVIRONMENT',
        'SENTRY_ENVIRONMENT',
    ], 'Sentry environment');
    if (explicit) {
        return assertEnvironment(explicit);
    }

    const vercelEnvironment = typeof environment.VERCEL_ENV === 'string'
        ? environment.VERCEL_ENV.trim()
        : '';
    if (vercelEnvironment === 'production' || vercelEnvironment === 'preview') {
        return vercelEnvironment;
    }
    if (vercelEnvironment === 'development') {
        return 'development';
    }

    const ref = typeof environment.GITHUB_REF === 'string'
        ? environment.GITHUB_REF.trim()
        : '';
    if (/^refs\/tags\/v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u.test(ref)) {
        return 'production';
    }
    if (environment.GITHUB_EVENT_NAME === 'pull_request') {
        return 'preview';
    }
    if (environment.NODE_ENV === 'test') {
        return 'test';
    }
    if (environment.NODE_ENV === 'development') {
        return 'development';
    }
    if (environment.CI === 'true' || environment.GITHUB_ACTIONS === 'true') {
        return 'test';
    }
    if (environment.NODE_ENV === 'production') {
        return 'production';
    }
    return 'development';
}

function inferSentryBuildTarget(environment) {
    const release = consistentNonEmpty(environment, ['EVB_SENTRY_RELEASE'], 'Sentry release');
    const inferredTargets = new Set();
    if (release.startsWith(`${SENTRY_WEB_RELEASE_NAME}@`)) {
        inferredTargets.add('web');
    } else if (release.startsWith(`${SENTRY_DESKTOP_RELEASE_NAME}@`)) {
        inferredTargets.add('desktop');
    }

    const targetPlatform = consistentNonEmpty(
        environment,
        TARGET_PLATFORM_ENV_KEYS,
        'release target platform',
    );
    const targetArchitecture = consistentNonEmpty(
        environment,
        TARGET_ARCH_ENV_KEYS,
        'release target architecture',
    );
    const targetDist = consistentNonEmpty(environment, [
        'EVB_RELEASE_TARGET_DIST',
        'EVB_SENTRY_DIST',
    ], 'Sentry dist');
    if (targetPlatform || targetArchitecture || isDesktopDiagnosticDist(targetDist)) {
        inferredTargets.add('desktop');
    }
    if (targetDist === SENTRY_WEB_PRODUCTION_DIST || targetDist.startsWith('preview-')) {
        inferredTargets.add('web');
    }

    if (
        environment.VERCEL === '1'
        || environment.NOW_BUILDER === '1'
        || firstNonEmpty(environment, [
            'EVB_WEB_BUILD_ID',
            'VERCEL_DEPLOYMENT_ID',
        ])
    ) {
        inferredTargets.add('web');
    }
    if (inferredTargets.size > 1) {
        throw new Error(`Conflicting Sentry build target signals: ${[...inferredTargets].join(', ')}`);
    }
    return inferredTargets.values().next().value ?? null;
}

export function resolveSentryBuildTarget(environment = {}) {
    const explicit = consistentNonEmpty(environment, [
        'EVB_SENTRY_TARGET',
        'SENTRY_TARGET',
    ], 'Sentry target');
    const inferred = inferSentryBuildTarget(environment);
    if (explicit) {
        const target = assertTarget(explicit);
        if (inferred && inferred !== target) {
            throw new Error(`Conflicting Sentry build target signals: ${target}, ${inferred}`);
        }
        return target;
    }
    return inferred ?? 'desktop';
}

export function resolveDesktopDiagnosticDist({
    environment = {},
    platform,
    architecture,
} = {}) {
    const explicit = consistentNonEmpty(environment, [
        'EVB_SENTRY_DIST',
        'EVB_RELEASE_TARGET_DIST',
    ], 'Sentry dist');
    const configuredPlatform = consistentNonEmpty(environment, TARGET_PLATFORM_ENV_KEYS, 'release target platform');
    const configuredArchitecture = consistentNonEmpty(environment, TARGET_ARCH_ENV_KEYS, 'release target architecture');
    const platformName = DESKTOP_TARGET_PLATFORM_NAMES.get(configuredPlatform || platform);
    const arch = configuredArchitecture || architecture;
    if (!platformName || (arch !== 'x64' && arch !== 'arm64')) {
        throw new Error(
            `Cannot resolve a closed desktop Sentry dist from platform "${platform}" and architecture "${architecture}"`,
        );
    }

    const derived = `${platformName}-${arch}`;
    if (explicit) {
        const explicitPlatform = desktopDistPlatform(explicit);
        const explicitArchitecture = desktopDistArchitecture(explicit);
        if (
            configuredPlatform
            && explicitPlatform !== platformName
            || configuredArchitecture
            && explicitArchitecture !== arch
        ) {
            throw new Error(`Conflicting desktop Sentry dist identities: ${explicit}, ${derived}`);
        }
        return assertDist('desktop', explicit);
    }
    return assertDist('desktop', derived);
}

function resolveWebBuildId(environment = {}) {
    const raw = firstNonEmpty(environment, [
        'EVB_WEB_BUILD_ID',
        'VERCEL_GIT_COMMIT_SHA',
        'GITHUB_SHA',
        'CI_COMMIT_SHA',
        'EVB_BUILD_GIT_SHA',
        'VERCEL_DEPLOYMENT_ID',
    ]) || 'local';
    const buildId = raw.replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^-+/u, '').slice(0, 128);
    return SAFE_BUILD_ID_PATTERN.test(buildId) ? buildId : 'local';
}

export function resolveWebDiagnosticDist({
    environment = {},
    sentryEnvironment = resolveEnvironment(environment),
} = {}) {
    const normalizedEnvironment = assertEnvironment(sentryEnvironment);
    const configuredEnvironment = consistentNonEmpty(environment, [
        'EVB_SENTRY_ENVIRONMENT',
        'SENTRY_ENVIRONMENT',
    ], 'Sentry environment');
    if (configuredEnvironment && normalizedEnvironment !== configuredEnvironment) {
        throw new Error(`Conflicting Sentry environment values: ${normalizedEnvironment}, ${configuredEnvironment}`);
    }
    const explicit = consistentNonEmpty(environment, [
        'EVB_SENTRY_DIST',
        'EVB_WEB_DIST',
        'EVB_RELEASE_TARGET_DIST',
    ], 'Sentry dist');
    const dist = explicit || (
        normalizedEnvironment === 'production'
            ? SENTRY_WEB_PRODUCTION_DIST
            : `preview-${resolveWebBuildId(environment)}`
    );
    assertDist('web', dist);
    if (normalizedEnvironment === 'production' && dist !== SENTRY_WEB_PRODUCTION_DIST) {
        throw new Error('Production web builds must use the production Sentry dist');
    }
    if (normalizedEnvironment !== 'production' && dist === SENTRY_WEB_PRODUCTION_DIST) {
        throw new Error('Non-production web builds must use a preview Sentry dist');
    }
    return dist;
}

/**
 * Creates the immutable identity consumed by every diagnostics layer.
 * Supplying both an explicit release/dist and their derived inputs is
 * intentional. A mismatch fails the build instead of allowing two identities
 * to escape through different paths.
 */
export function createSentryBuildIdentity({
    target,
    version,
    deployment,
    release,
    dist,
    environment,
} = {}) {
    const normalizedTarget = assertTarget(target);
    const normalizedEnvironment = assertEnvironment(environment);
    const derivedRelease = normalizedTarget === 'desktop'
        ? `${SENTRY_DESKTOP_RELEASE_NAME}@${assertDesktopVersion(version)}`
        : `${SENTRY_WEB_RELEASE_NAME}@${assertWebReleaseToken(deployment ?? version)}`;
    const normalizedRelease = release === undefined
        ? derivedRelease
        : assertRelease(release);
    assertRelease(derivedRelease);
    if (normalizedRelease !== derivedRelease) {
        throw new Error(
            `Conflicting Sentry release identities: derived "${derivedRelease}" but received "${normalizedRelease}"`,
        );
    }
    const normalizedDist = assertDist(normalizedTarget, dist);
    if (
        normalizedTarget === 'web'
        && normalizedEnvironment === 'production'
        && normalizedDist !== SENTRY_WEB_PRODUCTION_DIST
    ) {
        throw new Error('Production web builds must use the production Sentry dist');
    }
    if (
        normalizedTarget === 'web'
        && normalizedEnvironment !== 'production'
        && normalizedDist === SENTRY_WEB_PRODUCTION_DIST
    ) {
        throw new Error('Non-production web builds must use a preview Sentry dist');
    }
    return Object.freeze({
        target: normalizedTarget,
        release: normalizedRelease,
        dist: normalizedDist,
        environment: normalizedEnvironment,
    });
}

export function resolveSentryBuildIdentity({
    target,
    version,
    deployment,
    release,
    environment = {},
    platform,
    architecture,
} = {}) {
    const inferredTarget = inferSentryBuildTarget(environment);
    const configuredTarget = consistentNonEmpty(environment, [
        'EVB_SENTRY_TARGET',
        'SENTRY_TARGET',
    ], 'Sentry target');
    const resolvedTarget = target === undefined
        ? (configuredTarget ? assertTarget(configuredTarget) : inferredTarget ?? 'desktop')
        : assertTarget(target);
    if (target !== undefined && configuredTarget && resolvedTarget !== configuredTarget) {
        throw new Error(`Conflicting Sentry build target values: ${resolvedTarget}, ${configuredTarget}`);
    }
    if (target !== undefined && inferredTarget && resolvedTarget !== inferredTarget) {
        throw new Error(`Conflicting Sentry build target signals: ${resolvedTarget}, ${inferredTarget}`);
    }
    const sentryEnvironment = resolveEnvironment(environment);
    const packageVersion = consistentArgument(
        version,
        environment,
        [
            'EVB_PACKAGE_VERSION',
            'npm_package_version',
        ],
        'package version',
    );
    const explicitRelease = consistentArgument(
        release,
        environment,
        ['EVB_SENTRY_RELEASE'],
        'Sentry release',
    );
    const webDeployment = consistentArgument(
        deployment,
        environment,
        [
            'EVB_WEB_DEPLOYMENT',
            'VERCEL_DEPLOYMENT_ID',
            'VERCEL_GIT_COMMIT_SHA',
        ],
        'web deployment',
    ) || packageVersion;
    const resolvedDist = resolvedTarget === 'desktop'
        ? resolveDesktopDiagnosticDist({
            environment,
            platform,
            architecture,
        })
        : resolveWebDiagnosticDist({
            environment,
            sentryEnvironment,
        });
    return createSentryBuildIdentity({
        target: resolvedTarget,
        version: packageVersion,
        deployment: webDeployment,
        release: explicitRelease || undefined,
        dist: resolvedDist,
        environment: sentryEnvironment,
    });
}

export function isSentryDiagnosticsBuild(environment = {}) {
    return environment.EVB_SENTRY_DIAGNOSTICS_BUILD === '1'
        || environment.EVB_ELECTRON_SOURCEMAP === '1'
        || Boolean(firstNonEmpty(environment, [
            'EVB_SENTRY_RELEASE',
            'EVB_SENTRY_DIST',
            'EVB_SENTRY_ENVIRONMENT',
        ]))
        || Boolean(firstNonEmpty(environment, [
            'EVB_RELEASE_TARGET_PLATFORM',
            'EVB_RELEASE_TARGET_ARCH',
            'EVB_RELEASE_TARGET_DIST',
        ]))
        || environment.VERCEL === '1'
        || environment.NOW_BUILDER === '1';
}

export function assertSentryBuildIdentity(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Invalid Sentry build identity');
    }
    const target = value.target;
    const release = value.release;
    const dist = value.dist;
    const environment = value.environment;
    const keys = Object.keys(value);
    if (keys.length !== 4 || keys.some(key => ![
        'target',
        'release',
        'dist',
        'environment',
    ].includes(key))) {
        throw new Error('Invalid Sentry build identity shape');
    }
    assertTarget(target);
    assertReleaseForTarget(target, release);
    assertDist(target, dist);
    assertEnvironment(environment);
    const expectedPrefix = target === 'desktop'
        ? `${SENTRY_DESKTOP_RELEASE_NAME}@`
        : `${SENTRY_WEB_RELEASE_NAME}@`;
    if (!release.startsWith(expectedPrefix)) {
        throw new Error(`Sentry release does not match target "${target}"`);
    }
    if (
        target === 'web'
        && ((environment === 'production' && dist !== SENTRY_WEB_PRODUCTION_DIST)
            || (environment !== 'production' && dist === SENTRY_WEB_PRODUCTION_DIST))
    ) {
        throw new Error(`Sentry web dist does not match environment "${environment}"`);
    }
    return Object.freeze({
        target,
        release,
        dist,
        environment,
    });
}

export function sentryBuildIdentityKey(identity) {
    const normalized = assertSentryBuildIdentity(identity);
    return [
        normalized.target,
        normalized.release,
        normalized.dist,
        normalized.environment,
    ].join('\0');
}

export function assertSameSentryBuildIdentity(expected, actual) {
    if (sentryBuildIdentityKey(expected) !== sentryBuildIdentityKey(actual)) {
        throw new Error(
            `Conflicting Sentry build identities: "${expected.release}/${expected.dist}/${expected.environment}" `
            + `and "${actual.release}/${actual.dist}/${actual.environment}"`,
        );
    }
    return assertSentryBuildIdentity(actual);
}
