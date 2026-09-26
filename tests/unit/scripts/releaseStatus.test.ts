import {
    describe, expect, it,
} from 'vitest';
import {
    formatReleaseStatus, summarizeReleaseStatus,
} from '@scripts/release/release-status.mjs';

const version = '1.2.3';
const assets = [
    `EVB-Viewer-${version}-arm64.dmg`,
    `EVB-Viewer-${version}-arm64.zip`,
    'latest-mac.yml',
    `EVB-Viewer-${version}-x64-setup.exe`,
    `EVB-Viewer-${version}-arm64-setup.exe`,
    'latest-win-x64.yml',
    'latest-win-arm64.yml',
    `EVB-Viewer-${version}-amd64.deb`,
    `EVB-Viewer-${version}-arm64.deb`,
    `EVB-Viewer-${version}-win-x64-provenance.json`,
    `EVB-Viewer-${version}-win-arm64-provenance.json`,
    'SHA256SUMS',
];
const deps = (releaseAssets: string[], isDraft = false) => ({
    runCommand: () => JSON.stringify({
        assets: releaseAssets.map(name => ({name})),
        isDraft,
        publishedAt: null,
        tagName: 'v1.2.3',
    }),
    listWorkflowRunsFn: () => [{
        displayTitle: 'Release v1.2.3',
        status: 'completed',
        conclusion: 'success',
        url: 'https://example.test/run',
    }],
});

describe('release status', () => {
    it('requires every package target, checksums, and release completion', () => {
        const status = summarizeReleaseStatus('v1.2.3', deps(assets));
        expect(status.complete).toBe(true);
        expect(status.missing).toEqual([]);
        expect(formatReleaseStatus(status)).toContain('required assets: complete');
        expect(status.workflow?.conclusion).toBe('success');
    });

    it('reports missing assets and keeps drafts in progress', () => {
        const status = summarizeReleaseStatus('v1.2.3', deps(assets.slice(0, 4), true));
        expect(status.complete).toBe(false);
        expect(status.state).toBe('in-progress');
        expect(status.missing).toContain('EVB-Viewer-1.2.3-arm64-setup.exe');
    });

    it('accepts stable tags only', () => {
        expect(() => summarizeReleaseStatus('v1.2.3-drill.4', deps(assets))).toThrow('Expected a release tag');
    });
});
