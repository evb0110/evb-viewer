import * as v from 'valibot';
import {
    definePlatformFeature,
    type TFeatureCapability,
} from '@contracts/platformFeature';

const defaultedOptionsSchema = v.pipe(
    v.object({
        flag: v.optional(v.boolean()),
    }),
    v.transform(options => ({
        flag: options.flag ?? false,
    })),
);

const validFeature = definePlatformFeature({
    path: ['testFeature'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        run: {
            kind: 'async',
            channel: 'test:run',
            ipc: {
                args: v.strictTuple([
                    v.string(),
                    defaultedOptionsSchema,
                ]),
                result: v.boolean(),
            },
            client: {
                mapArgs: (id: string, flag?: boolean): [string, { flag?: boolean }] => [
                    id,
                    ...(flag === undefined ? [{}] as const : [{ flag }] as const),
                ],
            },
            main: {
                method: 'run',
                context: 'none',
            },
            browser: { method: 'run' },
            lazy: 'forwarded',
        },
    },
});

export type TValidFeatureCapability = TFeatureCapability<typeof validFeature>;
export const verifyValidCapability: TValidFeatureCapability['run'] = async (
    _id: string,
    _flag?: boolean,
) => true;

export const invalidArrayMapperFeature = definePlatformFeature({
    path: ['testInvalidArray'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        run: {
            kind: 'async',
            channel: 'test:invalid-array',
            ipc: {
                args: v.strictTuple([v.string()]),
                result: v.boolean(),
            },
            client: {
                // @ts-expect-error array return type does not satisfy fixed-arity wire tuple
                mapArgs: (id: string) => [id],
            },
            main: {
                method: 'run',
                context: 'none',
            },
            browser: { method: 'run' },
            lazy: 'forwarded',
        },
    },
});

export const invalidTypeMapperFeature = definePlatformFeature({
    path: ['testInvalidType'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        run: {
            kind: 'async',
            channel: 'test:invalid-type',
            ipc: {
                args: v.strictTuple([v.string()]),
                result: v.boolean(),
            },
            client: {
                // @ts-expect-error wire tuple element type mismatch must be rejected
                mapArgs: (count: number): [number] => [count],
            },
            main: {
                method: 'run',
                context: 'none',
            },
            browser: { method: 'run' },
            lazy: 'forwarded',
        },
    },
});
