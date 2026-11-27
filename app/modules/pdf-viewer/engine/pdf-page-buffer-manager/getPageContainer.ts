import type {TPageIndex} from '@contracts/pageNumbers';

export function getPageContainer(containerRoot: HTMLElement, pageIndex: TPageIndex) {
    if (pageIndex < 0) {
        return null;
    }

    const pageNumber = pageIndex + 1;
    const directMatch = containerRoot.querySelector<HTMLElement>(`.page_container[data-page="${pageNumber}"]`);
    if (directMatch) {
        return directMatch;
    }

    const mountedPages = containerRoot.querySelectorAll<HTMLElement>('.page_container');
    for (const pageContainer of mountedPages) {
        const mountedPageNumber = Number.parseInt(pageContainer.dataset.page ?? '', 10);
        if (mountedPageNumber === pageNumber) {
            return pageContainer;
        }
    }

    return null;
}
