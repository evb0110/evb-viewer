import {
    describe, expect, it,
} from 'vitest';
import {
    ASSISTANT_MCP_SERVER_NAME,
    createCodexIsolationArgs,
    readCodexMcpStatusPage,
    readCodexUserToolConfig,
} from '@electron/features/agent/codexAssistantConfig';

describe('Codex shared-home tool isolation', () => {
    it('reads configured servers and plugins without counting EVB as a foreign server', () => {
        expect(readCodexUserToolConfig({config: {
            mcp_servers: {
                outside: {},
                [ASSISTANT_MCP_SERVER_NAME]: {},
            },
            plugins: {helper: {}},
        }})).toEqual({
            mcpServers: ['outside'],
            plugins: ['helper'],
        });
        expect(readCodexUserToolConfig(null)).toEqual({
            mcpServers: [],
            plugins: [],
        });
    });
    it('disables every addressable user server and plugin before adding EVB last', () => {
        const args = createCodexIsolationArgs('http://127.0.0.1:1234/mcp', 'high', {
            mcpServers: [
                'outside',
                'other-server',
                'has.dot',
            ],
            plugins: [
                'helper',
                'has.dot',
            ],
        });
        expect(args.filter((_, index) => index % 2 === 0).every(value => value === '-c')).toBe(true);
        const overrides = args.filter((_, index) => index % 2 === 1);
        expect(overrides).toEqual(expect.arrayContaining([
            'mcp_servers.outside.enabled=false',
            'mcp_servers.other-server.enabled=false',
            'plugins.helper.enabled=false',
            'features.apps=false',
            'features.memories=false',
            'features.multi_agent=false',
            'features.shell_tool=false',
            'features.unified_exec=false',
            'web_search="disabled"',
            'sandbox_mode="read-only"',
            'approval_policy="never"',
            'project_doc_max_bytes=0',
            'model_reasoning_effort="high"',
        ]));
        expect(overrides.some(value => value.includes('has.dot'))).toBe(false);
        expect(overrides.at(-1)).toContain(`mcp_servers.${ASSISTANT_MCP_SERVER_NAME}={`);
        expect(overrides.at(-1)).toContain('url="http://127.0.0.1:1234/mcp"');
    });
    it('reports only foreign servers that expose tools, with the next page cursor', () => {
        expect(readCodexMcpStatusPage({
            data: [
                {
                    name: ASSISTANT_MCP_SERVER_NAME,
                    tools: {evb_run_action: {}},
                },
                {
                    name: 'empty',
                    tools: {},
                },
                {
                    name: 'leaking-server',
                    tools: {exec: {}},
                },
            ],
            nextCursor: 'page-2',
        })).toEqual({
            leaks: ['leaking-server'],
            nextCursor: 'page-2',
        });
    });
    it.each([
        null,
        {},
        {data: null},
        {data: [null]},
        {data: [{tools: {}}]},
        {data: [{name: 'absent'}]},
        {data: [{
            name: 'null-tools',
            tools: null,
        }]},
        {data: [{
            name: 'array-tools',
            tools: [],
        }]},
        {
            data: [],
            nextCursor: 3,
        },
    ])('fails closed on an unreadable status %#', response => {
        expect(() => readCodexMcpStatusPage(response)).toThrow('unreadable MCP server status');
    });
});
