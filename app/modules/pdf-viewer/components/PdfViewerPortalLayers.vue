<template>
    <template v-for="(links, pageNum) in linksByPage" :key="`links-${pageNum}`">
        <Teleport v-if="linkLayerTargets.get(Number(pageNum))" :to="linkLayerTargets.get(Number(pageNum))!">
            <PdfLinkOverlayLayer
                :links="links"
                @navigate-destination="handleLinkDestination"
            />
        </Teleport>
    </template>
</template>

<script setup lang="ts">
import { useMutationObserver } from '@vueuse/core';
import PdfLinkOverlayLayer from '@app/modules/pdf-viewer/components/annotations/PdfLinkOverlayLayer.vue';
import { resolvePdfViewerPortalTargets } from '@app/modules/pdf-viewer/runtime/portal/resolvePdfViewerPortalTargets';
import type { ILinkAnnotation } from '@app/types/annotations';

interface IProps {
    viewerContainer: HTMLElement | null;
    linksByPage: Record<number, ILinkAnnotation[]>;
}

const {
    linksByPage,
    viewerContainer,
} = defineProps<IProps>();

const emit = defineEmits<{'link-destination': [dest: NonNullable<ILinkAnnotation['dest']>];}>();

const portalTargetRefreshTick = ref(0);
let portalTargetRefreshFrame: number | null = null;

const linkLayerTargets = computed(() => {
    void portalTargetRefreshTick.value;
    return resolvePdfViewerPortalTargets(viewerContainer, Object.keys(linksByPage).map(Number));
});

function handleLinkDestination(dest: NonNullable<ILinkAnnotation['dest']>) {
    emit('link-destination', dest);
}

function refreshPortalTargets() {
    portalTargetRefreshTick.value += 1;
}

function cancelPortalTargetRefreshFrame() {
    if (portalTargetRefreshFrame === null || typeof window === 'undefined') {
        portalTargetRefreshFrame = null;
        return;
    }
    window.cancelAnimationFrame(portalTargetRefreshFrame);
    portalTargetRefreshFrame = null;
}

function schedulePortalTargetRefresh() {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
        refreshPortalTargets();
        return;
    }
    if (portalTargetRefreshFrame !== null) {
        return;
    }
    portalTargetRefreshFrame = window.requestAnimationFrame(() => {
        portalTargetRefreshFrame = null;
        refreshPortalTargets();
    });
}

function elementContainsPageContainer(element: Element) {
    return element.matches('.page_container')
        || Boolean(element.querySelector('.page_container'));
}

function mutationTouchesPortalTargets(records: MutationRecord[]) {
    return records.some((record) => {
        if (record.type === 'attributes') {
            return record.target instanceof Element
                && record.target.matches('.page_container');
        }

        return [
            ...record.addedNodes,
            ...record.removedNodes,
        ].some(node => node instanceof Element && elementContainsPageContainer(node));
    });
}

function handlePortalTargetMutations(records: MutationRecord[]) {
    if (mutationTouchesPortalTargets(records)) {
        schedulePortalTargetRefresh();
    }
}

function handleViewerContainerChange() {
    cancelPortalTargetRefreshFrame();
    refreshPortalTargets();
}

onMounted(refreshPortalTargets);
onBeforeUnmount(cancelPortalTargetRefreshFrame);

useMutationObserver(
    () => viewerContainer,
    handlePortalTargetMutations,
    {
        attributes: true,
        attributeFilter: [
            'class',
            'data-page',
        ],
        childList: true,
        subtree: true,
    },
);

watch(
    () => viewerContainer,
    handleViewerContainerChange,
);
</script>
