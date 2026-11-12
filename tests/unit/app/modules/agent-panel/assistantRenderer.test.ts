// @vitest-environment happy-dom
import {
    afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
    createApp, defineComponent, h, nextTick, reactive, type Component,
} from 'vue';
import type {
    IAssistantChat, IAssistantEvent, IAssistantItem, IAssistantState,
} from '@contracts/assistant';
import type {
    IAgentAssistantChatScope, IAgentAssistantErrorEnvelope,
} from '@contracts/agent';
import {
    requireIsoTimestamp, requireEpochMs,
} from '@contracts/timestamps';
import { requireTabId } from '@contracts/windowTabs';
import {
    createAssistantInstance, createAssistantState,
} from '@tests/helpers/createAgentAssistantStatus';
import AgentAssistantPanel from '@app/modules/agent-panel/components/AgentAssistantPanel.vue';
import AssistantComposer from '@app/modules/agent-panel/components/AssistantComposer.vue';
import AssistantTimeline from '@app/modules/agent-panel/components/AssistantTimeline.vue';
import { STORAGE_KEYS } from '@app/constants/storageKeys';

const api = vi.hoisted(() => ({
    getAssistantState: vi.fn(),
    sendAssistantMessage: vi.fn(),
    installAssistantCodex: vi.fn(),
    startAssistantLogin: vi.fn(),
    cancelAssistantLogin: vi.fn(),
    interruptAssistant: vi.fn(),
    resetAssistantChat: vi.fn(),
    onAssistantEvent: vi.fn(),
    reportRuntimeError: vi.fn(),
}));
vi.mock('@app/utils/getAgentCapability', () => ({ getAgentCapability: () => api }));
vi.mock('@app/composables/useRuntimeErrorReports', () => ({ useRuntimeErrorReports: () => ({ reportRuntimeError: api.reportRuntimeError }) }));
vi.mock('@app/composables/useTypedI18n', () => ({ useTypedI18n: () => ({ t: (key: string, params?: Record<string, string | number>) => key + (params ? JSON.stringify(params) : '') }) }));
const scope: IAgentAssistantChatScope = {
    kind: 'document',
    key: 'a',
    title: 'A.pdf',
    tabId: requireTabId('tab-a'),
};
const selection = {
    instanceId: 'codex',
    model: 'gpt',
    effort: 'high',
    speedMode: 'standard',
} as const;
function item(id: string, kind: IAssistantItem['kind'], text: string, extra: Partial<IAssistantItem> = {}): IAssistantItem {
    return {
        id,
        kind,
        text,
        turnId: 'turn',
        status: 'completed',
        createdAt: requireIsoTimestamp('2026-11-12T00:00:00.000Z'),
        ...extra,
    };
}
function chat(items: IAssistantItem[] = []): IAssistantChat {
    return {
        sessionKey: 'codex:a',
        scope,
        instanceId: 'codex',
        model: 'gpt',
        items,
        turn: null,
    };
}
function envelope(message: string, retryable: boolean): IAgentAssistantErrorEnvelope {
    return {
        code: 'INTERNAL',
        message,
        retryable,
        details: { timestamp: requireEpochMs(Date.now()) },
    };
}
let current: IAssistantState;
let listener: (event: IAssistantEvent) => void;
const dispose = vi.fn();
const unmounts: Array<() => void> = [];
const Button = defineComponent({
    inheritAttrs: false,
    props: {
        label: String,
        disabled: Boolean,
        type: {
            type: String,
            default: 'button',
        },
    },
    setup: (props, {
        attrs, slots,
    }) => () => h('button', {
        ...attrs,
        type: props.type,
        disabled: props.disabled,
    }, [
        slots.leading?.(),
        props.label,
        slots.default?.(),
    ]),
});
const Slot = defineComponent({ setup: (_props, { slots }) => () => h('div', [
    slots.default?.(),
    slots.content?.(),
]) });
const Input = defineComponent({
    inheritAttrs: false,
    props: { modelValue: String },
    emits: ['update:modelValue'],
    setup: (props, {
        attrs, emit,
    }) => () => h('input', {
        ...attrs,
        value: props.modelValue,
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
    }),
});
function mount(component: Component = AgentAssistantPanel, props: Record<string, unknown> = {
    chatScope: scope,
    activeDocumentName: 'A.pdf',
}) {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({ setup: () => () => h(component, props) }));
    app.component('UButton', Button);
    app.component('UIcon', defineComponent({ setup: () => () => h('span') }));
    app.component('AppTooltip', Slot);
    app.component('UPopover', Slot);
    app.component('UInput', Input);
    app.mount(host);
    unmounts.push(() => { app.unmount(); host.remove(); });
    return host;
}
async function settle() { for (let index = 0; index < 6; index++) await nextTick(); }
function button(host: HTMLElement, label: string) {
    const found = [...host.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label);
    if (!found) throw new Error('Missing button ' + label);
    return found;
}
async function draft(host: HTMLElement, text: string) {
    const input = host.querySelector('textarea');
    if (!input) throw new Error('Missing composer');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
}
beforeEach(() => {
    localStorage.clear(); vi.clearAllMocks();
    current = createAssistantState({ chat: chat() });
    api.getAssistantState.mockImplementation(async () => current);
    api.sendAssistantMessage.mockImplementation(async () => ({
        ok: true,
        state: current,
    }));
    api.interruptAssistant.mockImplementation(async () => current);
    api.resetAssistantChat.mockImplementation(async () => current);
    api.installAssistantCodex.mockImplementation(async () => ({
        ok: true,
        state: current,
    }));
    api.startAssistantLogin.mockImplementation(async () => ({
        ok: true,
        state: current,
    }));
    api.onAssistantEvent.mockImplementation((callback: typeof listener) => { listener = callback; return dispose; });
});
afterEach(() => { unmounts.splice(0).forEach(unmount => unmount()); });

