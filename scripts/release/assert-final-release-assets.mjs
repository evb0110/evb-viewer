#!/usr/bin/env node

import {
    readFileSync, readdirSync,
} from 'node:fs';
import path from 'node:path';
import {
    assertPublishUpdaterMetadataPolicy, assertPublishUpdaterMetadataReferences, assertUpdaterMetadataVersion,
} from './policy.mjs';
import {assertMacUpdaterMetadataHashes} from './notarize-macos-dmgs.mjs';
import {assertUpdaterArtifactIntegrity} from './assert-updater-artifact-integrity.mjs';

const artifactsDir = path.resolve(process.argv[2] ?? 'artifacts');
const version = process.argv[3] ?? JSON.parse(readFileSync('package.json', 'utf8')).version;
const files = readdirSync(artifactsDir);
const signedMac = process.argv[4] !== 'false';
const expected = [
    new RegExp(`^EVB-Viewer-${version}-arm64\\.dmg$`, 'u'),
    new RegExp(`^EVB-Viewer-${version}-arm64\\.zip$`, 'u'),
    new RegExp(`^EVB-Viewer-${version}-x64-setup\\.exe$`, 'u'),
    new RegExp(`^EVB-Viewer-${version}-arm64-setup\\.exe$`, 'u'),
    new RegExp(`^EVB-Viewer-${version}-x64\\.deb$`, 'u'),
    new RegExp(`^EVB-Viewer-${version}-arm64\\.deb$`, 'u'),
    ...(signedMac ? [/^latest-mac\.yml$/u] : []),
    /^latest-win-x64\.yml$/u,
    /^latest-win-arm64\.yml$/u,
];
for (const pattern of expected) {
    if (!files.some(file => pattern.test(file))) {
        throw new Error(`Missing final release asset matching ${pattern}`);
    }
}
assertPublishUpdaterMetadataPolicy(files, {EVB_RELEASE_HAS_MAC_SIGNING: String(signedMac)});
/** @param {string} name */
const readMetadata = name => readFileSync(path.join(artifactsDir, name), 'utf8');
assertPublishUpdaterMetadataReferences(files, readMetadata);
assertUpdaterMetadataVersion(files, readMetadata, version);
assertUpdaterArtifactIntegrity({
    artifactNames: files,
    artifactsDir,
    readMetadataText: readMetadata,
});
if (signedMac) assertMacUpdaterMetadataHashes({
    artifactNames: files,
    artifactsDir,
    readMetadataText: readMetadata,
});
process.stdout.write(`Final release assets validated for ${version}: ${files.length} files.\n`);
