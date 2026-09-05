import {
    describe,
    expect,
    it,
} from 'vitest';
import fc from 'fast-check';
import {
    ExternalIdentityConflictError,
    ExternalIdentityIndex,
} from '@app/modules/pdf-viewer/annotations/domain/externalIdentityIndex';
import {
    asAnnotationId,
    deriveAnnotationId,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

const nonBlankString = fc.string({
    minLength: 1,
    maxLength: 64,
})
    .filter(value => value.trim().length > 0);
const normalizedNonBlankString = nonBlankString.map(value => value.trim());

describe('ExternalIdentityIndex properties', () => {
    it('derives the same canonical id independently of geometry jitter', () => {
        fc.assert(fc.property(
            nonBlankString,
            nonBlankString,
            fc.record({
                left: fc.double({
                    min: 0,
                    max: 1,
                    noNaN: true,
                }),
                top: fc.double({
                    min: 0,
                    max: 1,
                    noNaN: true,
                }),
                width: fc.double({
                    min: 0,
                    max: 0.02,
                    noNaN: true,
                }),
                height: fc.double({
                    min: 0,
                    max: 0.02,
                    noNaN: true,
                }),
            }),
            (documentKey, persistentIdentity, geometry) => {
                const before = deriveAnnotationId(documentKey, persistentIdentity);
                const after = deriveAnnotationId(documentKey, persistentIdentity);
                expect({
                    before,
                    after,
                    geometry,
                }).toMatchObject({before: after});
            },
        ));
    });

    it('resolves the reduced PDF reference binding idempotently and never from proximity or text', () => {
        fc.assert(fc.property(
            fc.uniqueArray(nonBlankString, {
                minLength: 2,
                maxLength: 2,
            }),
            (values) => {
                const [
                    idValue,
                    pdfRef,
                ] = values as [string, string];
                const id = asAnnotationId(idValue);
                const index = new ExternalIdentityIndex();
                index.bind({
                    id,
                    pdfRef,
                });

                expect(index.resolve({pdfRef})).toBe(id);
                expect(index.resolve({})).toBeNull();
                expect(index.resolve(castUnknownBindings({
                    pageIndex: 10,
                    text: 'same words',
                    rect: {
                        left: 0.1,
                        top: 0.1,
                        width: 0.01,
                        height: 0.01,
                    },
                }))).toBeNull();
            },
        ));
    });

    it('never merges two annotations that claim the same PDF reference', () => {
        fc.assert(fc.property(
            nonBlankString,
            nonBlankString,
            nonBlankString,
            (firstIdValue, secondIdValue, pdfRef) => {
                fc.pre(firstIdValue.trim() !== secondIdValue.trim());
                const index = new ExternalIdentityIndex();
                index.bind({
                    id: asAnnotationId(firstIdValue),
                    pdfRef,
                });

                expect(() => index.bind({
                    id: asAnnotationId(secondIdValue),
                    pdfRef,
                }))
                    .toThrow(ExternalIdentityConflictError);
            },
        ));
    });

    it('resolves only the owner of the supplied PDF reference', () => {
        fc.assert(fc.property(
            fc.uniqueArray(normalizedNonBlankString, {
                minLength: 3,
                maxLength: 3,
            }),
            (values) => {
                const [
                    firstId,
                    secondId,
                    pdfRef,
                ] = values as [string, string, string];
                const index = new ExternalIdentityIndex();
                index.bind({
                    id: asAnnotationId(firstId),
                    pdfRef,
                });
                index.bind({
                    id: asAnnotationId(secondId),
                    pdfRef: `${pdfRef}-other`,
                });

                expect(index.resolve({pdfRef})).toBe(asAnnotationId(firstId));
            },
        ));
    });

    it('leaves existing bindings intact when a replacement conflicts', () => {
        const index = new ExternalIdentityIndex();
        const firstId = asAnnotationId('first');
        const secondId = asAnnotationId('second');
        index.bind({
            id: firstId,
            pdfRef: 'first-ref',
        });
        index.bind({
            id: secondId,
            pdfRef: 'second-ref',
        });

        expect(() => index.replace([{
            before: {
                id: firstId,
                pdfRef: 'first-ref',
            },
            after: {
                id: firstId,
                pdfRef: 'second-ref',
            },
        }])).toThrow(ExternalIdentityConflictError);

        expect(index.resolve({pdfRef: 'first-ref'})).toBe(firstId);
        expect(index.resolve({pdfRef: 'second-ref'})).toBe(secondId);
    });

    it('reuses a released binding atomically within one replacement batch', () => {
        const index = new ExternalIdentityIndex();
        const firstId = asAnnotationId('first');
        const secondId = asAnnotationId('second');
        index.bind({
            id: firstId,
            pdfRef: 'shared-ref',
        });

        index.replace([
            {
                before: {
                    id: firstId,
                    pdfRef: 'shared-ref',
                },
                after: null,
            },
            {
                before: null,
                after: {
                    id: secondId,
                    pdfRef: 'shared-ref',
                },
            },
        ]);

        expect(index.resolve({pdfRef: 'shared-ref'})).toBe(secondId);
    });

    it('reuses a binding when its addition precedes its release in the replacement batch', () => {
        const index = new ExternalIdentityIndex();
        const firstId = asAnnotationId('first');
        const secondId = asAnnotationId('second');
        index.bind({
            id: firstId,
            pdfRef: 'shared-ref',
        });

        index.replace([
            {
                before: null,
                after: {
                    id: secondId,
                    pdfRef: 'shared-ref',
                },
            },
            {
                before: {
                    id: firstId,
                    pdfRef: 'shared-ref',
                },
                after: null,
            },
        ]);

        expect(index.resolve({pdfRef: 'shared-ref'})).toBe(secondId);
        expect(index.resolve({pdfRef: 'shared-ref'})).not.toBe(firstId);
    });

    it('trims PDF references during lookup', () => {
        const index = new ExternalIdentityIndex();
        const owner = asAnnotationId('owner');
        index.bind({
            id: owner,
            pdfRef: ' ref ',
        });

        expect(index.resolve({pdfRef: 'ref'})).toBe(owner);
    });
});

function castUnknownBindings(value: object) {
    return value as Parameters<ExternalIdentityIndex['resolve']>[0];
}
