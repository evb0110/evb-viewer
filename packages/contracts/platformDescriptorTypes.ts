export type TPlatformBackend = 'electron' | 'browser';

export type TPlatformMethodKind = 'async' | 'event' | 'sync' | 'void';
export type TBrowserPlatformLazyMode = 'forwarded' | 'direct';

export interface IPlatformMethodDescriptor {
    readonly path: readonly string[];
    readonly kind: TPlatformMethodKind;
    readonly required: Readonly<Record<TPlatformBackend, boolean>>;
    readonly optionalWhenImplemented?: boolean;
    readonly browserLazy: TBrowserPlatformLazyMode;
}

export interface IPlatformCapabilityDescriptor {
    readonly path: readonly string[];
    readonly required: Readonly<Record<TPlatformBackend, boolean>>;
    readonly manifestPath?: readonly string[];
}

export interface IPlatformApiDescriptor {
    readonly capabilities: readonly IPlatformCapabilityDescriptor[];
    readonly methods: readonly IPlatformMethodDescriptor[];
}
