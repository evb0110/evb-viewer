import {isBrowserPlatformActive} from '@app/utils/platform';

export function shouldHandleRendererMenuAccelerators() {
    return isBrowserPlatformActive();
}
