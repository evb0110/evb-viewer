import {resolve} from 'node:path';

/**
 * One owner for a diagnostics manifest scope.
 *
 * A diagnostics harness builds product manifests and launches the real
 * sidecar, so it is part of the runnable inventory: the directory a manifest's
 * paths are constrained to and the root the native launch is told about must
 * be the same value. Both come from this scope, so the two cannot drift apart
 * as a harness grows extra manifests or extra launches.
 *
 * The runnable builder is injected because these scripts load it through
 * `tsImport`; keeping this helper free of that load lets tests exercise it
 * directly with the real builder.
 */
export function createScanCleanupDiagnosticsManifestScope(allowedPathRoot, buildRunnableNativeScanCleanupManifest) {
    if (typeof allowedPathRoot !== 'string' || allowedPathRoot === '') {
        throw new Error('Scan-cleanup diagnostics manifest scope requires an allowed path root');
    }
    if (typeof buildRunnableNativeScanCleanupManifest !== 'function') {
        throw new Error('Scan-cleanup diagnostics manifest scope requires the runnable manifest builder');
    }
    // Resolved once, here: the builder judges paths against an absolute root and
    // the native flag names one, so a harness that passes a relative root must
    // not leave those two sides reading it against different directories.
    const resolvedAllowedPathRoot = resolve(allowedPathRoot);
    return {
        allowedPathRoot: resolvedAllowedPathRoot,
        /** Build a runnable manifest constrained to this scope's root. */
        buildManifest(input) {
            if (input === null || typeof input !== 'object') {
                throw new Error('Scan-cleanup diagnostics manifest input must be an object');
            }
            if ('allowedPathRoot' in input) {
                throw new Error('Scan-cleanup diagnostics manifest input must not carry its own allowed path root');
            }
            return buildRunnableNativeScanCleanupManifest({
                ...input,
                allowedPathRoot: resolvedAllowedPathRoot,
            });
        },
        /** Sidecar argv for a manifest this scope built. */
        sidecarArgv(manifestPath) {
            if (typeof manifestPath !== 'string' || manifestPath === '') {
                throw new Error('Scan-cleanup diagnostics sidecar argv requires a manifest path');
            }
            return ['--manifest', manifestPath, '--allowed-path-root', resolvedAllowedPathRoot];
        },
    };
}
