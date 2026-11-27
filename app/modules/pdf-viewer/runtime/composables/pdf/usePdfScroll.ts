export type {IScrollToPageOptions} from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';

/** The page the viewport authority reports, once the authority binds it. */
export const usePdfScroll = () => {
    const currentPageProjection = shallowRef<{projection: Readonly<Ref<number>>} | null>(null);
    const currentPage = computed(() => currentPageProjection.value?.projection.value ?? 1);

    function bindCurrentPageProjection(projection: Readonly<Ref<number>>) {
        currentPageProjection.value = {projection};
    }

    return {
        currentPage,
        bindCurrentPageProjection,
    };
};
