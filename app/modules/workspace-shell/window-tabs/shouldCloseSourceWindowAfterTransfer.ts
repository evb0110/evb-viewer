export function shouldCloseSourceWindowAfterTransfer(tabCountBeforeTransfer: number, hasElectronBridge: boolean) {
    return hasElectronBridge && tabCountBeforeTransfer <= 1;
}
