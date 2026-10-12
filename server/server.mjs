// Serveur notes de frais — sans dépendance (Node ≥ 22).
//   GET  /              page d'installation du favori (bookmarklet), après connexion EPFL
//   GET  /login         connexion EPFL (Entra ID) ; ?popup=1 depuis sesame
//   GET  /auth/callback retour d'Entra → cookie de session
//   GET  /logout
//   GET  /ndf.js        le script chargé dans sesame par le favori (sinon : invitation à se connecter)
//   GET  /vendor/*      décodeurs PDF / HEIC / TIFF chargés par ndf.js à la demande
//   POST /extract       lecture d'un justificatif (clé RCP côté serveur)
//   POST /classify      tri d'une page de PDF (justificatif ou non, début de document…)
//   GET  /stats         compteurs d'usage anonymes (personnes, appels, jetons par jour et par mois)
//   GET  /healthz
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { extract, classify } from './extract.mjs';
import { createAuth, readCookie, sameString } from './auth.mjs';
import { RateLimiter } from './rate-limit.mjs';
import { createStats } from './stats.mjs';

const ROOT = new URL('../', import.meta.url);
const PORT = Number(process.env.PORT || 8787);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://sesame.epfl.ch').split(',').map((s) => s.trim());
// URL publique (ex. https://expert-finder.epfl.ch/notes-de-frais) ; à défaut, déduite de la requête.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
// Préfixe de chemin quand le service vit sous un hôte partagé (ex. /notes-de-frais) :
// l'ingress transmet le chemin complet, c'est à nous de l'enlever.
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');
const MAX_BODY = 9_000_000;
const PRODUCTION = process.env.NODE_ENV === 'production';
// En production, l'adresse publique est fixée : jamais déduite des en-têtes Host /
// X-Forwarded-Host, qu'un client peut falsifier (redirections, redirect_uri OIDC).
if (PRODUCTION && !PUBLIC_URL) throw new Error('PUBLIC_URL est obligatoire en production');

// Clé RCP : variable d'environnement (k8s) ou, en dev, `API-KEY=` du .env du dépôt.
function loadApiKey() {
  if (process.env.RCP_API_KEY) return process.env.RCP_API_KEY;
  const envFile = new URL('.env', ROOT);
  if (!existsSync(envFile)) return '';
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(API-KEY|RCP_API_KEY)\s*=\s*(.*)$/.exec(line);
    if (m) return m[2].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}
const API_KEY = loadApiKey();
if (!API_KEY) console.warn('⚠ RCP_API_KEY absente : /extract répondra 503.');

// Deux verrous indépendants, cumulables :
//  - connexion EPFL (Entra ID) si ENTRA_CLIENT_ID est défini : identifie la personne ;
//  - mot de passe commun si ACCESS_PASSWORD est défini : restreint la phase de test aux
//    personnes qui le connaissent (Entra ouvre à tout le personnel). À retirer au feu vert.
// Aucun des deux : tout est refusé en production (jamais d'accès libre par oubli), accès
// libre en développement local.
const auth = process.env.ENTRA_CLIENT_ID ? createAuth({
  tenantId: process.env.ENTRA_TENANT_ID,
  clientId: process.env.ENTRA_CLIENT_ID,
  clientSecret: process.env.ENTRA_CLIENT_SECRET,
  sessionSecret: process.env.SESSION_SECRET,
  authority: process.env.OIDC_AUTHORITY,
  sessionHours: Number(process.env.SESSION_HOURS || 12),
}) : null;
// Jeton dérivé du mot de passe, gardé en cookie 30 jours ; changer le mot de passe le révoque.
export const accessToken = (password) => createHmac('sha256', password).update('ndf-access-v1').digest('hex').slice(0, 32);
const PASSWORD_TOKEN = process.env.ACCESS_PASSWORD ? accessToken(process.env.ACCESS_PASSWORD) : '';
const passwordOk = (req) => !PASSWORD_TOKEN || sameString(readCookie(req.headers.cookie, 'ndf_access') || '', PASSWORD_TOKEN);
const passwordTries = new RateLimiter(10, 15 * 60_000); // 10 essais par quart d'heure et par IP
const OPEN = !auth && !PASSWORD_TOKEN;
console.warn(`accès : ${[auth && 'connexion EPFL', PASSWORD_TOKEN && 'mot de passe'].filter(Boolean).join(' + ')
  || (PRODUCTION ? '⚠ aucun verrou configuré, accès refusé à tous' : '⚠ libre (développement)')}`);

