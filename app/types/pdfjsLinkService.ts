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
