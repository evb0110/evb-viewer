import {SETTINGS_PLATFORM_FEATURE} from '@contracts/settingsPlatformFeature';
import {WINDOW_TABS_PLATFORM_FEATURE} from '@contracts/windowTabsPlatformFeature';
import {AGENT_PLATFORM_FEATURE} from '@contracts/agentPlatformFeature';
import {DJVU_PLATFORM_FEATURE} from '@contracts/djvuPlatformFeature';
import {HOST_PLATFORM_FEATURE} from '@contracts/hostPlatformFeature';
import {UPDATES_PLATFORM_FEATURE} from '@contracts/updatesPlatformFeature';
import {OCR_PLATFORM_FEATURE} from '@contracts/ocrPlatformFeature';
import {IMAGE_EXPORT_PLATFORM_FEATURE} from '@contracts/imageExportPlatformFeature';
import {SEARCH_PLATFORM_FEATURE} from '@contracts/searchPlatformFeature';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { SHELL_PLATFORM_FEATURE } from '@contracts/shellPlatformFeature';

// Independent wire spellings. Keep this fixture literal so registry generation cannot bless a rename.
describe('platform wire compatibility', () => {
    it.each([
        {feature: SHELL_PLATFORM_FEATURE,
            invoke: 'openExternal=shell:openExternal',
            events: ''},
        {feature: SETTINGS_PLATFORM_FEATURE,
            invoke: 'get=settings:get getRecoveryNotice=settings:getRecoveryNotice save=settings:save',
            events: 'onChanged=settings:changed'},
        {feature: WINDOW_TABS_PLATFORM_FEATURE,
            invoke: 'transfer=tabs:transfer transferAck=tabs:transferAck listTargetWindows=tabs:listTargets closeCurrentWindow=window:closeCurrent ' +
                'claimPendingExternalOpenPaths=app:claimPendingExternalOpenPaths ' +
                'acknowledgePendingExternalOpenPaths=app:acknowledgePendingExternalOpenPaths saveWorkspaceCheckpoint=workspace:checkpointSave ' +
                'discardWorkspaceCheckpoint=workspace:checkpointDiscard resumeWorkspaceCheckpoint=workspace:checkpointResume ' +
                'claimWorkspaceCheckpoint=workspace:checkpointClaim acknowledgeWorkspaceCheckpoint=workspace:checkpointAcknowledge',
            events: 'onIncomingTransfer=tabs:incomingTransfer onWindowAction=menu:windowTabsAction onMenuNewTab=menu:newTab ' +
                'onMenuCloseTab=menu:closeTab onMenuSplitEditor=menu:splitEditor'},
        {feature: AGENT_PLATFORM_FEATURE,
            invoke: 'getMcpIntegrationStatus=agent:getMcpIntegrationStatus setMcpIntegrationEnabled=agent:setMcpIntegrationEnabled ' +
                'getAssistantState=agent:getAssistantState installAssistantCodex=agent:installAssistantCodex ' +
                'startAssistantLogin=agent:startAssistantLogin cancelAssistantLogin=agent:cancelAssistantLogin ' +
                'sendAssistantMessage=agent:sendAssistantMessage interruptAssistant=agent:interruptAssistant ' +
                'resetAssistantChat=agent:resetAssistantChat getAssistantInstances=agent:getAssistantInstances ' +
                'saveAssistantInstances=agent:saveAssistantInstances importAssistantInstancesFromT3=agent:importAssistantInstancesFromT3 ' +
                'submitWorkspaceSnapshot=agent:submitWorkspaceSnapshot submitCommandResponse=agent:submitCommandResponse',
            events: 'onMcpIntegrationChanged=agent:mcpIntegrationChanged onAssistantEvent=agent:assistantEvent ' +
                'onWorkspaceSnapshotRequest=agent:workspaceSnapshotRequest onCommandCancelRequest=agent:commandCancelRequest ' +
                'onCommandRequest=agent:commandRequest'},
        {feature: DJVU_PLATFORM_FEATURE,
            invoke: 'startOpenForViewing=djvu:open:start releaseViewingPath=djvu:releaseViewingPath startConvertToPdf=djvu:convert:start ' +
                'printDjvuPath=djvu:printDjvuPath cancel=djvu:cancel getJobState=djvu:job:getState cancelPagePreview=djvu:cancelPagePreview ' +
                'searchText=djvu:text:search cancelTextSearch=djvu:text:cancel getInfo=djvu:getInfo getPageSourceInfo=djvu:getPageSourceInfo ' +
                'getPageText=djvu:getPageText getOutline=djvu:getOutline getPageSizes=djvu:getPageSizes ' +
                'renderPagePreview=djvu:renderPagePreview estimateSizes=djvu:estimateSizes cleanupTemp=djvu:cleanupTemp ' +
                'subscribeProgress=djvu:progress:subscribe',
            events: 'onProgress=djvu:progress onConvertComplete=djvu:convert:complete onOpenComplete=djvu:open:complete ' +
                'onTextSearchProgress=djvu:text:progress onMenuConvertToPdf=menu:convertToPdf'},
        {feature: HOST_PLATFORM_FEATURE,
            invoke: 'getEnvironment=host:getEnvironment getZenModeState=host:getZenModeState setZenMode=host:setZenMode ' +
                'restoreNormalWindow=host:restoreNormalWindow writeBugReportBundle=host:writeBugReportBundle',
            events: 'onEnvironmentChange=host:environmentChanged onZenModeChange=host:zenModeChanged onWheelScrollSequenceChange=host:wheelScrollSequenceChanged'},
        {feature: UPDATES_PLATFORM_FEATURE,
            invoke: 'getState=updates:getState check=updates:check download=updates:download install=updates:install defer=updates:defer skipVersion=updates:skipVersion',
            events: 'onStatus=updates:status'},
        {feature: OCR_PLATFORM_FEATURE,
            invoke: 'cancel=ocr:cancel getLanguages=ocr:getLanguages resolveDocumentTextCatalog=ocr:resolveDocumentTextCatalog ' +
                'resolveDocumentTextCatalogWindow=ocr:resolveDocumentTextCatalogWindow ' +
                'resolveDocumentOcrAvailability=ocr:resolveDocumentOcrAvailability resolveDocumentOcrPage=ocr:resolveDocumentOcrPage ' +
                'acknowledgeResultFile=ocr:ackResultFile createSearchablePdf=ocr:createSearchablePdf subscribeProgress=ocr:progress:subscribe',
            events: 'onProgress=ocr:progress onComplete=ocr:complete'},
        {feature: IMAGE_EXPORT_PLATFORM_FEATURE,
            invoke: 'captureCurrentView=pdfExport:region exportPdfToImages=pdfExport:images exportPdfToMultiPageTiff=pdfExport:multipage-tiff ' +
                'subscribeProgress=pdfExport:progress:subscribe',
            events: 'onProgress=pdfExport:progress'},
        {feature: SEARCH_PLATFORM_FEATURE,
            invoke: 'run=pdf:search warmIndex=pdf:search:warmIndex cancel=pdf:search:cancel resetCache=pdf:search:resetCache subscribeProgress=pdf:search:progress:subscribe',
            events: 'onProgress=pdf:search:progress'},
    ])('preserves $feature.path invoke and event channels', ({feature, invoke, events}) => {
        const channelMap = (wire: string) => Object.fromEntries(wire.split(' ').filter(Boolean).map(pair => pair.split('=')));
        expect(feature.invokeChannels).toEqual(channelMap(invoke));
        expect(feature.eventChannels).toEqual(channelMap(events));
    });

    it.each([
        DJVU_PLATFORM_FEATURE, OCR_PLATFORM_FEATURE, IMAGE_EXPORT_PLATFORM_FEATURE, SEARCH_PLATFORM_FEATURE,
    ])('preserves $path progress replay policy', feature => {
        expect(feature.events.onProgress.subscription.replay).toMatchObject({
            intervalMs: 50, mode: 'latest-per-key', owner: 'ipc-progress-pump', terminalRetentionMs: 30_000,
        });
    });
});

