export interface IReaderPrintCommandState {
    hasInteractiveDocument: boolean;
    canPrint: boolean;
    isPreparingPrint: boolean;
    isAnySaving: boolean;
    isHistoryBusy: boolean;
}

export function isReaderPrintCommandDisabled(state: IReaderPrintCommandState) {
    return !state.hasInteractiveDocument || !state.canPrint || state.isPreparingPrint || state.isAnySaving || state.isHistoryBusy;
}
