const CACHE_NAME = 'campusync-shell-v7'
const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/campusync-logo.png?v=campusync-3',
  '/favicon.ico',
  '/favicon.svg?v=campusync-3',
  '/favicon.png?v=campusync-3',
  '/apple-touch-icon.png',
  '/icons/campusync-icon-192.png',
  '/icons/campusync-icon-512.png',
  '/icons/campusync-maskable-512.png',
  '/valencia-nhs-campus.jpg',
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => (key.startsWith('schoolguard-shell-') || key.startsWith('valencia-nhs-shell-') || key.startsWith('campusync-shell-')) && key !== CACHE_NAME).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/')) return

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone()
      void caches.open(CACHE_NAME).then((cache) => cache.put('/', copy))
      return response
    }).catch(async () => (await caches.match('/')) || Response.error()))
    return
  }

  event.respondWith(caches.match(request).then((cached) => {
    const network = fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone()
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
      }
      return response
    })
    return cached || network
  }))
})

self.addEventListener('push', (event) => {
  let data = { title: 'CampuSync update', body: 'You have a new school notification.', url: '/' }
  try { data = { ...data, ...(event.data?.json() ?? {}) } } catch { /* Use the generic notification. */ }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/icons/campusync-icon-192.png',
    badge: '/icons/campusync-icon-192.png',
    data: { url: data.url },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url ?? '/', self.location.origin).href
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => client.url === target)
    if (existing) return existing.focus()
    return self.clients.openWindow(target)
  }))
})
