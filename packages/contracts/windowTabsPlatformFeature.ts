import {
    windowTabDocumentRefSchema,
    windowTabIncomingTransferSchema,
    windowTabPaneDirectionSchema,
    windowTabTargetWindowsSchema,
    windowTabTransferAckSchema,
    windowTabTransferRequestSchema,
    windowTabTransferResultSchema,
    windowTabsActionSchema,
} from '@contracts/windowTabsValidation';
import {
    defineForwardedPlatformEvent,
    defineForwardedPlatformMethod,
    definePlatformFeature,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import {
    decodeWorkspaceCheckpoint,
    type IWorkspaceCheckpoint,
} from '@contracts/workspaceCheckpoint';
import * as v from 'valibot';

const noArgs = v.strictTuple([]);
const voidResult = v.pipe(v.undefined('expected an undefined IPC result'), v.transform((): void => undefined));
const checkpointDiscardToken = v.pipe(
    v.string('invalid workspace checkpoint discard token'),
    v.regex(/^\d+$/u, 'invalid workspace checkpoint discard token'),
);
const workspaceCheckpoint = v.pipe(v.unknown(), v.transform((value) => {
    const decoded = decodeWorkspaceCheckpoint(value);
    if (!decoded) {
        throw new Error('invalid workspace checkpoint');
    }
    return decoded;
}));
const nullableWorkspaceCheckpoint = v.pipe(v.unknown(), v.transform((value): IWorkspaceCheckpoint | null => {
    if (value === null) {
        return null;
    }
    const decoded = decodeWorkspaceCheckpoint(value);
    if (!decoded) {
        throw new Error('invalid workspace checkpoint');
    }
    return decoded;
}));

export const WINDOW_TABS_PLATFORM_FEATURE = definePlatformFeature({
    path: ['windowTabs'],
    required: {
        browser: true,
        electron: true,
    },
    manifestPath: ['windowTabs'],
    methods: {
        transfer: defineForwardedPlatformMethod({
            name: 'transfer',
            channel: 'tabs:transfer',
            args: v.strictTuple([windowTabTransferRequestSchema]),
            result: windowTabTransferResultSchema,
            main: 'requestWindowTabTransfer',
        }),
        transferAck: defineForwardedPlatformMethod({
            name: 'transferAck',
            channel: 'tabs:transferAck',
            args: v.strictTuple([windowTabTransferAckSchema]),
            result: v.boolean(),
            main: 'acknowledgeWindowTabTransfer',
        }),
        listTargetWindows: defineForwardedPlatformMethod({
            name: 'listTargetWindows',
            channel: 'tabs:listTargets',
            args: noArgs,
            result: windowTabTargetWindowsSchema,
            main: 'listWindowTabTargets',
        }),
        closeCurrentWindow: defineForwardedPlatformMethod({
            name: 'closeCurrentWindow',
            channel: 'window:closeCurrent',
            args: noArgs,
            result: v.boolean(),
            main: 'closeCurrentWindow',
        }),
        claimPendingExternalOpenPaths: defineForwardedPlatformMethod({
            name: 'claimPendingExternalOpenPaths',
            channel: 'app:claimPendingExternalOpenPaths',
            args: noArgs,
            result: v.array(windowTabDocumentRefSchema),
            main: 'claimPendingExternalOpenPaths',
        }),
        acknowledgePendingExternalOpenPaths: defineForwardedPlatformMethod({
            name: 'acknowledgePendingExternalOpenPaths',
            channel: 'app:acknowledgePendingExternalOpenPaths',
            args: v.strictTuple([v.array(windowTabDocumentRefSchema)]),
            result: voidResult,
            main: 'acknowledgePendingExternalOpenPaths',
        }),
        saveWorkspaceCheckpoint: defineForwardedPlatformMethod({
            name: 'saveWorkspaceCheckpoint',
            channel: 'workspace:checkpointSave',
            args: v.strictTuple([workspaceCheckpoint]),
            result: voidResult,
            main: 'saveWorkspaceCheckpoint',
        }),
        discardWorkspaceCheckpoint: defineForwardedPlatformMethod({
            name: 'discardWorkspaceCheckpoint',
            channel: 'workspace:checkpointDiscard',
            args: noArgs,
            result: checkpointDiscardToken,
            main: 'discardWorkspaceCheckpoint',
        }),
        resumeWorkspaceCheckpoint: defineForwardedPlatformMethod({
            name: 'resumeWorkspaceCheckpoint',
            channel: 'workspace:checkpointResume',
            args: v.strictTuple([checkpointDiscardToken]),
            result: voidResult,
            main: 'resumeWorkspaceCheckpoint',
        }),
        claimWorkspaceCheckpoint: defineForwardedPlatformMethod({
            name: 'claimWorkspaceCheckpoint',
            channel: 'workspace:checkpointClaim',
            args: noArgs,
            result: nullableWorkspaceCheckpoint,
            main: 'claimWorkspaceCheckpoint',
        }),
        acknowledgeWorkspaceCheckpoint: defineForwardedPlatformMethod({
            name: 'acknowledgeWorkspaceCheckpoint',
            channel: 'workspace:checkpointAcknowledge',
            args: noArgs,
            result: voidResult,
            main: 'acknowledgeWorkspaceCheckpoint',
        }),
    },
    events: {
        onIncomingTransfer: defineForwardedPlatformEvent({
            name: 'onIncomingTransfer',
            channel: 'tabs:incomingTransfer',
            payload: windowTabIncomingTransferSchema,
        }),
        onWindowAction: defineForwardedPlatformEvent({
            name: 'onWindowAction',
            channel: 'menu:windowTabsAction',
            payload: windowTabsActionSchema,
        }),
        onMenuNewTab: defineForwardedPlatformEvent({
            name: 'onMenuNewTab',
            channel: 'menu:newTab',
            payload: v.undefined(),
        }),
        onMenuCloseTab: defineForwardedPlatformEvent({
            name: 'onMenuCloseTab',
            channel: 'menu:closeTab',
            payload: v.undefined(),
        }),
        onMenuSplitEditor: defineForwardedPlatformEvent({
            name: 'onMenuSplitEditor',
            channel: 'menu:splitEditor',
            payload: windowTabPaneDirectionSchema,
        }),
        onMenuFocusEditorPane: defineForwardedPlatformEvent({
            name: 'onMenuFocusEditorPane',
            channel: 'menu:focusEditorPane',
            payload: windowTabPaneDirectionSchema,
        }),
        onMenuMoveTabToPane: defineForwardedPlatformEvent({
            name: 'onMenuMoveTabToPane',
            channel: 'menu:moveTabToPane',
            payload: windowTabPaneDirectionSchema,
        }),
        onMenuCopyTabToPane: defineForwardedPlatformEvent({
            name: 'onMenuCopyTabToPane',
            channel: 'menu:copyTabToPane',
            payload: windowTabPaneDirectionSchema,
        }),
    },
});

interface IWindowTabsLifecycleCapability {notifyRendererReady: () => void;}

export type IWindowTabsApi = Pick<
    TFeatureCapability<typeof WINDOW_TABS_PLATFORM_FEATURE>,
    | 'transfer'
    | 'transferAck'
    | 'listTargetWindows'
    | 'onIncomingTransfer'
    | 'onWindowAction'
>;
export type IWindowTabsCapability =
    TFeatureCapability<typeof WINDOW_TABS_PLATFORM_FEATURE> & IWindowTabsLifecycleCapability;
export type IWindowTabsInvokeMap = TFeatureInvokeMap<typeof WINDOW_TABS_PLATFORM_FEATURE>;
export type IWindowTabsEventMap = TFeatureEventMap<typeof WINDOW_TABS_PLATFORM_FEATURE>;
