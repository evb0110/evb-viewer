export const RELEASE_ACTION_ARTIFACT_GROUPS = Object.freeze([
    'dist-mac-arm64',
    'dist-linux-x64',
    'dist-linux-arm64',
    'dist-win-x64',
    'supplemental-win-arm64',
    'store-appx-win-x64',
    'store-appx-win-arm64',
]);

export function formatArtifactGroupList(artifactGroups = RELEASE_ACTION_ARTIFACT_GROUPS) {
    return artifactGroups.join(', ');
}
