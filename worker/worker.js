// MYC · pasarela privada (Cloudflare Worker, sin dependencias).
// - Verifica la cuenta de Google UNA vez y entrega una sesión firmada de 90 días.
// - Firma cada petición hacia Apps Script con GATEWAY_SECRET (igual que antes).
// - Guarda las suscripciones push en KV (MYC_KV) y, con el cron, envía los avisos.
// Variables: GOOGLE_CLIENT_ID, ALLOWED_USERS, GATEWAY_SECRET, APP_ORIGIN, APPS_SCRIPT_URL.
// Enlace KV: MYC_KV. Cron: */5 * * * *.

const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX_BODY = 15e5;
const SESSION_DAYS = 90;
const SESSION_RENEW_DAYS = 30;
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
const USER_ACTIONS = ['login', 'snapshot', 'mutate', 'receipt', 'push-key', 'push-subscribe', 'push-unsubscribe', 'push-test'];

class HttpError extends Error {
  constructor(status, message, code = 'ERROR') { super(message); this.status = status; this.code = code; }
}

// ---------- utilidades ----------
const b64u = bytes => { let s = ''; const b = new Uint8Array(bytes); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = str => { const s = str.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(s + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(bin, c => c.charCodeAt(0)); };
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}
function safeEqual(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

function configuration(env) {
  const allowed = JSON.parse(env.ALLOWED_USERS || '{}');
  if (!env.APP_ORIGIN || new URL(env.APP_ORIGIN).origin !== env.APP_ORIGIN || !env.APP_ORIGIN.startsWith('https://') || !env.GOOGLE_CLIENT_ID || !env.GATEWAY_SECRET || env.GATEWAY_SECRET.length < 43 || Object.keys(allowed).length !== 2) throw new Error('Configuración incompleta.');
  const url = new URL(env.APPS_SCRIPT_URL);
  if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname)) throw new Error('Configuración incompleta.');
  return allowed;
}

// ---------- identidad de Google (solo al entrar) ----------
let certCache = { keys: null, until: 0 };
async function googleKeys(force = false) {
  if (!force && certCache.keys && Date.now() < certCache.until) return certCache.keys;
  const r = await fetch(GOOGLE_CERTS, { cf: { cacheTtl: 3600 } });
  if (!r.ok) throw new HttpError(503, 'Google no responde. Reintenta en un momento.', 'UPSTREAM');
  const maxAge = Number((r.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
  certCache = { keys: (await r.json()).keys, until: Date.now() + Math.min(maxAge, 21600) * 1000 };
  return certCache.keys;
}
function actorFor(env, sub, emailRaw, emailVerified) {
  const users = JSON.parse(env.ALLOWED_USERS);
  const email = emailVerified === true && typeof emailRaw === 'string' && emailRaw.toLowerCase().endsWith('@gmail.com') ? emailRaw.toLowerCase() : '';
  const key = Object.hasOwn(users, sub) ? sub : email && Object.hasOwn(users, email) ? email : null;
  if (typeof sub !== 'string' || !/^\d{10,30}$/.test(sub) || !key || !['Carlos', 'María'].includes(users[key])) throw new HttpError(403, 'Esta cuenta no tiene acceso a MYC.', 'FORBIDDEN');
  return { sub, name: users[key], ...(email ? { email } : {}) };
}
async function verifyGoogle(token, env) {
  try {
    const [h, p, s] = token.split('.');
    const header = JSON.parse(dec.decode(unb64u(h)));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw 0;
    let jwk = (await googleKeys()).find(k => k.kid === header.kid);
    if (!jwk) jwk = (await googleKeys(true)).find(k => k.kid === header.kid);
    if (!jwk) throw 0;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64u(s), enc.encode(h + '.' + p))) throw 0;
    const c = JSON.parse(dec.decode(unb64u(p)));
    const now = Math.floor(Date.now() / 1000);
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(c.iss) || c.aud !== env.GOOGLE_CLIENT_ID || !(c.exp > now - 5) || !(c.iat <= now + 5) || now - c.iat > 65 * 60) throw 0;
    return actorFor(env, c.sub, c.email, c.email_verified);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(401, 'No se ha podido comprobar tu cuenta de Google. Vuelve a entrar.', 'UNAUTHORIZED');
  }
}

