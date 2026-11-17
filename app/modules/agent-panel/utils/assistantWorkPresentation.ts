import type {
    IAssistantItem, TAssistantItemStatus,
} from '@contracts/assistant';

/*
 * Work-row presentation, adapted from T3 Code
 * packages/client-runtime/src/work-log/presentation.ts@0b6f482dc5 (MIT, T3 Tools Inc.):
 * a row's own lifecycle chooses both its icon and its verb, and a finished group is
 * named by its most telling action, with the step count as secondary text.
 */

export type TAssistantWorkState = 'running' | 'completed' | 'failed' | 'interrupted';

// EVB's own MCP tool names (electron/features/agent/mcp/mcpToolDefinitions.ts) and the
// Codex item types the service reports as tools. Anything else is a generic tool.
const TOOL_KINDS = {
    evb_workspace_snapshot: 'workspace',
    evb_viewer_open_documents: 'workspace',
    evb_document_readiness: 'inspect',
    evb_inspect_document_text: 'inspect',
    evb_job_status: 'inspect',
    evb_read_document_pages: 'read',
    evb_read_resource: 'read',
    evb_search_document: 'search',
    evb_viewer_search_open_document: 'search',
    evb_activate_tab: 'navigate',
    evb_go_to_page: 'navigate',
    evb_list_capabilities: 'capabilities',
    evb_describe_capability: 'capabilities',
    evb_read_action: 'preview',
    evb_run_action: 'action',
    webSearch: 'web',
} as const;

type TWorkKind = typeof TOOL_KINDS[keyof typeof TOOL_KINDS] | 'tool' | 'reasoning';

const LABEL_KEYS = {
    workspace: ['assistant.work.workspaceActive', 'assistant.work.workspaceDone'],
    inspect: ['assistant.work.inspectActive', 'assistant.work.inspectDone'],
    read: ['assistant.work.readActive', 'assistant.work.readDone'],
    search: ['assistant.work.searchActive', 'assistant.work.searchDone'],
    navigate: ['assistant.work.navigateActive', 'assistant.work.navigateDone'],
    capabilities: ['assistant.work.capabilitiesActive', 'assistant.work.capabilitiesDone'],
    preview: ['assistant.work.previewActive', 'assistant.work.previewDone'],
    action: ['assistant.work.actionActive', 'assistant.work.actionDone'],
    web: ['assistant.work.webActive', 'assistant.work.webDone'],
    tool: ['assistant.work.toolActive', 'assistant.work.toolDone'],
    reasoning: ['assistant.work.reasoningActive', 'assistant.work.reasoningDone'],
} as const satisfies Record<TWorkKind, readonly [string, string]>;

// A finished group is named by the action that changed or showed the most.
const SUMMARY_PRIORITY: readonly TWorkKind[] = [
    'action',
    'preview',
    'navigate',
    'search',
    'read',
    'inspect',
    'workspace',
    'capabilities',
    'web',
    'tool',
    'reasoning',
];

const STATUS_KEYS = {
    running: null,
    completed: null,
    failed: 'assistant.toolPhaseFailed',
    interrupted: 'assistant.interrupted',
} as const satisfies Record<TAssistantWorkState, string | null>;

export const ASSISTANT_WORK_ICONS = {
    running: 'i-ph-circle-notch',
    completed: 'i-ph-check',
    failed: 'i-ph-warning-circle',
    interrupted: 'i-ph-stop-circle',
} as const satisfies Record<TAssistantWorkState, string>;

function workState(status: TAssistantItemStatus): TAssistantWorkState {
    return status === 'streaming' ? 'running' : status;
}

function workKind(item: IAssistantItem): TWorkKind {
    if (item.kind === 'reasoning') return 'reasoning';
    // Claude reports MCP tools as mcp__<server>__<tool>.
    const name = item.toolName?.split('__').at(-1) ?? '';
    return Object.hasOwn(TOOL_KINDS, name) ? TOOL_KINDS[name as keyof typeof TOOL_KINDS] : 'tool';
}

function present(kind: TWorkKind, state: TAssistantWorkState) {
    return {
        state,
        labelKey: LABEL_KEYS[kind][state === 'running' ? 0 : 1],
        statusKey: STATUS_KEYS[state],
    };
}

export function describeAssistantWorkItem(item: IAssistantItem) {
    return present(workKind(item), workState(item.status));
}

/** The group's row: the live action while one runs, else its failure, else its most telling action. */
export function summarizeAssistantWork(items: readonly IAssistantItem[]) {
    const running = items.findLast(item => item.status === 'streaming');
    if (running) return present(workKind(running), 'running');
    const failed = items.find(item => item.status === 'failed');
    if (failed) return present(workKind(failed), 'failed');
    const kinds = new Set(items.map(workKind));
    const kind = SUMMARY_PRIORITY.find(candidate => kinds.has(candidate)) ?? 'tool';
    return present(kind, items.some(item => item.status === 'interrupted') ? 'interrupted' : 'completed');
}
