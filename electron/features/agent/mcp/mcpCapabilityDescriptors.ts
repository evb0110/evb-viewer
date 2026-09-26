import type {
    IAgentCapabilityDescriptor,
    IAgentCompactCapabilityDescriptor,
    IAgentTabSnapshot,
    IAgentWorkspaceSnapshot,
    TAgentCapabilityDomain,
} from '@contracts/agent';
import type { TTabId } from '@contracts/windowTabs';
import {toJsonSchema} from '@valibot/to-json-schema';
import { AGENT_CAPABILITY_DOMAINS } from '@contracts/agent';
import { isOneOf } from '@contracts/runtimeGuards';
import {
    AGENT_CAPABILITY_TEMPLATES,
    type IAgentCapabilityTemplate,
} from '@electron/features/agent/mcp/mcpDefinitions';
import {
    getOptionalTabId,
    getOptionalWindowId,
    getParamsObject,
} from '@electron/features/agent/mcp/mcpRequestParams';

const AGENT_CAPABILITY_ALIASES: Record<string, string> = {
    'document.screenshot_page': 'document.capture_page_image',
    'page_numbering.read': 'page_labels.read',
    'page_numbering.preview': 'page_labels.preview',
    'page_numbering.apply_plan': 'page_labels.apply_plan',
    'page_numbering.set_ranges': 'page_labels.set_ranges',
    'page_numbering.apply_range': 'page_labels.apply_range',
    'page_numbering.set_labels': 'page_labels.set_labels',
    'page_numbering.clear': 'page_labels.clear',
    'toc.preview_tree': 'bookmarks.preview_tree',
    'toc.apply_plan': 'bookmarks.apply_plan',
    'toc.set_tree': 'bookmarks.set_tree',
    'toc.add': 'bookmarks.add',
    'toc.add_batch': 'bookmarks.add_batch',
    'toc.update': 'bookmarks.update',
    'toc.delete': 'bookmarks.delete',
    'toc.delete_batch': 'bookmarks.delete_batch',
    'toc.set_style': 'bookmarks.set_style',
    'annotation.start_note_placement': 'annotation.create_note',
    'annotation.place_note': 'annotation.create_note_at_point',
    'annotation.set_tool': 'annotation.select_tool',
    'annotation.mark_text': 'annotation.create_text_markup',
    'annotation.draw_shape': 'annotation.create_shape',
};

interface ICapabilitySnapshotOptions { getWorkspaceSnapshot(windowId?: number): Promise<IAgentWorkspaceSnapshot>; }

function getOptionalCapabilityDomain(params: unknown): TAgentCapabilityDomain | undefined {
    const value = getParamsObject(params).domain;
    return isOneOf(AGENT_CAPABILITY_DOMAINS, value)
        ? value
        : undefined;
}

export function getRequiredCapabilityId(params: unknown) {
    const value = getParamsObject(params).id;
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('Capability id is required.');
    }
    const id = value.trim();
    return AGENT_CAPABILITY_ALIASES[id] ?? id;
}

export function getRequestedCapabilityId(params: unknown) {
    const value = getParamsObject(params).id;
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : null;
}

export function getCapabilityTemplate(id: string) {
    return AGENT_CAPABILITY_TEMPLATES.find(template => template.id === id) ?? null;
}

export function isAgentDocumentTab(tab: IAgentTabSnapshot) {
    return tab.kind !== 'empty'
        && (
            Boolean(tab.fileName)
            || Boolean(tab.originalPath)
            || tab.hasPdf === true
            || tab.isDjvu === true
        );
}

function findCapabilityTargetTab(snapshot: IAgentWorkspaceSnapshot, tabId?: TTabId) {
    const targetTabId = tabId ?? snapshot.activeTabId;
    if (!targetTabId) {
        return null;
    }
    return snapshot.tabs.find(tab => tab.tabId === targetTabId) ?? null;
}

