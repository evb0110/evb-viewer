import { cloneAssistantScope } from '@agent-core/assistantScope';
import type {
    IAgentAssistantChatScope, TAgentAssistantPresetId,
} from '@contracts/agent';
import {
    assistantSessionKey,
    type IAssistantEvent,
    type IAssistantOperationResult,
    type IAssistantState,
} from '@contracts/assistant';
import {
    defaultWindow, useEventListener,
} from '@vueuse/core';
import { getAgentCapability } from '@app/utils/getAgentCapability';
import { getErrorMessage } from '@app/utils/error';
import { useRuntimeErrorReports } from '@app/composables/useRuntimeErrorReports';
import {
    captureAssistantFailure, type TAssistantFailureAction,
} from '@app/modules/agent-panel/utils/assistantFailure';
import { useTypedI18n } from '@app/composables/useTypedI18n';
import {
    persistAssistantSelection,
    readAssistantSelectionPreference,
    resolveAssistantSelection,
} from '@app/modules/agent-panel/utils/assistantSelectionPreference';
import { ASSISTANT_PRESETS } from '@app/modules/agent-panel/utils/assistantPresets';
import { useAssistantImageComposer } from '@app/modules/agent-panel/composables/useAssistantImageComposer';
import type { TAssistantComposerImage } from '@app/modules/agent-panel/utils/assistantImageAttachments';

export interface IAgentAssistantPanelControllerProps {
    activeDocumentName?: string | null | undefined;
    chatScope?: IAgentAssistantChatScope | null | undefined;
    isChatScopePending?: boolean | undefined;
    isAssistantCommandRunning?: boolean | undefined;
    hasActiveDocument?: boolean | undefined;
    hasAnyDocument?: boolean | undefined;
    width?: number | undefined;
    isResizing?: boolean | undefined;
}

