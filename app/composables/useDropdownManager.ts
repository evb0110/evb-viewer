import type { Ref } from 'vue';

interface IDropdownExpose {close: () => void;}

interface IOcrPopupExpose extends IDropdownExpose {open: () => void;}

export const useDropdownManager = (deps: {
    zoomDropdownRef: Ref<IDropdownExpose | null>;
    pageDropdownRef: Ref<IDropdownExpose | null>;
    ocrPopupRef: Ref<IOcrPopupExpose | null>;
    overflowMenuRef: Ref<IDropdownExpose | null>;
}) => {
    const {
        zoomDropdownRef,
        pageDropdownRef,
        ocrPopupRef,
        overflowMenuRef,
    } = deps;

    function closeAllDropdowns() {
        zoomDropdownRef.value?.close();
        pageDropdownRef.value?.close();
        ocrPopupRef.value?.close();
        overflowMenuRef.value?.close();
    }

    function closeOtherDropdowns(except: 'zoom' | 'page' | 'ocr') {
        if (except !== 'zoom') zoomDropdownRef.value?.close();
        if (except !== 'page') pageDropdownRef.value?.close();
        if (except !== 'ocr') ocrPopupRef.value?.close();
        overflowMenuRef.value?.close();
    }

    return {
        closeAllDropdowns,
        closeOtherDropdowns,
    };
};
