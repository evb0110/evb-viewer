import type { InjectionKey } from 'vue';
import type { TDocumentInstanceId } from '@contracts/documentInstanceId';
import {
    describeTabDocument,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

interface IUseDirtyTabCloseDialogDeps {getSession: (tabId: string) => IWorkspaceDocumentController | null;}

export type TDirtyCloseDecision = 'save' | 'discard' | 'cancel';
export type TDirtyCloseDialogMode = 'tab' | 'window';
export type TDirtyTabCloseConfirmation = (tabId: string) => Promise<TDirtyCloseDecision>;

export const dirtyTabCloseConfirmationKey: InjectionKey<TDirtyTabCloseConfirmation> = Symbol('dirty-tab-close-confirmation');

interface IDirtyTabCloseTarget {
    id: string;
    documentInstanceId: TDocumentInstanceId | null;
    name: string | null;
}

export const useDirtyTabCloseDialog = (
    deps: IUseDirtyTabCloseDialogDeps,
) => {
    const { t } = useTypedI18n();
    const dirtyTabCloseDialogOpen = ref(false);
    const dirtyTabCloseTargetId = ref<string | null>(null);
    const dirtyTabCloseTarget = ref<IDirtyTabCloseTarget | null>(null);
    const dirtyTabCloseDialogMode = ref<TDirtyCloseDialogMode>('tab');
    let dirtyTabCloseDialogResolver: ((decision: TDirtyCloseDecision) => void) | null = null;

    const dirtyTabCloseTargetName = computed(() => dirtyTabCloseTarget.value?.name ?? t('tabs.newTab'));

    function readTargetInstanceId(tabId: string) {
        return deps.getSession(tabId)?.snapshot.value.identity.documentInstanceId ?? null;
    }

    function resolveDirtyTabCloseDialog(decision: TDirtyCloseDecision | boolean) {
        const resolver = dirtyTabCloseDialogResolver;
        dirtyTabCloseDialogResolver = null;
        dirtyTabCloseTargetId.value = null;
        dirtyTabCloseDialogOpen.value = false;
        if (resolver) {
            resolver(typeof decision === 'boolean'
                ? decision ? 'discard' : 'cancel'
                : decision);
        }
    }

    function requestDirtyTabCloseConfirmation(tabId: string) {
        if (dirtyTabCloseDialogResolver) {
            resolveDirtyTabCloseDialog(false);
        }
        const session = deps.getSession(tabId);
        if (!session) {
            return Promise.resolve<TDirtyCloseDecision>('cancel');
        }
        dirtyTabCloseTarget.value = {
            id: tabId,
            documentInstanceId: session.snapshot.value.identity.documentInstanceId,
            name: describeTabDocument(session.snapshot.value).fileName,
        };
        dirtyTabCloseTargetId.value = tabId;
        dirtyTabCloseDialogMode.value = 'tab';
        const confirmation = new Promise<TDirtyCloseDecision>((resolve) => {
            dirtyTabCloseDialogResolver = resolve;
        });
        dirtyTabCloseDialogOpen.value = true;
        return confirmation;
    }

    function requestDirtyWindowCloseConfirmation() {
        if (dirtyTabCloseDialogResolver) {
            resolveDirtyTabCloseDialog('cancel');
        }
        dirtyTabCloseDialogMode.value = 'window';
        dirtyTabCloseTarget.value = null;
        dirtyTabCloseTargetId.value = null;
        const confirmation = new Promise<TDirtyCloseDecision>((resolve) => {
            dirtyTabCloseDialogResolver = resolve;
        });
        dirtyTabCloseDialogOpen.value = true;
        return confirmation;
    }

    if (getCurrentInstance()) {
        provide(dirtyTabCloseConfirmationKey, requestDirtyTabCloseConfirmation);
    }

    // The prompt names one document. If the tab closes or now holds another
    // document, the question no longer applies.
    watch(() => {
        const target = dirtyTabCloseTarget.value;
        return dirtyTabCloseDialogMode.value === 'tab' && target
            ? deps.getSession(target.id) !== null && readTargetInstanceId(target.id) === target.documentInstanceId
            : true;
    }, (current) => {
        if (!current && dirtyTabCloseDialogResolver) {
            resolveDirtyTabCloseDialog(false);
        }
    });

    if (getCurrentScope()) {
        onScopeDispose(() => {
            resolveDirtyTabCloseDialog(false);
        });
    }

    return {
        dirtyTabCloseDialogOpen,
        dirtyTabCloseDialogMode,
        dirtyTabCloseTargetId,
        dirtyTabCloseTargetName,
        requestDirtyTabCloseConfirmation,
        requestDirtyWindowCloseConfirmation,
        resolveDirtyTabCloseDialog,
    };
};
