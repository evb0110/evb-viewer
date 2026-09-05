import type { Ref } from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { TWorkspaceSaveAbort } from '@app/modules/workspace-shell/composables/file-operations/workspaceSaveExecutionResult';
import { notSavedBeforeWrite } from '@app/modules/workspace-shell/composables/file-operations/workspaceSaveExecutionResult';
import type { TWorkspaceSavePlan } from '@app/modules/workspace-shell/composables/file-operations/workspaceSavePlan';

export interface IUnencryptedSaveNoticeResult {
    confirmed: boolean;
    dontShowAgain: boolean;
}

export interface IUnencryptedSaveNoticeDependencies {
    request: () => Promise<IUnencryptedSaveNoticeResult>;
    suppress: Ref<boolean>;
    updateSuppress: () => void;
    resetSuppress: () => void;
    flushSettings: () => Promise<boolean>;
}

interface IUnencryptedSaveGateDependencies {
    document: {
        sessionKey: Ref<string | null>;
        wasEncrypted?: Ref<boolean>;
    };
    unencryptedSaveNotice?: IUnencryptedSaveNoticeDependencies;
}

export async function unencryptedSaveNoticeGate(
    deps: IUnencryptedSaveGateDependencies,
    plan: Pick<TWorkspaceSavePlan, 'target'>,
    acknowledgedSessions: Set<string>,
): Promise<TWorkspaceSaveAbort | null> {
    if (deps.document.wasEncrypted?.value !== true) {
        return null;
    }
    const sessionKey = plan.target.expectedDocumentSessionKey;
    if (
        !sessionKey
        || acknowledgedSessions.has(sessionKey)
        || deps.unencryptedSaveNotice?.suppress.value === true
    ) {
        return null;
    }
    const notice = deps.unencryptedSaveNotice;
    if (!notice) {
        BrowserLogger.error(
            'workspace',
            'Encrypted document save warning is unavailable; save was blocked',
            undefined,
            {
                code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
                context: {},
            },
        );
        return notSavedBeforeWrite(
            'capability-unavailable',
            plan.target.expectedRevisionToken,
            null,
        );
    }
    const choice = await notice.request();
    if (!choice.confirmed) {
        return notSavedBeforeWrite(
            'cancelled',
            plan.target.expectedRevisionToken,
            null,
        );
    }

    // The acknowledgement belongs to the open session, not the path. A later
    // reopen of the same file must ask again.
    acknowledgedSessions.add(sessionKey);
    if (choice.dontShowAgain) {
        notice.updateSuppress();
        const persisted = await notice.flushSettings();
        if (!persisted) {
            notice.resetSuppress();
            BrowserLogger.warn(
                'workspace',
                'The unencrypted-save warning preference could not be saved; it remains enabled',
            );
        }
    }
    return null;
}
