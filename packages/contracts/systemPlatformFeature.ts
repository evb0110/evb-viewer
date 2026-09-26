import {
    definePlatformFeature,
    type TFeatureCapability,
} from '@contracts/platformFeature';
import type {TRequestId} from '@contracts/shared';
import * as v from 'valibot';

const memoryInfo = v.nullable(v.object({
    availableBytes: v.pipe(v.number(), v.finite()),
    totalBytes: v.pipe(v.number(), v.finite()),
    freeBytes: v.pipe(v.number(), v.finite()),
}));
export type ISystemMemoryInfo = Exclude<v.InferOutput<typeof memoryInfo>, null>;

export const SYSTEM_PLATFORM_FEATURE = definePlatformFeature({
    path: ['system'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {getMemoryInfo: {
        kind: 'sync',
        args: v.strictTuple([]),
        result: memoryInfo,
        browser: {method: 'getMemoryInfo'},
        lazy: 'direct',
    }},
    events: {},
});

export interface IShutdownSaveFlushResponse {
    dirtyWorkingCopyPaths?: string[];
    flushedWorkingCopyPaths?: string[];
}

export type TWindowCloseDecision = 'save' | 'discard' | 'cancel';

export type TWindowCloseUnavailableReason =
    | 'no-handler'
    | 'multiple-handlers'
    | 'handler-error'
    | 'invalid-decision';

export interface IWindowCloseRequest {requestId: TRequestId;}

export type IWindowCloseResponse = {
    decision: TWindowCloseDecision;
    requestId: TRequestId;
} | {
    requestId: TRequestId;
    status: 'unavailable';
    reason: TWindowCloseUnavailableReason;
};

export type TWindowCloseRequestHandler = (
    request: IWindowCloseRequest,
) => Promise<TWindowCloseDecision> | TWindowCloseDecision;

interface ISystemLifecycleCapability {
    onShutdownSaveFlushRequest: (
        callback: () => Promise<IShutdownSaveFlushResponse> | IShutdownSaveFlushResponse,
    ) => () => void;
    onWindowCloseRequest?: (callback: TWindowCloseRequestHandler) => () => void;
}

export type ISystemCapability = TFeatureCapability<typeof SYSTEM_PLATFORM_FEATURE> & ISystemLifecycleCapability;
