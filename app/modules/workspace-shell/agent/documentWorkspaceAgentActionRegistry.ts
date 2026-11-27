import type {IWorkspaceAgentCommandContext} from '@app/types/workspaceExpose';

export type TAgentActionHandlerRunResult = object | Promise<object>;

export interface IAgentActionExecutionPolicy {
    requiresLoadedDocument: boolean;
    mutatesDocument: boolean;
    cancelsOnDocumentChange: boolean;
}

const DEFAULT_AGENT_ACTION_EXECUTION_POLICY: IAgentActionExecutionPolicy = {
    requiresLoadedDocument: true,
    mutatesDocument: false,
    cancelsOnDocumentChange: true,
};

interface IParsedAgentAction {
    policy: IAgentActionExecutionPolicy;
    run: (context?: IWorkspaceAgentCommandContext) => TAgentActionHandlerRunResult;
}

interface IAgentActionHandler {
    parse: (input: Record<string, unknown>, actionId: string) => IParsedAgentAction;
}

export interface IAgentActionHandlerDefinition<TParsedInput> {
    ids: readonly string[];
    policy?: Partial<IAgentActionExecutionPolicy>;
    parse(input: Record<string, unknown>, actionId: string): TParsedInput;
    run(parsedInput: TParsedInput, actionId: string, context?: IWorkspaceAgentCommandContext): TAgentActionHandlerRunResult;
}

function createAgentActionHandler<TParsedInput>(definition: IAgentActionHandlerDefinition<TParsedInput>): IAgentActionHandler {
    return {
        parse: (input, actionId) => {
            const parsedInput = definition.parse(input, actionId);
            const policy = {
                ...DEFAULT_AGENT_ACTION_EXECUTION_POLICY,
                ...definition.policy,
            };
            return {
                policy,
                run: (context) => definition.run(parsedInput, actionId, context),
            };
        },
    };
}

export function createAgentActionHandlerRegistry(definitions: ReadonlyArray<IAgentActionHandlerDefinition<unknown>>) {
    return Object.fromEntries(
        definitions.flatMap((definition) => definition.ids.map((id) => [id, createAgentActionHandler(definition)])),
    ) as Record<string, IAgentActionHandler>;
}

export function defineAgentActionHandler<TParsedInput>(definition: IAgentActionHandlerDefinition<TParsedInput>) {
    return definition;
}
