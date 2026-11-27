declare const brand: unique symbol;

export type TBrand<TBase, TName extends string> = TBase & {readonly [brand]: TName};

export function parseBranded<TBranded>(value: unknown, guard: (value: unknown) => value is TBranded): TBranded | null {
    return guard(value) ? value : null;
}

export function isBrandedString<TName extends string>(value: unknown, maxLength = 512): value is TBrand<string, TName> {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

export function createBrandedId<TBranded>(prefix: string, guard: (value: unknown) => value is TBranded): TBranded {
    const parsed = parseBranded(`${prefix}-${globalThis.crypto.randomUUID()}`, guard);
    if (parsed === null) {
        throw new Error('Generated identifier failed validation');
    }
    return parsed;
}
