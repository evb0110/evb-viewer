import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    decodeWorkspaceCheckpoint, readWorkspaceRecoveryMetadata,
} from '@contracts/workspaceCheckpoint';
import {createTabId} from '@contracts/windowTabs';

function createCheckpoint() {
    return {
        version: 1,
        capturedAt: 1_700_000_000_000,
        activePaneId: 'pane-1',
        activeTabId: 'tab-1',
        layout: {
            type: 'leaf',
            paneId: 'pane-1',
        },
        panes: [{
            paneId: 'pane-1',
            tabIds: ['tab-1'],
            activeTabId: 'tab-1',
        }],
        tabs: [{
            tabId: 'tab-1',
            paneId: 'pane-1',
            fileName: 'draft.pdf',
            sourceRef: '/documents/draft.pdf',
            workingCopyRef: '/tmp/working/draft.pdf',
            isDirty: true,
            isDjvu: false,
            currentPage: 7,
            zoom: 1.25,
            zoomMode: 'custom',
        }],
    };
}

describe('decodeWorkspaceCheckpoint', () => {
    it('admits explicit metadata deletion and keeps legacy annotation artifacts readable', () => {
        const metadata = {
            bookmarks: {
                revision: 2,
                dirty: true,
                items: [],
            },
            pageLabels: {
                revision: 3,
                dirty: true,
                ranges: [],
            },
        };
        expect(readWorkspaceRecoveryMetadata({
            version: 1,
            metadata,
        })).toEqual(metadata);
        expect(readWorkspaceRecoveryMetadata({
            version: 1,
            entities: [],
        })).toBeUndefined();
        expect(() => readWorkspaceRecoveryMetadata({metadata: {bookmarks: {
            revision: -1,
            dirty: true,
            items: [],
        }}})).toThrow();
        expect(() => readWorkspaceRecoveryMetadata({metadata: {pageLabels: {
            revision: 1,
            dirty: true,
            ranges: [{
                startPage: 0,
                style: 'D',
                prefix: '',
                startNumber: 1,
            }],
        }}})).toThrow();
    });

    it('preserves the complete live tab list beyond 128 tabs', () => {
        const checkpoint = createCheckpoint();
        const template = checkpoint.tabs[0]!;
        checkpoint.tabs = Array.from({length: 129}, () => ({
            ...template,
            tabId: createTabId(),
        }));
        const tabIds = checkpoint.tabs.map(tab => tab.tabId);
        checkpoint.panes[0]!.tabIds = tabIds;
        checkpoint.panes[0]!.activeTabId = tabIds[0]!;
        checkpoint.activeTabId = tabIds[0]!;
        expect(decodeWorkspaceCheckpoint(checkpoint)).toEqual(checkpoint);
    });

    it('decodes a versioned pane, tab, document, and view-state snapshot', () => {
        expect(decodeWorkspaceCheckpoint(createCheckpoint())).toEqual(createCheckpoint());
    });

    it('strips unrecognized fields from the parsed checkpoint output', () => {
        const checkpoint = createCheckpoint();
        const candidate = {
            ...checkpoint,
            ignored: true,
            tabs: checkpoint.tabs.map(tab => ({
                ...tab,
                ignored: true,
            })),
        };

        expect(decodeWorkspaceCheckpoint(candidate)).toEqual(checkpoint);
    });

    it.each([
        [
            false,
            'facing',
        ],
        [
            true,
            'single',
        ],
    ] as const)('round-trips scroll and view mode (%s, %s)', (continuousScroll, viewMode) => {
        const base = createCheckpoint();
        const checkpoint = {
            ...base,
            tabs: base.tabs.map(tab => ({
                ...tab,
                continuousScroll,
                viewMode,
            })),
        };

        expect(decodeWorkspaceCheckpoint(checkpoint)).toEqual(checkpoint);
    });

    it('keeps the documents a restore left closed and still reads records without them', () => {
        expect(decodeWorkspaceCheckpoint(createCheckpoint())).not.toHaveProperty('notReopened');
        const notReopened = [{
            fileName: 'bomb.pdf',
            sourceRef: '/documents/bomb.pdf',
        }];
        expect(decodeWorkspaceCheckpoint({
            ...createCheckpoint(),
            notReopened,
        })?.notReopened).toEqual(notReopened);
    });

    it('round-trips the scan-cleanup surface without accepting renderer state', () => {
        const checkpoint = {
            ...createCheckpoint(),
            tabs: createCheckpoint().tabs.map(tab => ({
                ...tab,
                surfaceMode: 'scan-cleanup' as const,
            })),
        };

        expect(decodeWorkspaceCheckpoint({
            ...checkpoint,
            tabs: checkpoint.tabs.map(tab => ({
                ...tab,
                scanCleanup: {
                    previewPage: 138_000,
                    pageMapping: {
                        '1': [1],
                        '138000': [138_000],
                    },
                },
            })),
        })).toEqual(checkpoint);
        expect(decodeWorkspaceCheckpoint({
            ...checkpoint,
            tabs: checkpoint.tabs.map(tab => ({
                ...tab,
                surfaceMode: 'invalid',
            })),
        })).toBeNull();
    });

    it.each([
        0,
        90,
        180,
        270,
    ] as const)('round-trips view rotation %s', (viewRotation) => {
        const checkpoint = {
            ...createCheckpoint(),
            tabs: createCheckpoint().tabs.map(tab => ({
                ...tab,
                viewRotation,
            })),
        };

        expect(decodeWorkspaceCheckpoint(checkpoint)).toEqual(checkpoint);
    });

    it.each([
        {
            ...createCheckpoint(),
            version: 2,
        },
        {
            ...createCheckpoint(),
            layout: {
                type: 'split',
                id: 'bad',
                orientation: 'horizontal',
                ratio: 0.5,
            },
        },
        {
            ...createCheckpoint(),
            tabs: [{
                ...createCheckpoint().tabs[0],
                currentPage: 0,
            }],
        },
        {
            ...createCheckpoint(),
            tabs: [{
                ...createCheckpoint().tabs[0],
                zoomMode: 'page-width',
            }],
        },
        {
            ...createCheckpoint(),
            tabs: [{
                ...createCheckpoint().tabs[0],
                viewRotation: 45,
            }],
        },
        {
            ...createCheckpoint(),
            activePaneId: 42,
        },
        {
            ...createCheckpoint(),
            activeTabId: '',
        },
        {
            ...createCheckpoint(),
            tabs: [{
                ...createCheckpoint().tabs[0],
                paneId: 42,
            }],
        },
        {
            ...createCheckpoint(),
            tabs: [{
                ...createCheckpoint().tabs[0],
                sourceRef: 'not-an-absolute-path',
            }],
        },
        {
            ...createCheckpoint(),
            tabs: [{
                ...createCheckpoint().tabs[0],
                workingCopyRef: 42,
            }],
        },
        {
            ...createCheckpoint(),
            panes: [{
                ...createCheckpoint().panes[0],
                activeTabId: 42,
            }],
        },
    ])('rejects malformed or unsupported checkpoints', (candidate) => {
        expect(decodeWorkspaceCheckpoint(candidate)).toBeNull();
    });
});
