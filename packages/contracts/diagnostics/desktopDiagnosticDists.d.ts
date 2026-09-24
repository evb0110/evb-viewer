export declare const DESKTOP_DIAGNOSTIC_DIST_IDENTITIES: readonly [
    'macos-arm64',
    'windows-x64',
    'windows-arm64',
    'linux-x64',
    'linux-arm64',
    'store-appx-x64',
    'store-appx-arm64',
];

export type DesktopDiagnosticDist = typeof DESKTOP_DIAGNOSTIC_DIST_IDENTITIES[number];

export declare function isDesktopDiagnosticDist(
    value: unknown,
): value is DesktopDiagnosticDist;
