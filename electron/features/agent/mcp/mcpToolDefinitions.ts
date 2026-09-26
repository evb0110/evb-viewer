import type {
    IMcpPromptDefinition,
    IMcpResourceTemplateDefinition,
    IMcpToolDefinition,
} from '@electron/features/agent/mcp/mcpDefinitionTypes';
import { AGENT_CAPABILITY_DOMAINS } from '@contracts/agent';
import {isRecord} from '@contracts/runtimeGuards';
import * as v from 'valibot';
import {toJsonSchema} from '@valibot/to-json-schema';
import { AGENT_CAPABILITY_TEMPLATES } from '@electron/features/agent/mcp/agentCapabilityTemplates';
import type {GenericSchema} from 'valibot';

const WINDOW_ID_SCHEMA = v.pipe(
    v.number(),
    v.description('Optional Electron window id. Defaults to the focused window or main window.'),
);
const TAB_ID_SCHEMA = v.pipe(
    v.string(),
    v.description('Optional tab id. Defaults to the active tab.'),
);
const READ_ONLY_CLOSED_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};
const UI_NAVIGATION_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};
const RUN_ACTION_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
};
const INTERNAL_RUN_ACTION_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
};
const OBJECT_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: true,
};
const CAPABILITY_ID_SCHEMA = v.pipe(
    v.string(),
    v.description('Stable EVB capability id, for example document.search, document.capture_page_image, annotation.open_note, page_labels.apply_range, bookmarks.add, ocr.start, or ocr.open_popup.'),
);
const RESOURCE_URI_SCHEMA = v.pipe(
    v.string(),
    v.description('EVB resource URI such as evb://document/{tabId}/annotations, /bookmarks, /page-labels, or /toc.'),
);
const CAPABILITY_DETAIL_SCHEMA = v.pipe(
    v.picklist([
        'compact',
        'full',
    ]),
    v.description('Capability listing detail. Defaults to compact; use evb_describe_capability for full schemas when possible.'),
);
const CAPABILITY_DOMAIN_SCHEMA = v.pipe(
    v.picklist(AGENT_CAPABILITY_DOMAINS),
    v.description('Optional capability domain filter.'),
);

function toMcpJsonSchema(schema: GenericSchema): Record<string, unknown> {
    const jsonSchema = toJsonSchema(schema);
    delete jsonSchema.$schema;
    const removeEmptyRequired = (value: unknown): void => {
        if (Array.isArray(value)) {
            value.forEach(removeEmptyRequired);
        } else if (isRecord(value)) {
            if (Array.isArray(value.required) && value.required.length === 0) {
                delete value.required;
            }
            Object.values(value).forEach(removeEmptyRequired);
        }
    };
    removeEmptyRequired(jsonSchema);
    return {...jsonSchema};
}

const ACTION_VALIDATION_SCHEMA = v.strictObject({
    windowId: v.optional(WINDOW_ID_SCHEMA),
    tabId: v.optional(TAB_ID_SCHEMA),
    id: v.string(),
    input: v.optional(v.record(v.string(), v.unknown())),
    dryRun: v.optional(v.pipe(v.boolean(), v.description('Validate and preview without mutating visible app state when supported.'))),
});
const ACTION_INPUT_SCHEMA = {
    type: 'object',
    oneOf: AGENT_CAPABILITY_TEMPLATES.map((capability) => {
        const schema = toMcpJsonSchema(v.strictObject({
            windowId: v.optional(WINDOW_ID_SCHEMA),
            tabId: v.optional(TAB_ID_SCHEMA),
            id: v.literal(capability.id),
            input: v.optional(capability.inputSchema),
            dryRun: v.optional(v.pipe(v.boolean(), v.description('Validate and preview without mutating visible app state when supported.'))),
        }));
        const properties = schema.properties as Record<string, Record<string, unknown>>;
        properties.id = {
            ...toMcpJsonSchema(CAPABILITY_ID_SCHEMA),
            ...properties.id,
        };
        return schema;
    }),
};

