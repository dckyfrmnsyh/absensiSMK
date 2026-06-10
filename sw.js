// =============================================
// Service Worker - Absensi PKL PWA (Supabase Version)
// =============================================

const CACHE_NAME = 'absensi-pkl-supabase-v2';
const APP_SHELL = [
    '/',
    '/index.html',
    '/manifest.json'
];

// Install - Cache app shell
self.addEventListener('install', (event) => {
    console.log('[SW] Installing Service Worker...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[SW] Caching app shell');
                return cache.addAll(APP_SHELL);
            })
            .then(() => self.skipWaiting())
    );
});

// Activate - Clean old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating Service Worker...');
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames
                    .filter(name => name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch - Cache First for app shell, Network for Supabase
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip Supabase requests (always go to network)
    if (url.hostname.includes('supabase.co')) {
        return; // Let it go to network
    }

    // Cache First + Network Fallback (better for PWA)
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                return cachedResponse;
            }

            return fetch(event.request)
                .then((response) => {
                    if (!response || response.status !== 200 || response.type !== 'basic') {
                        return response;
                    }

                    const responseToCache = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseToCache);
                    });

                    return response;
                })
                .catch(() => {
                    if (event.request.mode === 'navigate') {
                        return caches.match('/index.html');
                    }
                });
        })
    );
});

// Optional: Background Sync (future use)
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-absensi') {
        console.log('[SW] Background sync triggered');
        // You can implement real background sync here later
    }
});

// Background Sync Handler
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-absensi') {
        console.log('[SW] Background Sync triggered: sync-absensi');
        event.waitUntil(syncPendingAttendances());
    }
});

async function syncPendingAttendances() {
    // In a production app, we would read from IndexedDB here
    // and POST to Supabase. For this demo, we just log.
    console.log('[SW] Would sync pending attendances to Supabase here...');
}

console.log('%c[SW] Service Worker loaded successfully (Supabase version)', 'color:#22c55e');
