import type {TDocumentOperationKind} from '@app/types/documentOperationKind';

export function runWithoutDocumentOperationLease<T>(_kind: TDocumentOperationKind, operation: () => Promise<T>) {
    return operation();
}
