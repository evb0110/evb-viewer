import type {IPdfNativeMutationSet} from '@contracts/electronApiDocuments';
import {requirePageIndex} from '@contracts/pageNumbers';

export function createNativeMarkupMutations(): IPdfNativeMutationSet {
    return {markup: {
        overrides: [],
        hints: [{
            subtype: 'Highlight',
            pageIndex: requirePageIndex(0),
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.2,
            },
            appAnnotationId: 'app-annotation-1',
            annotationId: 'editor-markup-1',
            color: '#ffff00',
            id: 'markup-1',
            source: 'editor',
        }],
    }};
}

export const nativeMarkupIdentityBinding = {
    annotationId: 'app-annotation-1',
    pdfRef: '700 0 R',
};

export const nativeShapeIdentityBinding = {
    annotationId: 'shape-annotation-1',
    pdfRef: '701 0 R',
};

export function createMixedNativeMarkupAndShapeMutations(): IPdfNativeMutationSet {
    return {
        ...createNativeMarkupMutations(),
        shapes: {
            totalPages: 1,
            rewriteShapeState: true,
            shapes: [{
                type: 'rectangle',
                pageIndex: requirePageIndex(0),
                x: 0.2,
                y: 0.3,
                width: 0.2,
                height: 0.1,
                color: '#336699',
                opacity: 0.8,
                strokeWidth: 2,
                stableKey: 'shape-annotation-1',
            }],
            deletedAnnotationIds: [],
            deletedStableKeys: [],
        },
    };
}
