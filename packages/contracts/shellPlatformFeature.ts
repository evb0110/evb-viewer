import { sanitizeAllowedExternalUrl } from '@contracts/externalUrl';
import {
    defineForwardedPlatformMethod,
    definePlatformFeature,
    type TFeatureCapability,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import * as v from 'valibot';

const externalUrl = v.pipe(v.unknown(), v.transform(sanitizeAllowedExternalUrl));
const voidResult = v.pipe(
    v.undefined('expected an undefined IPC result'),
    v.transform((): void => undefined),
);

export const SHELL_PLATFORM_FEATURE = definePlatformFeature({
    path: ['shell'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {openExternal: defineForwardedPlatformMethod({
        name: 'openExternal',
        channel: 'shell:openExternal',
        args: v.strictTuple([externalUrl]),
        result: voidResult,
        main: 'openExternal',
    })},
    events: {},
});

export type IShellCapability = TFeatureCapability<typeof SHELL_PLATFORM_FEATURE>;
export type IShellInvokeMap = TFeatureInvokeMap<typeof SHELL_PLATFORM_FEATURE>;
