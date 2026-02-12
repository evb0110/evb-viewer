import {
    ref,
    computed,
} from 'vue';
import { useContextMenuPosition } from '@app/composables/useContextMenuPosition';

interface IPageContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    pages: number[];
}

export const usePageContextMenu = () => {
    const { clampToViewport } = useContextMenuPosition();

    const pageContextMenu = ref<IPageContextMenuState>({
        visible: false,
        x: 0,
        y: 0,
        pages: [],
    });

    const pageContextMenuStyle = computed(() => ({
        left: `${pageContextMenu.value.x}px`,
        top: `${pageContextMenu.value.y}px`,
    }));

    function showPageContextMenu(payload: {
        clientX: number;
        clientY: number;
        pages: number[];
    }) {
        const width = 220;
        const estimatedHeight = 280;
        const clamped = clampToViewport(payload.clientX, payload.clientY, width, estimatedHeight);

        pageContextMenu.value = {
            visible: true,
            x: clamped.x,
            y: clamped.y,
            pages: payload.pages,
        };
    }

    function closePageContextMenu() {
        if (!pageContextMenu.value.visible) {
            return;
        }
        pageContextMenu.value = {
            visible: false,
            x: 0,
            y: 0,
            pages: [],
        };
    }

    return {
        pageContextMenu,
        pageContextMenuStyle,
        showPageContextMenu,
        closePageContextMenu,
    };
};
