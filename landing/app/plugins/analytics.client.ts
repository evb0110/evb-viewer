export default defineNuxtPlugin(() => {
    const router = useRouter()

    router.afterEach((to) => {
        fetch('/api/analytics/page-view', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: to.path,
                referrer: document.referrer || null,
            }),
        }).catch(() => {})
    })
})
