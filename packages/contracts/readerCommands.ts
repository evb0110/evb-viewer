export const READER_COMMAND_CATEGORIES = [
    'document',
    'view',
    'navigation',
    'annotation',
    'export',
    'history',
    'shell',
] as const;

export type TReaderCommandCategory = typeof READER_COMMAND_CATEGORIES[number];
export type TReaderCommandIconName = `ph:${string}`;

export const READER_COMMANDS = [
    'app-menu',
    'capture-region',
    'continuous-scroll',
    'crop',
    'drag-mode',
    'export-docx',
    'actual-size',
    'fit-height',
    'fit-width',
    'fullscreen',
    'ocr',
    'open-file',
    'optimize-pdf-for-interaction',
    'overflow-menu',
    'page-navigation',
    'print',
    'print-current-page',
    'quick-note',
    'redo',
    'save',
    'save-as',
    'scan-cleanup',
    'settings',
    'text-select',
    'toggle-sidebar',
    'undo',
    'view-mode',
    'zoom',
] as const;

export type TReaderCommandId = typeof READER_COMMANDS[number];
export type TReaderCommandPlacement = 'inline' | 'menu';
export type TReaderCommandMap = Readonly<Record<TReaderCommandId, boolean>>;

export interface IReaderCommandDescriptor {
    readonly id: TReaderCommandId;
    readonly category: TReaderCommandCategory;
    readonly labelKey: string;
    readonly icon: TReaderCommandIconName;
}

export interface IReaderCommandSurface {
    readonly inline: TReaderCommandMap;
    readonly menu: TReaderCommandMap;
}

export interface IReaderCommandState {
    readonly id: TReaderCommandId;
    readonly enabled: boolean;
    readonly visible: boolean;
    readonly selected?: boolean;
}

export interface IReaderCommandStateSnapshot { readonly commands: readonly IReaderCommandState[] }

export interface IReaderCommandRequest {
    id: TReaderCommandId;
    payload?: unknown;
}

export const READER_COMMAND_DESCRIPTORS = Object.freeze({
    'app-menu': {
        id: 'app-menu',
        category: 'shell',
        labelKey: 'toolbar.appMenu',
        icon: 'ph:caret-down',
    },
    'capture-region': {
        id: 'capture-region',
        category: 'export',
        labelKey: 'toolbar.captureRegion',
        icon: 'ph:scan',
    },
    'continuous-scroll': {
        id: 'continuous-scroll',
        category: 'view',
        labelKey: 'zoom.continuousScroll',
        icon: 'ph:scroll',
    },
    crop: {
        id: 'crop',
        category: 'export',
        labelKey: 'toolbar.crop',
        icon: 'ph:crop',
    },
    'drag-mode': {
        id: 'drag-mode',
        category: 'view',
        labelKey: 'zoom.handTool',
        icon: 'ph:hand',
    },
    'export-docx': {
        id: 'export-docx',
        category: 'export',
        labelKey: 'toolbar.exportDocx',
        icon: 'ph:file-text',
    },
    'actual-size': {
        id: 'actual-size',
        category: 'view',
        labelKey: 'zoom.actualSize',
        icon: 'ph:magnifying-glass',
    },
    'fit-height': {
        id: 'fit-height',
        category: 'view',
        labelKey: 'zoom.fitHeight',
        icon: 'ph:arrows-out-line-vertical',
    },
    'fit-width': {
        id: 'fit-width',
        category: 'view',
        labelKey: 'zoom.fitWidth',
        icon: 'ph:arrows-out-line-horizontal',
    },
    fullscreen: {
        id: 'fullscreen',
        category: 'shell',
        labelKey: 'toolbar.fullscreen',
        icon: 'ph:corners-out',
    },
    ocr: {
        id: 'ocr',
        category: 'export',
        labelKey: 'ocr.button',
        icon: 'ph:text-aa',
    },
    'open-file': {
        id: 'open-file',
        category: 'document',
        labelKey: 'toolbar.openPdf',
        icon: 'ph:folder-open',
    },
    'optimize-pdf-for-interaction': {
        id: 'optimize-pdf-for-interaction',
        category: 'document',
        labelKey: 'menu.optimizePdfForInteraction',
        icon: 'ph:gauge',
    },
    'overflow-menu': {
        id: 'overflow-menu',
        category: 'shell',
        labelKey: 'toolbar.moreTools',
        icon: 'ph:dots-three',
    },
    'page-navigation': {
        id: 'page-navigation',
        category: 'navigation',
        labelKey: 'annotations.page',
        icon: 'ph:caret-right',
    },
    print: {
        id: 'print',
        category: 'export',
        labelKey: 'toolbar.print',
        icon: 'ph:printer',
    },
    'print-current-page': {
        id: 'print-current-page',
        category: 'export',
        labelKey: 'toolbar.printCurrentPage',
        icon: 'ph:printer',
    },
    'quick-note': {
        id: 'quick-note',
        category: 'annotation',
        labelKey: 'annotations.createNotes',
        icon: 'ph:chat-circle-dots',
    },
    redo: {
        id: 'redo',
        category: 'history',
        labelKey: 'toolbar.redo',
        icon: 'ph:arrow-u-up-right',
    },
    save: {
        id: 'save',
        category: 'document',
        labelKey: 'toolbar.save',
        icon: 'ph:floppy-disk',
    },
    'save-as': {
        id: 'save-as',
        category: 'document',
        labelKey: 'toolbar.saveAs',
        icon: 'ph:floppy-disk-back',
    },
    'scan-cleanup': {
        id: 'scan-cleanup',
        category: 'export',
        labelKey: 'scanCleanup.button',
        icon: 'ph:scissors',
    },
    settings: {
        id: 'settings',
        category: 'shell',
        labelKey: 'toolbar.settings',
        icon: 'ph:gear',
    },
    'text-select': {
        id: 'text-select',
        category: 'view',
        labelKey: 'zoom.textSelect',
        icon: 'ph:cursor-text',
    },
    'toggle-sidebar': {
        id: 'toggle-sidebar',
        category: 'navigation',
        labelKey: 'toolbar.toggleSidebar',
        icon: 'ph:sidebar-simple',
    },
    undo: {
        id: 'undo',
        category: 'history',
        labelKey: 'toolbar.undo',
        icon: 'ph:arrow-u-up-left',
    },
    'view-mode': {
        id: 'view-mode',
        category: 'view',
        labelKey: 'zoom.sectionLayout',
        icon: 'ph:book-open',
    },
    zoom: {
        id: 'zoom',
        category: 'view',
        labelKey: 'zoom.zoomIn',
        icon: 'ph:magnifying-glass-plus',
    },
} satisfies Readonly<Record<TReaderCommandId, IReaderCommandDescriptor>>);
