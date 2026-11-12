export interface IPdfReloadWaiterViewer {
    scrollToPage: (page: number) => void;
    getUserViewportInteractionEpoch?: () => number;
}
