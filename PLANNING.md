# notesDeFrais — saisie automatique des notes de frais EPFL (sesame)

## Objectif

Les doctorants et professeurs saisissent leurs frais de voyage à la main dans
*My Travel and Expenses* (sesame.epfl.ch, SAP Fiori), une page par frais. But :
déposer les photos/PDF des justificatifs → un LLM extrait montant, devise, date,
fournisseur et type de frais → l'utilisateur valide un tableau → la note est
créée en **brouillon** (Save, jamais Submit). Doit marcher aussi sur téléphone.

## Décisions

- **24.09.2026** — Passer par l'API OData `PAOC_TRV_SRV` (service standard SAP
  derrière l'app) au lieu d'automatiser les clics. Séquence documentée dans
  [docs/api-sesame-PAOC_TRV_SRV.md](docs/api-sesame-PAOC_TRV_SRV.md).
- **24.09.2026** — Prototype = **userscript** injecté dans sesame.epfl.ch
  (session SSO + CSRF de la page, CORS interdit tout appel externe). Un seul
  fichier JS : Tampermonkey (desktop), Firefox Android + Tampermonkey, app
  « Userscripts » sur Safari iOS. Bookmarklet en secours.
- Brouillon uniquement : l'utilisateur relit et soumet lui-même.
- LLM : endpoint approuvé EPFL (RCP) — justificatifs = données personnelles.
- **24.09.2026** — Modèle `zai-org/GLM-5.3-Flash` sur `https://inference.rcp.epfl.ch/v1`
  (OpenAI-compatible, lit les images), `reasoning_effort: "low"` (seul levier
  qui marche sur GLM-5.x ; `enable_thinking:false` fait fuiter la réflexion dans
  `content`). Appel via `GM_xmlhttpRequest` (pas de CORS). Clé : v0 = clé RCP
  personnelle saisie par l'usager ; diffusion = proxy serveur + OIDC Entra comme
  DPO-Agent (`/llm/*`), jamais de clé partagée dans le script.

- **24.09.2026 — Pivot bookmarklet** (public = assistantes administratives : installer
  Tampermonkey + clé API est rédhibitoire). Un site séparé ne peut pas remplir sesame
  (même origine) → favori qui charge `ndf.js` depuis notre serveur. Test console : sesame
  n'a **aucune CSP**, script et fetch externes OK. Serveur Node sans dépendance
  (`server/`) : page d'installation, `/ndf.js`, `/extract` (clé RCP + prompt côté
  serveur, types validés strictement, origine sesame, 20/min & 300/jour par IP).
  Cible : `expert-finder.epfl.ch/notes-de-frais` (namespace `epfl-chatbot`, comme
  `/outlook`, pas de DNS à demander). Types de frais relus dans SAP à l'ouverture.
  Le userscript Tampermonkey est abandonné.
