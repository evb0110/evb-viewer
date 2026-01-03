<script setup lang="ts">
const { data: items } = await useFetch('/api/heavy-data');

const renderTime = useState('renderTime', () => new Date().toISOString());

function handleClick() {
    window.alert('Clicked!');
}
</script>

<template>
    <div class="container">
        <h1>Electron + Nuxt SSR Demo</h1>

        <div class="info-box">
            <p>
                <strong
                    >This HTML was rendered on the server (main process)</strong
                >
            </p>
            <p>Render time: {{ renderTime }}</p>
            <p>
                The content below was fetched during SSR - no loading spinner
                needed!
            </p>
        </div>

        <h2>Data from SSR:</h2>
        <ul>
            <li v-for="item in items" :key="item.id">
                {{ item.name }} - {{ item.value }}
            </li>
        </ul>

        <div class="hydration-test">
            <p>
                Hydration works: <button @click="handleClick">Click me</button>
            </p>
        </div>
    </div>
</template>

<style>
.container {
    max-width: 600px;
    margin: 40px auto;
    font-family: system-ui, sans-serif;
}

.info-box {
    background: #e8f4e8;
    border: 1px solid #4a4;
    padding: 16px;
    border-radius: 8px;
    margin: 20px 0;
}

.hydration-test {
    margin-top: 20px;
    padding: 16px;
    background: #f0f0f0;
    border-radius: 8px;
}

button {
    padding: 8px 16px;
    cursor: pointer;
}
</style>