// IP du client : la DERNIÈRE valeur de X-Forwarded-For, celle qu'ajoute notre ingress (un
// seul relais devant le pod). Les premières peuvent être écrites par le client lui-même.
function clientIp(req) {
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((h) => h.trim()).filter(Boolean);
  return hops.at(-1) || req.socket.remoteAddress || '?';
}

/** Étape de connexion manquante ('entra' | 'password'), ou null si la personne peut entrer. */
function missingStep(req) {
  if (OPEN) return PRODUCTION ? 'closed' : null;
  if (auth && !auth.user(req.headers.cookie)) return 'entra';
  if (!passwordOk(req)) return 'password';
  return null;
}
/** Personne connectée ({sub, name, email}), ou null. Sans Entra, l'IP tient lieu d'identifiant. */
function currentUser(req) {
  if (missingStep(req)) return null;
  if (auth) return auth.user(req.headers.cookie);
  return OPEN ? { sub: 'dev', name: 'développement local', email: '' } : { sub: `ip:${clientIp(req)}`, name: '', email: '' };
}

// Par personne, appels au modèle (lecture + tri des pages de PDF) : un PDF de 10 pages en
// coûte ~14 (10 tris + 1 lecture par justificatif) ; une note ordinaire, une quinzaine au plus.
const perMinute = new RateLimiter(Number(process.env.RATE_PER_MINUTE || 60), 60_000);
const perDay = new RateLimiter(Number(process.env.RATE_PER_DAY || 1000), 86_400_000);

// Fichiers relus à chaque requête en dev (NDF_DEV=1), mis en cache sinon.
const DEV = process.env.NDF_DEV === '1' && !PRODUCTION; // jamais de raccourci de dev en production
const cache = new Map();
function asset(rel) {
  if (!DEV && cache.has(rel)) return cache.get(rel);
  const content = readFileSync(new URL(rel, ROOT), 'utf8');
  cache.set(rel, content);
  return content;
}

// Liste fermée, relevée au démarrage : aucun chemin venu de la requête n'atteint le disque.
const VENDOR_FILES = new Set(readdirSync(new URL('web/vendor/', ROOT), { recursive: true })
  .map((f) => String(f).replaceAll('\\', '/'))
  .filter((f) => /\.m?js$/.test(f))
  .map((f) => `/vendor/${f}`));

// Logs : les erreurs seulement, sans identité ni pseudonyme. L'usage est suivi par les
// compteurs anonymes (server/stats.mjs), pas par une ligne par appel.
const logError = (ev, fields) => console.log(JSON.stringify({ ev, ...fields }));

// Compteurs d'usage (server/stats.mjs), dans un fichier du volume persistant en production.
// STATS_SECRET : clé des empreintes, à ne jamais changer (sinon tout le monde redevient « nouveau »).
const stats = createStats({ file: process.env.STATS_FILE || '', secret: process.env.STATS_SECRET || process.env.SESSION_SECRET || randomBytes(32) });

function publicUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}${BASE_PATH}`;
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true'); // cookie de session (même site epfl.ch)
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    // Test en local : page sesame (réseau privé) → localhost.
    if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'unsafe-none', // la fenêtre de connexion doit pouvoir prévenir sesame
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function cookie(name, value, base, { path = BASE_PATH || '/', maxAge }) {
  const secure = base.startsWith('https:') ? '; Secure' : '';
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('requête trop volumineuse'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('JSON invalide'), { status: 400 }); }
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// CSP des pages HTML : rien d'externe, pas d'encadrement ; scripts en ligne autorisés
// seulement par leur empreinte (les nôtres, calculées ici), jamais un script injecté.
function csp(body) {
  const hashes = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  return ["default-src 'none'", `script-src ${hashes.join(' ') || "'none'"}`, "style-src 'unsafe-inline'", "img-src 'self' data:",
    "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'"].join('; ');
}
const html = (res, status, body, extra = {}) => send(res, status, body, 'text/html; charset=utf-8',
  { 'Cache-Control': 'no-store', 'Content-Security-Policy': csp(body), ...extra });

/** Page de l'étape de connexion manquante : bouton EPFL, ou formulaire du mot de passe. */
function loginPage(res, base, { step = 'entra', status = 200, error = '', popup = false, headers = {} } = {}) {
  let form;
  if (step === 'password') {
    form = `<form method="post" action="${escHtml(`${base}/password`)}">
      <label for="pw">Mot de passe de la phase de test</label>
      <input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
      ${popup ? '<input type="hidden" name="popup" value="1">' : ''}
      <button type="submit">Entrer</button></form>`;
  } else if (step === 'closed') {
    form = '<p>Aucune méthode de connexion n’est configurée sur ce serveur.</p>';
  } else {
    form = `<p>Connectez-vous avec votre compte EPFL.</p><a class="btn" href="${escHtml(`${base}/login${popup ? '?popup=1' : ''}`)}">Se connecter</a>`;
  }
  return html(res, status, asset('web/login.html')
    .replaceAll('{{INTRO}}', 'Service en phase de test : accès réservé.')
    .replaceAll('{{FORM}}', form)
    .replaceAll('{{ERROR}}', error ? `<p class="err" role="alert">${escHtml(error)}</p>` : ''), headers);
}

/** Connexion terminée : fenêtre ouverte depuis sesame → prévient la page ; sinon → accueil. */
function loggedIn(res, base, popup, headers = {}) {
  return popup ? html(res, 200, popupDone(), headers) : send(res, 303, '', 'text/plain', { ...headers, Location: `${base}/` });
}

async function readForm(req) {
  let text = '';
  for await (const c of req) {
    text += c;
    if (text.length > 4096) throw Object.assign(new Error('requête trop volumineuse'), { status: 413 });
  }
  return new URLSearchParams(text);
}

// Fin de connexion dans la fenêtre ouverte depuis sesame : prévient la page, puis se ferme.
function popupDone() {
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Connecté</title>
<body style="font:16px/1.5 system-ui,sans-serif;padding:32px;color:#1d1d1f">
<p>✅ Connexion réussie. Cette fenêtre va se fermer ; sinon, fermez-la et revenez dans sesame.</p>
<script>for (const o of ${JSON.stringify(ALLOWED_ORIGINS)}) { try { window.opener && window.opener.postMessage('ndf-login-ok', o); } catch (e) {} }
setTimeout(() => window.close(), 400);</script></body></html>`;
}

function bookmarklet(base) {
  // Charge le script à chaque clic (sans cache) : c'est lui qui rouvre le panneau
  // existant ou le remplace s'il date d'une version antérieure du serveur.
  return `javascript:(()=>{if(!/(^|\\.)sesame\\.epfl\\.ch$/.test(location.hostname))return alert('Ouvrez d\\'abord sesame.epfl.ch (My Travel and Expenses), puis recliquez sur ce favori.');var s=document.createElement('script');s.src='${base}/ndf.js?t='+Date.now();document.body.appendChild(s)})()`;
}

