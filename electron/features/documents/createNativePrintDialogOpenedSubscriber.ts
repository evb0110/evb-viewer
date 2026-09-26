import type {IpcRenderer} from 'electron';
import type {
    IDocumentsFileCapability,
    IPdfNativePrintDialogOpenedEvent,
} from '@contracts/electronApiDocuments';
import {DOCUMENT_PDF_PLATFORM_FEATURE} from '@contracts/documentsPlatformFeature';
import {PDF_NATIVE_PRINT_DIALOG_OPENED_EVENT_SCHEMA} from '@contracts/pdfPathPrintOptions';
import {createTypedIpcEventSubscriber} from '@electron/preload/ipcClient';
import * as v from 'valibot';

interface INativePrintDialogEventMap {[DOCUMENT_PDF_PLATFORM_FEATURE.eventChannels.onNativePrintDialogOpened]: IPdfNativePrintDialogOpenedEvent;}

type TSubscribeToNativePrintDialogOpened = NonNullable<
    IDocumentsFileCapability['onNativePrintDialogOpened']
>;

function decodePreloadNativePrintDialogOpenedEvent(value: unknown) {
    const parsed = v.safeParse(PDF_NATIVE_PRINT_DIALOG_OPENED_EVENT_SCHEMA, value, {abortEarly: true});
    return parsed.success ? parsed.output : null;
}

export function createNativePrintDialogOpenedSubscriber(
    ipcRenderer: Partial<Pick<IpcRenderer, 'on' | 'removeListener'>>,
): TSubscribeToNativePrintDialogOpened {
    const eventSubscriber = createTypedIpcEventSubscriber<INativePrintDialogEventMap>(ipcRenderer);
    return callback => eventSubscriber.onDecodedPayload(
        DOCUMENT_PDF_PLATFORM_FEATURE.eventChannels.onNativePrintDialogOpened,
        decodePreloadNativePrintDialogOpenedEvent,
        callback,
    );
}