function createCapabilityAvailability(
    template: IAgentCapabilityTemplate,
    tab: IAgentTabSnapshot | null,
) {
    if (template.availabilityKind === 'always') {
        return {available: true};
    }

    if (!tab) {
        return {
            available: false,
            reason: 'No target tab is available.',
        };
    }

    if (template.availabilityKind === 'document' && !isAgentDocumentTab(tab)) {
        return {
            available: false,
            reason: `Tab ${tab.tabId} does not have an open document.`,
        };
    }

    if ((template.availabilityKind === 'pdf' || template.availabilityKind === 'pdf-path') && tab.kind !== 'pdf') {
        return {
            available: false,
            reason: `Tab ${tab.tabId} is a ${tab.kind} document; convert/open it as PDF first.`,
        };
    }

    if (template.availabilityKind === 'pdf-path' && !tab.originalPath) {
        return {
            available: false,
            reason: `Tab ${tab.tabId} does not expose a readable PDF path yet.`,
        };
    }

    if (template.availabilityKind === 'renderer-document' || template.availabilityKind === 'renderer-pdf') {
        if (!isAgentDocumentTab(tab)) {
            return {
                available: false,
                reason: `Tab ${tab.tabId} does not have an open document.`,
            };
        }
        if (!tab.workspaceAttached) {
            return {
                available: false,
                reason: `Workspace for tab ${tab.tabId} is not attached yet.`,
            };
        }
    }

    if (template.availabilityKind === 'renderer-pdf' && tab.kind !== 'pdf') {
        return {
            available: false,
            reason: `Tab ${tab.tabId} is a ${tab.kind} document; convert/open it as PDF first.`,
        };
    }

    return {available: true};
}

function createCapabilityDescriptor(
    template: IAgentCapabilityTemplate,
    tab: IAgentTabSnapshot | null,
): IAgentCapabilityDescriptor {
    const inputSchema = toJsonSchema(template.inputSchema);
    delete inputSchema.$schema;
    return {
        id: template.id,
        domain: template.domain,
        title: template.title,
        summary: template.summary,
        risk: template.risk,
        inputSchema: {...inputSchema},
        ...(template.outputSchema === undefined ? {} : {outputSchema: template.outputSchema}),
        policy: template.policy,
        ...(template.resourceTemplates === undefined ? {} : {resourceTemplates: template.resourceTemplates}),
        availability: createCapabilityAvailability(template, tab),
    };
}

function createCompactCapabilityDescriptor(
    template: IAgentCapabilityTemplate,
    tab: IAgentTabSnapshot | null,
): IAgentCompactCapabilityDescriptor {
    return {
        id: template.id,
        domain: template.domain,
        title: template.title,
        summary: template.summary,
        risk: template.risk,
        policy: template.policy,
        availability: createCapabilityAvailability(template, tab),
        hasInputSchema: true,
        hasOutputSchema: template.outputSchema !== undefined,
        hasResourceTemplates: template.resourceTemplates !== undefined,
    };
}

function shouldListFullCapabilities(params: unknown) {
    return getParamsObject(params).detail === 'full';
}

export async function listAgentCapabilities(params: unknown, options: ICapabilitySnapshotOptions) {
    const windowId = getOptionalWindowId(params);
    const snapshot = await options.getWorkspaceSnapshot(windowId);
    const targetTab = findCapabilityTargetTab(snapshot, getOptionalTabId(params));
    const domain = getOptionalCapabilityDomain(params);
    const full = shouldListFullCapabilities(params);
    const capabilities = AGENT_CAPABILITY_TEMPLATES
        .filter(template => domain === undefined || template.domain === domain)
        .map(template => full
            ? createCapabilityDescriptor(template, targetTab)
            : createCompactCapabilityDescriptor(template, targetTab));
    return {
        activeTabId: snapshot.activeTabId,
        targetTabId: targetTab?.tabId ?? null,
        domain: domain ?? null,
        detail: full ? 'full' : 'compact',
        capabilityCount: capabilities.length,
        capabilities,
    };
}

export async function describeAgentCapability(params: unknown, options: ICapabilitySnapshotOptions) {
    const id = getRequiredCapabilityId(params);
    const requestedId = getRequestedCapabilityId(params);
    const template = getCapabilityTemplate(id);
    if (!template) {
        throw new Error(`Unknown EVB capability: ${requestedId ?? id}`);
    }

    const windowId = getOptionalWindowId(params);
    const snapshot = await options.getWorkspaceSnapshot(windowId);
    const targetTab = findCapabilityTargetTab(snapshot, getOptionalTabId(params));
    return {
        activeTabId: snapshot.activeTabId,
        targetTabId: targetTab?.tabId ?? null,
        ...(requestedId && requestedId !== id ? {requestedId} : {}),
        capability: createCapabilityDescriptor(template, targetTab),
    };
}
