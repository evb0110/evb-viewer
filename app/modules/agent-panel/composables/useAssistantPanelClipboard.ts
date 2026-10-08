import type { ComputedRef } from 'vue';
import type { IAgentAssistantChatMessage } from '@contracts/agent';
import type { TTranslateFn } from '@i18n-app';
import type {formatAssistantMessage} from '@app/modules/agent-panel/utils/formatAssistantMessage';
import {createStreamingAssistantMessageFormatter} from '@app/modules/agent-panel/utils/formatAssistantMessage';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    defaultDocument,
    tryOnScopeDispose,
    useClipboard,
    useTimeoutFn,
} from '@vueuse/core';

export const useAssistantPanelClipboard = (options: {
    messages: ComputedRef<IAgentAssistantChatMessage[]>;
    t: TTranslateFn;
}) => {
    const EMPTY_MESSAGE_BLOCKS: ReturnType<typeof formatAssistantMessage> = [];
    let markdownCache = new Map<string, {
        text: string;
        blocks: ReturnType<typeof formatAssistantMessage>;
        formatter: ReturnType<typeof createStreamingAssistantMessageFormatter>;
    }>();
    const copiedMessageId = ref<string | null>(null);
    const panelRef = ref<HTMLElement | null>(null);
    const messagesRef = ref<HTMLElement | null>(null);
    const { copy } = useClipboard();
    const copiedReset = useTimeoutFn(() => {
        copiedMessageId.value = null;
    }, 1800, { immediate: false });

    const renderedMessages = computed(() => {
        const nextCache: typeof markdownCache = new Map();
        const rows = options.messages.value.map(message => {
            const cached = markdownCache.get(message.id) ?? {
                text: '',
                blocks: EMPTY_MESSAGE_BLOCKS,
                formatter: createStreamingAssistantMessageFormatter(),
            };
            nextCache.set(message.id, cached);
            const blocks = computed(() => {
                if (cached.text !== message.text) {
                    cached.text = message.text;
                    cached.blocks = message.text.length ? cached.formatter.format(message.text) : EMPTY_MESSAGE_BLOCKS;
                }
                return cached.blocks;
            });
            return reactive({
                message,
                blocks,
            });
        });
        markdownCache = nextCache;
        return rows;
    });

    const isCopyShortcut = (event: KeyboardEvent) => (
        [
            event.metaKey,
            event.ctrlKey,
        ].some(Boolean) && !event.altKey && event.key.toLowerCase() === 'c'
    );
    const isEditableCopyTarget = (target: EventTarget | null) => {
        if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) {
            return false;
        }
        return [
            target.isContentEditable,
            target.closest('[contenteditable="true"], [contenteditable=""]'),
            target.closest('input, textarea, select'),
        ].some(Boolean);
    };
    const getSelectionText = () => {
        const panel = panelRef.value;
        const selection = defaultDocument?.getSelection();
        if (!panel || !selection || selection.isCollapsed || selection.rangeCount === 0) {
            return '';
        }
        const nodeInPanel = (node: Node | null) => Boolean(node && (node === panel || panel.contains(node)));
        const rangeIntersectsPanel = (range: Range) => {
            try {
                return range.intersectsNode(panel);
            } catch {
                return false;
            }
        };
        const isInPanel = nodeInPanel(selection.anchorNode)
            || nodeInPanel(selection.focusNode)
            || Array.from({ length: selection.rangeCount }).some((_, index) => (
                rangeIntersectsPanel(selection.getRangeAt(index))
            ));
        const text = isInPanel ? selection.toString() : '';
        return text.trim().length > 0 ? text : '';
    };
    const copyText = async (text: string, logMessage: string) => {
        try {
            await copy(text);
            return true;
        } catch (error) {
            BrowserLogger.warn('assistant', logMessage, error);
            return false;
        }
    };
    const handleAssistantCopyShortcut = (event: KeyboardEvent) => {
        if (!isCopyShortcut(event) || isEditableCopyTarget(event.target)) {
            return;
        }
        const text = getSelectionText();
        if (!text) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        void copyText(text, 'Failed to copy selected assistant text');
    };
    const handleCopyMessageText = (messageId: string, text: string) => {
        if (text.trim().length === 0) {
            return;
        }
        void (async () => {
            if (!await copyText(text, 'Failed to copy assistant message text')) {
                return;
            }
            copiedReset.stop();
            copiedMessageId.value = messageId;
            copiedReset.start();
        })();
    };

    tryOnScopeDispose(copiedReset.stop);
    return {
        handleAssistantCopyShortcut,
        handleCopyMessageText,
        messagesRef,
        panelRef,
        renderedMessages,
        copyMessageIcon: (messageId: string) => copiedMessageId.value === messageId ? 'i-ph-check' : 'i-ph-copy',
        copyMessageTooltip: (messageId: string) => copiedMessageId.value === messageId
            ? options.t('assistant.copyMessageCopied')
            : options.t('assistant.copyMessage'),
    };
};
