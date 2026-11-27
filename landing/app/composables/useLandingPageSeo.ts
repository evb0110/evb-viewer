import {buildAbsoluteUrl, normalizeSiteUrl, SEO_IMAGE_PATH} from '~~/shared/seo';

interface IUseLandingPageSeoOptions {
    title: () => string;
    description: () => string;
    ogTitle?: () => string;
}

export function useLandingPageSeo(options: IUseLandingPageSeoOptions) {
    const route = useRoute();
    const runtimeConfig = useRuntimeConfig();

    const siteUrl = computed(() => normalizeSiteUrl(runtimeConfig.public.siteUrl));
    const canonicalUrl = computed(() => buildAbsoluteUrl(siteUrl.value, route.path));
    const ogImage = computed(() => buildAbsoluteUrl(siteUrl.value, SEO_IMAGE_PATH));
    const ogTitle = computed(() => options.ogTitle?.() ?? options.title());
    const description = computed(() => options.description());

    useSeoMeta({
        title: () => options.title(),
        description: () => description.value,
        ogTitle: () => ogTitle.value,
        ogDescription: () => description.value,
        ogUrl: () => canonicalUrl.value,
        ogImage: () => ogImage.value,
        twitterTitle: () => ogTitle.value,
        twitterDescription: () => description.value,
        twitterImage: () => ogImage.value,
    });

    return {
        canonicalUrl,
        ogImage,
        siteUrl,
    };
}
