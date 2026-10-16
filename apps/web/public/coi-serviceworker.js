/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, MIT License */
let coepCredentialless = false;
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener('fetch', function (event) {
    if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') {
      return;
    }

    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.status === 0) {
            return response;
          }

          const newHeaders = new Headers(response.headers);
          newHeaders.set('Cross-Origin-Embedder-Policy', coepCredentialless ? 'credentialless' : 'require-corp');
          newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch((e) => console.error(e)),
    );
  });
} else {
  (() => {
    const coi = {
      shouldRegister: () => !window.crossOriginIsolated,
      shouldDeregister: () => false,
      doReload: () => window.location.reload(),
      quiet: false,
      ...(window.coi || {}),
    };

    const n = navigator;
    if (n.serviceWorker && coi.shouldRegister()) {
      n.serviceWorker
        .register(window.document.currentScript ? window.document.currentScript.src : 'coi-serviceworker.js')
        .then(
          (registration) => {
            if (!coi.quiet) console.log('COI ServiceWorker registered');
            registration.addEventListener('updatefound', () => {
              if (!coi.quiet) console.log('Reloading page to apply COI...');
              coi.doReload();
            });
            if (registration.active && !n.serviceWorker.controller) {
              if (!coi.quiet) console.log('Reloading page to activate COI controller...');
              coi.doReload();
            }
          },
          (err) => {
            if (!coi.quiet) console.error('COI ServiceWorker registration failed: ', err);
          },
        );
    }
  })();
}
