import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    DESKTOP_DIAGNOSTIC_DIST_IDENTITIES,
    isDesktopDiagnosticDist,
} from '@contracts/diagnostics/desktopDiagnosticDists.js';
import {
    createSentryBuildIdentity,
    assertSameSentryBuildIdentity,
    assertSentryBuildIdentity,
    isSentryDiagnosticsBuild,
    resolveDesktopDiagnosticDist,
    resolveSentryBuildIdentity,
    resolveSentryBuildTarget,
    resolveWebDiagnosticDist,
    sentryBuildIdentityKey,
    SENTRY_DIAGNOSTIC_ENVIRONMENTS,
} from '@contracts/diagnostics/releaseIdentity.js';
import {
    decodeStartupCrashMarkerRecord,
    DESKTOP_DIAGNOSTIC_DIST_IDENTITIES as STARTUP_MARKER_DISTS,
} from '@contracts/diagnostics/startupCrashMarker';

const EXPECTED_DESKTOP_DISTS = [
    'macos-arm64',
    'macos-x64',
    'windows-x64',
    'windows-arm64',
    'linux-x64',
    'linux-arm64',
    'store-appx-x64',
    'store-appx-arm64',
    'win7-legacy-x64',
] as const;

const DESKTOP_ENVIRONMENT = {
    EVB_SENTRY_ENVIRONMENT: 'test',
    EVB_RELEASE_TARGET_PLATFORM: 'mac',
    EVB_RELEASE_TARGET_ARCH: 'arm64',
};

