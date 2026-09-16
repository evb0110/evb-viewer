import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    formatReleaseStatus,
    getReleaseStatusState,
    summarizeReleaseStatus,
} from '@scripts/release/release-status.mjs';

const TAG = 'v1.2.3';

type TReleasePlatform = 'mac' | 'linux' | 'win';

const NODE_PLATFORM_BY_RELEASE_PLATFORM = {
    linux: 'linux',
    mac: 'darwin',
    win: 'win32',
} as const satisfies Record<TReleasePlatform, NodeJS.Platform>;

function toReleasePlatform(platform: NodeJS.Platform): TReleasePlatform {
    switch (platform) {
        case 'darwin':
            return 'mac' as const;
        case 'win32':
            return 'win' as const;
        default:
            return 'linux' as const;
    }
}

function createPolicyDeps() {
    return {
        getLocalReleaseTargetsFn: ({
            arch = 'x64',
            platform = 'linux',
        }: {
            arch?: string;
            platform?: NodeJS.Platform;
        } = {}) => [{
            arch,
            expectsUpdaterMetadata: true,
            isPrimaryHostTarget: true,
            platform: toReleasePlatform(platform),
        }],
        getRequiredArtifactPatternsFn: ({
            arch,
            platform,
        }: {
            arch: string;
            platform: TReleasePlatform;
        }) => [new RegExp(`${NODE_PLATFORM_BY_RELEASE_PLATFORM[platform]}-${arch}`, 'u')],
        getSupplementalReleaseAssetNamesFn: () => [
            'intel-supplemental.zip',
            'arm-supplemental.exe',
        ],
    };
}

function createReleaseDeps(assets: string[]) {
    return {
        ...createPolicyDeps(),
        listWorkflowRunsFn: (workflow: string) => workflow === 'release.yml'
            ? [{
                conclusion: 'success',
                createdAt: '2026-09-01T08:00:00.000Z',
                databaseId: 10,
                displayTitle: `Release ${TAG}`,
                status: 'completed',
                url: 'https://github.com/example/repo/actions/runs/10',
            }]
            : [{
                conclusion: 'success',
                createdAt: '2026-09-01T09:00:00.000Z',
                databaseId: 11,
                name: `Supplemental ${TAG}`,
                status: 'completed',
                url: 'https://github.com/example/repo/actions/runs/11',
            }],
        readReleaseStateFn: () => ({
            assets,
            error: null,
            exists: true,
            isDraft: false,
            publishedAt: '2026-09-01T08:30:00.000Z',
            tagName: TAG,
        }),
        readTagStateFn: () => ({
            error: null,
            exists: true,
        }),
    };
}

const CORE_ASSETS = [
    'artifact-darwin-arm64',
    'artifact-linux-x64',
    'artifact-linux-arm64',
    'artifact-win32-x64',
    'SHA256SUMS',
];

