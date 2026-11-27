import {compareInstallersForSelect, type IReleaseInstaller, type TReleasePlatform} from '@releaseSelection';

export function selectInstallersForPlatform(assets: IReleaseInstaller[], platform: TReleasePlatform): IReleaseInstaller[] {
    return assets.filter((asset) => asset.platform === platform).sort(compareInstallersForSelect);
}
