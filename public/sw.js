const CACHE_NAME = 'bruneau-agent-v1';
const STATIC_ASSETS = [
    '/',
    '/index.html',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});

// ===== Push Notifications =====
self.addEventListener('push', (event) => {
    let data = { title: 'Bruneau Agent', body: 'Nouvelle notification' };
    try {
        data = event.data.json();
    } catch (e) {
        data.body = event.data?.text() || 'Nouvelle notification';
    }

    const options = {
        body: data.body,
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        tag: data.tag || 'bruneau-agent',
        data: {
            url: data.url || '/?action=rdv-confirm',
        },
        vibrate: [200, 100, 200],
        requireInteraction: true,
    };

    event.waitUntil(
        self.registration.showNotification(data.title || 'Bruneau Agent', options)
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            for (const client of windowClients) {
                if (client.url.includes(self.location.origin)) {
                    client.focus();
                    client.navigate(url);
                    return;
                }
            }
            return clients.openWindow(url);
        })
    );
});
