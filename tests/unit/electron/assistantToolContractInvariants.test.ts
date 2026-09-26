import {
    describe,
    expect,
    it,
} from 'vitest';
import { AGENT_CAPABILITY_TEMPLATES } from '@electron/features/agent/mcp/mcpDefinitions';
import {
    MCP_TOOLS,
    validateJsonObjectAgainstSchema,
} from '@electron/features/agent/mcp/mcpToolDefinitions';
import { ASSISTANT_MCP_TOOL_HANDLER_NAMES } from '@electron/features/agent/mcp/mcpServerCore';
import { resolveAgentCommandRequestTimeoutMs } from '@electron/features/agent/workspaceBridge';
import {AGENT_OCR_RUN_INPUT_SCHEMA} from '@contracts/agentOcr';
import {toJsonSchema} from '@valibot/to-json-schema';

function generatedInputSchema(schema: Parameters<typeof toJsonSchema>[0]) {
    const generated = toJsonSchema(schema);
    delete generated.$schema;
    const removeEmptyRequired = (value: unknown): void => {
        if (Array.isArray(value)) {
            value.forEach(removeEmptyRequired);
        } else if (typeof value === 'object' && value !== null) {
            const record = value as Record<string, unknown>;
            if (Array.isArray(record.required) && record.required.length === 0) {
                delete record.required;
            }
            Object.values(record).forEach(removeEmptyRequired);
        }
    };
    removeEmptyRequired(generated);
    return generated;
}

describe('assistant tool contract invariants', () => {
    it('maps every advertised tool to exactly one handler and keeps capability ids unique', () => {
        expect(new Set(MCP_TOOLS.map(tool => tool.name))).toEqual(new Set(ASSISTANT_MCP_TOOL_HANDLER_NAMES));
        const capabilityIds = AGENT_CAPABILITY_TEMPLATES.map(capability => capability.id);
        expect(new Set(capabilityIds).size).toBe(capabilityIds.length);
    });

    it('derives every advertised action input branch directly from the canonical capability catalog', () => {
        const actionTool = MCP_TOOLS.find(tool => tool.name === 'evb_run_action');
        const branches = actionTool?.inputSchema.oneOf as Array<{properties: {
            id: {const: string};
            input: Record<string, unknown>;
        }}>;
        expect(branches).toHaveLength(AGENT_CAPABILITY_TEMPLATES.length);
        for (const template of AGENT_CAPABILITY_TEMPLATES) {
            const branch = branches.find(candidate => candidate.properties.id.const === template.id);
            expect(branch?.properties.input).toEqual(generatedInputSchema(template.inputSchema));
        }
    });

    it('uses the advertised schema itself as the recursive runtime validator', () => {
        const template = AGENT_CAPABILITY_TEMPLATES.find(candidate => candidate.id === 'document.search');
        if (!template) {
            throw new Error('document.search template is missing');
        }
        expect(() => validateJsonObjectAgainstSchema('document.search', {
            query: 'needle',
            unexpected: true,
        }, template.inputSchema)).toThrow(/advertised schema/u);
        expect(() => validateJsonObjectAgainstSchema('document.search', {query: 'needle'}, template.inputSchema)).not.toThrow();
    });

    it('advertises the shared OCR contract and enforces replace-all acknowledgement', () => {
        const template = AGENT_CAPABILITY_TEMPLATES.find(candidate => candidate.id === 'ocr.start');
        if (!template) {
            throw new Error('ocr.start template is missing');
        }
        expect(template.inputSchema).toBe(AGENT_OCR_RUN_INPUT_SCHEMA);
        expect(() => validateJsonObjectAgainstSchema(
            'ocr.start',
            {supersessionPolicy: 'replace-all'},
            template.inputSchema,
        )).toThrow(/advertised schema/u);
        expect(() => validateJsonObjectAgainstSchema('ocr.start', {
            languages: ['eng'],
            supersessionPolicy: 'replace-all',
            replaceAllAcknowledged: true,
            open: false,
        }, template.inputSchema)).not.toThrow();
        expect(() => validateJsonObjectAgainstSchema(
            'ocr.start',
            {selectedLanguages: ['eng']},
            template.inputSchema,
        )).toThrow(/advertised schema/u);
    });

    it.each([
        'ocr.start',
        'export.docx',
        'export.images',
        'export.multi_page_tiff',
        'page_ops.convert_to_pdf',
    ])('uses the long-running timeout for %s', (id) => {
        expect(resolveAgentCommandRequestTimeoutMs({
            name: 'run_action',
            arguments: {id},
        })).toBe(180_000);
    });
});