const MCP_TOOL_SCHEMA_DEFINITIONS = [
    {
        name: 'evb_list_capabilities',
        title: 'EVB Viewer list capabilities',
        description: 'List semantic EVB Viewer capabilities for the current workspace or a specific tab. Defaults to compact descriptors; use evb_describe_capability for full schemas. Use this to discover annotation, note, bookmark, page-label, OCR, UI, file, export, page, history, search, and navigation actions without bloating the top-level MCP tool list.',
        inputSchema: v.strictObject({
            windowId: v.optional(WINDOW_ID_SCHEMA),
            tabId: v.optional(TAB_ID_SCHEMA),
            domain: v.optional(CAPABILITY_DOMAIN_SCHEMA),
            detail: v.optional(CAPABILITY_DETAIL_SCHEMA),
        }),
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_describe_capability',
        title: 'EVB Viewer describe capability',
        description: 'Describe one EVB Viewer capability, including its input schema, side-effect risk, availability, policy, and related resource templates. Call evb_list_capabilities first when the id is unknown.',
        inputSchema: v.strictObject({
            windowId: v.optional(WINDOW_ID_SCHEMA),
            tabId: v.optional(TAB_ID_SCHEMA),
            id: CAPABILITY_ID_SCHEMA,
        }),
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_read_resource',
        title: 'EVB Viewer read resource',
        description: 'Read an EVB resource URI as JSON or text. Useful resources include workspace/current, document page text, text status, annotations, notes, TOC/bookmarks, and page labels.',
        inputSchema: v.strictObject({
            windowId: v.optional(WINDOW_ID_SCHEMA),
            uri: RESOURCE_URI_SCHEMA,
        }),
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_run_action',
        title: 'EVB Viewer run action',
        description: 'Run a semantic EVB Viewer write, destructive, navigation, or long-running action by capability id. Use evb_describe_capability to inspect the expected input. For non-mutating preview/read capabilities, use evb_read_action.',
        inputSchema: ACTION_VALIDATION_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: RUN_ACTION_ANNOTATIONS,
    },
    {
        name: 'evb_read_action',
        title: 'EVB Viewer read action',
        description: 'Run a semantic EVB Viewer read-only or preview action by capability id. Use this for non-mutating capabilities such as bookmarks.preview_tree, page_labels.preview, document.search, and document.read_pages.',
        inputSchema: ACTION_VALIDATION_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_job_status',
        title: 'EVB Viewer job status',
        description: 'Read status for a long-running EVB action job if an action returned a job id. OCR progress is exposed through capability ocr.status; current EVB MCP jobs are otherwise not tracked here.',
        inputSchema: v.strictObject({jobId: v.optional(v.pipe(v.string(), v.description('Optional job id returned by evb_run_action.')))}),
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_workspace_snapshot',
        title: 'EVB Viewer workspace snapshot',
        description: 'Fast read of the current EVB Viewer workspace: workspace mode, panes, tabs, active tab, recent files shown on the empty start page, page numbers, document kinds, and preparation recommendations. Use this first to discover what is open in EVB Viewer / evb-viewer.',
        inputSchema: v.strictObject({windowId: v.optional(WINDOW_ID_SCHEMA)}),
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_viewer_open_documents',
        title: 'EVB Viewer open documents',
        description: 'Use this when the user asks what file, PDF, tab, or document is open in EVB Viewer, evb-viewer, or the viewer app. Empty tabs are reported as empty workspace state, not documents. Recent files are listed separately and are not open document contents.',
        inputSchema: v.strictObject({windowId: v.optional(WINDOW_ID_SCHEMA)}),
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_document_readiness',
        title: 'EVB Viewer document readiness',
        description: 'Fast read of document preparation hints for the active tab, a specific tab, or all tabs. For exact PDF text/OCR coverage, call evb_inspect_document_text.',
        inputSchema: v.strictObject({
            windowId: v.optional(WINDOW_ID_SCHEMA),
            tabId: v.optional(v.pipe(v.string(), v.description('Optional tab id. Defaults to all tabs with the active tab highlighted.'))),
        }),
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_inspect_document_text',
        title: 'EVB Viewer inspect PDF text coverage',
        description: 'Build or reuse EVB Viewer\'s PDF search index and report searchable text coverage by page. On very large PDFs this can be expensive; prefer evb_read_document_pages or document.read_pages for bounded probes unless global OCR/text coverage is required.',
        inputSchema: v.strictObject({
            windowId: v.optional(WINDOW_ID_SCHEMA),
            tabId: v.optional(TAB_ID_SCHEMA),
        }),
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_search_document',
        title: 'EVB Viewer search open PDF',
        description: 'Search searchable text in an open PDF using EVB Viewer\'s cached search index. Use when the user asks to find, locate, search, or navigate to a topic in EVB Viewer / evb-viewer. Returns page numbers and bounded excerpts, so use this before rendering pages or reading the file directly.',
        inputSchema: v.strictObject({
            windowId: v.optional(WINDOW_ID_SCHEMA),
            tabId: v.optional(TAB_ID_SCHEMA),
            query: v.pipe(v.string(), v.description('Text or regex query to search for in the PDF.')),
            maxResults: v.optional(v.pipe(v.number(), v.description('Maximum results to return. Defaults to 25 and is capped at 100.'))),
            matchCase: v.optional(v.pipe(v.boolean(), v.description('Whether case must match exactly.'))),
            wholeWord: v.optional(v.pipe(v.boolean(), v.description('Whether matches must be whole words.'))),
            useRegex: v.optional(v.pipe(v.boolean(), v.description('Treat query as a regular expression.'))),
        }),
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_viewer_search_open_document',
        title: 'EVB Viewer search open document',
        description: 'Use this when the user asks to find a word, topic, table, paradigm, or section in the document currently open in EVB Viewer / evb-viewer. It searches the active PDF with EVB Viewer\'s index and returns page candidates for navigation.',
        inputSchema: v.strictObject({
            windowId: v.optional(WINDOW_ID_SCHEMA),
            tabId: v.optional(TAB_ID_SCHEMA),
            query: v.pipe(v.string(), v.description('Text or regex query to search for in the currently open EVB Viewer PDF.')),
            maxResults: v.optional(v.pipe(v.number(), v.description('Maximum results to return. Defaults to 25 and is capped at 100.'))),
            matchCase: v.optional(v.pipe(v.boolean(), v.description('Whether case must match exactly.'))),
            wholeWord: v.optional(v.pipe(v.boolean(), v.description('Whether matches must be whole words.'))),
            useRegex: v.optional(v.pipe(v.boolean(), v.description('Treat query as a regular expression.'))),
        }),
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_read_document_pages',
        title: 'EVB Viewer read PDF page text',
        description: 'Read extracted text for specific one-based PDF pages. Uses cached search text when available and otherwise performs a bounded direct page probe, so use this for huge/slow PDFs before attempting full text coverage.',
        inputSchema: v.strictObject({
            windowId: v.optional(WINDOW_ID_SCHEMA),
            tabId: v.optional(TAB_ID_SCHEMA),
            pages: v.optional(v.pipe(v.array(v.number()), v.description('One-based page numbers to read. If omitted, reads the current page.'))),
            startPage: v.optional(v.pipe(v.number(), v.description('Optional first page in a one-based inclusive range.'))),
            endPage: v.optional(v.pipe(v.number(), v.description('Optional last page in a one-based inclusive range.'))),
            maxCharsPerPage: v.optional(v.pipe(v.number(), v.description('Maximum characters to return per page. Defaults to 6000 and is capped at 30000.'))),
        }),
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_activate_tab',
        title: 'EVB Viewer activate tab',
        description: 'Activate an open EVB Viewer tab by id. Use tab ids from evb_workspace_snapshot.',
        inputSchema: v.strictObject({
            windowId: v.optional(WINDOW_ID_SCHEMA),
            tabId: v.pipe(v.string(), v.description('The tab id to activate.')),
        }),
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: UI_NAVIGATION_ANNOTATIONS,
    },
    {
        name: 'evb_go_to_page',
        title: 'EVB Viewer go to page',
        description: 'Activate a tab if needed and navigate its PDF viewer to a one-based page number. Use after search/read tools identify the target page.',
        inputSchema: v.strictObject({
            windowId: v.optional(WINDOW_ID_SCHEMA),
            tabId: v.optional(TAB_ID_SCHEMA),
            page: v.pipe(v.number(), v.description('One-based page number to navigate to.')),
        }),
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: UI_NAVIGATION_ANNOTATIONS,
    },
] as const satisfies ReadonlyArray<Omit<IMcpToolDefinition, 'inputSchema'> & {inputSchema: GenericSchema}>;

