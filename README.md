# Notes de frais EPFL — saisie automatique

Photographiez ou glissez vos justificatifs dans sesame : un LLM de l'EPFL
(GLM-5.3-Flash sur RCP) les lit, vous validez un tableau, et la note de frais
est créée **en brouillon** dans *My Travel and Expenses*. Vous la relisez et la
soumettez vous-même.

Pour l'usager, il n'y a **rien à installer** : un favori (bookmarklet) à glisser
une fois dans la barre des favoris, depuis la page d'accueil du service.

## Architecture

```
navigateur, page sesame.epfl.ch                   serveur (expert-finder.epfl.ch/notes-de-frais)
┌───────────────────────────────┐                 ┌──────────────────────────────────────┐
│ clic sur le favori 🧾 ─────────┼── GET /ndf.js ─►│ web/ndf.js (panneau, logique SAP)     │
│ panneau : dépôt, tableau      │                 │                                      │
│ photos réduites ──────────────┼─ POST /extract ►│ prompt fixe + clé RCP → GLM-5.3-Flash │
│ création : OData PAOC_TRV_SRV │                 └──────────────────────────────────────┘
│ avec la session SSO de l'usager (même origine que SAP, rien ne passe par le serveur)
└───────────────────────────────┘
```

- Un site séparé ne peut pas remplir sesame (règle de même origine) : le code
  doit tourner dans la page sesame, d'où le favori. Sesame n'a pas de CSP
  (vérifié le 24.09.2026), le favori peut donc charger un script externe.
- Le serveur ne voit que les photos réduites, le temps de les lire ; il ne
  touche jamais à SAP et ne conserve rien.
- Fonctionnement de l'API sesame : [docs/api-sesame-PAOC_TRV_SRV.md](docs/api-sesame-PAOC_TRV_SRV.md)

## Développement

```bash
node --test tests/core.test.mjs tests/server.test.mjs tests/stats.test.mjs   # tests (faux RCP et faux Entra, aucun appel réel)
node tests/extract-live.mjs                             # extraction réelle sur tests/receipts/
NDF_DEV=1 node server/server.mjs                        # serveur local sur http://localhost:8787
```

La clé RCP se lit dans `.env` (`API-KEY=…`) en local, dans le secret
`notes-de-frais-secrets` en production. Pour tester en local : ouvrir
http://localhost:8787, glisser le favori, puis le cliquer dans sesame (Chrome
demande l'accès au réseau local : accepter).

**Accès** — deux verrous indépendants, cumulables (`server/auth.mjs`) :
- **connexion EPFL** si `ENTRA_CLIENT_ID` est défini (application Entra
  « notesDeFrais » de l'App Portal ; `ENTRA_TENANT_ID` et `ENTRA_CLIENT_ID` dans
  `k8s/deployment.yaml`, `ENTRA_CLIENT_SECRET` et `SESSION_SECRET` dans le secret).
  OpenID Connect + PKCE, session = cookie signé de 12 h. Depuis sesame, le script
  non connecté propose une fenêtre de connexion puis se recharge ;
- **mot de passe de la phase de test** si `ACCESS_PASSWORD` est défini (cookie de
  30 jours) : Entra ouvre à tout le personnel, le mot de passe réserve l'accès aux
  testeurs. À retirer du secret au feu vert cybersécurité / DPO.

La page `/stats` (compteurs d'usage) est réservée aux adresses de `STATS_ADMINS`
(`k8s/deployment.yaml`).

Les cookies (domaine expert-finder.epfl.ch) accompagnent les appels du script
chargé dans sesame car les deux sont sur le même site `epfl.ch`. Sans aucun
verrou : tout est refusé en production, accès libre en local.

Dossiers de validation (cybersécurité, DPO) : source en Markdown dans
`docs/dossiers/*.md`, PDF dans `docs/` via `python docs/dossiers/build_dossiers.py`
— à mettre à jour à chaque changement de flux de données, de stockage,
d'authentification ou de bibliothèque tierce.

## Déploiement

`./update.ps1` : tests → image `ic-registry.epfl.ch/mr-pezeu/notes-de-frais` →
manifestes `k8s/` (namespace `epfl-chatbot`, chemin `/notes-de-frais` sur
`expert-finder.epfl.ch`) → redémarrage → contrôle de `/healthz`.
Le secret se crée à partir de `k8s/secret.yaml.example`.

## Limites actuelles

- PDF : joints tels quels, pas encore lus automatiquement (ligne à remplir).
- Destination : toujours la valeur par défaut (Suisse). Voyage à l'étranger :
  corriger la destination dans sesame avant de soumettre.
- Pas de type « Hôtel » dans le schéma actuel : le modèle propose le type
  « autres frais de voyage » et le signale.
