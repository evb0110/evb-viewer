import type { Page } from 'puppeteer-core';

export interface IRendererFrame {
    data: string;
    metadata?: {timestamp?: number};
    sessionId: number;
}

/** Shared CDP transport for bounded diagnostic captures and continuous session video. */
export async function startRendererFrameStream(
    page: Page,
    receive: (frame: IRendererFrame) => void | Promise<void>,
    options: {
        quality: number;
        maxWidth?: number;
        maxHeight?: number
    },
) {
    const client = await page.createCDPSession();
    let accepting = true;
    let pending = Promise.resolve();
    const handleFrame = (frame: IRendererFrame) => {
        if (accepting) {
            pending = pending.then(() => receive(frame));
        }
        // Acknowledge after consumption so a slow consumer cannot accumulate frames.
        const ack = () => client.send('Page.screencastFrameAck', {sessionId: frame.sessionId}).catch(() => {});
        void pending.then(ack, ack);
    };
    client.on('Page.screencastFrame', handleFrame);
    try {
        await client.send('Page.enable');
        await client.send('Page.startScreencast', {
            everyNthFrame: 1,
            format: 'jpeg',
            ...options,
        });
    } catch (error) {
        accepting = false;
        client.off('Page.screencastFrame', handleFrame);
        await client.detach().catch(() => {});
        throw error;
    }
    return {
        client,
        handleFrame,
        async stop() {
            accepting = false;
            await client.send('Page.stopScreencast').catch(() => {});
            client.off('Page.screencastFrame', handleFrame);
            try { await pending; } finally { await client.detach().catch(() => {}); }
        },
    };
}
