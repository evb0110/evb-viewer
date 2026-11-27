<script setup lang="ts">
import {resolveInitialDesktopRuntime} from '@app/utils/platform';

const route = useRoute();

if (import.meta.server) {
    useSeoMeta({robots: 'noindex, nofollow'});
}

if (import.meta.client && resolveInitialDesktopRuntime(route.path)) {
    await navigateTo('/electron', {replace: true});
} else {
    await navigateTo('/', {replace: true});
}
</script>
