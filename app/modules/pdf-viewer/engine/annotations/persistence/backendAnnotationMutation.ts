import type {AnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

export type TAnnotationMutationOperation =
    | 'prepare-free-text-appearance'
    | 'write-free-text-contents'
    | 'write-text-markup'
    | 'write-shape'
    | 'delete-annotation'
    | 'bind-identities';

export interface IBackendAnnotationMutation {
    readonly backend: 'native-append' | 'native-append' | 'native-append';
    readonly order: number;
    readonly annotationId: AnnotationId;
    readonly operation: TAnnotationMutationOperation;
    readonly fields: Readonly<Record<string, unknown>>;
}
