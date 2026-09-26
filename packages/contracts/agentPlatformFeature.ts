import {
    AGENT_ASSISTANT_EVENT_SCHEMA,
    AGENT_ASSISTANT_INSTALL_RESULT_SCHEMA,
    AGENT_ASSISTANT_LOGIN_REQUEST_SCHEMA,
    AGENT_ASSISTANT_LOGIN_RESULT_SCHEMA,
    AGENT_ASSISTANT_SEND_MESSAGE_REQUEST_SCHEMA,
    AGENT_ASSISTANT_SEND_MESSAGE_RESULT_SCHEMA,
    AGENT_ASSISTANT_STATE_REQUEST_SCHEMA,
    AGENT_ASSISTANT_STATE_SCHEMA,
    AGENT_COMMAND_CANCEL_REQUEST_SCHEMA,
    AGENT_COMMAND_REQUEST_SCHEMA,
    AGENT_COMMAND_RESPONSE_SCHEMA,
    AGENT_MCP_INTEGRATION_STATUS_SCHEMA,
    AGENT_MCP_INTEGRATION_UPDATE_RESULT_SCHEMA,
    AGENT_RENDERER_ACK_SCHEMA,
    AGENT_WORKSPACE_SNAPSHOT_REQUEST_SCHEMA,
    AGENT_WORKSPACE_SNAPSHOT_RESPONSE_SCHEMA,
} from '@contracts/agent';
import {
    definePlatformFeature,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
    type TPlatformFeatureSchema,
} from '@contracts/platformFeature';
import * as v from 'valibot';

function defineAgentMethod<
    const TName extends string,
    const TChannel extends string,
    const TArgs extends TPlatformFeatureSchema<unknown[]>,
    const TResult extends TPlatformFeatureSchema,
>(definition: {
    name: TName;
    channel: TChannel;
    args: TArgs;
    result: TResult;
}) {
    return {
        kind: 'async',
        channel: definition.channel,
        ipc: {
            args: definition.args,
            result: definition.result,
        },
        main: {
            method: definition.name,
            context: 'sender',
        },
        browser: {method: definition.name},
        lazy: 'forwarded',
    } as const;
}

const noArgs = v.strictTuple([]);
const enabledArgs = v.message(v.strictTuple([v.boolean()]), 'enabled must be a boolean');
const optionalAssistantRequestArgs = v.pipe(
    v.strictTuple([v.optional(v.nullable(AGENT_ASSISTANT_STATE_REQUEST_SCHEMA))]),
    v.transform(([request]) => request == null ? [] : [request]),
);
const assistantLoginArgs = v.message(v.strictTuple([AGENT_ASSISTANT_LOGIN_REQUEST_SCHEMA]), 'invalid assistant login request');
const assistantMessageArgs = v.strictTuple([AGENT_ASSISTANT_SEND_MESSAGE_REQUEST_SCHEMA]);
const workspaceSnapshotResponseArgs = v.strictTuple([AGENT_WORKSPACE_SNAPSHOT_RESPONSE_SCHEMA]);
const commandResponseArgs = v.strictTuple([AGENT_COMMAND_RESPONSE_SCHEMA]);
const rendererAckResult = AGENT_RENDERER_ACK_SCHEMA;

