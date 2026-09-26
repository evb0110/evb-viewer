import type {IpcMainInvokeEvent} from 'electron';
import { expect } from 'vitest';
import type {
    IIpcInvokeSpec,
    IIpcMainRegistrar,
    TIpcCodecMap,
} from '@contracts/ipcMain';
import type { TAnyDefinedPlatformFeature } from '@contracts/platformFeature';
import {
    createChannelSet,
    createValidatedIpcMainRegistrar,
    type IValidatedIpcMainRegistrarOptions,
    type IValidatedIpcMainRegistrar,
} from '@electron/platform-ipc/validatedIpcRegistrar';

export type TCapturedIpcHandler = (
    event: IpcMainInvokeEvent,
    ...args: unknown[]
) => unknown;

export interface IValidatedRegistrarCase {
    channel: string;
    validArgs: unknown[];
}

export function createFeatureRegistrarCases(feature: TAnyDefinedPlatformFeature): IValidatedRegistrarCase[] {
    const methodCases = Object.values(feature.methods).flatMap((spec) => {
        if (spec.kind === 'sync' || 'local' in spec) {
            return [];
        }
        return [{
            channel: spec.channel,
            validArgs: spec.ipc.args.example(),
        }];
    });
    const subscriptionCases = Object.values(feature.events).flatMap((spec) => (
        spec.subscription
            ? [{
                channel: spec.subscription.channel,
                validArgs: [],
            }]
            : []
    ));
    return [
        ...methodCases,
        ...subscriptionCases,
    ];
}

export function createValidatedRegistrarHarness<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec},
    TService,
>(options: {
    channels: Record<string, string>;
    codecs: TIpcCodecMap<TMap>;
    register: (registrar: IValidatedIpcMainRegistrar<TMap, IpcMainInvokeEvent>, service: TService) => void;
    service: TService;
}) {
    const handlers = new Map<string, TCapturedIpcHandler>();
    const nativeRegistrar: IIpcMainRegistrar<never, IpcMainInvokeEvent> = {handle: ((
        channel: string,
        handler: TCapturedIpcHandler,
    ) => {
        handlers.set(channel, handler);
    }) as IIpcMainRegistrar<never, IpcMainInvokeEvent>['handle']};
    const allowedChannels = createChannelSet(options.channels);
    const registrarOptions: IValidatedIpcMainRegistrarOptions = {
        allowedChannels,
        codecs: options.codecs,
    };
    const registrar = createValidatedIpcMainRegistrar<TMap>(nativeRegistrar, registrarOptions);
    options.register(registrar, options.service);
    return handlers;
}

export function getCapturedIpcHandler(
    handlers: ReadonlyMap<string, TCapturedIpcHandler>,
    channel: string,
) {
    const handler = handlers.get(channel);
    if (handler === undefined) {
        throw new Error(`Expected a registered IPC handler for ${channel}`);
    }
    return handler;
}

export function createHarnessEvent(senderId = 7) {
    return {sender: {id: senderId}} as IpcMainInvokeEvent;
}

export async function assertValidatedRegistrarCases(options: {
    cases: readonly IValidatedRegistrarCase[];
    channels: Record<string, string>;
    handlers: ReadonlyMap<string, TCapturedIpcHandler>;
    setTrusted: (trusted: boolean) => void;
}) {
    const expectedChannels = [...new Set(Object.values(options.channels))].sort();
    expect([...options.handlers.keys()].sort()).toEqual(expectedChannels);
    expect(options.cases.map(testCase => testCase.channel).sort()).toEqual(expectedChannels);

    for (const testCase of options.cases) {
        const handler = getCapturedIpcHandler(options.handlers, testCase.channel);
        options.setTrusted(true);
        await expect(handler(createHarnessEvent(), ...testCase.validArgs)).resolves.not.toThrow();

        for (let index = 0; index < testCase.validArgs.length; index += 1) {
            const malformedArgs = [...testCase.validArgs];
            malformedArgs[index] = Symbol('malformed');
            await expect(handler(createHarnessEvent(), ...malformedArgs)).rejects.toThrow(
                `Invalid IPC arguments for ${testCase.channel}`,
            );
        }
        await expect(handler(createHarnessEvent(), ...testCase.validArgs, Symbol('extra'))).rejects.toThrow(
            `Invalid IPC arguments for ${testCase.channel}`,
        );

        options.setTrusted(false);
        await expect(handler(createHarnessEvent(), ...testCase.validArgs)).rejects.toThrow('IPC sender is not trusted');
    }
}
