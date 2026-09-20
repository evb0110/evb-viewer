import type { MaybeRefOrGetter } from 'vue';
import type { IDocumentNavigationTicket } from '@app/modules/document-viewer/public';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

interface IUseWorkspaceToolbarPageModelOptions {
    /** The physical page projection shown in the page indicator. */
    sourcePage: MaybeRefOrGetter<number>;
    /** Direct shared-surface physical projection used by the toolbar. */
    physicalPage?: MaybeRefOrGetter<number> | undefined;
    /** The shared command cursor; it is never copied into the physical indicator. */
    navigationTicket: MaybeRefOrGetter<IDocumentNavigationTicket | null>;
    goToPage: (page: number) => void;
}

export const useWorkspaceToolbarPageModel = (options: IUseWorkspaceToolbarPageModelOptions) => {
    const currentPage = computed(() => options.physicalPage
        ? toValue(options.physicalPage)
        : toValue(options.sourcePage));
    const navigationPage = computed(() => {
        const ticket = options.navigationTicket ? toValue(options.navigationTicket) : null;
        const target = ticket?.request.target;
        return target && 'page' in target ? target.page : currentPage.value;
    });

    function handleGoToPage(page: number) {
        logPdfRenderTrace('workspace-toolbar-page-commit-navigation', {
            page,
            sourcePage: currentPage.value,
        });
        options.goToPage(page);
    }

    return {
        currentPage,
        navigationPage,
        handleGoToPage,
    };
};