describe('assistant renderer on instance contract', () => {
    it.each([
        'checking',
        'warning',
        'error',
    ] as const)('keeps history and sending visible for a selected %s instance', async state => {
        current = createAssistantState({
            instances: [
                createAssistantInstance({
                    state,
                    message: 'initialize failed: actual network detail',
                }),
                createAssistantInstance({
                    id: 'other',
                    label: 'Other',
                    state: 'error',
                    message: 'OTHER FAILURE',
                }),
            ],
            chat: chat([item('answer', 'assistant', 'Existing **answer**')]),
        });
        const host = mount();
        await settle();
        expect(host.textContent).toContain('Existing');
        expect(host.querySelector('.provider-banner')?.textContent).not.toContain('OTHER FAILURE');
        if (state !== 'checking') expect(host.querySelector('.provider-banner')?.textContent).toContain('initialize failed: actual network detail');
        await draft(host, 'next message');
        const send = host.querySelector<HTMLButtonElement>('.composer-send');
        expect(send?.disabled).toBe(false);
        send?.click();
        await settle();
        expect(api.sendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
            text: 'next message',
            scope,
            selection,
        }));
    });

    it('offers no sign-in for a failure that did not establish a missing login', async () => {
        current.instances[0] = createAssistantInstance({
            state: 'error',
            auth: 'unknown',
            message: 'Codex did not start within 10 seconds.',
            canSignIn: true,
        });
        const host = mount();
        await settle();
        expect(host.textContent).toContain('Codex did not start within 10 seconds.');
        expect([...host.querySelectorAll('button')].some(candidate => candidate.textContent?.includes('assistant.signIn'))).toBe(false);
    });

    it('refreshes the selected instance and exposes install and device-code sign-in', async () => {
        current.instances[0] = createAssistantInstance({
            state: 'error',
            auth: 'unauthenticated',
            message: 'EXACT transport\nfailed',
            canInstall: true,
            canSignIn: true,
        });
        const host = mount();
        await settle();
        button(host, 'assistant.refresh').click();
        await settle();
        expect(api.getAssistantState).toHaveBeenLastCalledWith({
            scope,
            selection,
            probe: true,
        });
        expect(host.querySelector('.provider-message')?.textContent).toContain('EXACT transport\nfailed');
        button(host, 'assistant.installCodex').click();
        await settle();
        expect(api.installAssistantCodex).toHaveBeenCalled();
        button(host, 'assistant.signInDeviceCode').click();
        await settle();
        expect(api.startAssistantLogin).toHaveBeenCalledWith({
            instanceId: 'codex',
            mode: 'device-code',
        });
    });

    it('applies current-session upserts/deltas/turns and ignores other keys', async () => {
        const host = mount();
        await settle();
        listener({
            type: 'item',
            sessionKey: 'other:a',
            item: item('other', 'assistant', 'WRONG'),
        });
        listener({
            type: 'item',
            sessionKey: 'codex:a',
            item: item('answer', 'assistant', 'Hello'),
        });
        listener({
            type: 'item-delta',
            sessionKey: 'codex:a',
            itemId: 'answer',
            delta: ' world',
        });
        await settle();
        expect(host.textContent).toContain('Hello world');
        listener({
            type: 'item',
            sessionKey: 'codex:a',
            item: item('answer', 'assistant', 'Replaced answer'),
        });
        listener({
            type: 'turn',
            sessionKey: 'codex:a',
            turn: {
                id: 'turn',
                phase: 'thinking',
                startedAtMs: Date.now() - 4000,
                usage: null,
            },
        });
        await settle();
        expect(host.textContent).toContain('Replaced answer');
        expect(host.textContent).not.toContain('WRONG');
        expect(host.querySelectorAll('.assistant-message')).toHaveLength(1);
        expect(host.textContent).toContain('assistant.workingFor');
        listener({
            type: 'turn',
            sessionKey: 'other:a',
            turn: null,
        });
        await settle();
        expect(host.querySelector('.timeline-working')).not.toBeNull();
        unmounts.pop()?.();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('sends a draft as a steer while running and shows Stop only for an empty composer', async () => {
        current.chat = {
            ...chat(),
            turn: {
                id: 'turn',
                phase: 'streaming',
                startedAtMs: Date.now(),
                usage: null,
            },
        };
        const host = mount();
        await settle();
        button(host, 'assistant.stop').click();
        await settle();
        expect(api.interruptAssistant).toHaveBeenCalledWith({
            scope,
            instanceId: 'codex',
        });
        await draft(host, 'Use page 2');
        button(host, 'assistant.sendSteer').click();
        await settle();
        expect(api.sendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'Use page 2' }));
    });

    it('retries the failed turn with its own message and keeps the draft being typed', async () => {
        current.chat = chat([
            item('first', 'user', 'First question', {turnId: 'turn-1'}),
            item('first-failure', 'system', 'First failed', {
                turnId: 'turn-1',
                status: 'failed',
                errorEnvelope: envelope('First failed', true),
            }),
            item('second', 'user', 'Second question', {turnId: 'turn-2'}),
            item('second-reply', 'assistant', 'Answer', {turnId: 'turn-2'}),
        ]);
        const host = mount();
        await settle();
        await draft(host, 'Half-typed follow-up');
        button(host, 'assistant.turnRetry').click();
        await settle();
        expect(api.sendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({text: 'First question'}));
        expect((host.querySelector('.composer-input') as HTMLTextAreaElement).value).toBe('Half-typed follow-up');
    });

    it('does not retry another turn when the failed turn has no message left', async () => {
        current.chat = chat([
            item('orphan-failure', 'system', 'Old failure', {
                turnId: 'trimmed-turn',
                status: 'failed',
                errorEnvelope: envelope('Old failure', true),
            }),
            item('newer', 'user', 'Newer question', {turnId: 'turn-2'}),
        ]);
        const host = mount();
        await settle();
        button(host, 'assistant.turnRetry').click();
        await settle();
        expect(api.sendAssistantMessage).not.toHaveBeenCalled();
    });

    it('shows a failed reply once in the timeline and never also toasts it', async () => {
        const host = mount();
        await settle();
        api.sendAssistantMessage.mockImplementation(async () => ({
            ok: false,
            state: {
                ...current,
                chat: chat([item('failure', 'system', 'Fallback', {
                    status: 'failed',
                    errorEnvelope: envelope('Exact provider failure', true),
                })]),
            },
            error: envelope('Exact provider failure', true),
        }));
        await draft(host, 'Try this');
        button(host, 'assistant.send').click();
        await settle();
        expect(host.querySelectorAll('.timeline-error')).toHaveLength(1);
        expect(host.querySelector('.timeline-error')?.textContent).toContain('Exact provider failure');
        expect(api.reportRuntimeError).not.toHaveBeenCalled();
    });

    it('retains a pushed failure when the returned snapshot predates it', async () => {
        const host = mount();
        await settle();
        api.sendAssistantMessage.mockImplementation(async () => {
            const old = createAssistantState({ chat: chat() });
            listener({
                type: 'item',
                sessionKey: 'codex:a',
                item: item('pushed-error', 'system', '', {
                    status: 'failed',
                    errorEnvelope: envelope('Pushed provider failure', true),
                }),
            });
            return {
                ok: false,
                state: old,
                error: envelope('Pushed provider failure', true),
            };
        });
        await draft(host, 'Try this');
        button(host, 'assistant.send').click();
        await settle();
        expect(host.querySelectorAll('.timeline-error')).toHaveLength(1);
        expect(host.querySelector('.timeline-error')?.textContent).toContain('Pushed provider failure');
        expect(api.reportRuntimeError).not.toHaveBeenCalled();
    });

    it('toasts refused sends only when there is no new system reply', async () => {
        api.sendAssistantMessage.mockResolvedValue({
            ok: false,
            state: current,
            error: envelope('Another document is busy', false),
        });
        const host = mount();
        await settle();
        await draft(host, 'Try this');
        button(host, 'assistant.send').click();
        await settle();
        expect(host.querySelector('.timeline-error')).toBeNull();
        expect(api.reportRuntimeError).toHaveBeenCalledOnce();
        expect(api.reportRuntimeError).toHaveBeenCalledWith(expect.objectContaining({ description: 'Another document is busy' }));
        expect(host.querySelector('textarea')?.value).toBe('Try this');
    });

    it('retries only retryable errors with the last user text and original images, and treats completed system rows as notices', async () => {
        const attachments = [{
            type: 'image' as const,
            id: 'image',
            name: 'page.png',
            mimeType: 'image/png' as const,
            sizeBytes: 1,
            dataUrl: 'data:image/png;base64,AA==',
        }];
        current.chat = chat([
            item('user', 'user', 'Read this', { attachments }),
            item('error', 'system', 'Fallback', {
                status: 'failed',
                errorEnvelope: envelope('Retry this failure', true),
            }),
            item('notice', 'system', 'Starts with a fresh context'),
        ]);
        const host = mount();
        await settle();
        expect(host.querySelectorAll('.timeline-error button')).toHaveLength(1);
        expect(host.querySelector('.timeline-notice')?.textContent).toContain('Starts with a fresh context');
        button(host, 'assistant.turnRetry').click();
        await settle();
        expect(api.sendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
            text: 'Read this',
            attachments,
        }));
    });

    it('migrates the old selection and persists model/effort/speed under v2', async () => {
        localStorage.setItem(STORAGE_KEYS.ASSISTANT_SELECTION_LEGACY, JSON.stringify({
            provider: 'claude',
            model: 'sonnet',
        }));
        current = createAssistantState({
            instances: [createAssistantInstance({
                id: 'claude',
                driver: 'claude',
                defaultModel: 'sonnet',
                models: [{
                    id: 'sonnet',
                    label: 'Sonnet',
                }],
            })],
            selection: null,
        });
        const host = mount();
        await settle();
        expect(host.querySelector('.picker-trigger')?.textContent).toContain('Sonnet');
        expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.ASSISTANT_SELECTION) ?? 'null')).toMatchObject({
            instanceId: 'claude',
            model: 'sonnet',
            speedMode: 'standard',
        });
    });

    it('falls back from a removed instance/model to the main selection and default model', async () => {
        localStorage.setItem(STORAGE_KEYS.ASSISTANT_SELECTION, JSON.stringify({
            ...selection,
            instanceId: 'removed',
            model: 'old',
        }));
        const host = mount();
        await settle();
        expect(host.querySelector('.picker-trigger')?.textContent).toContain('GPT');
        expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.ASSISTANT_SELECTION) ?? 'null')).toEqual(selection);
    });

    it('shows auth reasons and hides disabled instances in the picker', async () => {
        current.instances[0] = createAssistantInstance({
            auth: 'unauthenticated',
            message: 'Real sign-in reason',
            canSignIn: true,
            state: 'warning',
        });
        current.instances.push(createAssistantInstance({
            id: 'disabled',
            label: 'HIDDEN',
            enabled: false,
            state: 'disabled',
        }));
        const host = mount();
        await settle();
        await draft(host, 'hello');
        expect(host.querySelector('.composer-send')?.getAttribute('aria-label')).toBe('Real sign-in reason');
        expect(host.querySelector<HTMLButtonElement>('.composer-send')?.disabled).toBe(true);
        expect(host.querySelector('.provider-picker')?.textContent).not.toContain('HIDDEN');
    });

    it('switches instance/model/effort/speed atomically through the picker and sends its selection', async () => {
        current.instances.push(createAssistantInstance({
            id: 'codex-b',
            label: 'B',
            state: 'warning',
            message: 'B warning',
            models: [{
                id: 'gpt-b',
                label: 'GPT B',
                reasoningEfforts: [
                    {
                        id: 'low',
                        label: 'Low',
                    },
                    {
                        id: 'high',
                        label: 'High',
                    },
                ],
                defaultReasoningEffort: 'high',
                serviceTiers: [{
                    id: 'priority',
                    label: 'Fast',
                }],
            }],
            defaultModel: 'gpt-b',
        }));
        const host = mount();
        await settle();
        button(host, 'GPT B').click();
        await settle();
        const effort = host.querySelector<HTMLInputElement>('input[name$="-effort"]');
        effort?.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        const fast = [...host.querySelectorAll<HTMLInputElement>('input[name$="-speed"]')].at(-1);
        fast?.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(host.querySelector('.picker-trigger')?.textContent).toContain('B · GPT B · low');
        expect(host.querySelector('.provider-banner')?.textContent).toContain('B warning');
        await draft(host, 'Use B');
        button(host, 'assistant.send').click();
        await settle();
        expect(api.sendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({selection: {
            instanceId: 'codex-b',
            model: 'gpt-b',
            effort: 'low',
            speedMode: 'fast',
        }}));
    });

    it('keeps image-only retries and the image preview gallery', async () => {
        const attachments = [
            'one',
            'two',
        ].map(id => ({
            type: 'image' as const,
            id,
            name: id + '.png',
            mimeType: 'image/png' as const,
            sizeBytes: 1,
            dataUrl: 'data:image/png;base64,AA==',
        }));
        current.chat = chat([
            item('user', 'user', '', { attachments }),
            item('error', 'system', 'Retry', {
                status: 'failed',
                errorEnvelope: envelope('Retry', true),
            }),
        ]);
        const host = mount();
        await settle();
        host.querySelector<HTMLButtonElement>('.message-images button')?.click();
        await settle();
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('one.png');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
        await settle();
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('two.png');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await settle();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        button(host, 'assistant.turnRetry').click();
        await settle();
        expect(api.sendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
            text: '',
            attachments,
        }));
    });

    it('retains the committed document and draft through a pending scope handoff', async () => {
        current.chat = chat([item('answer', 'assistant', 'Existing answer')]);
        const props = reactive({
            chatScope: scope,
            isChatScopePending: false,
        });
        const host = mount(AgentAssistantPanel, props);
        await settle();
        await draft(host, 'Keep this draft');
        props.isChatScopePending = true;
        await settle();
        expect(host.textContent).toContain('Existing answer');
        expect(host.querySelector('textarea')?.value).toBe('Keep this draft');
        expect(host.querySelector('.composer-send')?.getAttribute('aria-label')).toBe('assistant.documentPending');
        props.isChatScopePending = false;
        await settle();
        expect(host.querySelector('textarea')?.value).toBe('Keep this draft');
    });

    it('drops stale snapshots after switching scope', async () => {
        const first = Promise.withResolvers<IAssistantState>();
        api.getAssistantState.mockReturnValueOnce(first.promise);
        const props = reactive({ chatScope: scope });
        const host = mount(AgentAssistantPanel, props);
        props.chatScope = {
            ...scope,
            key: 'b',
        };
        current.chat = {
            ...chat([item('b', 'assistant', 'New document')]),
            scope: props.chatScope,
            sessionKey: 'codex:b',
        };
        await settle();
        first.resolve(createAssistantState({ chat: chat([item('a', 'assistant', 'STALE')]) }));
        await settle();
        expect(host.textContent).not.toContain('STALE');
        expect(host.textContent).toContain('New document');
    });
});