- Idée à creuser : le voyageur photographie sur téléphone (page web), l'assistante
  crée la note « pour le compte de » (`onbehalfSet`, `Onbehalfuser` dans l'API).

## Jalons

- [x] Capture HAR d'une création manuelle, séquence OData décodée (24.09.2026)
- [x] Upload d'un justificatif capturé : `POST Expenses('<id>')/Attachments` binaire + `slug` (24.09.2026)
- [ ] Capturer un voyage multi-jours/étranger (types de frais hôtel ?)
- [x] Userscript v0 écrit (24.09.2026) : `userscript/notes-de-frais.user.js` — dépôt/collage/photo,
  extraction GLM-5.3-Flash (3 en parallèle), lignes éditables + pourboire séparé + doublons,
  fonds/approbateur mémorisés, création brouillon → Save → réouverture → justificatifs → Save.
  16 tests unitaires OK (vraies réponses $batch anonymisées) ; extraction réelle OK sur 3
  justificatifs de synthèse (train CHF, resto + pourboire, taxi EUR), < 1 s chacun.
- [x] **Premier essai réel dans sesame réussi** (24.09.2026, Chrome + Tampermonkey 5.5) :
  2 justificatifs → 3 lignes (souper, pourboire, train) → note n° 10100001 enregistrée,
  2 justificatifs joints, ~9 s de bout en bout. Contrôle visuel OK : montants, dates,
  but, fonds 100 %, approbateur, note, 📎 sur Dinner et Train (pas sur Tip), total 94 CHF.
- [x] **Bookmarklet testé dans sesame** (24.09.2026, serveur local) : note n° 10100002
  créée, identique à la version Tampermonkey ; 50 types de frais relus dans SAP.
  25 tests OK (cœur + serveur contre faux RCP). Image Docker construite et testée
  (préfixe `/notes-de-frais`, uid 1000). Manifestes k8s + `update.ps1` prêts.
- [x] **Déployé** le 24.09.2026 : https://expert-finder.epfl.ch/notes-de-frais
  (ns `epfl-chatbot`, 1 pod, image `sha256:643ce138…`). Vérifié en prod : page, ndf.js
  (BASE_URL prod), CORS sesame seulement, origine étrangère 403, extraction réelle 1,1 s.
  ⚠ Secret = **clé RCP personnelle de Yannick** en attendant la validation par son chef
  d'une clé dédiée → alors : mettre à jour `k8s/secret.yaml` puis `./update.ps1`.
- [x] **Clé RCP dédiée en prod** (24.09.2026, validée par le chef ; vérifiée par empreinte,
  0,4 s comme l'ancienne). Redéployé : image `sha256:2868ace4…`, avec gestion de SIGTERM.
  Dossier cybersécurité mis à jour en conséquence.
- [x] **Fiabilité pourboire corrigée** (24.09.2026) : le modèle recopie `printed_total`,
  `items_sum` et `tip`, le code tranche (articles = total → en plus ; articles + tip =
  total → inclus ; sinon estimation + avertissement). Mesuré : 13/13 lectures justes
  (resto 44 + 4 ×9, taxi 27,40 + 2,60 EUR ×3, CFF 46), plus de remarque parasite.
- [x] Retours du test de Yannick (24.09.2026) : destination étrangère OK dans SAP ; marche
  aussi depuis la page d'accueil de sesame. Corrigé : double enregistrement (le panneau
  n'était pas vidé après succès → 2e clic = 2e note ; + empreinte des frais déjà créés
  avec confirmation) ; fermeture par clic hors du panneau / Échap, en-tête collant.
- [x] **Favori toujours à jour** (24.09.2026) : l'ancien favori rouvrait le panneau déjà
  chargé → une page sesame ouverte avant une mise à jour gardait l'ancien code (vu par
  Yannick : doublon + clic extérieur « pas corrigés » alors qu'ils l'étaient). Le favori
  recharge désormais `ndf.js` à chaque clic ; le script compare son empreinte (`VERSION`,
  injectée par le serveur) et remplace une version plus ancienne, sauf création en cours.
  ⚠ Les favoris installés AVANT ce changement gardent l'ancien comportement : à re-glisser
  (seul Yannick concerné).