// ---------- sesión propia (90 días) ----------
async function sessionKey(env) { return hmac(enc.encode(env.GATEWAY_SECRET), enc.encode('myc-session-v1')); }
async function epochFor(env, name) { return env.MYC_KV ? Number(await env.MYC_KV.get('epoch:' + name) || 0) : 0; }
async function issueSession(env, actor) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: actor.sub, name: actor.name, ...(actor.email ? { email: actor.email } : {}), iat: now, exp: now + SESSION_DAYS * 86400, ep: await epochFor(env, actor.name) };
  const body = 'myc1.' + b64u(enc.encode(JSON.stringify(claims)));
  return { token: body + '.' + b64u(await hmac(await sessionKey(env), enc.encode(body))), exp: claims.exp * 1000 };
}
async function verifySession(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Tu sesión no es válida. Vuelve a entrar.', 'UNAUTHORIZED');
  const body = parts[0] + '.' + parts[1];
  const expected = b64u(await hmac(await sessionKey(env), enc.encode(body)));
  if (!safeEqual(expected, parts[2])) throw new HttpError(401, 'Tu sesión no es válida. Vuelve a entrar.', 'UNAUTHORIZED');
  let c; try { c = JSON.parse(dec.decode(unb64u(parts[1]))); } catch { throw new HttpError(401, 'Tu sesión no es válida. Vuelve a entrar.', 'UNAUTHORIZED'); }
  const now = Math.floor(Date.now() / 1000);
  if (!(c.exp > now)) throw new HttpError(401, 'Tu sesión ha caducado. Vuelve a entrar con Google.', 'UNAUTHORIZED');
  const actor = actorFor(env, c.sub, c.email, !!c.email); // si os quitan de ALLOWED_USERS, la sesión deja de valer
  if (actor.name !== c.name || (c.ep || 0) !== await epochFor(env, actor.name)) throw new HttpError(401, 'Tu sesión se ha cerrado. Vuelve a entrar.', 'UNAUTHORIZED');
  return { actor, renew: now - c.iat > SESSION_RENEW_DAYS * 86400 };
}

// ---------- Apps Script ----------
async function signEnvelope(env, actor, action, payload) {
  const body = JSON.stringify({ actor, action, payload });
  const timestamp = Date.now();
  const nonce = crypto.randomUUID();
  const signature = hex(await hmac(enc.encode(env.GATEWAY_SECRET), enc.encode(`${timestamp}\n${nonce}\n${body}`)));
  return { body, timestamp, nonce, signature };
}
async function callScript(env, actor, action, payload) {
  const envelope = await signEnvelope(env, actor, action, payload);
  let response;
  try {
    response = await fetch(env.APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope), redirect: 'follow', signal: AbortSignal.timeout(25e3) });
  } catch { throw new HttpError(504, 'Google tarda en responder. Puedes reintentar sin duplicar el registro.', 'TIMEOUT'); }
  let result;
  try { result = await response.json(); } catch { throw new HttpError(502, 'Apps Script no ha devuelto una respuesta válida.', 'UPSTREAM'); }
  if (!response.ok || !result || typeof result.ok !== 'boolean') throw new HttpError(502, 'No se ha podido conectar con Google.', 'UPSTREAM');
  if (!result.ok) {
    const status = { CONFLICT: 409, INVALID: 400, NOT_FOUND: 404, FORBIDDEN: 403, BUSY: 503 }[result.code] || 502;
    throw new HttpError(status, status === 502 ? 'No se ha podido completar la operación.' : result.error, result.code);
  }
  return result.data;
}

async function readJson(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Se requiere JSON.');
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw new HttpError(413, 'La fotografía es demasiado grande.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Falta el contenido.');
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new HttpError(413, 'La fotografía es demasiado grande.'); }
    chunks.push(value);
  }
  try { return JSON.parse(dec.decode(concat(...chunks))); } catch { throw new HttpError(400, 'JSON no válido.'); }
}