describe('composer keyboard and picker', () => {
    it('handles IME, Shift+Enter and ordinary Enter without disabling draft editing during work', async () => {
        const submit = vi.fn();
        const host = mount(AssistantComposer, {
            modelValue: 'Hello',
            images: [],
            instances: current.instances,
            selection,
            sendDisabledReason: '',
            running: true,
            interrupting: false,
            hasDocument: true,
            error: '',
            onSubmit: submit,
        });
        const input = host.querySelector('textarea');
        input?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            isComposing: true,
        }));
        input?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            shiftKey: true,
        }));
        input?.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            keyCode: 229,
        }));
        expect(submit).not.toHaveBeenCalled();
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(submit).toHaveBeenCalledOnce();
        expect(input?.disabled).toBe(false);
    });
});

describe('timeline presentation and following', () => {
    it('groups only contiguous work within one turn and preserves interrupted text', async () => {
        const items = [
            item('user', 'user', 'Question'),
            item('think', 'reasoning', 'Reasoning'),
            item('tool', 'tool', '', {
                toolName: 'read_page',
                toolDetail: 'Page two',
            }),
            item('answer', 'assistant', '**Partial**', { status: 'interrupted' }),
            item('tool2', 'tool', '', { toolName: 'search' }),
        ];
        const host = mount(AssistantTimeline, {
            sessionKey: 'codex:a',
            items,
            turn: null,
            running: false,
            hasDocument: true,
            error: '',
            retryable: false,
            copyIcon: () => 'i-ph-copy',
            copyLabel: () => 'Copy',
        });
        expect(host.querySelectorAll('.work-group')).toHaveLength(2);
        expect(host.querySelector('strong')?.textContent).toBe('Partial');
        expect(host.textContent).toContain('assistant.interrupted');
        expect(host.querySelector('.work-group')?.hasAttribute('open')).toBe(false);
        expect(host.textContent).toContain('Page two');
    });

    it('releases follow on scroll and exposes a scroll-to-end action without jumping on new text', async () => {
        const props = reactive({
            sessionKey: 'codex:a',
            items: [item('answer', 'assistant', 'Answer')],
            turn: null,
            running: false,
            hasDocument: true,
            error: '',
            retryable: false,
            copyIcon: () => 'i-ph-copy',
            copyLabel: () => 'Copy',
        });
        const host = mount(AssistantTimeline, props);
        await settle();
        const viewport = host.querySelector<HTMLElement>('.assistant-timeline');
        if (!viewport) throw new Error('Missing viewport');
        Object.defineProperties(viewport, {
            scrollHeight: {
                configurable: true,
                value: 1200,
            },
            clientHeight: {
                configurable: true,
                value: 400,
            },
        });
        viewport.scrollTop = 100;
        viewport.dispatchEvent(new Event('scroll'));
        await settle();
        props.items.push(item('next', 'assistant', 'More text'));
        await settle();
        expect(viewport.scrollTop).toBe(100);
        button(host, 'assistant.scrollToEnd').click();
        expect(viewport.scrollTop).toBe(1200);
    });
});
