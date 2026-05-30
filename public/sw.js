const CACHE = 'kidstime-v2';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/'])));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'KidsTime', {
      body: data.body || '',
      icon: '/favicon.ico',
      tag: data.tag || 'kidstime',
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(cs => {
    if (cs.length) cs[0].focus();
    else clients.openWindow('/');
  }));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.host.includes('supabase')) return; // Supabase géré côté app

  // Assets statiques Next.js → cache en priorité
  if (url.pathname.startsWith('/_next/static/')) {
    e.respondWith(
      caches.match(e.request).then(cached =>
        cached || fetch(e.request).then(resp => {
          caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
          return resp;
        })
      )
    );
    return;
  }

  // Pages HTML → réseau en priorité, cache en secours
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        if (resp.ok) caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
