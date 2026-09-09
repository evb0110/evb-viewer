import type {
    ComputedRef,
    Ref,
} from 'vue';
import type {
    IAgentAssistantChatScope,
    IAgentAssistantImageAttachment,
    TAgentAssistantPresetId,
} from '@contracts/agent';
import type { TTranslateFn } from '@i18n-app';

export interface IAssistantSubmitPayload {
    text: string;
    attachments?: IAgentAssistantImageAttachment[];
    presetId?: TAgentAssistantPresetId;
}

interface IAssistantSteeringOptions {
    chatScope: ComputedRef<IAgentAssistantChatScope | null>;
    clearComposerImages: () => void;
    composerError: Ref<string>;
    composerImages: Ref<IAgentAssistantImageAttachment[]>;
    draft: Ref<string>;
    handleInterrupt: () => void;
    isSending: Ref<boolean>;
    isTurnActive: ComputedRef<boolean>;
    queuedSteer: Ref<IAssistantSubmitPayload | null>;
    queuedSteerSendInFlight: Ref<boolean>;
    replaceComposerImages: (images: readonly IAgentAssistantImageAttachment[]) => void;
    sendGeneration: () => number;
    setTurnActivity: (activity: string) => void;
    submitAssistantPayload: (
        payload: IAssistantSubmitPayload,
        errorTitle: string,
        onSendError?: () => void,
    ) => Promise<boolean>;
    scopeFingerprint: () => string;
    t: TTranslateFn;
}

export function createAssistantSteering(options: IAssistantSteeringOptions) {
    function queueSteer(payload: IAssistantSubmitPayload) {
        if (options.queuedSteer.value || options.queuedSteerSendInFlight.value) {
            return;
        }
        const queuedPayload: IAssistantSubmitPayload = {
            text: payload.text,
            ...(payload.attachments && payload.attachments.length > 0
                ? {attachments: payload.attachments.map(attachment => ({...attachment}))}
                : {}),
        };
        options.queuedSteer.value = queuedPayload;
        options.draft.value = queuedPayload.text;
        options.replaceComposerImages(queuedPayload.attachments ?? []);
        options.composerError.value = '';
        options.setTurnActivity(options.t('assistant.steerQueued'));
        if (options.isTurnActive.value) {
            options.handleInterrupt();
        }
    }

    function flushQueuedSteerIfReady() {
        if (
            !options.queuedSteer.value
            || options.isTurnActive.value
            || options.isSending.value
            || options.queuedSteerSendInFlight.value
            || !options.chatScope.value
        ) {
            return;
        }

        const payload = options.queuedSteer.value;
        const requestScopeFingerprint = options.scopeFingerprint();
        const requestGeneration = options.sendGeneration();
        options.queuedSteerSendInFlight.value = true;
        options.setTurnActivity(options.t('assistant.steerSending'));
        void options.submitAssistantPayload(
            payload,
            'Failed to send queued assistant steer',
            () => {
                if (isCurrentQueue(options, payload, requestScopeFingerprint, requestGeneration)) {
                    options.draft.value = payload.text;
                    options.replaceComposerImages(payload.attachments ?? []);
                }
            },
        ).then(success => {
            const queueStillCurrent = options.queuedSteer.value === payload
                && requestScopeFingerprint === options.scopeFingerprint();
            if (!queueStillCurrent) {
                return;
            }
            if (requestGeneration !== options.sendGeneration()) {
                restorePayloadIfOwned(options, payload);
                options.queuedSteerSendInFlight.value = false;
                return;
            }
            if (success) {
                options.queuedSteer.value = null;
                if (isComposerPayloadCurrent(options, payload)) {
                    options.draft.value = '';
                    options.clearComposerImages();
                }
            } else {
                options.queuedSteer.value = null;
                restorePayloadIfOwned(options, payload);
            }
            options.queuedSteerSendInFlight.value = false;
        });
    }

    return {
        flushQueuedSteerIfReady,
        queueSteer,
    };
}

function restorePayloadIfOwned(
    options: IAssistantSteeringOptions,
    payload: IAssistantSubmitPayload,
) {
    if (!isComposerPayloadCurrent(options, payload)) {
        return;
    }
    options.draft.value = payload.text;
    options.replaceComposerImages(payload.attachments ?? []);
}

function isComposerPayloadCurrent(
    options: IAssistantSteeringOptions,
    payload: IAssistantSubmitPayload,
) {
    const attachments = payload.attachments ?? [];
    return options.draft.value === payload.text
        && options.composerImages.value.length === attachments.length
        && options.composerImages.value.every((image, index) => image.id === attachments[index]?.id);
}

function isCurrentQueue(
    options: IAssistantSteeringOptions,
    payload: IAssistantSubmitPayload,
    requestScopeFingerprint: string,
    requestGeneration: number,
) {
    return options.queuedSteer.value === payload
        && requestGeneration === options.sendGeneration()
        && requestScopeFingerprint === options.scopeFingerprint();
}
