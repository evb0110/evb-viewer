interface ICommandLineLike {
    appendSwitch(name: string, value?: string): void;
    hasSwitch?: (name: string) => boolean;
}

interface IAppLike {commandLine: ICommandLineLike;}

export const MAC_SAFE_STORAGE_KEYCHAIN_SWITCH = 'use-mock-keychain';

export function configureMacKeychainAccess(app: IAppLike) {
    if (process.platform !== 'darwin') {
        return false;
    }

    if (app.commandLine.hasSwitch?.(MAC_SAFE_STORAGE_KEYCHAIN_SWITCH) === true) {
        return false;
    }

    app.commandLine.appendSwitch(MAC_SAFE_STORAGE_KEYCHAIN_SWITCH);
    return true;
}
