import { isAnchoredCurrentPageSyncPdfRerenderSource } from '@app/modules/pdf-viewer/engine/pdf-rerender-protocol/pdfRerenderProtocol';

export function isAnchoredCurrentPageSyncSource(source: string) {
    return isAnchoredCurrentPageSyncPdfRerenderSource(source);
}
