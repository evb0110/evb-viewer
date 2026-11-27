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

const mixedScalarOrTupleSchema = v.pipe(
    v.union([
        v.string(),
        v.strictTuple([v.string()]),
    ]),
    v.transform((value): [string] => (typeof value === 'string' ? [value] : value)),
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
        runReadonlyTuple: {
            kind: 'async',
            channel: 'test:run-readonly',
            ipc: {
                args: v.strictTuple([v.string()]),
                result: v.boolean(),
            },
            client: {
                mapArgs: (id: string): readonly [string] => [id],
            },
            main: {
                method: 'runReadonlyTuple',
                context: 'none',
            },
            browser: { method: 'runReadonlyTuple' },
            lazy: 'forwarded',
        },
        runMixedInput: {
            kind: 'async',
            channel: 'test:run-mixed',
            ipc: {
                args: mixedScalarOrTupleSchema,
                result: v.boolean(),
            },
            client: {
                mapArgs: (id: string): [string] => [id],
            },
            main: {
                method: 'runMixedInput',
                context: 'none',
            },
            browser: { method: 'runMixedInput' },
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

export const invalidMixedInputFeature = definePlatformFeature({
    path: ['testInvalidMixed'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        run: {
            kind: 'async',
            channel: 'test:invalid-mixed',
            ipc: {
                args: mixedScalarOrTupleSchema,
                result: v.boolean(),
            },
            client: {
                // @ts-expect-error mixed scalar-or-tuple schema must still enforce its tuple branch
                mapArgs: (): [boolean] => [true],
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

const optionalInvalidClientSpec: {
    readonly kind: 'async';
    readonly channel: 'test:optional-invalid';
    readonly ipc: {
        readonly args: v.StrictTupleSchema<readonly [v.StringSchema<undefined>], undefined>;
        readonly result: v.BooleanSchema<undefined>;
    };
    readonly client?: { readonly mapArgs: () => [boolean] };
    readonly main: {
        readonly method: 'run';
        readonly context: 'none';
    };
    readonly browser: { readonly method: 'run' };
    readonly lazy: 'forwarded';
} = {
    kind: 'async',
    channel: 'test:optional-invalid',
    ipc: {
        args: v.strictTuple([v.string()]),
        result: v.boolean(),
    },
    client: {
        mapArgs: () => [true],
    },
    main: {
        method: 'run',
        context: 'none',
    },
    browser: { method: 'run' },
    lazy: 'forwarded',
};

export const optionalInvalidClientFeature = definePlatformFeature({
    path: ['testOptionalInvalid'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        // @ts-expect-error optional client.mapArgs must still be checked against ipc.args
        run: optionalInvalidClientSpec,
    },
});

const swappedUnionA = {
    kind: 'async',
    channel: 'test:swap-a',
    ipc: {
        args: v.strictTuple([v.string()]),
        result: v.boolean(),
    },
    client: {
        mapArgs: (): [boolean] => [true],
    },
    main: {
        method: 'run',
        context: 'none',
    },
    browser: { method: 'run' },
    lazy: 'forwarded',
} as const;

const swappedUnionB = {
    kind: 'async',
    channel: 'test:swap-b',
    ipc: {
        args: v.strictTuple([v.boolean()]),
        result: v.boolean(),
    },
    client: {
        mapArgs: (): [string] => ['bad'],
    },
    main: {
        method: 'run',
        context: 'none',
    },
    browser: { method: 'run' },
    lazy: 'forwarded',
} as const;

export const swappedUnionFeature = definePlatformFeature({
    path: ['testSwappedUnion'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        // @ts-expect-error union descriptors cannot borrow each other's mapper return types
        run: Math.random() > 0.5 ? swappedUnionA : swappedUnionB,
    },
});

const optionalReadonlyMapperSpec: {
    readonly kind: 'async';
    readonly channel: 'test:optional-readonly-mapper';
    readonly ipc: {
        readonly args: v.StrictTupleSchema<readonly [v.StringSchema<undefined>], undefined>;
        readonly result: v.BooleanSchema<undefined>;
    };
    readonly client?: { readonly mapArgs: (page: number) => readonly [string] };
    readonly main: {
        readonly method: 'run';
        readonly context: 'none';
    };
    readonly browser: { readonly method: 'run' };
    readonly lazy: 'forwarded';
} = {
    kind: 'async',
    channel: 'test:optional-readonly-mapper',
    ipc: {
        args: v.strictTuple([v.string()]),
        result: v.boolean(),
    },
    client: {
        mapArgs: (page: number): readonly [string] => [page.toFixed(0)],
    },
    main: {
        method: 'run',
        context: 'none',
    },
    browser: { method: 'run' },
    lazy: 'forwarded',
};

const optionalReadonlyMapperFeature = definePlatformFeature({
    path: ['testOptionalReadonlyMapper'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        run: optionalReadonlyMapperSpec,
    },
});

export function verifyOptionalReadonlyMapperCapability(
    capability: TFeatureCapability<typeof optionalReadonlyMapperFeature>,
) {
    // @ts-expect-error optional client.mapArgs taking number must not expose string-only wire args
    void capability.run('1');
    // @ts-expect-error omitted client branch requires string wire args, so number is also unsafe
    void capability.run(1);
}
