import type {
    ComputedRef,
    Ref,
} from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import type {
    IWindowCloseRequest,
    ISystemCapability,
    TWindowCloseDecision,
} from '@contracts/systemPlatformFeature';
import type {
    IWorkspaceDocumentController,
    IWorkspaceDocumentRetirement,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { emitAutomationEvent } from '@app/modules/workspace-shell/automation/automationReadinessEvents';
import { rememberReadingView } from '@app/modules/workspace-shell/document-sessions/recentReadingView';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getSystemCapability } from '@app/utils/getSystemCapability';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;
type TRetiring = Map<IWorkspaceDocumentController, IWorkspaceDocumentRetirement>;

interface IUseNativeWindowCloseHandshakeOptions {
    documentSessionsByTabId: TReadableRef<Record<string, IWorkspaceDocumentController>>;
    requestDirtyCloseConfirmation: () => Promise<TWindowCloseDecision>;
    flushSettings?: () => Promise<boolean>;
    systemCapability?: Pick<ISystemCapability, 'onWindowCloseRequest'>;
}

export const useNativeWindowCloseHandshake = (
    options: IUseNativeWindowCloseHandshakeOptions,
) => {
    const systemCapability = options.systemCapability ?? getSystemCapability();
    let closeRequestInFlight = false;

    // One entry per document: tabs that show the same document share it.
    function getDocuments() {
        return [...new Set(Object.values(options.documentSessionsByTabId.value))];
    }
    // A close that goes ahead first remembers where each document was left,
    // after any save has published its new source, one tab at a time in the
    // order the window holds them: of two tabs that show one file, as linked
    // views or opened on their own, the later one's place is the one kept.
    async function closeWith(decision: 'save' | 'discard', retiring: TRetiring): Promise<TWindowCloseDecision> {
        for (const [tabId, session] of Object.entries(options.documentSessionsByTabId.value)) {
            await rememberReadingView(session, tabId);
        }
        return getDocuments().some(session => session.operationLease.isBusy.value || !retiring.get(session)?.isCurrent()
            || (decision === 'save' && session.snapshot.value.dirty)) ? 'cancel' : decision;
    }

    // A document Save names the revision and file it committed, read when it commits.
    function saveTab(session: IWorkspaceDocumentController) {
        const tabId = Object.entries(options.documentSessionsByTabId.value).find(([, candidate]) => candidate === session)?.[0] ?? null;
        return session.saveDurably((documentRevisionToken) => {
            const {originalPath, workingCopyPath} = session.snapshot.value.identity;
            emitAutomationEvent('save-committed', {documentRevisionToken, path: originalPath ?? workingCopyPath, tabId});
        });
    }

    // Each document closes as a tab's last view does: it releases what it
    // runs and drains, the window asks once, and each Save returns at its
    // durable result. Work newer than a Save keeps its document dirty.
    async function decideWindowClose(retiring: TRetiring): Promise<TWindowCloseDecision> {
        if (options.flushSettings && !await options.flushSettings()) {
            return 'cancel';
        }
        const dirtyTabs = getDocuments().filter(session => session.snapshot.value.dirty);
        const decision = dirtyTabs.length === 0 ? 'save' : await options.requestDirtyCloseConfirmation();
        // Each document is still the one drained, under the same close.
        if (decision === 'cancel' || getDocuments().some(session => !retiring.get(session)?.isCurrent())) return 'cancel';
        if (decision === 'save') {
            for (const session of dirtyTabs) {
                if (!retiring.get(session)?.isCurrent() || !await saveTab(session)) {
                    return 'cancel';
                }
            }
            if (dirtyTabs.length > 0 && options.flushSettings && !await options.flushSettings()) {
                return 'cancel';
            }
        }
        // The Saves' reloads are released as each document drains again before the final check.
        await Promise.all(getDocuments().map(session => session.quiesce()));
        return await closeWith(decision, retiring);
    }

    async function handleWindowClose(_request: IWindowCloseRequest): Promise<TWindowCloseDecision> {
        if (closeRequestInFlight) {
            return 'cancel';
        }

        closeRequestInFlight = true;
        const retiring: TRetiring = new Map();
        try {
            await Promise.all(getDocuments().map(async session => retiring.set(session, await session.quiesce())));
            const decision = await decideWindowClose(retiring);
            // A window that stays open leaves every document usable.
            if (decision === 'cancel') retiring.forEach(document => document.keep());
            return decision;
        } catch (error) {
            BrowserLogger.error('workspace', 'Native window close save failed', {error}, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'});
            retiring.forEach(document => document.keep());
            return 'cancel';
        } finally {
            closeRequestInFlight = false;
        }
    }

    const subscribe = systemCapability.onWindowCloseRequest;
    if (!subscribe) {
        return;
    }

    const unsubscribe = subscribe(handleWindowClose);
    tryOnScopeDispose(unsubscribe);
    return unsubscribe;
};
