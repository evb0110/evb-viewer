import {
    describe,
    expect,
    it,
} from 'vitest';
import { requireDocumentRef } from '@contracts/documentRef';
import { WINDOW_TABS_PLATFORM_FEATURE } from '@contracts/windowTabsPlatformFeature';

const [transferRequest] = WINDOW_TABS_PLATFORM_FEATURE.methods.transfer.ipc.args.example();
const checkpoint = WINDOW_TABS_PLATFORM_FEATURE.methods.saveWorkspaceCheckpoint.ipc.args.example()[0];
const transferResult = {
    transferId: 'transfer-1',
    success: true,
    targetWindowId: 2,
};

describe('window tabs platform feature schemas', () => {
    const channels = WINDOW_TABS_PLATFORM_FEATURE.invokeChannels;
    const codecs = WINDOW_TABS_PLATFORM_FEATURE.ipcCodecs;

    it('owns all request/response and renderer event members but not renderer readiness', () => {
        expect(channels).toEqual({
            transfer: 'tabs:transfer',
            transferAck: 'tabs:transferAck',
            listTargetWindows: 'tabs:listTargets',
            closeCurrentWindow: 'window:closeCurrent',
            claimPendingExternalOpenPaths: 'app:claimPendingExternalOpenPaths',
            acknowledgePendingExternalOpenPaths: 'app:acknowledgePendingExternalOpenPaths',
            saveWorkspaceCheckpoint: 'workspace:checkpointSave',
            discardWorkspaceCheckpoint: 'workspace:checkpointDiscard',
            resumeWorkspaceCheckpoint: 'workspace:checkpointResume',
            claimWorkspaceCheckpoint: 'workspace:checkpointClaim',
            acknowledgeWorkspaceCheckpoint: 'workspace:checkpointAcknowledge',
        });
        expect(WINDOW_TABS_PLATFORM_FEATURE.eventChannels).toEqual({
            onIncomingTransfer: 'tabs:incomingTransfer',
            onWindowAction: 'menu:windowTabsAction',
            onMenuNewTab: 'menu:newTab',
            onMenuCloseTab: 'menu:closeTab',
            onMenuSplitEditor: 'menu:splitEditor',
            onMenuFocusEditorPane: 'menu:focusEditorPane',
            onMenuMoveTabToPane: 'menu:moveTabToPane',
            onMenuCopyTabToPane: 'menu:copyTabToPane',
        });
        expect(WINDOW_TABS_PLATFORM_FEATURE.platformDescriptors.methods).toHaveLength(19);
        expect(WINDOW_TABS_PLATFORM_FEATURE.platformDescriptors.methods)
            .not.toContainEqual(expect.objectContaining({path: [
                'windowTabs',
                'notifyRendererReady',
            ]}));
    });

    it('round-trips transfer, checkpoint, target-window, and external-open values', () => {
        expect(codecs[channels.transfer]!.decodeArgs([transferRequest])).toEqual([transferRequest]);
        expect(codecs[channels.transfer]!.decodeResult(transferResult)).toEqual(transferResult);
        expect(codecs[channels.saveWorkspaceCheckpoint]!.decodeArgs([checkpoint])).toEqual([checkpoint]);
        expect(codecs[channels.discardWorkspaceCheckpoint]!.decodeArgs([])).toEqual([]);
        expect(codecs[channels.discardWorkspaceCheckpoint]!.decodeResult('7')).toBe('7');
        expect(codecs[channels.resumeWorkspaceCheckpoint]!.decodeArgs(['7'])).toEqual(['7']);
        expect(codecs[channels.resumeWorkspaceCheckpoint]!.decodeResult(undefined)).toBeUndefined();
        expect(codecs[channels.claimWorkspaceCheckpoint]!.decodeResult(checkpoint)).toEqual(checkpoint);
        expect(codecs[channels.claimWorkspaceCheckpoint]!.decodeResult(null)).toBeNull();
        expect(codecs[channels.acknowledgeWorkspaceCheckpoint]!.decodeArgs([])).toEqual([]);
        expect(codecs[channels.acknowledgePendingExternalOpenPaths]!.decodeArgs([['/tmp/a.pdf']]))
            .toEqual([['/tmp/a.pdf']]);
    });

    it('preserves generated and ordinary dirty PDF payloads through transfer decoding', () => {
        const generatedPayload = {
            kind: 'pdfSnapshot' as const,
            fileName: 'generated.pdf',
            originalPath: requireDocumentRef('/tmp/source.pdf'),
            snapshotPath: requireDocumentRef('/tmp/generated-working.pdf'),
            isDirty: true,
            isGenerated: true,
        };
        const ordinaryDirtyPayload = {
            kind: 'pdfSnapshot' as const,
            fileName: 'ordinary.pdf',
            originalPath: requireDocumentRef('/tmp/source-ordinary.pdf'),
            snapshotPath: requireDocumentRef('/tmp/ordinary-working.pdf'),
            isDirty: true,
        };
        const generatedRequest = {
            ...transferRequest,
            payload: generatedPayload,
        };
        const ordinaryRequest = {
            ...transferRequest,
            payload: ordinaryDirtyPayload,
        };

        expect(codecs[channels.transfer]!.decodeArgs([generatedRequest])).toEqual([generatedRequest]);
        expect(codecs[channels.transfer]!.decodeArgs([ordinaryRequest])).toEqual([ordinaryRequest]);

        const generatedIncoming = {
            transferId: 'transfer-generated',
            sourceWindowId: 1,
            targetWindowId: 2,
            tab: transferRequest.tab,
            payload: generatedPayload,
        };
        const ordinaryIncoming = {
            ...generatedIncoming,
            transferId: 'transfer-ordinary',
            payload: ordinaryDirtyPayload,
        };
        expect(WINDOW_TABS_PLATFORM_FEATURE.events.onIncomingTransfer.payload.decode(generatedIncoming).payload)
            .toEqual(generatedPayload);
        expect(WINDOW_TABS_PLATFORM_FEATURE.events.onIncomingTransfer.payload.decode(ordinaryIncoming).payload)
            .toEqual(ordinaryDirtyPayload);
    });

    it('decodes event payloads and rejects malformed boundary values', () => {
        expect(WINDOW_TABS_PLATFORM_FEATURE.events.onMenuSplitEditor.payload.decode('right')).toBe('right');
        expect(() => codecs[channels.transferAck]!.decodeArgs([{
            transferId: '',
            success: true,
        }])).toThrow('invalid window tab transfer acknowledgement');
        expect(() => codecs[channels.listTargetWindows]!.decodeResult([{
            windowId: 0,
            label: 'Invalid',
        }])).toThrow('invalid window tab target windows');
        expect(() => codecs[channels.saveWorkspaceCheckpoint]!.decodeArgs([null]))
            .toThrow('invalid workspace checkpoint');
        expect(() => WINDOW_TABS_PLATFORM_FEATURE.events.onMenuSplitEditor.payload.decode('diagonal'))
            .toThrow('invalid pane direction');
    });
});
