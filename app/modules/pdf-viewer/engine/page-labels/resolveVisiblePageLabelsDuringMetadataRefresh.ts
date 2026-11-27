export function resolveVisiblePageLabelsDuringMetadataRefresh(options: {
    pageLabels: string[] | null;
    pageLabelsResolved: boolean;
    isSaving: boolean;
    totalPages: number;
}) {
    const {pageLabels, pageLabelsResolved, isSaving, totalPages} = options;

    if (pageLabelsResolved || isSaving) {
        return pageLabels;
    }

    return pageLabels?.length === totalPages ? pageLabels : null;
}