export const MCP_TOOLS: readonly IMcpToolDefinition[] = MCP_TOOL_SCHEMA_DEFINITIONS.map((tool) => ({
    ...tool,
    inputSchema: tool.name === 'evb_run_action' || tool.name === 'evb_read_action'
        ? ACTION_INPUT_SCHEMA
        : toMcpJsonSchema(tool.inputSchema),
}));

export function validateJsonObjectAgainstSchema(label: string, value: unknown, schema: GenericSchema) {
    const result = v.safeParse(schema, value, {abortEarly: true});
    if (!result.success) {
        const details = result.issues
            .slice(0, 3)
            .map((issue) => {
                const path = issue.path?.map(item => String(item.key)).join('/') ?? '';
                return `/${path} ${issue.message}`;
            })
            .join('; ');
        throw new Error(`${label} did not match its advertised schema: ${details}`);
    }
    return result.output;
}

export function validateMcpToolArguments(name: string, value: unknown) {
    const tool = MCP_TOOL_SCHEMA_DEFINITIONS.find(candidate => candidate.name === name);
    if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
    }
    const input = value === undefined ? {} : value;
    const parsed = validateJsonObjectAgainstSchema(`${name} arguments`, input, tool.inputSchema);
    if (name !== 'evb_run_action' && name !== 'evb_read_action') {
        return parsed;
    }
    if (!isRecord(parsed)) {
        throw new Error(`${name} arguments did not match its advertised schema: / Expected object`);
    }
    const capability = AGENT_CAPABILITY_TEMPLATES.find(template => template.id === parsed.id);
    if (!capability) {
        throw new Error(`${name} arguments did not match its advertised schema: /id Unknown capability id`);
    }
    const parsedInput = validateJsonObjectAgainstSchema(`${name} arguments`, parsed.input ?? {}, capability.inputSchema);
    return parsed.input === undefined ? parsed : {
        ...parsed,
        input: parsedInput,
    };
}

