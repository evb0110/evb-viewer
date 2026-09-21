import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFContext,
    PDFName,
    PDFPage,
    PDFRef,
    PDFString,
} from 'pdf-lib';
import type {PDFDict} from 'pdf-lib';
import {
    safePdfContextLookupDict,
    safePdfDictLookupDict,
    safePdfDictLookupName,
    safePdfPageInheritableDict,
} from '@pdf-core/safePdfLookup';

interface IForeignName {
    asString: () => string;
    value: () => string;
}

interface IForeignRef {
    generationNumber: number;
    objectNumber: number;
    tag: string;
}

function createForeignDict(
    entries: ReadonlyArray<readonly [string, unknown]>,
    context: {lookup: (...values: never[]) => unknown},
): PDFDict {
    const values = new Map<IForeignName, unknown>();
    const names = entries.map(([
        name,
        value,
    ]) => {
        const key = {
            asString: () => `/${name}`,
            value: () => `/${name}`,
        } satisfies IForeignName;
        values.set(key, value);
        return key;
    });
    return Object.assign(Object.create(null), {
        context,
        get(key: IForeignName) {
            return values.get(key);
        },
        keys() {
            return names;
        },
        lookupMaybe() {
            return undefined;
        },
    });
}

describe('safe PDF lookup helpers', () => {
    it('resolves pdf-lib-shaped dictionaries and refs from another module copy', () => {
        const foreignRef: IForeignRef = {
            generationNumber: 0,
            objectNumber: 7,
            tag: '7 0 R',
        };
        const context: {lookup: (value: unknown) => unknown} = {lookup: () => undefined};
        const xObject = createForeignDict([], context);
        context.lookup = (value: unknown) => {
            if (value === foreignRef) {
                return foreignRef;
            }
            if (typeof value === 'object' && value !== null
                    && 'tag' in value && value.tag === foreignRef.tag) {
                return xObject;
            }
            return value;
        };
        const resources = createForeignDict([[
            'XObject',
            foreignRef,
        ]], context);
        const pageNode = createForeignDict([[
            'Resources',
            resources,
        ]], context);
        const page = Object.assign(Object.create(PDFPage.prototype), {
            doc: {context},
            node: pageNode,
        });

        const resolvedResources = safePdfPageInheritableDict(page, PDFName.of('Resources'));
        if (!resolvedResources) {
            throw new Error('Expected a foreign resources dictionary');
        }
        expect(resolvedResources).toBe(resources);
        expect(safePdfDictLookupDict(resolvedResources, PDFName.of('XObject'))).toBe(xObject);
    });

    it('does not classify string objects as names', () => {
        const context: {lookup: (value: unknown) => unknown} = {lookup: value => value};
        const dict = createForeignDict([[
            'Subtype',
            PDFString.of('Form'),
        ]], context);

        expect(safePdfDictLookupName(dict, PDFName.of('Subtype'))).toBeNull();
    });

    it('does not classify numeric records as refs without the PDFRef tag', () => {
        const context = PDFContext.create();
        const xObject = createForeignDict([], context);
        context.assign(PDFRef.of(7), xObject);
        const ordinaryRecord = {
            generationNumber: 0,
            objectNumber: 7,
        };

        expect(safePdfContextLookupDict(context, ordinaryRecord)).toBeNull();
    });
});
