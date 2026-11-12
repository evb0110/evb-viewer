import { isRecord } from '@contracts/runtimeGuards';
import type {
    IAgentCommandResponse,
    IAgentWorkspaceSnapshotResponse,
} from '@contracts/agent';
import {
    AGENT_COMMAND_CANCEL_REQUEST_SCHEMA,
    AGENT_COMMAND_REQUEST_SCHEMA,
    AGENT_MCP_INTEGRATION_STATUS_SCHEMA,
    AGENT_MCP_INTEGRATION_UPDATE_RESULT_SCHEMA,
    AGENT_RENDERER_ACK_SCHEMA,
    AGENT_WORKSPACE_SNAPSHOT_REQUEST_SCHEMA,
} from '@contracts/agent';
import {
    ASSISTANT_CHAT_REQUEST_SCHEMA,
    ASSISTANT_EVENT_SCHEMA,
    ASSISTANT_INSTANCE_REQUEST_SCHEMA,
    ASSISTANT_INSTANCES_RESULT_SCHEMA,
    ASSISTANT_INSTANCES_SCHEMA,
    ASSISTANT_LOGIN_REQUEST_SCHEMA,
    ASSISTANT_LOGIN_RESULT_SCHEMA,
    ASSISTANT_OPERATION_RESULT_SCHEMA,
    ASSISTANT_SEND_REQUEST_SCHEMA,
    ASSISTANT_STATE_REQUEST_SCHEMA,
    ASSISTANT_STATE_SCHEMA,
} from '@contracts/assistant';
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
const optionalAssistantStateArgs = v.pipe(
    v.strictTuple([v.optional(v.nullable(ASSISTANT_STATE_REQUEST_SCHEMA))]),
    v.transform(([request]) => request == null ? [] : [request]),
);
const assistantChatArgs = v.strictTuple([ASSISTANT_CHAT_REQUEST_SCHEMA]);
const assistantInstanceArgs = v.strictTuple([ASSISTANT_INSTANCE_REQUEST_SCHEMA]);
const assistantLoginArgs = v.message(v.strictTuple([ASSISTANT_LOGIN_REQUEST_SCHEMA]), 'invalid assistant login request');
const assistantMessageArgs = v.strictTuple([ASSISTANT_SEND_REQUEST_SCHEMA]);
const assistantInstancesArgs = v.strictTuple([ASSISTANT_INSTANCES_SCHEMA]);
// Response envelopes reach the bridge as plain objects so a malformed one can still reject its pending request by id.
// The bridge parses each with the shared response schema, and the static type stays on the renderer-facing args.
const workspaceSnapshotResponseArgs = v.strictTuple([v.custom<IAgentWorkspaceSnapshotResponse>(isRecord)]);
const commandResponseArgs = v.strictTuple([v.custom<IAgentCommandResponse>(isRecord)]);
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
            args: optionalAssistantStateArgs,
            result: ASSISTANT_STATE_SCHEMA,
        }),
        installAssistantCodex: defineAgentMethod({
            name: 'installAssistantCodex',
            channel: 'agent:installAssistantCodex',
            args: noArgs,
            result: ASSISTANT_OPERATION_RESULT_SCHEMA,
        }),
        startAssistantLogin: defineAgentMethod({
            name: 'startAssistantLogin',
            channel: 'agent:startAssistantLogin',
            args: assistantLoginArgs,
            result: ASSISTANT_LOGIN_RESULT_SCHEMA,
        }),
        cancelAssistantLogin: defineAgentMethod({
            name: 'cancelAssistantLogin',
            channel: 'agent:cancelAssistantLogin',
            args: assistantInstanceArgs,
            result: ASSISTANT_STATE_SCHEMA,
        }),
        sendAssistantMessage: defineAgentMethod({
            name: 'sendAssistantMessage',
            channel: 'agent:sendAssistantMessage',
            args: assistantMessageArgs,
            result: ASSISTANT_OPERATION_RESULT_SCHEMA,
        }),
        interruptAssistant: defineAgentMethod({
            name: 'interruptAssistant',
            channel: 'agent:interruptAssistant',
            args: assistantChatArgs,
            result: ASSISTANT_STATE_SCHEMA,
        }),
        resetAssistantChat: defineAgentMethod({
            name: 'resetAssistantChat',
            channel: 'agent:resetAssistantChat',
            args: assistantChatArgs,
            result: ASSISTANT_STATE_SCHEMA,
        }),
        getAssistantInstances: defineAgentMethod({
            name: 'getAssistantInstances',
            channel: 'agent:getAssistantInstances',
            args: noArgs,
            result: ASSISTANT_INSTANCES_RESULT_SCHEMA,
        }),
        saveAssistantInstances: defineAgentMethod({
            name: 'saveAssistantInstances',
            channel: 'agent:saveAssistantInstances',
            args: assistantInstancesArgs,
            result: ASSISTANT_INSTANCES_RESULT_SCHEMA,
        }),
        importAssistantInstancesFromT3: defineAgentMethod({
            name: 'importAssistantInstancesFromT3',
            channel: 'agent:importAssistantInstancesFromT3',
            args: noArgs,
            result: ASSISTANT_INSTANCES_RESULT_SCHEMA,
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
        onMcpIntegrationChanged: {
            kind: 'event',
            channel: 'agent:mcpIntegrationChanged',
            payload: AGENT_MCP_INTEGRATION_STATUS_SCHEMA,
            browser: {
                unsupported: 'omitted',
                reason: 'requires-native-backend',
            },
            optionalWhenImplemented: true,
            lazy: 'forwarded',
        },
        onAssistantEvent: {
            kind: 'event',
            channel: 'agent:assistantEvent',
            payload: ASSISTANT_EVENT_SCHEMA,
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
