export type TPlatformUnsupportedReason =
    'unsupported-backend' | 'missing-browser-permission' | 'user-canceled' | 'not-implemented' | 'requires-native-backend';

export interface IPlatformUnsupportedResult {
    readonly ok: false;
    readonly reason: TPlatformUnsupportedReason;
    readonly message?: string;
}

export interface IPlatformOkResult<T> {
    readonly ok: true;
    readonly value: T;
}

export type TPlatformResult<T> = IPlatformOkResult<T> | IPlatformUnsupportedResult;

export function createPlatformUnsupportedResult(reason: TPlatformUnsupportedReason, message?: string): IPlatformUnsupportedResult {
    return {
        ok: false,
        reason,
        ...(message === undefined ? {} : {message}),
    };
}