describe('release-status', () => {
    it('summarizes a public release and selects the latest run for each workflow', () => {
        const status = summarizeReleaseStatus(TAG, createReleaseDeps([
            ...CORE_ASSETS,
            'intel-supplemental.zip',
            'arm-supplemental.exe',
        ]));

        expect(status).toMatchObject({
            checksumManifestPresent: true,
            coreComplete: true,
            isDraft: false,
            isPublic: true,
            publishedAt: '2026-09-01T08:30:00.000Z',
            releaseExists: true,
            supplementalComplete: true,
            tagExists: true,
        });
        expect(status.workflows.release).toMatchObject({
            conclusion: 'success',
            status: 'completed',
            url: 'https://github.com/example/repo/actions/runs/10',
        });
        expect(status.workflows.supplemental).toMatchObject({
            conclusion: 'success',
            status: 'completed',
            url: 'https://github.com/example/repo/actions/runs/11',
        });
    });

    it('reports missing core and supplemental assets without hiding the exact names', () => {
        const status = summarizeReleaseStatus(TAG, createReleaseDeps([
            'artifact-darwin-arm64',
            'SHA256SUMS',
        ]));
        const output = formatReleaseStatus(status);

        expect(status.coreComplete).toBe(false);
        expect(status.core.missing).toEqual([
            'linux-x64 /linux-x64/u',
            'linux-arm64 /linux-arm64/u',
            'win-x64 /win32-x64/u',
        ]);
        expect(status.supplemental.missing).toEqual([
            'intel-supplemental.zip',
            'arm-supplemental.exe',
        ]);
        expect(output).toContain('core assets: incomplete');
        expect(output).toContain('intel-supplemental.zip, arm-supplemental.exe');
    });

    it('does not count supplemental ZIPs as the macOS arm64 core ZIP', () => {
        const deps = {
            ...createPolicyDeps(),
            getRequiredArtifactPatternsFn: () => [/\.zip$/u],
            readReleaseStateFn: () => ({
                assets: [
                    'intel-supplemental.zip',
                    'SHA256SUMS',
                ],
                error: null,
                exists: true,
                isDraft: false,
                publishedAt: '2026-09-01T08:30:00.000Z',
                tagName: TAG,
            }),
            readTagStateFn: () => ({
                error: null,
                exists: true,
            }),
        };

        const status = summarizeReleaseStatus(TAG, deps);

        expect(status.core.present).not.toContain('mac-arm64 /\\.zip$/');
        expect(status.supplemental.present).toEqual(['intel-supplemental.zip']);
    });

    it('reports a checked mirror pointer separately from core completion', () => {
        const status = summarizeReleaseStatus(TAG, {
            ...createReleaseDeps(CORE_ASSETS),
            env: {
                MIRROR_S3_ACCESS_KEY_ID: 'key',
                MIRROR_S3_BUCKET: 'bucket',
                MIRROR_S3_ENDPOINT: 'https://mirror.example.test',
                MIRROR_S3_SECRET_KEY: 'secret',
            },
            readMirrorChannelFn: () => ({
                checked: true,
                error: null,
                tag: TAG,
            }),
        });

        expect(status.mirror).toEqual({
            checked: true,
            error: null,
            matchesTag: true,
            tag: TAG,
        });
        expect(status.coreComplete).toBe(true);
    });

    it('does not call a configured release complete when the mirror points elsewhere', () => {
        const status = summarizeReleaseStatus(TAG, {
            ...createReleaseDeps(CORE_ASSETS),
            env: {
                MIRROR_S3_ACCESS_KEY_ID: 'key',
                MIRROR_S3_BUCKET: 'bucket',
                MIRROR_S3_ENDPOINT: 'https://mirror.example.test',
                MIRROR_S3_SECRET_KEY: 'secret',
            },
            readMirrorChannelFn: () => ({
                checked: true,
                error: null,
                tag: 'v1.2.2',
            }),
        });

        expect(status.mirror.matchesTag).toBe(false);
        expect(status.coreComplete).toBe(false);
        expect(formatReleaseStatus(status)).toContain('does not match');
    });

    it('prints not checked when mirror credentials are absent', () => {
        const status = summarizeReleaseStatus(TAG, createReleaseDeps(CORE_ASSETS));

        expect(formatReleaseStatus(status)).toContain('mirror: not checked');
    });

    it('treats a draft release as incomplete and preserves the published timestamp shape', () => {
        const status = summarizeReleaseStatus(TAG, {
            ...createReleaseDeps(CORE_ASSETS),
            readReleaseStateFn: () => ({
                assets: CORE_ASSETS,
                error: null,
                exists: true,
                isDraft: true,
                publishedAt: null,
                tagName: TAG,
            }),
        });

        expect(status).toMatchObject({
            coreComplete: false,
            isDraft: true,
            isPublic: false,
            publishedAt: null,
        });
        expect(formatReleaseStatus(status)).toContain('release: draft');
    });

    it('rejects a non-release tag before making remote calls', () => {
        expect(() => summarizeReleaseStatus('latest', {runCommand: () => {
            throw new Error('must not run');
        }})).toThrow(/Expected a release tag/u);
    });
});

interface IWorkflowState {
    conclusion: string | null;
    createdAt: string | null;
    error: string | null;
    found: boolean;
    status: string;
    url: string;
}

interface IAssetSummary {
    complete: boolean;
    expected: string[];
    missing: string[];
    present: string[];
}

