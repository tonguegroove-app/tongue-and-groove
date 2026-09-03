// Stands in for `virtual:pwa-register` in the native build, where the PWA
// plugin is not loaded (see vite.config.js). A packaged app updates through the
// App Store, not a service worker; shipping one inside the wrapper would mean
// two competing update mechanisms caching the same bundle.
export const registerSW = () => () => {};
