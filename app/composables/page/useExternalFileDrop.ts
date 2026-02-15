interface IUseExternalFileDropOptions {openPathInAppropriateTab: (path: string) => Promise<void>;}

function hasExternalFilePayload(dataTransfer: DataTransfer | null) {
    if (!dataTransfer) {
        return false;
    }
    return Array.from(dataTransfer.types).includes('Files');
}

function isSidebarDropArea(event: DragEvent) {
    if (typeof Element === 'undefined') {
        return false;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
        return false;
    }
    return Boolean(target.closest('.pdf-sidebar-pages-thumbnails'));
}

function getDroppedDocumentPaths(dataTransfer: DataTransfer | null) {
    if (!dataTransfer || !window.electronAPI) {
        return [];
    }

    const paths: string[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < dataTransfer.files.length; i++) {
        const file = dataTransfer.files[i];
        if (!file) {
            continue;
        }

        const path = window.electronAPI.getPathForFile(file);
        if (!path || seen.has(path)) {
            continue;
        }

        const lowerPath = path.toLowerCase();
        if (
            lowerPath.endsWith('.pdf')
            || lowerPath.endsWith('.djvu')
            || lowerPath.endsWith('.djv')
            || lowerPath.endsWith('.png')
            || lowerPath.endsWith('.jpg')
            || lowerPath.endsWith('.jpeg')
            || lowerPath.endsWith('.tif')
            || lowerPath.endsWith('.tiff')
            || lowerPath.endsWith('.bmp')
            || lowerPath.endsWith('.webp')
            || lowerPath.endsWith('.gif')
        ) {
            seen.add(path);
            paths.push(path);
        }
    }

    return paths;
}

export function useExternalFileDrop(options: IUseExternalFileDropOptions) {
    const { openPathInAppropriateTab } = options;

    function handleWindowDragOver(event: DragEvent) {
        if (event.defaultPrevented || isSidebarDropArea(event)) {
            return;
        }

        if (!hasExternalFilePayload(event.dataTransfer)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy';
        }
    }

    function handleWindowDrop(event: DragEvent) {
        if (event.defaultPrevented || isSidebarDropArea(event)) {
            return;
        }

        if (!hasExternalFilePayload(event.dataTransfer)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const paths = getDroppedDocumentPaths(event.dataTransfer);
        if (paths.length === 0) {
            return;
        }

        void (async () => {
            for (const path of paths) {
                await openPathInAppropriateTab(path);
            }
        })();
    }

    return {
        handleWindowDragOver,
        handleWindowDrop,
    };
}
