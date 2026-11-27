import {usePositionedMenu} from '@app/composables/usePositionedMenu';
import type {IPageContextMenuState} from '@app/types/pdfContextMenu';

export const usePageContextMenu = () => {
    function createInitialPageContextMenuState(): IPageContextMenuState {
        return {
            visible: false,
            x: 0,
            y: 0,
            clickedPage: null,
            pages: [],
            selection: null,
        };
    }
    const {
        menu: pageContextMenu,
        menuStyle: pageContextMenuStyle,
        showPositionedMenu,
        resetMenu,
    } = usePositionedMenu<IPageContextMenuState>('.page-context-menu', createInitialPageContextMenuState, {
        autoDismiss: {onOutsideClick: true},
    });

    function showPageContextMenu(payload: {
        clientX: number;
        clientY: number;
        clickedPage: number;
        pages: number[];
        selection: IPageContextMenuState['selection'];
    }) {
        const fallbackWidth = 300;
        const estimatedHeight = 280;
        showPositionedMenu({
            x: payload.clientX,
            y: payload.clientY,
            fallbackWidth,
            fallbackHeight: estimatedHeight,
            buildState: (position) => ({
                visible: true,
                x: position.x,
                y: position.y,
                clickedPage: payload.clickedPage,
                pages: payload.pages,
                selection: payload.selection,
            }),
        });
    }

    function closePageContextMenu() {
        if (!pageContextMenu.value.visible) {
            return;
        }
        resetMenu();
    }

    return {
        pageContextMenu,
        pageContextMenuStyle,
        showPageContextMenu,
        closePageContextMenu,
    };
};
