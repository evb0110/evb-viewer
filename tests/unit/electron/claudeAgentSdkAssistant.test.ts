import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ClaudeAgentAssistantSession,
    normalizeClaudeSdkModelList,
    shouldRefuseClaudeContextContinuation,
} from '@electron/features/agent/claudeAgentSdkAssistant';
import {
    getClaudeAgentSdkInfo,
    getClaudeAssistantModelLabel,
    normalizeClaudeAssistantModel,
    shouldUseClaudeAssistantFastMode,
} from '@electron/features/agent/claudeProviderMetadata';

const sdkMocks = vi.hoisted(() => ({query: vi.fn()}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdkMocks.query }));

vi.mock('electron', () => ({ app: { getVersion: () => 'test' } }));

vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}) }));

class FakeClaudeQuery {
    private readonly messages: unknown[] = [];
    private readonly resolvers: Array<(value: IteratorResult<unknown>) => void> = [];
    private closed = false;

    readonly accountInfo = vi.fn(async () => null);
    readonly supportedModels = vi.fn(async () => []);
    readonly setModel = vi.fn(async () => undefined);
    readonly interrupt = vi.fn(async () => undefined);
    readonly close = vi.fn(() => {
        this.closed = true;
        while (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift();
            resolve?.({
                value: undefined,
                done: true,
            });
        }
    });

    push(message: unknown) {
        const resolver = this.resolvers.shift();
        if (resolver) {
            resolver({
                value: message,
                done: false,
            });
            return;
        }
        this.messages.push(message);
    }

    [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {next: () => {
            if (this.closed) {
                return Promise.resolve({
                    value: undefined,
                    done: true,
                });
            }
            const message = this.messages.shift();
            if (message) {
                return Promise.resolve({
                    value: message,
                    done: false,
                });
            }
            return new Promise<IteratorResult<unknown>>(resolve => this.resolvers.push(resolve));
        }};
    }
}

