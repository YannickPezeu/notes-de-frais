// Connexion EPFL : Entra ID en OpenID Connect (code d'autorisation + PKCE), sans dépendance.
// La session est un cookie signé (HMAC) : rien n'est stocké côté serveur.
//
// sesame.epfl.ch et expert-finder.epfl.ch sont le même « site » (epfl.ch) : le cookie de
// session (SameSite=Lax) accompagne donc aussi les appels du script chargé dans sesame.
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

export class AuthError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function sameString(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function readCookie(header, name) {
  return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(header || '')?.[1];
}

/** Valeur signée `<charge utile>.<hmac>`, avec expiration `exp` (secondes). */
export function signer(secret) {
  const mac = (s) => b64u(createHmac('sha256', secret).update(s).digest());
  return {
    sign(obj) {
      const payload = b64u(JSON.stringify(obj));
      return `${payload}.${mac(payload)}`;
    },
    unsign(value) {
      const [payload, sig] = String(value || '').split('.');
      if (!payload || !sig || !sameString(sig, mac(payload))) return null;
      try {
        const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return obj.exp > now() ? obj : null;
      } catch { return null; }
    },
  };
}

// Messages Entra fréquents, traduits pour l'usager.
function entraMessage(error, description = '') {
  if (/AADSTS50105|AADSTS50177/.test(description)) return 'Votre compte n’est pas autorisé pour ce service (phase de test réservée à quelques personnes).';
  if (error === 'access_denied') return 'Connexion refusée ou annulée.';
  return `Connexion EPFL impossible (${error}).`;
}

/**
 * config : { tenantId, clientId, clientSecret, sessionSecret, authority?, sessionHours?, fetchImpl? }
 * `authority` par défaut : https://login.microsoftonline.com/<tenant>/v2.0 (remplacé dans les tests).
 */
export function createAuth({ tenantId, clientId, clientSecret, sessionSecret, authority, sessionHours = 12, fetchImpl = fetch }) {
  if (!clientId || !clientSecret || !sessionSecret || sessionSecret.length < 32) {
    throw new Error('Entra ID : ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET et SESSION_SECRET (32 caractères au moins) sont requis');
  }
  authority = (authority || `https://login.microsoftonline.com/${tenantId}/v2.0`).replace(/\/$/, '');
  const { sign, unsign } = signer(sessionSecret);
  let discovery = null;
  let keys = null; // kid → clé publique
  let keysAt = 0;

  async function getJson(url, init) {
    const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new AuthError(`Entra : ${body.error_description?.split('\r')[0] || body.error || `HTTP ${r.status}`}`, 502);
    return body;
  }

  async function config() {
    discovery ??= await getJson(`${authority}/.well-known/openid-configuration`).catch((e) => { discovery = null; throw e; });
    return discovery;
  }

  async function publicKey(kid) {
    // Clés relues toutes les 24 h, ou plus tôt si une clé inconnue apparaît (Entra les fait
    // tourner), mais au plus une fois toutes les 5 minutes.
    const age = Date.now() - keysAt;
    if (!keys || age > 86_400_000 || (!keys.has(kid) && age > 300_000)) {
      const { jwks_uri } = await config();
      const { keys: list = [] } = await getJson(jwks_uri);
      keys = new Map(list.filter((k) => k.kty === 'RSA').map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]));
      keysAt = Date.now();
    }
    const key = keys.get(kid);
    if (!key) throw new AuthError('jeton Entra signé par une clé inconnue', 401);
    return key;
  }

  /** Vérifie signature (RS256), émetteur, audience, dates et nonce du jeton d'identité. */
  async function verifyIdToken(idToken, nonce) {
    const [h, p, s] = String(idToken || '').split('.');
    const part = (x) => { try { return JSON.parse(Buffer.from(x, 'base64url').toString('utf8')); } catch { return null; } };
    const header = h && p && s ? part(h) : null;
    if (!header) throw new AuthError('jeton Entra mal formé', 401);
    if (header.alg !== 'RS256') throw new AuthError('algorithme de jeton refusé', 401);
    const ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), await publicKey(header.kid), Buffer.from(s, 'base64url'));
    if (!ok) throw new AuthError('signature du jeton Entra invalide', 401);
    const c = part(p) || {};
    const { issuer } = await config();
    const t = now();
    if (c.iss !== issuer) throw new AuthError('émetteur du jeton inattendu', 401);
    if (c.aud !== clientId || (c.azp && c.azp !== clientId)) throw new AuthError('jeton destiné à une autre application', 401);
    if (!(c.exp > t - 60) || (c.nbf && c.nbf > t + 60)) throw new AuthError('jeton Entra expiré', 401);
    if (!nonce || !sameString(c.nonce || '', nonce)) throw new AuthError('jeton Entra rejoué (nonce)', 401);
    if (tenantId && c.tid && c.tid !== tenantId) throw new AuthError('compte d’un autre annuaire', 403);
    return c;
  }

  return {
    sessionMaxAge: sessionHours * 3600,

    /** Début de connexion → URL Entra + cookie de transaction (state, nonce, vérificateur PKCE). */
    async begin(redirectUri, popup) {
      const { authorization_endpoint } = await config();
      const tx = { state: b64u(randomBytes(16)), nonce: b64u(randomBytes(16)), verifier: b64u(randomBytes(32)), popup: Boolean(popup), exp: now() + 600 };
      const url = new URL(authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: clientId, response_type: 'code', response_mode: 'query', redirect_uri: redirectUri,
        scope: 'openid profile email', state: tx.state, nonce: tx.nonce,
        code_challenge: b64u(createHash('sha256').update(tx.verifier).digest()), code_challenge_method: 'S256',
      });
      return { location: url.href, txCookie: sign(tx) };
    },

    /** Retour d'Entra → utilisateur { sub, name, email } et cookie de session ; popup ou non. */
    async complete(query, txCookie, redirectUri) {
      const tx = unsign(txCookie);
      if (query.get('error')) throw new AuthError(entraMessage(query.get('error'), query.get('error_description') || ''), 403);
      if (!tx) throw new AuthError('connexion expirée ou commencée dans un autre navigateur : recommencez', 400);
      if (!sameString(query.get('state') || '', tx.state)) throw new AuthError('réponse de connexion inattendue (state) : recommencez', 400);
      const { token_endpoint } = await config();
      const tokens = await getJson(token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code',
          code: query.get('code') || '', redirect_uri: redirectUri, code_verifier: tx.verifier,
        }),
      });
      const c = await verifyIdToken(tokens.id_token, tx.nonce);
      // oid : identifiant stable de la personne dans l'annuaire (sub varie selon l'application).
      const user = { sub: c.oid || c.sub, name: c.name || '', email: c.email || c.preferred_username || '' };
      return { user, popup: tx.popup, sessionCookie: sign({ ...user, exp: now() + sessionHours * 3600 }) };
    },

    /** Utilisateur de la session, ou null (absente, falsifiée, expirée). */
    user(cookieHeader) {
      const s = unsign(readCookie(cookieHeader, 'ndf_session'));
      return s ? { sub: s.sub, name: s.name, email: s.email } : null;
    },
  };
}