export type TMcpToolCallerKind = 'internal' | 'external';

export function createMcpToolsForCaller(callerKind: TMcpToolCallerKind): readonly IMcpToolDefinition[] {
    return MCP_TOOLS.map((tool): IMcpToolDefinition => {
        if (tool.name !== 'evb_run_action') {
            return tool;
        }
        if (callerKind === 'internal') {
            return {
                ...tool,
                description: 'Run a semantic EVB Viewer write, navigation, or long-running action by capability id. EVB policy still blocks confirmation-only/destructive capabilities until an app grant flow exists. Use evb_describe_capability to inspect the expected input. For non-mutating preview/read capabilities, use evb_read_action.',
                annotations: INTERNAL_RUN_ACTION_ANNOTATIONS,
            };
        }
        return {
            ...tool,
            annotations: RUN_ACTION_ANNOTATIONS,
        };
    });
}

export const MCP_RESOURCE_TEMPLATES = [
    {
        name: 'evb_document_page_text',
        title: 'EVB PDF page text',
        uriTemplate: 'evb://document/{tabId}/page/{page}',
        description: 'Read extracted text for one PDF page in an open EVB Viewer tab using cached text or a bounded direct page probe.',
        mimeType: 'text/plain',
    },
    {
        name: 'evb_document_text_status',
        title: 'EVB PDF text status',
        uriTemplate: 'evb://document/{tabId}/text-status',
        description: 'Read searchable text coverage and OCR recommendations for an open PDF tab. This may inspect the full document; use page text resources for bounded large-document probes.',
        mimeType: 'application/json',
    },
    {
        name: 'evb_document_ocr_status',
        title: 'EVB PDF OCR status',
        uriTemplate: 'evb://document/{tabId}/ocr-status',
        description: 'Read OCR/searchable-text status for an open PDF tab. Alias of text status for agents thinking in OCR terms.',
        mimeType: 'application/json',
    },
    {
        name: 'evb_document_annotations',
        title: 'EVB PDF annotations',
        uriTemplate: 'evb://document/{tabId}/annotations',
        description: 'Read annotation summaries, stable keys, pages, subtype, colors, and note flags for an open EVB Viewer document.',
        mimeType: 'application/json',
    },
    {
        name: 'evb_document_notes',
        title: 'EVB PDF notes',
        uriTemplate: 'evb://document/{tabId}/notes',
        description: 'Read note-bearing annotation summaries plus open note-window state for an open EVB Viewer document.',
        mimeType: 'application/json',
    },
    {
        name: 'evb_document_toc',
        title: 'EVB PDF table of contents',
        uriTemplate: 'evb://document/{tabId}/toc',
        description: 'Read the document TOC/bookmarks when present, including titles and one-based page numbers.',
        mimeType: 'application/json',
    },
    {
        name: 'evb_document_bookmarks',
        title: 'EVB PDF bookmarks',
        uriTemplate: 'evb://document/{tabId}/bookmarks',
        description: 'Read editable PDF bookmarks as a nested tree with zero-based paths and one-based page numbers.',
        mimeType: 'application/json',
    },
    {
        name: 'evb_document_page_labels',
        title: 'EVB PDF page labels',
        uriTemplate: 'evb://document/{tabId}/page-labels',
        description: 'Read PDF page numbering ranges and materialized page labels for an open EVB Viewer document.',
        mimeType: 'application/json',
    },
] as const satisfies readonly IMcpResourceTemplateDefinition[];

