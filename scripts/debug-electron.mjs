import { _electron as electron } from 'playwright';
import { fileURLToPath } from 'url';
import {
    dirname,
    join,
} from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
    console.log('Launching Electron app...');

    const electronApp = await electron.launch({
        args: [join(__dirname, '../dist-electron/main.js')],
        env: {
            ...process.env,
            NODE_ENV: 'development',
        },
    });

    // Get the first window
    const window = await electronApp.firstWindow();
    console.log('Window title:', await window.title());

    // Wait for page to load
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(3000);

    // Check if electronAPI exists
    const electronAPIExists = await window.evaluate(() => {
        return typeof window.electronAPI !== 'undefined';
    });
    console.log('electronAPI exists:', electronAPIExists);

    // Get console messages
    window.on('console', msg => {
        console.log(`[Renderer ${msg.type()}]`, msg.text());
    });

    // Try clicking the Open PDF button
    console.log('\nLooking for Open PDF button...');
    const openButton = window.locator('button:has-text("Open PDF")');
    const buttonExists = await openButton.count() > 0;
    console.log('Open PDF button exists:', buttonExists);

    if (buttonExists) {
        console.log('Clicking Open PDF button...');
        await openButton.click();
        await window.waitForTimeout(2000);
    }

    // Take a screenshot
    await window.screenshot({ path: join(__dirname, '../.devkit/debug/electron-screenshot.png') });
    console.log('Screenshot saved to .devkit/debug/electron-screenshot.png');

    // Keep app open for manual inspection
    console.log('\nApp is running. Press Ctrl+C to close.');

    // Wait indefinitely
    await new Promise(() => {});
}

main().catch(console.error);
