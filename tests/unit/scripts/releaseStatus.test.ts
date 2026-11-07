import {
    describe, expect, it,
} from 'vitest';
import {
    formatReleaseStatus, summarizeReleaseStatus,
} from '@scripts/release/release-status.mjs';

import {verifyMirrorObjects} from '@scripts/release/verifyReleaseMirror.mjs';

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
const servedMirror = async ({tag}: {tag: string}) => ({
    publicRoute: true,
    tag,
});
const deps = (releaseAssets: string[], isDraft = false, {
    conclusion = 'success',
    verifyMirrorObjectsFn = servedMirror,
}: {
    conclusion?: string;
    verifyMirrorObjectsFn?: (options: {tag: string}) => Promise<{
        publicRoute: boolean;
        tag: string
    }>;
} = {}) => ({
    env: {},
    runCommand: () => JSON.stringify({
        assets: releaseAssets.map(name => ({name})),
        isDraft,
        publishedAt: null,
        tagName: 'v1.2.3',
    }),
    listWorkflowRunsFn: () => [
        {
            displayTitle: 'Release v1.2.30',
            status: 'completed',
            conclusion: 'success',
            url: 'https://example.test/run-v1.2.30',
        },
        {
            displayTitle: 'Release v1.2.3',
            status: 'completed',
            conclusion,
            url: 'https://example.test/run',
        },
    ],
    verifyMirrorObjectsFn,
});

describe('release status', () => {
    it('requires every package target, checksums, and release completion', async () => {
        const status = await summarizeReleaseStatus('v1.2.3', deps(assets));
        expect(status.complete).toBe(true);
        expect(status.missing).toEqual([]);
        expect(formatReleaseStatus(status)).toContain('required assets: complete');
        expect(status.workflow?.conclusion).toBe('success');
        expect(status.workflow?.url, 'the run of this exact tag, not of v1.2.30').toBe('https://example.test/run');
    });

    it('reports missing assets and keeps drafts in progress', async () => {
        const status = await summarizeReleaseStatus('v1.2.3', deps(assets.slice(0, 4), true));
        expect(status.complete).toBe(false);
        expect(status.state).toBe('in-progress');
        expect(status.missing).toContain('EVB-Viewer-1.2.3-arm64-setup.exe');
    });

    it('accepts stable tags only', async () => {
        await expect(summarizeReleaseStatus('v1.2.3-drill.4', deps(assets))).rejects.toThrow('Expected a release tag');
    });

    it('keeps a public release incomplete until the updater mirror is shown to serve it', async () => {
        for (const conclusion of [
            'failure',
            'success',
        ]) {
            const status = await summarizeReleaseStatus('v1.2.3', deps(assets, false, {
                conclusion,
                verifyMirrorObjectsFn: async () => {
                    throw new Error('Mirror channel points to v1.2.2, expected v1.2.3');
                },
            }));
            expect(status.complete, `${conclusion} run, mirror on the previous tag`).toBe(false);
            expect(status.mirror).toContain('v1.2.2');
        }
    });

    it('reports complete when the served result is proven, even after a failed earlier run', async () => {
        const status = await summarizeReleaseStatus('v1.2.3', deps(assets, false, {conclusion: 'failure'}));
        expect(status.complete).toBe(true);
        expect(status.mirror).toBe('matches v1.2.3');
    });

    it('keeps status incomplete when the manifest serves only its first asset', async () => {
        const status = await summarizeReleaseStatus('v1.2.3', {
            ...deps(assets, false, {verifyMirrorObjectsFn: options => verifyMirrorObjects({
                ...options,
                fetchFn: async (url) => {
                    const requestUrl = String(url);
                    if (requestUrl.endsWith('/stable.json')) return Response.json({release: {tag: 'v1.2.3'}});
                    if (requestUrl.endsWith('/manifest.json')) return Response.json({
                        release: {tag: 'v1.2.3'},
                        assets: assets.map(name => ({name})),
                    });
                    return new Response(null, {status: requestUrl.endsWith(`/${assets[0]}`) ? 200 : 404});
                },
            })}),
            env: {
                MIRROR_S3_ENDPOINT: 'fixture',
                MIRROR_S3_BUCKET: 'fixture',
                MIRROR_S3_ACCESS_KEY_ID: 'fixture',
                MIRROR_S3_SECRET_KEY: 'fixture',
            },
            runCommand: (command: string) => JSON.stringify(command === 'aws'
                ? {release: {tag: 'v1.2.3'}}
                : {
                    assets: assets.map(name => ({name})),
                    isDraft: false,
                }),
        });
        expect(status.missing).toEqual([]);
        expect(status.complete).toBe(false);
        expect(status.mirror).toContain(`${assets[1]} returned HTTP 404`);
    });

});