describe('shell platform feature schemas', () => {
    const channels = SHELL_PLATFORM_FEATURE.invokeChannels;
    const codec = SHELL_PLATFORM_FEATURE.ipcCodecs[channels.openExternal]!;

    it('preserves the external-open invoke channel without an event layer', () => {
        expect(SHELL_PLATFORM_FEATURE.platformDescriptors.methods).toEqual([expect.objectContaining({
            kind: 'async',
            path: [
                'shell',
                'openExternal',
            ],
        })]);
    });

    it('normalizes and round-trips allowed external URLs', () => {
        expect(codec.decodeArgs([' https://example.test/path ']))
            .toEqual(['https://example.test/path']);
        expect(codec.decodeArgs(['mailto:reader@example.test']))
            .toEqual(['mailto:reader@example.test']);
        expect(codec.decodeResult(undefined)).toBeUndefined();
    });

    it('rejects malformed tuples and unsafe protocols', () => {
        expect(() => codec.decodeArgs([]))
            .toThrow('expected 1 arguments, received 0');
        expect(() => codec.decodeArgs(['file:///tmp/book.pdf']))
            .toThrow('Unsupported external URL protocol: file:');
        expect(() => codec.decodeArgs(['javascript:alert(1)']))
            .toThrow('Unsupported external URL protocol: javascript:');
        expect(() => codec.decodeResult(null))
            .toThrow('expected an undefined IPC result');
    });
});
