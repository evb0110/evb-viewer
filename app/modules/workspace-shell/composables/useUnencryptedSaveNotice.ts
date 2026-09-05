import type { Ref } from 'vue';
import type { IUnencryptedSaveNoticeResult } from '@app/modules/workspace-shell/composables/file-operations/unencryptedSaveNoticeGate';

type TNoticeResolver = (result: IUnencryptedSaveNoticeResult) => void;

let pendingResolver: TNoticeResolver | null = null;
let pendingOwner: symbol | null = null;
const queuedRequests: Array<{
    owner: symbol;
    resolve: TNoticeResolver;
}> = [];

export interface IUnencryptedSaveNoticeController {
    unencryptedSaveNoticeOpen: Ref<boolean>;
    unencryptedSaveNoticeDontShowAgain: Ref<boolean>;
    requestUnencryptedSaveNotice: () => Promise<IUnencryptedSaveNoticeResult>;
    confirmUnencryptedSaveNotice: () => void;
    cancelUnencryptedSaveNotice: () => void;
    resolveUnencryptedSaveNotice: (result: IUnencryptedSaveNoticeResult) => void;
}

/**
 * The shell owns one dialog while document workspaces request it from their
 * save services. State is keyed so the root and every workspace see the same
 * modal without threading UI props through the pane tree.
 */
export const useUnencryptedSaveNotice = (): IUnencryptedSaveNoticeController => {
    const open = useState('workspace:unencrypted-save-notice:open', () => false);
    const dontShowAgain = useState('workspace:unencrypted-save-notice:dont-show-again', () => false);
    const owner = Symbol('unencrypted-save-notice-owner');

    function activateQueuedRequest() {
        const next = queuedRequests.shift();
        if (!next) {
            pendingOwner = null;
            open.value = false;
            return;
        }
        pendingOwner = next.owner;
        pendingResolver = next.resolve;
        open.value = true;
        dontShowAgain.value = false;
    }

    function resolveUnencryptedSaveNotice(result: IUnencryptedSaveNoticeResult) {
        const resolver = pendingResolver;
        pendingResolver = null;
        pendingOwner = null;
        dontShowAgain.value = false;
        resolver?.(result);

        // A shared suppression choice applies to saves that were already
        // waiting for this dialog. Resolve them without opening another
        // dialog. The save gate still flushes the setting for each request.
        if (result.confirmed && result.dontShowAgain) {
            while (queuedRequests.length > 0) {
                queuedRequests.shift()?.resolve(result);
            }
        }
        activateQueuedRequest();
    }

    function requestUnencryptedSaveNotice() {
        return new Promise<IUnencryptedSaveNoticeResult>((resolve) => {
            if (pendingResolver) {
                queuedRequests.push({
                    owner,
                    resolve,
                });
                return;
            }
            open.value = true;
            dontShowAgain.value = false;
            pendingOwner = owner;
            pendingResolver = resolve;
        });
    }

    function confirmUnencryptedSaveNotice() {
        resolveUnencryptedSaveNotice({
            confirmed: true,
            dontShowAgain: dontShowAgain.value,
        });
    }

    function cancelUnencryptedSaveNotice() {
        resolveUnencryptedSaveNotice({
            confirmed: false,
            dontShowAgain: false,
        });
    }

    function cancelRequestsForOwner() {
        for (let index = queuedRequests.length - 1; index >= 0; index -= 1) {
            if (queuedRequests[index]?.owner !== owner) {
                continue;
            }
            const [request] = queuedRequests.splice(index, 1);
            request?.resolve({
                confirmed: false,
                dontShowAgain: false,
            });
        }
        if (pendingOwner === owner) {
            cancelUnencryptedSaveNotice();
        }
    }

    if (getCurrentScope()) {
        onScopeDispose(() => {
            cancelRequestsForOwner();
        });
    }

    return {
        unencryptedSaveNoticeOpen: open,
        unencryptedSaveNoticeDontShowAgain: dontShowAgain,
        requestUnencryptedSaveNotice,
        confirmUnencryptedSaveNotice,
        cancelUnencryptedSaveNotice,
        resolveUnencryptedSaveNotice,
    };
};
