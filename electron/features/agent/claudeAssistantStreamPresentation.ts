import type {
    SDKAssistantMessage,
    SDKResultMessage,
    SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { IAgentAssistantTokenUsage } from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';

export interface IClaudeAssistantToolActivity {
    toolId: string;
    name: string;
    phase: 'running' | 'completed' | 'failed';
}

// Adapted from T3 Code ClaudeAdapterV2.ts (0b6f482dc5), MIT:
// assistantTextFromSdkMessage and claudeToolResultEntriesFromMessage.
export function extractClaudeMessageItems(message: SDKAssistantMessage | SDKUserMessage) {
    const content = message.message.content;
    if (!Array.isArray(content)) {
        return [];
    }
    const text = content.flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n\n');
    let emittedText = false;
    return content.flatMap((block): (IClaudeAssistantToolActivity | {messageId: string; text: string})[] => {
        if (!isRecord(block)) {
            return [];
        }
        if (message.type === 'assistant' && block.type === 'text' && text && !emittedText) {
            emittedText = true;
            return [{messageId: message.uuid, text}];
        }
        if (message.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
            return [{
                toolId: block.id,
                name: typeof block.name === 'string' && block.name.trim() ? block.name : 'tool',
                phase: 'running',
            }];
        }
        return block.type === 'tool_result' && typeof block.tool_use_id === 'string' ? [{
            toolId: block.tool_use_id,
            name: 'tool',
            phase: block.is_error === true ? 'failed' : 'completed',
        }] : [];
    });
}

export function extractClaudeTokenUsage(message: SDKResultMessage): IAgentAssistantTokenUsage {
    const usage = message.usage;
    const cachedInputTokens = usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
    return {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        ...(cachedInputTokens > 0 ? {cachedInputTokens} : {}),
    };
}
