import type {Page} from 'playwright';

export async function clickCenter(page: Page, selector: string, button: 'left' | 'right' = 'left') {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) {
        throw new Error(`${selector} has no visible box`);
    }
    // Await each input acknowledgement so one task cannot batch the whole gesture.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({button});
    await page.mouse.up({button});
}