export const AGENT_PLATFORM_FEATURE = definePlatformFeature({
    path: ['agent'],
    required: {
        browser: true,
        electron: true,
    },
    manifestPath: ['agent'],
    methods: {
        getMcpIntegrationStatus: defineAgentMethod({
            name: 'getMcpIntegrationStatus',
            channel: 'agent:getMcpIntegrationStatus',
            args: noArgs,
            result: AGENT_MCP_INTEGRATION_STATUS_SCHEMA,
        }),
        setMcpIntegrationEnabled: defineAgentMethod({
            name: 'setMcpIntegrationEnabled',
            channel: 'agent:setMcpIntegrationEnabled',
            args: enabledArgs,
            result: AGENT_MCP_INTEGRATION_UPDATE_RESULT_SCHEMA,
        }),
        getAssistantState: defineAgentMethod({
            name: 'getAssistantState',
            channel: 'agent:getAssistantState',
            args: optionalAssistantRequestArgs,
            result: AGENT_ASSISTANT_STATE_SCHEMA,
        }),
        installAssistantCodex: defineAgentMethod({
            name: 'installAssistantCodex',
            channel: 'agent:installAssistantCodex',
            args: noArgs,
            result: AGENT_ASSISTANT_INSTALL_RESULT_SCHEMA,
        }),
        startAssistantLogin: defineAgentMethod({
            name: 'startAssistantLogin',
            channel: 'agent:startAssistantLogin',
            args: assistantLoginArgs,
            result: AGENT_ASSISTANT_LOGIN_RESULT_SCHEMA,
        }),
        cancelAssistantLogin: defineAgentMethod({
            name: 'cancelAssistantLogin',
            channel: 'agent:cancelAssistantLogin',
            args: noArgs,
            result: AGENT_ASSISTANT_STATE_SCHEMA,
        }),
        sendAssistantMessage: defineAgentMethod({
            name: 'sendAssistantMessage',
            channel: 'agent:sendAssistantMessage',
            args: assistantMessageArgs,
            result: AGENT_ASSISTANT_SEND_MESSAGE_RESULT_SCHEMA,
        }),
        interruptAssistant: defineAgentMethod({
            name: 'interruptAssistant',
            channel: 'agent:interruptAssistant',
            args: optionalAssistantRequestArgs,
            result: AGENT_ASSISTANT_STATE_SCHEMA,
        }),
        resetAssistantChat: defineAgentMethod({
            name: 'resetAssistantChat',
            channel: 'agent:resetAssistantChat',
            args: optionalAssistantRequestArgs,
            result: AGENT_ASSISTANT_STATE_SCHEMA,
        }),
        submitWorkspaceSnapshot: defineAgentMethod({
            name: 'submitWorkspaceSnapshot',
            channel: 'agent:submitWorkspaceSnapshot',
            args: workspaceSnapshotResponseArgs,
            result: rendererAckResult,
        }),
        submitCommandResponse: defineAgentMethod({
            name: 'submitCommandResponse',
            channel: 'agent:submitCommandResponse',
            args: commandResponseArgs,
            result: rendererAckResult,
        }),
    },
    events: {
        onAssistantEvent: {
            kind: 'event',
            channel: 'agent:assistantEvent',
            payload: AGENT_ASSISTANT_EVENT_SCHEMA,
            browser: {method: 'onAssistantEvent'},
            lazy: 'forwarded',
        },
        onWorkspaceSnapshotRequest: {
            kind: 'event',
            channel: 'agent:workspaceSnapshotRequest',
            payload: AGENT_WORKSPACE_SNAPSHOT_REQUEST_SCHEMA,
            browser: {method: 'onWorkspaceSnapshotRequest'},
            lazy: 'forwarded',
        },
        onCommandCancelRequest: {
            kind: 'event',
            channel: 'agent:commandCancelRequest',
            payload: AGENT_COMMAND_CANCEL_REQUEST_SCHEMA,
            browser: {method: 'onCommandCancelRequest'},
            lazy: 'forwarded',
        },
        onCommandRequest: {
            kind: 'event',
            channel: 'agent:commandRequest',
            payload: AGENT_COMMAND_REQUEST_SCHEMA,
            browser: {method: 'onCommandRequest'},
            lazy: 'forwarded',
        },
    },
});

export type IAgentCapability = TFeatureCapability<typeof AGENT_PLATFORM_FEATURE>;
export type IAgentInvokeMap = TFeatureInvokeMap<typeof AGENT_PLATFORM_FEATURE>;
export type IAgentEventMap = TFeatureEventMap<typeof AGENT_PLATFORM_FEATURE>;
