import {formatWebTitleTemplate} from '@app/utils/appWindowTitle';
import {LOCALE_CODES} from '@i18n-core';

interface IUseWebSeoOptions {
    noindex?: boolean;
}

const SEO_IMAGE_PATH = '/evb-viewer-seo.png';
const SEO_IMAGE_WIDTH = 1600;
const SEO_IMAGE_HEIGHT = 1038;
const FALLBACK_WEB_SITE_URL = 'https://web.evb-viewer.com';

function normalizeSiteUrl(siteUrl: string) {
    const configured = siteUrl.trim() || FALLBACK_WEB_SITE_URL;
    const withProtocol = /^https?:\/\//iu.test(configured) ? configured : `https://${configured}`;

    try {
        const normalized = new URL(withProtocol);
        if (normalized.protocol !== 'http:' && normalized.protocol !== 'https:') {
            return `${FALLBACK_WEB_SITE_URL}/`;
        }
        normalized.hash = '';
        normalized.search = '';
        return normalized.toString().endsWith('/') ? normalized.toString() : `${normalized.toString()}/`;
    } catch {
        return `${FALLBACK_WEB_SITE_URL}/`;
    }
}

export const useWebSeo = (options: IUseWebSeoOptions = {}) => {
    const runtimeConfig = useRuntimeConfig();
    const {locale, t} = useTypedI18n();

    const siteUrl = computed(() => {
        const configuredSiteUrl = typeof runtimeConfig.public.siteUrl === 'string' ? runtimeConfig.public.siteUrl.trim() : '';
        return normalizeSiteUrl(configuredSiteUrl || FALLBACK_WEB_SITE_URL);
    });
    const canonicalUrl = computed(() => new URL('/', siteUrl.value).toString());
    const ogImageUrl = computed(() => new URL(SEO_IMAGE_PATH, siteUrl.value).toString());
    const screenshotImageUrl = computed(() => new URL(SEO_IMAGE_PATH, siteUrl.value).toString());
    const robots = computed(() =>
        options.noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
    );

    useSeoMeta({
        title: () => t('seo.title'),
        description: () => t('seo.description'),
        applicationName: () => t('app.webTitle'),
        robots: () => robots.value,
        author: 'EVB Viewer',
        ogTitle: () => t('seo.title'),
        ogDescription: () => t('seo.description'),
        ogType: 'website',
        ogSiteName: () => t('app.webTitle'),
        ogUrl: () => canonicalUrl.value,
        ogImage: () => ogImageUrl.value,
        ogImageWidth: SEO_IMAGE_WIDTH,
        ogImageHeight: SEO_IMAGE_HEIGHT,
        ogImageType: 'image/png',
        ogImageAlt: () => t('seo.previewAlt'),
        ogLocale: () => locale.value,
        twitterCard: 'summary_large_image',
        twitterTitle: () => t('seo.title'),
        twitterDescription: () => t('seo.description'),
        twitterImage: () => ogImageUrl.value,
        twitterImageAlt: () => t('seo.previewAlt'),
    });

    useHead(() => ({
        htmlAttrs: {lang: locale.value},
        titleTemplate: (title) => formatWebTitleTemplate(title, t('app.webTitle')),
        link: [
            {
                rel: 'canonical',
                href: canonicalUrl.value,
            },
        ],
        script: options.noindex
            ? []
            : [
                  {
                      key: 'ld-web-application',
                      type: 'application/ld+json',
                      innerHTML: JSON.stringify({
                          '@context': 'https://schema.org',
                          '@type': 'WebApplication',
                          '@id': `${canonicalUrl.value}#app`,
                          name: t('seo.title'),
                          applicationCategory: 'BusinessApplication',
                          applicationSubCategory: 'Document Viewer',
                          browserRequirements: 'Requires a modern web browser',
                          operatingSystem: 'Web',
                          description: t('seo.description'),
                          url: canonicalUrl.value,
                          image: ogImageUrl.value,
                          screenshot: {
                              '@type': 'ImageObject',
                              url: screenshotImageUrl.value,
                              width: SEO_IMAGE_WIDTH,
                              height: SEO_IMAGE_HEIGHT,
                              caption: t('seo.screenshotAlt'),
                          },
                          offers: {
                              '@type': 'Offer',
                              price: '0',
                              priceCurrency: 'USD',
                          },
                          featureList: [
                              t('seo.featurePdf'),
                              t('seo.featureAnnotate'),
                              t('seo.featureSearch'),
                              t('seo.featurePageOps'),
                              t('seo.featureExport'),
                              t('seo.featureMultiTab'),
                          ],
                          inLanguage: [...LOCALE_CODES],
                      }),
                  },
                  {
                      key: 'ld-website',
                      type: 'application/ld+json',
                      innerHTML: JSON.stringify({
                          '@context': 'https://schema.org',
                          '@type': 'WebSite',
                          '@id': `${canonicalUrl.value}#website`,
                          name: t('app.webTitle'),
                          url: canonicalUrl.value,
                      }),
                  },
                  {
                      key: 'ld-webpage',
                      type: 'application/ld+json',
                      innerHTML: JSON.stringify({
                          '@context': 'https://schema.org',
                          '@type': 'WebPage',
                          '@id': `${canonicalUrl.value}#webpage`,
                          name: t('seo.title'),
                          description: t('seo.description'),
                          url: canonicalUrl.value,
                          isPartOf: {'@id': `${canonicalUrl.value}#website`},
                          mainEntity: {'@id': `${canonicalUrl.value}#app`},
                          primaryImageOfPage: {
                              '@type': 'ImageObject',
                              url: ogImageUrl.value,
                          },
                          inLanguage: locale.value,
                      }),
                  },
              ],
    }));
};
