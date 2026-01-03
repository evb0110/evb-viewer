// Simulates a slow API call - in SSR this happens before HTML is sent
// User never sees a loading state for this data

export default defineEventHandler(async () => {
    // Simulate slow database query
    await new Promise((resolve) => setTimeout(resolve, 500));

    return [
        {
            id: 1,
            name: 'Item Alpha',
            value: Math.random().toFixed(4),
        },
        {
            id: 2,
            name: 'Item Beta',
            value: Math.random().toFixed(4),
        },
        {
            id: 3,
            name: 'Item Gamma',
            value: Math.random().toFixed(4),
        },
        {
            id: 4,
            name: 'Item Delta',
            value: Math.random().toFixed(4),
        },
        {
            id: 5,
            name: 'Item Epsilon',
            value: Math.random().toFixed(4),
        },
    ];
});
