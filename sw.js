const CACHE='myc-shell-e9932c92a7ac';
const ROOT=new URL('./',self.location.href);
const FILES=['./','./index.html','./styles.css','./app.js','./api.js','./domain.js','./config.js','./manifest.webmanifest',...['icon-192.png','icon-512.png','apple-touch-icon.png','gastos.png','tareas.png','compra.png','mensajes.png','carlos.png','maria.png'].map(f=>'./assets/'+f)];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES.map(f=>new URL(f,ROOT).href)))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('myc-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('message',e=>{if(e.data==='SKIP_WAITING')self.skipWaiting();});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==ROOT.origin||!u.pathname.startsWith(ROOT.pathname))return;
  const isShell=FILES.some(f=>new URL(f,ROOT).pathname===u.pathname);
  if(e.request.mode==='navigate')e.respondWith(fetch(e.request).catch(()=>caches.match(new URL('./index.html',ROOT).href)));
  else if(isShell)e.respondWith(caches.open(CACHE).then(async cache=>(await cache.match(u.href))||fetch(e.request)));
});