describe('Sentry release identity contract', () => {
    it('keeps the exact nine desktop dists in the startup-marker contract', () => {
        expect(DESKTOP_DIAGNOSTIC_DIST_IDENTITIES).toEqual(EXPECTED_DESKTOP_DISTS);
        expect(STARTUP_MARKER_DISTS).toBe(DESKTOP_DIAGNOSTIC_DIST_IDENTITIES);
        expect(EXPECTED_DESKTOP_DISTS.every(isDesktopDiagnosticDist)).toBe(true);
        expect(isDesktopDiagnosticDist('latest')).toBe(false);
    });

    it('closes environments and rejects mutable identities', () => {
        expect(SENTRY_DIAGNOSTIC_ENVIRONMENTS).toEqual([
            'production',
            'preview',
            'development',
            'test',
        ]);

        for (const environment of [
            'staging',
            'latest',
            '',
            'production/latest',
        ]) {
            expect(() => createSentryBuildIdentity({
                target: 'desktop',
                version: '1.2.3',
                dist: 'macos-arm64',
                environment: environment as never,
            })).toThrow();
        }

        expect(() => createSentryBuildIdentity({
            target: 'web',
            deployment: 'latest',
            dist: 'preview-build-1',
            environment: 'preview',
        })).toThrow(/latest/iu);
        expect(() => createSentryBuildIdentity({
            target: 'web',
            version: '1.2.3',
            dist: 'preview-latest',
            environment: 'preview',
        })).toThrow(/latest/iu);
    });

    it('computes every desktop dist from the target platform and architecture', () => {
        const expectedByTarget = new Map([
            [
                'mac-arm64',
                'macos-arm64',
            ],
            [
                'mac-x64',
                'macos-x64',
            ],
            [
                'win-x64',
                'windows-x64',
            ],
            [
                'win-arm64',
                'windows-arm64',
            ],
            [
                'linux-x64',
                'linux-x64',
            ],
            [
                'linux-arm64',
                'linux-arm64',
            ],
        ]);

        for (const [
            target,
            expected,
        ] of expectedByTarget) {
            const [
                platform,
                architecture,
            ] = target.split('-');
            expect(resolveDesktopDiagnosticDist({environment: {
                EVB_RELEASE_TARGET_PLATFORM: platform,
                EVB_RELEASE_TARGET_ARCH: architecture,
            }})).toBe(expected);
        }

        for (const dist of EXPECTED_DESKTOP_DISTS) {
            expect(createSentryBuildIdentity({
                target: 'desktop',
                version: '1.2.3+ci.7',
                dist,
                environment: 'test',
            })).toEqual({
                target: 'desktop',
                release: 'evb-viewer-desktop@1.2.3+ci.7',
                dist,
                environment: 'test',
            });
        }

        for (const dist of [
            'store-appx-x64',
            'store-appx-arm64',
            'win7-legacy-x64',
        ] as const) {
            expect(resolveDesktopDiagnosticDist({environment: {
                EVB_RELEASE_TARGET_PLATFORM: 'win',
                EVB_RELEASE_TARGET_ARCH: dist.endsWith('-arm64') ? 'arm64' : 'x64',
                EVB_RELEASE_TARGET_DIST: dist,
            }})).toBe(dist);
        }
    });

    it('uses immutable production and preview web dists', () => {
        expect(resolveSentryBuildIdentity({
            target: 'web',
            version: '1.2.3',
            environment: {
                EVB_SENTRY_ENVIRONMENT: 'preview',
                EVB_WEB_BUILD_ID: 'build-41',
            },
        })).toEqual({
            target: 'web',
            release: 'evb-viewer-web@1.2.3',
            dist: 'preview-build-41',
            environment: 'preview',
        });

        expect(resolveWebDiagnosticDist({
            environment: {
                EVB_WEB_BUILD_ID: 'build-42',
                EVB_RELEASE_TARGET_DIST: 'preview-build-42',
            },
            sentryEnvironment: 'preview',
        })).toBe('preview-build-42');
        expect(resolveWebDiagnosticDist({
            environment: {EVB_WEB_BUILD_ID: 'build-42'},
            sentryEnvironment: 'production',
        })).toBe('production');

        expect(resolveSentryBuildIdentity({
            target: 'web',
            version: '1.2.3',
            environment: {
                VERCEL: '1',
                VERCEL_ENV: 'preview',
                VERCEL_DEPLOYMENT_ID: 'dpl-42',
            },
        })).toEqual({
            target: 'web',
            release: 'evb-viewer-web@dpl-42',
            dist: 'preview-dpl-42',
            environment: 'preview',
        });
        expect(resolveSentryBuildIdentity({
            target: 'web',
            version: '1.2.3',
            environment: {
                VERCEL: '1',
                VERCEL_ENV: 'production',
            },
        })).toEqual({
            target: 'web',
            release: 'evb-viewer-web@1.2.3',
            dist: 'production',
            environment: 'production',
        });
    });

    it('rejects conflicting target, release, dist, and environment values', () => {
        expect(() => resolveSentryBuildTarget({
            EVB_SENTRY_RELEASE: 'evb-viewer-web@dpl-1',
            EVB_RELEASE_TARGET_PLATFORM: 'mac',
        })).toThrow(/conflicting.*target/iu);
        expect(() => resolveSentryBuildIdentity({
            target: 'desktop',
            version: '1.2.3',
            environment: {
                EVB_SENTRY_ENVIRONMENT: 'test',
                EVB_SENTRY_RELEASE: 'evb-viewer-desktop@1.2.4',
            },
        })).toThrow(/conflicting.*release/iu);
        expect(() => resolveSentryBuildIdentity({
            target: 'desktop',
            version: '1.2.3',
            environment: {
                EVB_SENTRY_ENVIRONMENT: 'test',
                EVB_SENTRY_DIST: 'macos-arm64',
                EVB_RELEASE_TARGET_DIST: 'macos-x64',
            },
        })).toThrow(/conflicting.*dist/iu);
        expect(() => resolveSentryBuildIdentity({
            target: 'desktop',
            version: '1.2.3',
            environment: {
                EVB_SENTRY_ENVIRONMENT: 'test',
                SENTRY_ENVIRONMENT: 'production',
            },
        })).toThrow(/conflicting.*environment/iu);
        expect(() => createSentryBuildIdentity({
            target: 'desktop',
            version: '1.2.3',
            release: 'evb-viewer-desktop@1.2.4',
            dist: 'macos-arm64',
            environment: 'test',
        })).toThrow(/conflicting.*release/iu);
    });

    it('keeps one identity key and accepts SemVer build metadata in startup markers', () => {
        const identity = resolveSentryBuildIdentity({
            target: 'desktop',
            version: '1.2.3+ci.7',
            environment: DESKTOP_ENVIRONMENT,
        });
        const sameIdentity = createSentryBuildIdentity({
            target: 'desktop',
            version: '1.2.3+ci.7',
            dist: 'macos-arm64',
            environment: 'test',
        });
        expect(sentryBuildIdentityKey(identity)).toBe(sentryBuildIdentityKey(sameIdentity));
        expect(assertSameSentryBuildIdentity(identity, sameIdentity)).toEqual(identity);
        expect(() => assertSentryBuildIdentity({
            ...identity,
            unexpected: true,
        })).toThrow();

        expect(decodeStartupCrashMarkerRecord({
            schemaVersion: 1,
            eventId: 'a'.repeat(32),
            code: 'MAIN_STARTUP_CRASH',
            frames: [],
            timestamp: 0,
            release: identity.release,
            dist: identity.dist,
        })).toMatchObject({
            release: identity.release,
            dist: identity.dist,
        });
    });

    it('requires explicit host identity for desktop resolution', () => {
        expect(resolveDesktopDiagnosticDist({
            platform: 'linux',
            architecture: 'arm64',
        })).toBe('linux-arm64');
        expect(() => resolveDesktopDiagnosticDist()).toThrow(/Cannot resolve/u);
    });

    it('marks only explicit diagnostics or release builds as eligible', () => {
        expect(isSentryDiagnosticsBuild({})).toBe(false);
        expect(isSentryDiagnosticsBuild({EVB_ELECTRON_SOURCEMAP: '1'})).toBe(true);
        expect(isSentryDiagnosticsBuild({EVB_RELEASE_TARGET_ARCH: 'arm64'})).toBe(true);
        expect(isSentryDiagnosticsBuild({VERCEL: '1'})).toBe(true);
    });
});
