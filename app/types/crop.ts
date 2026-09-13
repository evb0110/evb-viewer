import type { ILocalRect } from '@app/modules/document-viewer/public';
import type { ICropMargins } from '@contracts/shared';
import type { TPageSelection } from '@contracts/pageNumbers';

export type {
    ICropMargins,
    IPdfBox,
    IPageGeometry,
} from '@contracts/shared';

export interface ICropSelectionResult {
    pageNumber: number;
    pageRect: {
        width: number;
        height: number;
    };
    pageLocalRect: ILocalRect;
}

export interface ICropApplyPayload {
    margins: ICropMargins;
    pages: number[];
    pageSelection?: TPageSelection;
}

export interface ICropRemovePayload {
    pages: number[];
    pageSelection?: TPageSelection;
}

export type TCropUnit = 'pt' | 'mm' | 'in';
