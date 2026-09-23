import type {
    InjectionKey,
    Ref,
} from 'vue';
import type { ITab } from '@app/types/tabs';

interface IUseDirtyTabCloseDialogDeps {tabs: Ref<ITab[]>;}

export type TDirtyCloseDecision = 'save' | 'discard' | 'cancel';
export type TDirtyCloseDialogMode = 'tab' | 'window';
export type TDirtyTabCloseConfirmation = (tabId: string) => Promise<TDirtyCloseDecision>;

export const dirtyTabCloseConfirmationKey: InjectionKey<TDirtyTabCloseConfirmation> = Symbol('dirty-tab-close-confirmation');

interface IDirtyTabCloseTarget {
    id: string;
    documentInstanceId: ITab['documentInstanceId'] | null;
    name: string | null;
}

export const useDirtyTabCloseDialog = (
    deps: IUseDirtyTabCloseDialogDeps,
) => {
    const { tabs } = deps;
    const { t } = useTypedI18n();
    const dirtyTabCloseDialogOpen = ref(false);
    const dirtyTabCloseTargetId = ref<string | null>(null);
    const dirtyTabCloseTarget = ref<IDirtyTabCloseTarget | null>(null);
    const dirtyTabCloseDialogMode = ref<TDirtyCloseDialogMode>('tab');
    let dirtyTabCloseDialogResolver: ((decision: TDirtyCloseDecision) => void) | null = null;

    const dirtyTabCloseTargetName = computed(() => dirtyTabCloseTarget.value?.name ?? t('tabs.newTab'));

    function isCurrentTarget(tab: ITab | undefined) {
        const target = dirtyTabCloseTarget.value;
        return target !== null
            && tab?.id === target.id
            && (tab.documentInstanceId ?? null) === target.documentInstanceId;
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
        const tab = tabs.value.find(candidate => candidate.id === tabId);
        if (!tab) {
            return Promise.resolve<TDirtyCloseDecision>('cancel');
        }
        dirtyTabCloseTarget.value = {
            id: tab.id,
            documentInstanceId: tab.documentInstanceId ?? null,
            name: tab.fileName,
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

    watch(() => {
        if (dirtyTabCloseDialogMode.value !== 'tab') {
            return null;
        }
        const target = dirtyTabCloseTarget.value;
        const tab = target ? tabs.value.find(candidate => candidate.id === target.id) : undefined;
        return tab ? [
            tab.id,
            tab.documentInstanceId ?? null,
        ] : [
            null,
            null,
        ];
    }, () => {
        if (dirtyTabCloseDialogMode.value !== 'tab') {
            return;
        }
        if (dirtyTabCloseDialogResolver && !isCurrentTarget(
            dirtyTabCloseTarget.value
                ? tabs.value.find(candidate => candidate.id === dirtyTabCloseTarget.value?.id)
                : undefined,
        )) {
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