export const useAgentAssistantPanelController = (props: Readonly<IAgentAssistantPanelControllerProps>) => {
    const { t } = useTypedI18n();
    const { reportRuntimeError } = useRuntimeErrorReports();
    const state = ref<IAssistantState>({
        supported: true,
        enabled: true,
        instances: [],
        selection: null,
        chat: null,
        installProgress: null,
    });
    const selection = ref(readAssistantSelectionPreference(defaultWindow?.localStorage));
    const scope = computed<IAgentAssistantChatScope | null>(previous => props.isChatScopePending ? previous ?? null : props.chatScope ?? null);
    const sessionKey = computed(() => scope.value && selection.value ? assistantSessionKey(selection.value.instanceId, scope.value.key) : null);
    const requestIdentity = computed(() => JSON.stringify([
        scope.value,
        selection.value,
    ]));
    const chat = computed(() => state.value.chat?.sessionKey === sessionKey.value ? state.value.chat : null);
    const instance = computed(() => state.value.instances.find(item => item.id === selection.value?.instanceId) ?? null);
    const draft = ref('');
    const composerImages = ref<TAssistantComposerImage[]>([]);
    const composerError = ref('');
    const deviceCode = ref('');
    const verificationUrl = ref('');
    const busyAction = ref<string | null>(null);
    const sending = ref(false);
    const interrupting = ref(false);
    const imageComposer = useAssistantImageComposer({
        composerImages,
        composerError,
        t,
    });
    const running = computed(() => Boolean(chat.value?.turn && ![
        'idle',
        'done',
        'failed',
        'cancelled',
    ].includes(chat.value.turn.phase)));
    const hasPayload = computed(() => Boolean(draft.value.trim() || composerImages.value.length));
    const providerDisabledReason = computed(() => {
        if (props.isChatScopePending) return t('assistant.documentPending');
        if (!scope.value) return t('assistant.noDocumentDescription');
        if (!state.value.supported) return t('assistant.unsupportedTitle');
        if (!instance.value) return t('assistant.instanceMissing');
        if (!state.value.enabled || !instance.value.enabled || instance.value.state === 'disabled') return t('assistant.instanceDisabled');
        if (instance.value.state === 'missing') return instance.value.message ?? t('assistant.instanceMissing');
        if (instance.value.auth === 'unauthenticated') return instance.value.message ?? t('assistant.signInRequired');
        return '';
    });
    const sendDisabledReason = computed(() => providerDisabledReason.value
        || (imageComposer.isImageIngestionPending.value ? t('assistant.preparingImages') : '')
        || (sending.value ? t('assistant.sending') : '')
        || (!hasPayload.value ? t('assistant.emptyDraft') : ''));

    function applyState(next: IAssistantState) {
        const currentChat = chat.value;
        state.value = {
            ...next,
            chat: next.chat?.sessionKey === sessionKey.value ? next.chat : currentChat,
        };
        const resolved = resolveAssistantSelection(selection.value, next.instances, next.selection);
        if (JSON.stringify(resolved) !== JSON.stringify(selection.value)) selection.value = resolved;
    }
    function handleEvent(event: IAssistantEvent) {
        if (event.type === 'instances') {
            state.value.instances = event.instances;
            const resolved = resolveAssistantSelection(selection.value, event.instances, state.value.selection);
            if (JSON.stringify(resolved) !== JSON.stringify(selection.value)) selection.value = resolved;
        } else if (event.type === 'install-progress') {
            state.value.installProgress = event.progress;
        } else if (event.type === 'chat') {
            if (event.chat.sessionKey === sessionKey.value) state.value.chat = event.chat;
        } else if (event.sessionKey === sessionKey.value && scope.value && selection.value) {
            const current = chat.value ?? {
                sessionKey: event.sessionKey,
                scope: scope.value,
                instanceId: selection.value.instanceId,
                model: selection.value.model,
                items: [],
                turn: null,
            };
            state.value.chat = current;
            if (event.type === 'turn') current.turn = event.turn;
            if (event.type === 'item') {
                const index = current.items.findIndex(item => item.id === event.item.id);
                if (index < 0) current.items.push(event.item);
                else current.items[index] = event.item;
            }
            if (event.type === 'item-delta') {
                const item = current.items.find(item => item.id === event.itemId);
                if (item) item.text += event.delta;
            }
        }
    }
    function reportFailure(error: unknown, action: TAssistantFailureAction) {
        reportRuntimeError(captureAssistantFailure(error, {
            action,
            title: t('assistant.runtimeErrorTitle'),
            description: getErrorMessage(error),
            section: 'assistant',
        }));
    }
    async function run(action: 'reset' | 'install' | 'login' | 'cancel', callback: () => Promise<void>) {
        if (busyAction.value) return;
        busyAction.value = action;
        const owner = sessionKey.value;
        try {
            await callback();
        } catch (error) {
            if (mounted && owner === sessionKey.value) reportFailure(error, action);
        } finally {
            busyAction.value = null;
        }
    }
    // A reset or a newer refresh retires the replies of earlier refreshes.
    let refreshSerial = 0;
    async function refresh(probe = false) {
        const identity = requestIdentity.value;
        const serial = ++refreshSerial;
        try {
            const next = await getAgentCapability().getAssistantState({
                scope: scope.value ? cloneAssistantScope(scope.value) : null,
                ...(selection.value ? { selection: { ...selection.value } } : {}),
                probe,
            });
            if (mounted && serial === refreshSerial && identity === requestIdentity.value) applyState(next);
        } catch (error) {
            if (mounted && serial === refreshSerial && identity === requestIdentity.value) reportFailure(error, 'refresh');
        }
    }
    function applyResult(result: IAssistantOperationResult, owner: string | null) {
        if (!mounted || owner !== sessionKey.value) return;
        applyState(result.state);
        if (!result.ok && result.error) {
            if (instance.value?.message !== result.error.message) reportFailure(new Error(result.error.message), busyAction.value === 'install' ? 'install' : 'login');
        }
    }
    /**
     * Sends the composer's draft, or an explicit payload (retry, preset). Only
     * a composer send clears the composer, so a retry keeps what is being typed.
     */
    async function send(payload?: {
        text: string;
        attachments: readonly TAssistantComposerImage[];
        presetId?: TAgentAssistantPresetId;
    }) {
        const fromComposer = payload === undefined;
        const text = payload ? payload.text : draft.value.trim();
        const attachments = payload ? payload.attachments : composerImages.value;
        const presetId = payload?.presetId;
        if (providerDisabledReason.value || sending.value || imageComposer.isImageIngestionPending.value || !scope.value || !selection.value || (!text && !attachments.length)) return;
        const owner = sessionKey.value;
        const existingSystemIds = new Set(chat.value?.items.filter(item => item.kind === 'system').map(item => item.id));
        const hasNewSystemItem = (next: IAssistantState['chat']) => next?.sessionKey === owner
            && next.items.some(item => item.kind === 'system' && !existingSystemIds.has(item.id));
        const reportRefusal = (message: string) => reportRuntimeError(captureAssistantFailure(new Error(message), {
            action: 'send',
            title: t('assistant.runtimeErrorTitle'),
            description: message,
            section: 'assistant',
        }));
        const request = {
            text,
            attachments: attachments.map(({
                previewDataUrl: _preview, ...image
            }) => image),
            scope: cloneAssistantScope(scope.value),
            selection: { ...selection.value },
            ...(presetId ? { presetId } : {}),
        };
        sending.value = true;
        if (fromComposer) {
            draft.value = '';
            imageComposer.clearComposerImages();
        }
        try {
            const result = await getAgentCapability().sendAssistantMessage(request);
            if (owner !== sessionKey.value || !mounted) return;
            const pushedChat = chat.value;
            const hasReturnedReply = hasNewSystemItem(result.state.chat);
            const hasPushedReply = hasNewSystemItem(pushedChat);
            const hasReply = hasReturnedReply || hasPushedReply;
            applyState(result.state);
            // A failure already pushed is newer than a snapshot that lacks it.
            if (hasPushedReply && !hasReturnedReply) state.value.chat = pushedChat;
            if (!result.ok && !hasReply && result.error) reportRefusal(result.error.message);
            if (fromComposer && !result.ok && !hasReply && !draft.value && !composerImages.value.length) {
                draft.value = text;
                imageComposer.replaceComposerImages(attachments);
            }
        } catch (error) {
            if (mounted && owner === sessionKey.value) {
                if (!hasNewSystemItem(chat.value)) reportRefusal(getErrorMessage(error));
                if (fromComposer && !draft.value && !composerImages.value.length) {
                    draft.value = text;
                    imageComposer.replaceComposerImages(attachments);
                }
            }
        } finally {
            sending.value = false;
        }
    }
    /** Resends the user message of the failed turn, with its images. */
    async function retry(turnId: string | null) {
        const items = chat.value?.items ?? [];
        const user = items.findLast(item => item.kind === 'user' && (turnId === null || item.turnId === turnId))
            ?? items.findLast(item => item.kind === 'user');
        if (user) await send({
            text: user.text,
            attachments: user.attachments ?? [],
        });
    }
    async function interrupt() {
        if (!scope.value || !selection.value || interrupting.value || chat.value?.turn?.phase === 'interrupting') return;
        interrupting.value = true;
        const owner = sessionKey.value;
        try {
            const next = await getAgentCapability().interruptAssistant({
                scope: cloneAssistantScope(scope.value),
                instanceId: selection.value.instanceId,
            });
            if (mounted && owner === sessionKey.value) applyState(next);
        } catch (error) {
            if (mounted && owner === sessionKey.value) reportFailure(error, 'interrupt');
        } finally {
            interrupting.value = false;
        }
    }
    function reset() {
        if (!scope.value || !selection.value) return;
        const request = {
            scope: cloneAssistantScope(scope.value),
            instanceId: selection.value.instanceId,
        };
        const owner = sessionKey.value;
        refreshSerial += 1;
        void run('reset', async () => {
            const next = await getAgentCapability().resetAssistantChat(request);
            if (mounted && owner === sessionKey.value) {
                applyState(next);
                draft.value = '';
                imageComposer.clearComposerImages();
            }
        });
    }
    function install() {
        const owner = sessionKey.value;
        void run('install', async () => applyResult(await getAgentCapability().installAssistantCodex(), owner));
    }
    function login(mode: 'chatgpt' | 'device-code') {
        if (!selection.value) return;
        const instanceId = selection.value.instanceId;
        const owner = sessionKey.value;
        void run('login', async () => {
            const result = await getAgentCapability().startAssistantLogin({
                instanceId,
                mode,
            });
            applyResult(result, owner);
            if (mounted && owner === sessionKey.value) {
                deviceCode.value = result.userCode ?? '';
                verificationUrl.value = result.verificationUrl ?? result.authUrl ?? '';
            }
        });
    }
    function cancelLogin() {
        if (!selection.value) return;
        const instanceId = selection.value.instanceId;
        const owner = sessionKey.value;
        void run('cancel', async () => {
            const next = await getAgentCapability().cancelAssistantLogin({ instanceId });
            if (mounted && owner === sessionKey.value) {
                applyState(next);
                deviceCode.value = '';
                verificationUrl.value = '';
            }
        });
    }
    const presetLabel = (id: TAgentAssistantPresetId) => t(id === 'add-bookmarks' ? 'assistant.presetAddBookmarks' : id === 'number-pages' ? 'assistant.presetNumberPages' : 'assistant.presetCheckOcr');
    function sendPreset(id: TAgentAssistantPresetId) {
        void send({
            text: presetLabel(id),
            attachments: [],
            presetId: id,
        });
    }
    let mounted = false;
    let unsubscribe: (() => void) | undefined;
    watch(requestIdentity, () => { if (mounted) void refresh(); });
    watch(sessionKey, () => {
        draft.value = '';
        imageComposer.clearComposerImages();
        imageComposer.closeExpandedImage();
        deviceCode.value = '';
        verificationUrl.value = '';
    });
    watch(selection, value => { if (value) persistAssistantSelection(defaultWindow?.localStorage, value); }, {
        deep: true,
        immediate: true,
    });
    onMounted(() => {
        mounted = true;
        unsubscribe = getAgentCapability().onAssistantEvent(handleEvent);
        void refresh(true);
    });
    onBeforeUnmount(() => {
        mounted = false;
        unsubscribe?.();
        imageComposer.invalidatePendingImageIngestion();
    });
    useEventListener(defaultWindow, 'keydown', imageComposer.handleExpandedImageKeydown);
    return {
        t,
        state,
        scope,
        sessionKey,
        selection,
        instance,
        chat,
        draft,
        composerImages,
        composerError,
        deviceCode,
        verificationUrl,
        busyAction,
        sending,
        interrupting,
        running,
        hasPayload,
        providerDisabledReason,
        sendDisabledReason,
        refresh,
        send,
        retry,
        interrupt,
        reset,
        install,
        login,
        cancelLogin,
        presetLabel,
        sendPreset,
        presets: ASSISTANT_PRESETS,
        ...imageComposer,
    };
};