- [x] **Approbateur perdu avec une destination étrangère** (note 10100003) : changer la
  destination efface l'approbateur déjà posé. Ordre de l'UI reproduit (dates →
  destination → approbateur) + contrôle avant Save (reposé, sinon avertissement).
  Dates From/To de chaque frais fixées sur la date du justificatif (les Tip
  s'étendaient sur tout le voyage). À valider dans SAP.
- [x] Validé dans SAP par Yannick (note 10100004) : approbateur conservé avec destination
  étrangère, Tip datés du bon jour ; Échap et clic extérieur OK.
- [x] **Anti-doublon via SAP, sans rien stocker** (24.09.2026) : avant création, relecture
  seule (`TravelSummaries` + `…?$expand=Claims&mode=DIS`) des notes qui chevauchent le
  voyage, comparaison type/jour/montant/devise, confirmation si doublon. Remplace
  l'historique local ; n° de personnel plus mémorisé ; anciennes clés `ndf.pernr` et
  `ndf.created` effacées au chargement. Empreinte des photos envisagée puis écartée
  (Yannick : la comparaison SAP suffit). Dossier cybersécurité mis à jour.
- [ ] Tester l'anti-doublon SAP en local, puis déployer (29 tests OK)
- [x] Dossier d'évaluation cybersécurité rédigé (24.09.2026) :
  https://claude.ai/code/artifact/0fa1c51e-2513-4151-a12f-7d1b509acbad — risque principal
  R1 (script servi = code dans la session sesame de chaque usager), 4 actions avant pilote.
- [ ] **Avis de la cybersécurité** — bloquant avant tout test par une assistante
- [ ] Premier test d'une assistante avec l'URL de prod (installation du favori seule)
- [x] Capture « voyage » (12–14.10, Berlin, EUR) analysée le 24.09.2026 : destination,
  devises (conversion par SAP), champ fournisseur `SeName` exigé par la plupart des
  types, upload sur brouillon OK (7,2 Mo refusé), n° de personnel via `UserProfiles`.
  Toujours pas de type hôtel (schéma Z2 imposé par l'app EPFL) → question aux finances.
- [x] **Intégré au script, validé dans SAP par Yannick le 24.09.2026 (serveur local)** :
  destination (pays SAP en liste déroulante + ville, déduits des justificatifs),
  fournisseur éditable → `SeName`, champs obligatoires signalés en fin de création au
  lieu de bloquer, n° de personnel via `UserProfiles`. Non déployé.
- [x] **Tous formats de justificatif** (28.09.2026) : PDF lus (pdf.js 6.3 legacy, pages 1–3
  empilées en une image, avertissement au-delà), HEIC d'iPhone (natif Safari, sinon
  heic2any), TIFF (natif Safari, sinon UTIF), JPEG/PNG/WebP/GIF/BMP/AVIF ; type reconnu
  aussi par l'extension (HEIC sans MIME sous Windows). Joint : PDF, JPEG, PNG < 4 Mo tels
  quels, le reste converti en JPEG. Bibliothèques **servies par notre serveur**
  (`web/vendor/`, liste fermée, cache long), chargées à la demande, sans variable globale
  dans sesame. Décodage vérifié dans Chrome et Edge (page d'une autre origine) ; lecture
  LLM réelle d'un PDF pas testée (RCP injoignable hors réseau EPFL).
  ⚠ Code tiers supplémentaire exécuté dans la session sesame → à signaler au dossier
  cybersécurité (R1). Non déployé.
- [x] **PDF de plusieurs pages / liasses** (28.09.2026) : la limite de 3 pages par PDF
  remplacée par un tri. Chaque page (≤ 30) → `POST /classify` (prompt fixe côté serveur :
  justificatif ou non, fournisseur, n° de document, n° de page imprimé, début de
  document, total) → regroupement en code (`Core.groupPages`, 7 cas testés : même n°,
  « page 2/2 », page de suite, CG écartées, tri raté, justificatif > 3 pages → 1re + 2
  dernières) → une extraction par justificatif (pages empilées). PDF d'une page : pas de
  tri. Un justificatif illisible n'empêche pas les autres. Le PDF entier est joint une
  fois (1re ligne), chaque ligne indique ses pages. Quota par IP : 60 appels/min,
  1000/jour (configurables). 33 tests OK.
- [x] **Tri réel validé** (29.09.2026, GLM en prod, liasse synthétique de 10 pages) : CG et
  page blanche écartées, hôtel p. 1-2 et restaurant p. 7-8 regroupés, 3 taxis séparés avec
  pourboires → 6 justificatifs, 8 lignes justes ; tri 2,5 s + lecture 11 s. Reste à essayer
  sur de vrais scans.
- [x] **Mot de passe + déploiement** (29.09.2026) : page d'installation derrière un mot de
  passe (secret k8s `ACCESS_PASSWORD`, communiqué oralement, jamais dans le code) ; jeton
  dérivé (HMAC) en cookie 30 j et dans le favori, exigé par `/ndf.js`, `/extract`,
  `/classify` ; 10 essais / 15 min / IP. ⚠ Les anciens favoris affichent « à réinstaller »
  (Yannick : re-glisser le favori). Pseudonyme d'IP des journaux salé (HMAC, sel aléatoire)
  — l'ancienne empreinte SHA-256 tronquée était réversible. 35 tests OK. En prod : image
  `sha256:b7206622…` (tous formats, tri des PDF, mot de passe).
- [x] **Dossiers de validation PDF** (29.09.2026) : `docs/Dossier-cybersecurite-notes-de-frais.pdf`
  (6 p. : fonctionnement, surface exposée, risques R1-R8, empreintes des bibliothèques,
  encadré d'avis) et `docs/Dossier-protection-donnees-notes-de-frais.pdf` (5 p. : données,
  flux, durées, principes, points ouverts, encadré d'avis), générés par
  `docs/dossiers/build_dossiers.py` depuis leur source Markdown
  (`docs/dossiers/dossier-*.md`, éditable ; conventions dans `docs/dossiers/README.md`). Rédigés depuis le code (l'ancien dossier Claude Docs
  n'était pas lisible dans la session) : ils le remplacent.
- [x] **Connexion EPFL (Entra ID)** codée (30.09.2026) : app « notesDeFrais » déclarée par
  Yannick dans l'App Portal (Web App, client `7bf39c1e-…`, tenant EPFL `f6c2556a-…`,
  redirection `…/notes-de-frais/auth/callback`, ouverte au personnel). `server/auth.mjs`
  sans dépendance : OIDC code + PKCE, id_token vérifié (RS256/JWKS, iss, aud, exp, nonce,
  tid), session = cookie HMAC 12 h (même site epfl.ch → envoyé depuis sesame, fetch
  `credentials: 'include'`). **Mot de passe gardé en second verrou** jusqu'au feu vert
  (décision Yannick : Entra ouvre à tout le personnel). Depuis sesame : invitation +
  fenêtre de connexion (`web/login-helper.js`) → message à la page → script rechargé,
  panneau conservé. Sans verrou en prod : tout refusé. Quotas et journaux par personne
  (pseudonyme HMAC salé), plus par IP. 40 tests (faux Entra signant de vrais jetons) +
  parcours complet vérifié dans Chrome. Dossiers PDF mis à jour (R5, données d'identité).
- [x] **Déployé** (30.09.2026, image `sha256:110fecda…`) : secret client collé par Yannick,
  healthz `auth: true`, redirection Entra vérifiée (bon client, redirect_uri acceptée,
  page de connexion Microsoft normale). Docker = **Rancher Desktop** sur ce poste (à lancer
  après un redémarrage avant `update.ps1`).
- [x] Essai réel de la connexion EPFL (Yannick, 30.09.2026) : page d'installation, favori
  déjà connecté, et parcours depuis sesame après déconnexion (fenêtre → EPFL → panneau) OK.
- [x] **Compteurs d'usage anonymes** (30.09.2026, image `sha256:210d5303…`) : par jour
  personnes distinctes, connexions, lectures, pages triées, erreurs, jetons envoyés/reçus ;
  par mois personnes + jours d'utilisation par personne (Σ personnes/jour ÷ personnes/mois).
  Personnes distinctes comptées par empreinte HMAC (clé par jour/mois dérivée de
  SESSION_SECRET, absente du fichier), effacée à la clôture de la période. Fichier
  `/data/stats.json` sur un PVC `notes-de-frais-data` (dsi-nas, 100 Mi, fsGroup 1000,
  stratégie Recreate). Page `/stats` derrière la connexion. 45 tests. Dossiers mis à jour
  (R7, tableau des données DPO).
- [x] **Logs réduits aux erreurs** (30.09.2026, image `sha256:78606620…`) : plus de ligne par
  appel ni par connexion (les compteurs suivent l'usage), erreurs sans identité ni
  pseudonyme ; test qui capture les logs. Cluster vérifié : aucune collecte centralisée des
  logs → ils disparaissent à chaque déploiement. Dossiers : « journaux » → « logs », rétention
  précisée, point ouvert « logs Kubernetes » levé. 46 tests.
- **30.09.2026 — Décision (Yannick)** : compter aussi les **personnes au total** et les
  **nouvelles** personnes → empreintes HMAC à **clé fixe** (`STATS_SECRET` dédié, à ne jamais
  changer) et liste globale gardée tant que le service existe ; listes du jour/mois effacées
  en fin de période. Conséquence assumée et écrite dans le dossier DPO : l'administrateur
  (clé + annuaire) peut retrouver quelles personnes ont utilisé le service depuis sa mise en
  service (pas quels jours passés ni ce qu'elles ont fait) ; personne d'autre. Déployé
  (image `sha256:2266ed6a…`), 47 tests.
- [ ] **Envoyer les dossiers** à la cybersécurité et au DPO ; **avis bloquants** avant tout pilote
- [ ] Au feu vert : retirer `ACCESS_PASSWORD` du secret (ou restreindre l'app Entra à un groupe)
- [x] Rétention RCP (30.09.2026) : l'équipe RCP confirme que la plateforme ne garde aucune trace des
  requêtes. Écrit dans le dossier DPO ; points ouverts RCP et logs Kubernetes retirés.
- [ ] Plusieurs destinations, type hôtel
- [ ] Test sur téléphone (iOS Userscripts, Firefox Android)
- [ ] Discussion VPSI/finances pour une intégration officielle
