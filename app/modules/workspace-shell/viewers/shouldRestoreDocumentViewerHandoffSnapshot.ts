export function shouldRestoreDocumentViewerHandoffSnapshot(options: {
    fallbackPage: number;
    currentPage: number;
    pendingNavigationPage: number | null;
}) {
    return options.pendingNavigationPage === null
        && options.currentPage === options.fallbackPage;
}
