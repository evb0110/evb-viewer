import type { Ref } from 'vue';

type TDropdownName = 'zoom' | 'page' | 'ocr';

export const useDropdownManager = (deps: {
    zoomOpen: Ref<boolean>;
    pageOpen: Ref<boolean>;
    ocrOpen: Ref<boolean>;
}) => {
    const {
        zoomOpen,
        pageOpen,
        ocrOpen,
    } = deps;

    function setOpenState(dropdown: TDropdownName, value: boolean) {
        if (dropdown === 'zoom') {
            zoomOpen.value = value;
            return;
        }
        if (dropdown === 'page') {
            pageOpen.value = value;
            return;
        }
        ocrOpen.value = value;
    }

    function closeAllDropdowns() {
        zoomOpen.value = false;
        pageOpen.value = false;
        ocrOpen.value = false;
    }

    function closeOtherDropdowns(except: TDropdownName) {
        if (except !== 'zoom') {
            zoomOpen.value = false;
        }
        if (except !== 'page') {
            pageOpen.value = false;
        }
        if (except !== 'ocr') {
            ocrOpen.value = false;
        }
    }

    function handleDropdownOpenChange(dropdown: TDropdownName, isOpen: boolean) {
        setOpenState(dropdown, isOpen);
        if (isOpen) {
            closeOtherDropdowns(dropdown);
        }
    }

    function openDropdown(dropdown: TDropdownName) {
        handleDropdownOpenChange(dropdown, true);
    }

    return {
        closeAllDropdowns,
        closeOtherDropdowns,
        handleDropdownOpenChange,
        openDropdown,
    };
};
