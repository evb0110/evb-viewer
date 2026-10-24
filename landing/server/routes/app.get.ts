export default defineEventHandler((event) => {
    const hostname = getRequestURL(event).hostname;
    const target = hostname.endsWith('.vercel.app')
        ? 'https://evb-viewer-web.vercel.app'
        : useRuntimeConfig(event).public.webAppUrl;

    setHeader(event, 'cache-control', 'private, no-store');
    return sendRedirect(event, target, 302);
});
