// Faux Entra ID pour les tests : découverte OIDC, clés publiques, point d'échange du code.
// Il signe de vrais jetons RS256 et contrôle PKCE et secret client comme le vrai.
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

export async function startFakeIdp({ tenant = 'tenant-test', clientId, clientSecret }) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }); // clé d'un imposteur
  const idp = { pending: null, claims: {}, forge: false, tokenRequests: 0 }; // claims/forge : jeton piégé au prochain échange

  const srv = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === `/${tenant}/v2.0/.well-known/openid-configuration`) {
      return json(200, { issuer: idp.issuer, authorization_endpoint: `${idp.base}/authorize`, token_endpoint: `${idp.base}/token`, jwks_uri: `${idp.base}/keys` });
    }
    if (url.pathname === '/keys') return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
    // Écran de connexion « déjà connecté » : renvoie aussitôt vers l'application (essais navigateur).
    if (url.pathname === '/authorize') {
      const { code, state, params } = idp.authorize(url.href);
      res.writeHead(302, { Location: `${params.get('redirect_uri')}?code=${code}&state=${state}` });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        idp.tokenRequests++;
        const f = new URLSearchParams(b);
        const p = idp.pending;
        if (!p || f.get('code') !== p.code) return json(400, { error: 'invalid_grant', error_description: 'AADSTS70000: code invalide' });
        if (f.get('client_id') !== clientId || f.get('client_secret') !== clientSecret) return json(401, { error: 'invalid_client' });
        const challenge = createHash('sha256').update(f.get('code_verifier') || '').digest('base64url');
        if (challenge !== p.challenge) return json(400, { error: 'invalid_grant', error_description: 'AADSTS501481: PKCE' });
        if (f.get('redirect_uri') !== p.redirect_uri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri' });
        idp.pending = null; // un code ne sert qu'une fois
        return json(200, { token_type: 'Bearer', id_token: idp.idToken({ nonce: p.nonce, ...idp.claims }, { forge: idp.forge }) });
      });
      return;
    }
    json(404, {});
  });
  await new Promise((r) => srv.listen(0, r));
  idp.base = `http://127.0.0.1:${srv.address().port}`;
  idp.authority = `${idp.base}/${tenant}/v2.0`;
  idp.issuer = `https://login.example/${tenant}/v2.0`;

  /** Jeton d'identité signé ; `forge` : signé par une autre clé. */
  idp.idToken = (claims = {}, { forge = false } = {}) => {
    const t = Math.floor(Date.now() / 1000);
    const head = b64u({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
    const body = b64u({ iss: idp.issuer, aud: clientId, tid: tenant, iat: t, nbf: t, exp: t + 3600,
      oid: 'oid-alice', sub: 'pairwise-sub', name: 'Alice Test', preferred_username: 'alice.test@epfl.ch', ...claims });
    const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), forge ? other.privateKey : privateKey).toString('base64url');
    return `${head}.${body}.${sig}`;
  };

  /** Simule l'écran de connexion Entra : lit la redirection du serveur, renvoie le code et le state. */
  idp.authorize = (location, code = 'code-ok') => {
    const u = new URL(location);
    const q = u.searchParams;
    idp.pending = { code, nonce: q.get('nonce'), challenge: q.get('code_challenge'), redirect_uri: q.get('redirect_uri') };
    return { code, state: q.get('state'), params: q, endpoint: `${u.origin}${u.pathname}` };
  };

  idp.close = () => srv.close();
  return idp;
}
