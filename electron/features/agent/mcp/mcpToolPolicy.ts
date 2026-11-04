import { isRecord } from '@contracts/runtimeGuards';
import type { IAgentCapabilityTemplate } from '@electron/features/agent/mcp/mcpDefinitions';
import type {
    IProcessMcpRequestOptions,
    TMcpCallerKind,
} from '@electron/features/agent/mcp/mcpServerCoreTypes';

export const ASSISTANT_MCP_TOOL_HANDLER_NAMES = [
    'evb_list_capabilities',
    'evb_describe_capability',
    'evb_read_resource',
    'evb_run_action',
    'evb_read_action',
    'evb_job_status',
    'evb_workspace_snapshot',
    'evb_viewer_open_documents',
    'evb_document_readiness',
    'evb_inspect_document_text',
    'evb_search_document',
    'evb_viewer_search_open_document',
    'evb_read_document_pages',
    'evb_activate_tab',
    'evb_go_to_page',
] as const;

export function getMcpCallerKind(options: IProcessMcpRequestOptions): TMcpCallerKind {
    return options.callerKind ?? 'internal';
}

export function enforceCapabilityPolicy(
    template: IAgentCapabilityTemplate,
    options: IProcessMcpRequestOptions,
    action: {
        input?: Record<string, unknown> | undefined;
        dryRun?: boolean | undefined
    } = {},
) {
    const callerKind = getMcpCallerKind(options);
    const input = action.input ?? {};
    const bookmark = isRecord(input.bookmark) ? input.bookmark : input;
    const replacesBookmarks = template.id === 'bookmarks.set_tree'
        || template.id === 'bookmarks.apply_plan'
        || template.id === 'bookmarks.update' && (
            Array.isArray(bookmark.items) || Array.isArray(bookmark.children)
        );
    const policy = template.policy[callerKind];
    const decision = policy === 'allow' && !action.dryRun && replacesBookmarks
        ? 'confirm'
        : policy;
    if (decision === 'allow') {
        return;
    }
    if (decision === 'confirm') {
        throw new Error(`Capability ${template.id} requires explicit user confirmation for ${callerKind} MCP callers.`);
    }
    throw new Error(`Capability ${template.id} is not allowed for ${callerKind} MCP callers.`);
}

export function enforceReadActionToolPolicy(template: IAgentCapabilityTemplate) {
    if (template.risk !== 'read') {
        throw new Error(`Capability ${template.id} is ${template.risk}; use evb_run_action for non-read capabilities.`);
    }
}
