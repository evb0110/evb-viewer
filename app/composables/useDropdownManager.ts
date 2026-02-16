import type { Ref } from 'vue';

type TDropdownName = 'zoom' | 'page' | 'ocr' | 'overflow';

export const useDropdownManager = (deps: {
    zoomOpen: Ref<boolean>;
    pageOpen: Ref<boolean>;
    ocrOpen: Ref<boolean>;
    overflowOpen: Ref<boolean>;
}) => {
    const {
        zoomOpen,
        pageOpen,
        ocrOpen,
        overflowOpen,
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
        if (dropdown === 'ocr') {
            ocrOpen.value = value;
            return;
        }
        overflowOpen.value = value;
    }

    function closeAllDropdowns() {
        zoomOpen.value = false;
        pageOpen.value = false;
        ocrOpen.value = false;
        overflowOpen.value = false;
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
        if (except !== 'overflow') {
            overflowOpen.value = false;
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