const n = (x) => Number(x || 0).toLocaleString('fr-CH');
function statsTable(head, rows) {
  if (!rows.length) return '<p class="empty">Aucune utilisation pour l\u2019instant.</p>';
  const tr = (cells, tag = 'td') => `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
  return `<table><thead>${tr(head, 'th')}</thead><tbody>${rows.map((r) => tr(r)).join('')}</tbody></table>`;
}
function statsPage({ totalUsers, days, months }, base) {
  return asset('web/stats.html')
    .replace('{{TOTAL}}', n(totalUsers))
    .replace('{{MONTHS}}', statsTable(['Mois', 'Personnes', 'dont nouvelles', 'Jours d\u2019activité', 'Jours par personne'],
      months.map((m) => [m.month, n(m.users), n(m.newUsers), n(m.activeDays), String(m.daysPerUser).replace('.', ',')])))
    .replace('{{DAYS}}', statsTable(['Jour', 'Personnes', 'dont nouvelles', 'Connexions', 'Justificatifs lus', 'Pages triées', 'Erreurs', 'Jetons envoyés', 'Jetons reçus'],
      days.slice(0, 90).map((d) => [d.day, n(d.users), n(d.newUsers), n(d.logins), n(d.extract), n(d.classify), n(d.errors), n(d.promptTokens), n(d.completionTokens)])))
    .replaceAll('{{BASE}}', escHtml(base));
}

// Empreinte du script servi : le client compare la sienne pour savoir s'il est à jour.
const versionOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  let pathname = url.pathname;
  if (BASE_PATH && (pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`))) pathname = pathname.slice(BASE_PATH.length);
  const path = pathname.replace(/\/+$/, '') || '/';
  cors(req, res);

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true, rcp: Boolean(API_KEY), auth: Boolean(auth) });

  // ── Connexion EPFL ──────────────────────────────────────────────────────
  // Point d'entrée de la connexion (depuis la page d'accueil, ou en fenêtre depuis sesame).
  if (req.method === 'GET' && path === '/login') {
    const base = publicUrl(req);
    const popup = url.searchParams.get('popup') === '1';
    const step = missingStep(req);
    if (!step) return loggedIn(res, base, popup);
    if (step !== 'entra') return loginPage(res, base, { step, popup, status: step === 'closed' ? 503 : 200 });
    const { location, txCookie } = await auth.begin(`${base}/auth/callback`, popup);
    return send(res, 302, '', 'text/plain', {
      Location: location, 'Cache-Control': 'no-store',
      'Set-Cookie': cookie('ndf_oidc', txCookie, base, { path: `${BASE_PATH}/auth`, maxAge: 600 }),
    });
  }

  if (req.method === 'GET' && path === '/auth/callback') {
    const base = publicUrl(req);
    if (!auth) return loginPage(res, base, { step: missingStep(req) || 'closed', status: 404 });
    const clearTx = cookie('ndf_oidc', '', base, { path: `${BASE_PATH}/auth`, maxAge: 0 });
    let done;
    try {
      done = await auth.complete(url.searchParams, readCookie(req.headers.cookie, 'ndf_oidc'), `${base}/auth/callback`);
    } catch (e) {
      logError('login_error', { err: e.message });
      return loginPage(res, base, { status: e.status || 400, error: e.message, headers: { 'Set-Cookie': clearTx } });
    }
    stats.login(done.user.sub);
    const headers = { 'Set-Cookie': [clearTx, cookie('ndf_session', done.sessionCookie, base, { maxAge: auth.sessionMaxAge })] };
    // Mot de passe de la phase de test encore à saisir : même fenêtre, étape suivante.
    if (!passwordOk(req)) return loginPage(res, base, { step: 'password', popup: done.popup, headers });
    return loggedIn(res, base, done.popup, headers);
  }

  if (req.method === 'POST' && path === '/password') {
    const base = publicUrl(req);
    // Pas de soumission depuis un autre site (le formulaire vient toujours de nos pages).
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && origin !== new URL(base).origin) return send(res, 403, { error: 'origine non autorisée' });
    const form = await readForm(req);
    const popup = form.get('popup') === '1';
    if (!PASSWORD_TOKEN) return loggedIn(res, base, popup);
    if (!passwordTries.take(clientIp(req))) return loginPage(res, base, { step: 'password', popup, status: 429, error: 'Trop d’essais : réessayez dans un quart d’heure.' });
    if (!sameString(accessToken(form.get('password') || ''), PASSWORD_TOKEN)) {
      return loginPage(res, base, { step: 'password', popup, status: 401, error: 'Mot de passe incorrect.' });
    }
    return loggedIn(res, base, popup, { 'Set-Cookie': cookie('ndf_access', PASSWORD_TOKEN, base, { maxAge: 2592000 }) });
  }

  if (req.method === 'GET' && path === '/logout') {
    const base = publicUrl(req);
    return send(res, 303, '', 'text/plain', { Location: `${base}/`, 'Set-Cookie': cookie('ndf_session', '', base, { maxAge: 0 }) });
  }

  // ── Page d'installation et script ───────────────────────────────────────
  if (req.method === 'GET' && path === '/') {
    const base = publicUrl(req);
    const step = missingStep(req);
    if (step) return loginPage(res, base, { step, status: step === 'closed' ? 503 : 200 });
    const user = currentUser(req);
    return html(res, 200, asset('web/index.html')
      .replaceAll('{{BOOKMARKLET}}', bookmarklet(base).replace(/&/g, '&amp;').replace(/"/g, '&quot;'))
      .replaceAll('{{WHO}}', auth ? `<p class="who">Connecté·e : ${escHtml(user.name || user.email)} · <a href="${escHtml(`${base}/logout`)}">se déconnecter</a></p>` : '')
      .replaceAll('{{BASE}}', base));
  }

  if (req.method === 'GET' && path === '/ndf.js') {
    const base = publicUrl(req);
    // Pas (ou plus) de session : invitation à se connecter, qui recharge ensuite le script.
    const src = currentUser(req) ? asset('web/ndf.js') : null;
    const js = src
      ? src.replace("'{{BASE}}'", JSON.stringify(base)).replace("'{{VERSION}}'", JSON.stringify(versionOf(src)))
      : asset('web/login-helper.js').replace("'{{BASE}}'", JSON.stringify(base));
    return send(res, 200, js, 'text/javascript; charset=utf-8', { 'Cache-Control': 'no-store' });
  }

  if (req.method === 'GET' && path === '/stats') {
    const base = publicUrl(req);
    const step = missingStep(req);
    if (step) return loginPage(res, base, { step, status: step === 'closed' ? 503 : 200 });
    return html(res, 200, statsPage(stats.summary(), base));
  }

  // Noms versionnés (pdfjs-6.3.289/…) : cache long sans risque.
  if (req.method === 'GET' && VENDOR_FILES.has(path)) {
    return send(res, 200, asset(`web${path}`), 'text/javascript; charset=utf-8', { 'Cache-Control': 'public, max-age=604800, immutable' });
  }

  // ── Appels au modèle ────────────────────────────────────────────────────
  const llm = { '/extract': extract, '/classify': classify }[path];
  if (req.method === 'POST' && llm) {
    if (!ALLOWED_ORIGINS.includes(req.headers.origin) && !DEV) return send(res, 403, { error: 'origine non autorisée' });
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: 'session EPFL expirée : recliquez sur le favori « Note de frais » pour vous reconnecter (vos lignes sont conservées)' });
    if (!API_KEY) return send(res, 503, { error: 'service non configuré (clé RCP absente)' });
    if (!perMinute.take(user.sub) || !perDay.take(user.sub)) return send(res, 429, { error: 'trop de justificatifs envoyés, réessayez dans une minute' });
    const t0 = Date.now();
    try {
      const body = await readJson(req);
      const out = await llm(body, API_KEY);
      stats.call(user.sub, path.slice(1), out.usage);
      return send(res, 200, out);
    } catch (e) {
      logError(`${path.slice(1)}_error`, { ms: Date.now() - t0, err: e.message, detail: e.detail });
      stats.call(user.sub, path.slice(1), null, false);
      return send(res, e.status || (e.upstream ? 502 : 400), { error: e.message });
    }
  }

  return send(res, 404, { error: 'introuvable' });
}

export const server = createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { error: 'erreur interne' }); });
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, () => console.log(`notes de frais : http://localhost:${PORT}  (origines autorisées : ${ALLOWED_ORIGINS.join(', ')})`));
  // PID 1 dans le conteneur : sans ce gestionnaire, SIGTERM est ignoré et k8s attend 30 s avant de tuer le pod.
  process.on('SIGTERM', () => { stats.flush(); server.close(() => process.exit(0)); });
}
