<template>
    <UContainer class="py-10">
        <h1 class="text-3xl font-bold mb-6">
            Electron + Nuxt SSR Demo
        </h1>

        <UAlert
            color="success"
            icon="i-lucide-check-circle"
            title="This HTML was rendered on the server (main process)"
            class="mb-6"
        >
            <template #description>
                <p>Render time: {{ renderTime }}</p>
                <p>The content below was fetched during SSR - no loading spinner needed!</p>
            </template>
        </UAlert>

        <UCard class="mb-6">
            <template #header>
                <h2 class="text-xl font-semibold">
                    Data from SSR
                </h2>
            </template>

            <ul class="space-y-2">
                <li
                    v-for="item in items"
                    :key="item.id"
                    class="flex justify-between"
                >
                    <span>{{ item.name }}</span>
                    <UBadge color="primary">
                        {{ item.value }}
                    </UBadge>
                </li>
            </ul>
        </UCard>

        <UCard>
            <template #header>
                <h2 class="text-xl font-semibold">
                    Hydration Test
                </h2>
            </template>

            <div class="flex items-center gap-4">
                <span>Hydration works:</span>
                <UButton
                    icon="i-lucide-mouse-pointer-click"
                    @click="handleClick"
                >
                    Click me
                </UButton>
            </div>
        </UCard>
    </UContainer>
</template>

<script setup lang="ts">
const { data: items } = await useFetch('/api/heavy-data');

const renderTime = useState('renderTime', () => new Date().toISOString());

function handleClick() {
    window.alert('Clicked!');
}
</script>
