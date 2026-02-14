const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
    if (context.electronPlatformName !== 'darwin') {
        return;
    }

    const appName = context.packager.appInfo.productFilename;
    const src = path.resolve(__dirname, '..', 'resources', 'icon.icns');
    const dst = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources', 'icon.icns');

    if (!fs.existsSync(src)) {
        console.warn('[afterPack] Source icon not found:', src);
        return;
    }

    fs.copyFileSync(src, dst);
    console.log('[afterPack] Restored original icon.icns (bypassing app-builder alpha corruption)');
};
