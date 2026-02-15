const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function hasDeveloperIdCredentials() {
    return Boolean(process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD);
}

exports.default = async function afterSign(context) {
    if (context.electronPlatformName !== 'darwin') {
        return;
    }

    if (hasDeveloperIdCredentials()) {
        return;
    }

    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(context.appOutDir, `${appName}.app`);

    if (!fs.existsSync(appPath)) {
        console.warn('[afterSign] App bundle not found:', appPath);
        return;
    }

    console.log('[afterSign] No Developer ID credentials detected, applying ad-hoc signature.');
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
};