interface IReleaseStatusStateInput {
    assets: string[];
    blocker: string | null;
    checksumManifestPresent: boolean;
    core: IAssetSummary;
    coreComplete: boolean;
    isDraft: boolean | null;
    isPublic: boolean;
    mirror: {
        checked: boolean;
        error: string | null;
        matchesTag: boolean | null;
        tag: string | null
    };
    publishedAt: string | null;
    releaseError: string | null;
    releaseExists: boolean;
    releaseTag: string;
    state: 'blocked' | 'complete' | 'core-published-supplemental-pending' | 'in-progress' | 'ready';
    supplemental: IAssetSummary;
    supplementalComplete: boolean;
    tag: string;
    tagError: string | null;
    tagExists: boolean;
    workflows: {
        release: IWorkflowState;
        supplemental: IWorkflowState
    };
}

function createWorkflowState(): IWorkflowState {
    return {
        conclusion: null,
        createdAt: null,
        error: null,
        found: false,
        status: 'not found',
        url: '',
    };
}

function createStatus(overrides: Partial<IReleaseStatusStateInput> = {}): IReleaseStatusStateInput {
    const base: IReleaseStatusStateInput = {
        assets: [],
        blocker: null,
        checksumManifestPresent: false,
        core: {
            complete: false,
            expected: ['artifact'],
            missing: ['artifact'],
            present: [],
        },
        coreComplete: false,
        isDraft: false,
        isPublic: false,
        mirror: {
            checked: false,
            error: null,
            matchesTag: null,
            tag: null,
        },
        publishedAt: null,
        releaseError: null,
        releaseExists: false,
        releaseTag: 'v1.2.3',
        state: 'in-progress',
        supplemental: {
            complete: false,
            expected: [],
            missing: [],
            present: [],
        },
        supplementalComplete: false,
        tag: 'v1.2.3',
        tagError: null,
        tagExists: false,
        workflows: {
            release: createWorkflowState(),
            supplemental: createWorkflowState(),
        },
    };

    return {
        ...base,
        ...overrides,
        workflows: {
            ...base.workflows,
            ...overrides.workflows,
        },
    };
}

describe('release-status lifecycle states', () => {
    it.each([
        [
            'ready',
            createStatus(),
        ],
        [
            'in-progress',
            createStatus({
                isDraft: true,
                releaseExists: true,
            }),
        ],
        [
            'core-published-supplemental-pending',
            createStatus({
                coreComplete: true,
                releaseExists: true,
                supplementalComplete: false,
                tagExists: true,
            }),
        ],
        [
            'complete',
            createStatus({
                coreComplete: true,
                releaseExists: true,
                supplementalComplete: true,
                tagExists: true,
            }),
        ],
    ] as const)('reports %s', (expectedState, status) => {
        expect(getReleaseStatusState(status)).toEqual({
            blocker: null,
            state: expectedState,
        });
    });

    it('calls a fully published release complete and keeps a failed run as a note', () => {
        const status = createStatus({
            coreComplete: true,
            isDraft: false,
            isPublic: true,
            releaseExists: true,
            supplementalComplete: true,
            tagExists: true,
            workflows: {
                release: createWorkflowState(),
                supplemental: {
                    conclusion: 'failure',
                    createdAt: '2026-09-01T08:00:00.000Z',
                    error: null,
                    found: true,
                    status: 'completed',
                    url: 'https://github.com/example/repo/actions/runs/43',
                },
            },
        });

        const result = getReleaseStatusState(status);

        expect(result.state).toBe('complete');
        expect(result.blocker).toBeNull();
        expect(result.note).toContain('actions/runs/43');
        expect(formatReleaseStatus({
            ...status,
            ...result,
        })).toContain('state: complete (note: ');
    });

    it('reports a failed workflow as blocked with the run URL', () => {
        const status = createStatus({
            releaseExists: true,
            tagExists: true,
            workflows: {
                release: {
                    conclusion: 'failure',
                    createdAt: '2026-09-01T08:00:00.000Z',
                    error: null,
                    found: true,
                    status: 'completed',
                    url: 'https://github.com/example/repo/actions/runs/42',
                },
                supplemental: createWorkflowState(),
            },
        });

        const result = getReleaseStatusState(status);

        expect(result.state).toBe('blocked');
        expect(result.blocker).toContain('actions/runs/42');
        expect(formatReleaseStatus({
            ...status,
            blocker: result.blocker,
            state: result.state,
        })).toContain(`state: blocked (${result.blocker})`);
    });
});