// ---------- Web Push (RFC 8291 + VAPID) ----------
async function vapidKeys(env) {
  const saved = await env.MYC_KV.get('vapid', 'json');
  if (saved) return saved;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const keys = { publicKey: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
  await env.MYC_KV.put('vapid', JSON.stringify(keys));
  return keys;
}
async function vapidHeader(env, endpoint) {
  const keys = await vapidKeys(env);
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.APP_ORIGIN })));
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + claims));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}
async function encryptPush(subscription, text) {
  const uaPublic = unb64u(subscription.keys.p256dh);
  const authSecret = unb64u(subscription.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(enc.encode(text), new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPublic.length]), asPublic, cipher);
}
async function sendPush(env, subscription, message) {
  const body = await encryptPush(subscription, JSON.stringify(message));
  const r = await fetch(subscription.endpoint, { method: 'POST', headers: { Authorization: await vapidHeader(env, subscription.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' }, body });
  return r.status;
}
function validSubscription(s) {
  if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 1000 || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') return false;
  let u; try { u = new URL(s.endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || !PUSH_HOSTS.some(rx => rx.test(u.hostname))) return false;
  try { return unb64u(s.keys.p256dh).length === 65 && unb64u(s.keys.auth).length === 16; } catch { return false; }
}
async function subscriptions(env, name) { return (await env.MYC_KV.get('push:' + name, 'json')) || []; }
async function notify(env, name, message) {
  const list = await subscriptions(env, name);
  if (!list.length) return 0;
  const keep = []; let sent = 0;
  for (const s of list) {
    let status = 0;
    try { status = await sendPush(env, s, message); } catch { status = 0; }
    if (status >= 200 && status < 300) sent++;
    if (status !== 404 && status !== 410) keep.push(s); // suscripción caducada → se borra
  }
  if (keep.length !== list.length) await env.MYC_KV.put('push:' + name, JSON.stringify(keep));
  return sent;
}

async function pushAction(env, actor, action, payload) {
  if (!env.MYC_KV) throw new HttpError(503, 'Los avisos aún no están activados en el servidor.', 'CONFIGURATION');
  if (action === 'push-key') return { publicKey: (await vapidKeys(env)).publicKey };
  if (action === 'push-subscribe') {
    const s = payload?.subscription;
    if (!validSubscription(s)) throw new HttpError(400, 'Este navegador no ha dado una suscripción válida.', 'INVALID');
    const list = (await subscriptions(env, actor.name)).filter(x => x.endpoint !== s.endpoint);
    list.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, added: new Date().toISOString() });
    await env.MYC_KV.put('push:' + actor.name, JSON.stringify(list.slice(-6)));
    return { subscribed: true };
  }
  if (action === 'push-unsubscribe') {
    const endpoint = payload?.endpoint;
    const list = await subscriptions(env, actor.name);
    await env.MYC_KV.put('push:' + actor.name, JSON.stringify(list.filter(x => x.endpoint !== endpoint)));
    return { subscribed: false };
  }
  if (action === 'push-test') {
    const sent = await notify(env, actor.name, { title: 'MYC · Avisos activados', body: `Así te llegarán los recordatorios, ${actor.name} ♡`, tag: 'myc-test', url: './?section=tasks' });
    if (!sent) throw new HttpError(409, 'No hay ningún móvil con avisos activados para ti.', 'NO_DEVICES');
    return { sent };
  }
}

// ---------- recordatorios (cron) ----------
function madridParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
}
function madridToUtc(date, time) {
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall;
  for (let i = 0; i < 2; i++) guess = wall - (madridParts(guess) - guess);
  return guess;
}
async function runReminders(env) {
  if (!env.MYC_KV) return;
  configuration(env);
  const tasks = await callScript(env, { system: true, sub: 'system', name: 'MYC' }, 'reminders', {});
  const now = Date.now();
  for (const t of tasks || []) {
    if (!t.due || !/^\d{4}-\d{2}-\d{2}$/.test(t.due)) continue;
    const time = /^\d{2}:\d{2}$/.test(t.time || '') ? t.time : '09:00';
    // remind: lista de minutos de antelación; los recordatorios antiguos (sin campo) avisan a la hora.
    const leads = t.remind === undefined ? [0] : (Array.isArray(t.remind) ? t.remind : [t.remind]).map(Number).filter(n => [0, 15, 60, 1440].includes(n));
    for (const lead of leads) {
      const at = madridToUtc(t.due, time) - lead * 60000;
      // Solo avisa en la ventana de cada aviso (antes de que llegue el siguiente o, para «a la hora», en las 6 h siguientes).
      const windowMs = lead === 0 ? 6 * 3600 * 1000 : Math.min(lead, 60) * 60000;
      if (now < at || now - at > windowMs) continue;
      const key = `sent:${t.id}:${t.due}T${time}:${lead}`;
      if (await env.MYC_KV.get(key)) continue;
      await env.MYC_KV.put(key, '1', { expirationTtl: 8 * 86400 });
      const when = lead === 1440 ? 'Mañana' + (t.time ? ' a las ' + t.time : '') : lead ? `En ${lead === 60 ? '1 hora' : lead + ' minutos'}` + (t.time ? ' (' + t.time + ')' : '') : 'Ahora' + (t.time ? ' · ' + t.time : '');
      const people = t.assignedTo === 'Ambos' ? ['Carlos', 'María'] : [t.assignedTo];
      for (const name of people) {
        await notify(env, name, { title: '⏰ ' + t.title, body: when + ' · ' + (t.assignedTo === 'Ambos' ? 'para los dos' : 'te toca a ti') + (t.notes ? ' · ' + t.notes.slice(0, 80) : ''), tag: `myc-${t.id}-${lead}`, url: './?section=tasks' });
      }
    }
  }
}

// ---------- HTTP ----------
async function handle(request, env) {
  const origin = request.headers.get('Origin');
  const headers = { 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  const respond = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
  try {
    configuration(env);
    if (origin !== env.APP_ORIGIN) return respond({ error: 'Origen no autorizado.', code: 'FORBIDDEN' }, 403);
    headers['Access-Control-Allow-Origin'] = origin;
    if (request.method === 'OPTIONS') {
      const asked = (request.headers.get('Access-Control-Request-Headers') || '').toLowerCase().split(',').map(h => h.trim()).filter(Boolean);
      if (request.headers.get('Access-Control-Request-Method') !== 'POST' || asked.some(h => !['authorization', 'content-type'].includes(h))) throw new HttpError(403, 'Solicitud no permitida.');
      return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' } });
    }
    if (request.method !== 'POST') throw new HttpError(405, 'Método no permitido.');
    if (new URL(request.url).pathname !== '/api') throw new HttpError(404, 'Ruta no encontrada.');
    const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
    if (!token || token.length > 1e4) throw new HttpError(401, 'Inicia sesión para entrar.', 'UNAUTHORIZED');
    const input = await readJson(request);
    const action = input?.action;
    if (!USER_ACTIONS.includes(action)) throw new HttpError(400, 'Operación no válida.');

    let actor, session = null;
    if (token.startsWith('myc1.')) {
      if (action === 'login') throw new HttpError(400, 'Ya has iniciado sesión.');
      const v = await verifySession(token, env);
      actor = v.actor;
      if (v.renew) session = await issueSession(env, actor);
    } else {
      actor = await verifyGoogle(token, env); // compatibilidad con la versión anterior de la web
      if (action === 'login') session = await issueSession(env, actor);
    }

    if (action.startsWith('push-')) return respond({ ok: true, data: await pushAction(env, actor, action, input.payload || {}), user: actor.name, ...(session ? { session } : {}) });

    const data = await callScript(env, actor, action === 'login' ? 'snapshot' : action, input.payload || {});
    if (action === 'receipt') {
      if (data?.mime !== 'image/jpeg' || typeof data.base64 !== 'string' || data.base64.length > 135e4) throw new HttpError(502, 'Ticket no válido.');
      const bytes = Uint8Array.from(atob(data.base64), c => c.charCodeAt(0));
      return new Response(bytes, { headers: { ...headers, 'Content-Type': 'image/jpeg', 'Content-Disposition': 'inline; filename="ticket.jpg"' } });
    }
    return respond({ ok: true, data, user: actor.name, ...(session ? { session } : {}) });
  } catch (e) {
    return respond({ error: e instanceof HttpError ? e.message : 'El servicio aún no está configurado correctamente.', code: e instanceof HttpError ? e.code : 'CONFIGURATION' }, e instanceof HttpError ? e.status : 503);
  }
}

export default {
  fetch: handle,
  async scheduled(event, env, ctx) { ctx.waitUntil(runReminders(env).catch(e => console.error('Recordatorios:', e?.message || e))); },
};