async function settleAsyncTicks(count = 3) {
    for (let index = 0; index < count; index += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

describe('claudeAgentSdkAssistant', () => {
    beforeEach(() => {
        sdkMocks.query.mockReset();
    });

    it('keeps full versioned Claude model ids and labels known ids', () => {
        expect(normalizeClaudeAssistantModel('fable-5.1')).toBe('fable');
        expect(normalizeClaudeAssistantModel('claude-fable-5.1')).toBe('fable');
        expect(normalizeClaudeAssistantModel('claude-fable-5-1')).toBe('claude-fable-5-1');
        expect(normalizeClaudeAssistantModel('opus-5')).toBe('opus');
        expect(normalizeClaudeAssistantModel('claude-opus-5')).toBe('claude-opus-5');
        expect(normalizeClaudeAssistantModel('claude-opus-5.0')).toBe('opus');
        expect(normalizeClaudeAssistantModel('claude-opus-4-8')).toBe('claude-opus-4-8');
        expect(normalizeClaudeAssistantModel(' claude-fable-5 ')).toBe('claude-fable-5');
        expect(normalizeClaudeAssistantModel('global.anthropic.claude-fable-5')).toBe('global.anthropic.claude-fable-5');
        expect(normalizeClaudeAssistantModel('anthropic.claude-fable-5')).toBe('fable');
        expect(getClaudeAssistantModelLabel('fable')).toBe('Claude Fable 5.1');
        expect(getClaudeAssistantModelLabel('claude-fable-5-1')).toBe('Claude Fable 5.1');
        expect(getClaudeAssistantModelLabel('opus')).toBe('Claude Opus 5');
        expect(getClaudeAssistantModelLabel('claude-opus-5')).toBe('Claude Opus 5');
        expect(getClaudeAssistantModelLabel('claude-opus-4-8')).toBe('Claude Opus 4.8');
        expect(getClaudeAssistantModelLabel('anthropic.claude-fable-5')).toBe('Claude Fable 5');
        expect(getClaudeAssistantModelLabel('anthropic.claude-opus-4-8')).toBe('Claude Opus 4.8');
        expect(getClaudeAssistantModelLabel('anthropic.claude-opus-4-7')).toBe('Claude Opus 4.7');
        expect(getClaudeAssistantModelLabel('anthropic.claude-opus-4-6')).toBe('Claude Opus 4.6');
        expect(getClaudeAssistantModelLabel('anthropic.claude-sonnet-4-6')).toBe('Claude Sonnet 4.6');
        expect(getClaudeAssistantModelLabel('anthropic.claude-sonnet-4-5')).toBe('Claude Sonnet 4.5');
        expect(getClaudeAssistantModelLabel('anthropic.claude-haiku-4-5')).toBe('Claude Haiku 4.5');
        expect(getClaudeAssistantModelLabel('anthropic.claude-haiku-4-5-20251001')).toBe('Claude Haiku 4.5');
    });

    it('enables Claude fast mode only for Opus-family models', () => {
        expect(shouldUseClaudeAssistantFastMode('opus', 'fast')).toBe(true);
        expect(shouldUseClaudeAssistantFastMode('opus-5', 'fast')).toBe(true);
        expect(shouldUseClaudeAssistantFastMode('claude-opus-5', 'fast')).toBe(true);
        expect(shouldUseClaudeAssistantFastMode('claude-opus-4-8', 'fast')).toBe(true);
        expect(shouldUseClaudeAssistantFastMode('global.anthropic.claude-opus-4-8', 'fast')).toBe(true);
        expect(shouldUseClaudeAssistantFastMode('claude-sonnet-4-6', 'fast')).toBe(false);
        expect(shouldUseClaudeAssistantFastMode('claude-opus-4-8', 'standard')).toBe(false);
    });

    it('normalizes Claude SDK supportedModels metadata', () => {
        expect(normalizeClaudeSdkModelList([
            {
                value: 'claude-fable-5-1',
                displayName: 'Claude Fable 5.1 Runtime',
                description: 'Highest capability',
            },
            {
                value: 'claude-fable-5-1',
                displayName: 'Duplicate',
            },
            {
                value: 'claude-sonnet-5',
                displayName: '',
            },
            {
                value: '',
                displayName: 'Blank',
            },
        ])).toEqual([
            {
                id: 'claude-fable-5-1',
                label: 'Claude Fable 5.1 Runtime',
            },
            {
                id: 'claude-sonnet-5',
                label: 'Claude Sonnet 5',
            },
        ]);
        expect(normalizeClaudeSdkModelList({data: []})).toEqual([]);
    });

    it('refuses continuation when display history has no provider-owned context', () => {
        expect(shouldRefuseClaudeContextContinuation(1, null)).toBe(true);
        expect(shouldRefuseClaudeContextContinuation(1, '')).toBe(true);
        expect(shouldRefuseClaudeContextContinuation(1, 'provider-session')).toBe(false);
        expect(shouldRefuseClaudeContextContinuation(0, null)).toBe(false);
    });

    it('does not fail setup when SDK package metadata is missing but env CLI exists', async () => {
        const result = await getClaudeAgentSdkInfo({
            env: {CLAUDE_CODE_PATH: '/opt/claude/bin/claude'},
            resolveSdkPackageDir: () => {
                throw new Error('Cannot find module @anthropic-ai/claude-agent-sdk');
            },
            findClaudeOnPath: vi.fn(async () => null),
            pathIsExecutable: vi.fn(async path => path === '/opt/claude/bin/claude'),
        });

        expect(result).toEqual({
            installed: true,
            version: null,
            executablePath: '/opt/claude/bin/claude',
        });
    });

    it('finds user-local Claude CLI when packaged metadata and GUI launch PATH are sparse', async () => {
        const result = await getClaudeAgentSdkInfo({
            env: {
                HOME: '/Users/test',
                PATH: '/usr/bin:/bin',
            },
            resolveSdkPackageDir: () => {
                throw new Error('Cannot find module @anthropic-ai/claude-agent-sdk');
            },
            pathIsExecutable: vi.fn(async path => path === '/Users/test/.local/bin/claude'),
        });

        expect(result).toEqual({
            installed: true,
            version: null,
            executablePath: '/Users/test/.local/bin/claude',
        });
    });

    it('reports an actionable missing Claude CLI error when package metadata is unavailable', async () => {
        const result = await getClaudeAgentSdkInfo({
            env: {},
            resolveSdkPackageDir: () => {
                throw new Error('Cannot find module @anthropic-ai/claude-agent-sdk');
            },
            findClaudeOnPath: vi.fn(async () => null),
            pathIsExecutable: vi.fn(async () => false),
        });

        expect(result).toEqual({
            installed: false,
            version: null,
            executablePath: null,
            error: 'Claude Code executable was not found. Install Claude Code or set CLAUDE_CODE_PATH to a local claude executable.',
        });
    });

    it('reports the bundled Claude executable and SDK version through the shared metadata helper', async () => {
        const result = await getClaudeAgentSdkInfo({
            env: {},
            resolveSdkPackageDir: () => '/sdk',
            readSdkVersion: vi.fn(async () => '1.2.3'),
            findClaudeOnPath: vi.fn(async () => null),
            findBundledClaudeExecutable: vi.fn(async () => '/sdk-native/claude'),
            pathIsExecutable: vi.fn(async path => path === '/sdk-native/claude'),
        });

        expect(result).toEqual({
            installed: true,
            version: '1.2.3',
            executablePath: '/sdk-native/claude',
        });
    });

    it('includes the active turn id on assistant deltas, messages, and errors', async () => {
        const fakeQuery = new FakeClaudeQuery();
        sdkMocks.query.mockReturnValue(fakeQuery);
        const callbacks = {
            onInitialized: vi.fn(),
            onTurnStarted: vi.fn(),
            onAssistantDelta: vi.fn(),
            onReasoningDelta: vi.fn(),
            onToolActivity: vi.fn(),
            onUsage: vi.fn(),
            onAssistantMessage: vi.fn(),
            onTurnCompleted: vi.fn(),
            onError: vi.fn(),
        };
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'low',
            speedMode: 'standard',
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            callbacks,
        });

        const turnId = await session.sendMessage('Hello', [], 'opus');
        fakeQuery.push({
            type: 'stream_event',
            event: {
                type: 'content_block_delta',
                delta: {
                    type: 'text_delta',
                    text: 'Hi',
                },
            },
        });
        fakeQuery.push({
            type: 'stream_event',
            event: {
                type: 'content_block_delta',
                delta: {
                    type: 'thinking_delta',
                    thinking: 'First inspect the document.',
                },
            },
        });
        fakeQuery.push({
            type: 'assistant',
            message: { content: [{
                type: 'text',
                text: 'Hi there',
            }] },
        });
        fakeQuery.push({
            type: 'assistant',
            message: { content: [{
                type: 'tool_use',
                id: 'tool-1',
                name: 'mcp__evb_viewer_embedded__evb_run_action',
                input: {},
            }] },
        });
        fakeQuery.push({
            type: 'tool_progress',
            tool_use_id: 'tool-1',
            tool_name: 'mcp__evb_viewer_embedded__evb_run_action',
            elapsed_time_seconds: 1,
        });
        fakeQuery.push({
            type: 'tool_use_summary',
            summary: 'Done',
            preceding_tool_use_ids: ['tool-1'],
        });
        fakeQuery.push({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            usage: {
                input_tokens: 13,
                output_tokens: 8,
                cache_read_input_tokens: 5,
                cache_creation_input_tokens: 2,
            },
            result: 'Claude exploded politely.',
        });
        await settleAsyncTicks();

        expect(callbacks.onTurnStarted).toHaveBeenCalledWith(turnId);
        expect(callbacks.onAssistantDelta).toHaveBeenCalledWith(turnId, expect.any(String), 'Hi');
        expect(callbacks.onReasoningDelta).toHaveBeenCalledWith(turnId, 'First inspect the document.');
        expect(callbacks.onAssistantMessage).toHaveBeenCalledWith(turnId, expect.any(String), 'Hi there', true);
        expect(callbacks.onToolActivity).toHaveBeenCalledWith(turnId, {
            toolId: 'tool-1',
            name: 'mcp__evb_viewer_embedded__evb_run_action',
            phase: 'running',
        });
        expect(callbacks.onToolActivity).toHaveBeenCalledWith(turnId, {
            toolId: 'tool-1',
            name: 'mcp__evb_viewer_embedded__evb_run_action',
            phase: 'completed',
        });
        expect(callbacks.onUsage).toHaveBeenCalledWith(turnId, {
            inputTokens: 13,
            outputTokens: 8,
            cachedInputTokens: 7,
        });
        expect(callbacks.onError).toHaveBeenCalledWith(turnId, 'Claude exploded politely.');
    });

    it('awaits the consume-stream task when closing a live Claude session', async () => {
        const fakeQuery = new FakeClaudeQuery();
        sdkMocks.query.mockReturnValue(fakeQuery);
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'low',
            speedMode: 'standard',
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            callbacks: {
                onInitialized: vi.fn(),
                onTurnStarted: vi.fn(),
                onAssistantDelta: vi.fn(),
                onReasoningDelta: vi.fn(),
                onToolActivity: vi.fn(),
                onUsage: vi.fn(),
                onAssistantMessage: vi.fn(),
                onTurnCompleted: vi.fn(),
                onError: vi.fn(),
            },
        });

        await session.sendMessage('Hello', [], 'opus');
        const queryOptions = sdkMocks.query.mock.calls[0]?.[0]?.options;
        expect(queryOptions?.mcpServers?.evb_viewer_embedded).toMatchObject({timeout: 300_000});
        expect(queryOptions?.persistSession).toBe(true);
        const closePromise = session.close();
        expect(fakeQuery.close).toHaveBeenCalledTimes(1);

        await expect(closePromise).resolves.toBeUndefined();
    });

    it('resumes the provider-owned transcript when a replacement query is created', async () => {
        const fakeQuery = new FakeClaudeQuery();
        sdkMocks.query.mockReturnValue(fakeQuery);
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'medium',
            speedMode: 'fast',
            resumeSessionId: '2c8c2b8a-6d31-4b77-a8c0-0aef9c8e2e5e',
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            callbacks: {
                onInitialized: vi.fn(),
                onTurnStarted: vi.fn(),
                onAssistantDelta: vi.fn(),
                onReasoningDelta: vi.fn(),
                onToolActivity: vi.fn(),
                onUsage: vi.fn(),
                onAssistantMessage: vi.fn(),
                onTurnCompleted: vi.fn(),
                onError: vi.fn(),
            },
        });

        await session.sendMessage('Continue', [], 'opus');

        expect(sdkMocks.query).toHaveBeenCalledWith(expect.objectContaining({options: expect.objectContaining({
            resume: '2c8c2b8a-6d31-4b77-a8c0-0aef9c8e2e5e',
            persistSession: true,
        })}));
    });

    it('retires a query when interruption fails before accepting another turn', async () => {
        const firstQuery = new FakeClaudeQuery();
        const secondQuery = new FakeClaudeQuery();
        let rejectInterrupt: ((error: Error) => void) | undefined;
        firstQuery.interrupt.mockImplementationOnce(() => new Promise((_, reject) => {
            rejectInterrupt = reject;
        }));
        sdkMocks.query.mockReturnValueOnce(firstQuery).mockReturnValueOnce(secondQuery);
        const callbacks = {
            onInitialized: vi.fn(),
            onTurnStarted: vi.fn(),
            onAssistantDelta: vi.fn(),
            onReasoningDelta: vi.fn(),
            onToolActivity: vi.fn(),
            onUsage: vi.fn(),
            onAssistantMessage: vi.fn(),
            onTurnCompleted: vi.fn(),
            onError: vi.fn(),
        };
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'low',
            speedMode: 'standard',
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            callbacks,
        });

        const firstTurnId = await session.sendMessage('A', [], 'opus');
        const interruptPromise = session.interrupt();
        firstQuery.push({
            type: 'stream_event',
            event: {
                type: 'content_block_delta',
                delta: {
                    type: 'text_delta',
                    text: 'late A',
                },
            },
        });
        firstQuery.push({
            type: 'assistant',
            message: {content: [
                {
                    type: 'text',
                    text: 'late assistant A',
                },
                {
                    type: 'tool_use',
                    id: 'late-tool',
                    name: 'mcp__evb_viewer_embedded__evb_run_action',
                    input: {},
                },
            ]},
        });
        firstQuery.push({
            type: 'tool_progress',
            tool_use_id: 'late-tool',
            tool_name: 'mcp__evb_viewer_embedded__evb_run_action',
            elapsed_time_seconds: 1,
        });
        firstQuery.push({
            type: 'result',
            subtype: 'success',
            is_error: false,
            usage: {
                input_tokens: 1,
                output_tokens: 1,
            },
        });
        await settleAsyncTicks();
        expect(rejectInterrupt).toBeTypeOf('function');
        rejectInterrupt?.(new Error('interrupt rejected'));
        await interruptPromise;

        const secondTurnId = await session.sendMessage('B', [], 'opus');
        secondQuery.push({
            type: 'stream_event',
            event: {
                type: 'content_block_delta',
                delta: {
                    type: 'text_delta',
                    text: 'B',
                },
            },
        });
        await settleAsyncTicks();

        expect(firstTurnId).not.toBe(secondTurnId);
        expect(callbacks.onAssistantDelta).toHaveBeenCalledWith(secondTurnId, expect.any(String), 'B');
        expect(callbacks.onAssistantDelta).not.toHaveBeenCalledWith(secondTurnId, expect.any(String), 'late A');
        expect(callbacks.onTurnCompleted).toHaveBeenCalledWith(firstTurnId);
        expect(sdkMocks.query).toHaveBeenCalledTimes(2);
        expect(firstQuery.close).toHaveBeenCalledTimes(1);
    });

    it('keeps an unresolved interruption marked as retiring until the query closes', async () => {
        const query = new FakeClaudeQuery();
        let resolveInterrupt: (() => void) | undefined;
        query.interrupt.mockImplementationOnce(() => new Promise<undefined>(resolve => {
            resolveInterrupt = () => resolve(undefined);
        }));
        sdkMocks.query.mockReturnValue(query);
        const callbacks = {
            onInitialized: vi.fn(),
            onTurnStarted: vi.fn(),
            onAssistantDelta: vi.fn(),
            onReasoningDelta: vi.fn(),
            onToolActivity: vi.fn(),
            onUsage: vi.fn(),
            onAssistantMessage: vi.fn(),
            onTurnCompleted: vi.fn(),
            onError: vi.fn(),
        };
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'low',
            speedMode: 'standard',
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            callbacks,
        });

        await session.sendMessage('A', [], 'opus');
        const interruptPromise = session.interrupt();
        await settleAsyncTicks();

        expect(session.isUsable).toBe(false);
        expect(session.isRetiring).toBe(true);
        expect(query.close).not.toHaveBeenCalled();
        await expect(session.sendMessage('B', [], 'opus')).rejects.toThrow(
            'Claude assistant session is still retiring a previous turn.',
        );

        resolveInterrupt?.();
        await interruptPromise;

        expect(session.isRetiring).toBe(false);
        expect(query.close).toHaveBeenCalledTimes(1);
        expect(callbacks.onTurnCompleted).toHaveBeenCalledTimes(1);
    });
});
