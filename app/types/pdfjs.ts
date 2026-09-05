import type { IAnnotationMarkerRect } from '@app/types/annotations';

export interface IPdfjsHighlightBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface IPdfjsDrawLayerDrawProperties {
    bbox?: [number, number, number, number];
    root?: Record<string, string | null>;
    rootClass?: Record<string, boolean>;
    path?: Record<string, string | null>;
}

export interface IPdfjsDrawLayer {
    draw: (
        properties?: IPdfjsDrawLayerDrawProperties,
        isPathUpdatable?: boolean,
        hasClip?: boolean,
    ) => {
        clipPathId?: string;
        id: number;
    };
    remove: (id: number) => void;
}

export interface IPdfjsEditorParent {
    add?: (editor: IPdfjsEditor) => unknown;
    addOrRebuild?: (editor: IPdfjsEditor) => unknown;
    addCommands?: (params: {
        __evbSkipAppHistory?: boolean;
        cmd: () => void;
        mustExec: boolean;
        undo: () => void;
    }) => unknown;
    addUndoableEditor?: (editor: IPdfjsEditor) => unknown;
    div?: HTMLElement;
    drawLayer?: IPdfjsDrawLayer;
}

export interface IPdfjsEditor {
    id?: string;
    div?: HTMLElement;
    uid?: string;
    annotationElementId?: string | null;
    comment?: string | {
        text?: string | null;
        deleted?: boolean | null;
    } | null;
    hasComment?: boolean;
    color?: string | number[] | null;
    opacity?: number;
    parentPageIndex?: number;
    pageDimensions?: [number, number];
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    isSelected?: boolean;
    _isDraggable?: boolean;
    _onResized?: () => void;
    _onResizing?: () => void;
    isInEditMode?: () => boolean;
    enableEditMode?: () => boolean;
    updateParams?: (type: number, value: unknown) => void;
    onUpdatedColor?: () => void;
    setDims?: () => void;
    fixAndSetPosition?: () => void;
    parent?: IPdfjsEditorParent;
    _uiManager?: {
        addChangedExistingAnnotation?: (editor: IPdfjsEditor) => unknown;
        rebuild?: (editor: IPdfjsEditor) => unknown;
    };
    __evbPendingAnchorRect?: IAnnotationMarkerRect | null;
    __evbCommentMarkerAnchor?: boolean;
    __evbResolvedPageIndex?: number;
    __evbPlacementAttemptId?: string | null;
    __evbCreationHistoryRegistered?: boolean;
    __evbMarkupSubtypeColor?: string | null;
    __evbMarkupBoxes?: IPdfjsHighlightBox[] | null;
    __evbSelectionText?: string | null;
    getData?: () => {
        modificationDate?: string | null;
        creationDate?: string | null;
        color?: string | number[] | null;
        opacity?: number;
    };
    toggleComment?: (isSelected: boolean, visibility?: boolean) => void;
    addToAnnotationStorage?: () => void;
    commitOrRemove?: () => void;
    focusCommentButton?: () => void;
    remove?: () => void;
    delete?: () => void;
    isEmpty?: () => boolean;
}


export interface IPdfjsL10n {
    getLanguage: () => string | Promise<string>;
    getDirection: () => 'ltr' | 'rtl' | string | Promise<'ltr' | 'rtl' | string>;
    get: (
        ids: unknown,
        args?: null,
        fallback?: unknown,
    ) => Promise<unknown>;
    translate: (element: unknown) => Promise<void>;
    translateOnce?: (element: unknown) => Promise<void>;
    destroy?: () => Promise<void>;
    pause: () => void;
    resume: () => void;
}

export interface IPdfjsLinkService {
    pagesCount: number;
    page: number;
    rotation: number;
    isInPresentationMode: boolean;
    externalLinkEnabled: boolean;
    goToDestination: (dest: string | unknown[]) => Promise<void>;
    goToPage: (page: number | string) => void;
    goToXY: (pageNumber: number, x: number, y: number, options?: object) => void;
    addLinkAttributes: (
        link: HTMLAnchorElement,
        url: string,
        newWindow?: boolean,
    ) => void;
    getDestinationHash: (dest?: string | unknown[]) => string;
    getAnchorUrl: (hash?: string) => string;
    setHash: (hash: string) => void;
    executeNamedAction: (action: string) => void;
    executeSetOCGState: (state: unknown) => void;
}