export const MCP_PROMPTS = [
    {
        name: 'evb_find_in_current_pdf',
        title: 'Find a topic in the current EVB PDF',
        description: 'Workflow for locating a topic or paradigm in the active EVB Viewer PDF and navigating the viewer to the right page.',
        arguments: [{
            name: 'topic',
            title: 'Topic',
            description: 'The topic, term, table, paradigm, or phrase to locate.',
            required: true,
        }],
    },
    {
        name: 'evb_check_document_prep',
        title: 'Check whether the current EVB document needs OCR',
        description: 'Workflow for determining whether an open PDF has enough searchable text for agent analysis.',
    },
    {
        name: 'evb_large_document_strategy',
        title: 'Handle a large or hard EVB document',
        description: 'Workflow for large PDFs, scans, dictionaries, missing TOCs, weak OCR, or slow global text coverage: use bounded page probes, page-ranged searches, and page images before expensive full-document reads.',
    },
    {
        name: 'evb_number_pages_from_printed_pages',
        title: 'Number PDF pages',
        description: 'Universal workflow for reconstructing PDF page labels for any numbering scheme (roman front matter, arabic body, restarts, prefixed/alphabetic labels, unnumbered plates), using OCR as a starting point and visual verification when uncertain.',
    },
    {
        name: 'evb_rebuild_verified_bookmarks',
        title: 'Add or rebuild PDF bookmarks',
        description: 'Universal workflow for building bookmarks whatever the document state: from a user outline, the embedded TOC/bookmarks, a printed contents page, or derived document structure when no outline exists, verifying every target before writing.',
    },
] as const satisfies readonly IMcpPromptDefinition[];
