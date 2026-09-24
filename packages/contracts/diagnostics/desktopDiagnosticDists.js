/**
 * The shipping desktop dist identities are shared by the startup marker,
 * release identity resolver, and every build that can report a desktop
 * failure. Keep this tuple as the only desktop matrix in the repository.
 *
 * @type {readonly [
 *   'macos-arm64',
 *   'windows-x64',
 *   'windows-arm64',
 *   'linux-x64',
 *   'linux-arm64',
 *   'store-appx-x64',
 *   'store-appx-arm64',
 * ]}
 */
export const DESKTOP_DIAGNOSTIC_DIST_IDENTITIES = Object.freeze([
    'macos-arm64',
    'windows-x64',
    'windows-arm64',
    'linux-x64',
    'linux-arm64',
    'store-appx-x64',
    'store-appx-arm64',
]);

/**
 * @param {unknown} value
 * @returns {value is import('./desktopDiagnosticDists.js').DesktopDiagnosticDist}
 */
export function isDesktopDiagnosticDist(value) {
    return typeof value === 'string'
        && DESKTOP_DIAGNOSTIC_DIST_IDENTITIES.includes(value);
}
