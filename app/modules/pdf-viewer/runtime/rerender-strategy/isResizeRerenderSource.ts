import { isResizePdfRerenderSource } from '@app/modules/pdf-viewer/engine/pdf-rerender-protocol/pdfRerenderProtocol';

export function isResizeRerenderSource(source: string) {
    return isResizePdfRerenderSource(source);
}
