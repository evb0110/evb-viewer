import type {
    IRecentFile,
    ISettingsData,
} from '@app/types/shared';

export type { IRecentFile } from '@app/types/shared';
export type { ISettingsData } from '@app/types/shared';

export interface IIpcChannels {
    'dialog:openPdf': {
        args: [];
        result: string | null;
    };
    'dialog:savePdfAs': {
        args: [workingPath: string];
        result: string | null;
    };
    'dialog:saveDocxAs': {
        args: [workingPath: string];
        result: string | null;
    };
    'file:read': {
        args: [filePath: string];
        result: Uint8Array;
    };
    'file:readText': {
        args: [filePath: string];
        result: string;
    };
    'file:exists': {
        args: [filePath: string];
        result: boolean;
    };
    'file:write': {
        args: [filePath: string, data: Uint8Array];
        result: boolean;
    };
    'file:writeDocx': {
        args: [filePath: string, data: Uint8Array];
        result: boolean;
    };
    'window:setTitle': {
        args: [title: string];
        result: undefined;
    };
    'recent-files:get': {
        args: [];
        result: IRecentFile[];
    };
    'recent-files:add': {
        args: [originalPath: string];
        result: undefined;
    };
    'recent-files:remove': {
        args: [originalPath: string];
        result: undefined;
    };
    'recent-files:clear': {
        args: [];
        result: undefined;
    };
    'settings:get': {
        args: [];
        result: ISettingsData;
    };
    'settings:save': {
        args: [settings: ISettingsData];
        result: undefined;
    };
}

export interface IMenuEventCallback {(): void;}

export interface IMenuEventUnsubscribe {(): void;}

export interface IMenuEvents {
    onMenuOpenPdf: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSave: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSaveAs: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuExportDocx: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuZoomIn: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuZoomOut: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuActualSize: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuFitWidth: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuFitHeight: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuUndo: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuRedo: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuOpenSettings: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
}
