export function isReusableNuxtResponse(options: {poweredBy: string | null; body: string}) {
    return (options.poweredBy?.toLowerCase() ?? '').includes('nuxt') && options.body.includes('/_nuxt/');
}
