# Bibliothèques tierces (décodage des justificatifs)

Servies par notre serveur (`/vendor/…`, jamais par un CDN) et chargées par `web/ndf.js`
seulement quand un fichier en a besoin. Avant de les exécuter, `ndf.js` calcule leur
empreinte SHA-256 et **refuse tout fichier qui ne correspond pas** (`VENDOR_SHA256` dans
`web/ndf.js`) ; un test vérifie que les fichiers servis correspondent à ces empreintes.

| Fichier | Bibliothèque | Version | Source | Licence | Usage |
|---|---|---|---|---|---|
| `pdfjs-6.3.289/pdf.min.mjs`, `pdf.worker.min.mjs` | pdf.js (Mozilla) | 6.3.289, build `legacy` | npm `pdfjs-dist` | Apache-2.0 (`pdfjs-6.3.289/LICENSE`) | PDF → images, `isEvalSupported: false` |
| `heic2any-0.0.4.min.js` | heic2any | 0.0.4 | npm `heic2any` | MIT (`LICENSE-heic2any.md`) | photos HEIC hors Safari |
| `utif-3.1.0.js` | UTIF.js (Photopea) | 3.1.0 | npm `utif` | MIT (`LICENSE-utif`) | TIFF hors Safari |

Téléchargées le 28.09.2026 (`npm pack`). Points de vigilance :

- **heic2any n'est plus maintenu** (dernière version 2020). Si une faille apparaît, le plus
  simple est de le retirer : Safari (iPhone, Mac) lit le HEIC sans lui.
- Veille : https://github.com/mozilla/pdf.js/security/advisories et les avis npm des trois paquets.

## Suivi des vulnérabilités

Les trois paquets sont déclarés dans `package.json` / `package-lock.json` (jamais installés :
le serveur n'a aucune dépendance) pour que les scanners les voient : OSV (audit EPFL) et les
alertes Dependabot de GitHub (`.github/dependabot.yml`). Le lockfile liste aussi des paquets que
nous ne livrons pas (`@napi-rs/canvas`, rendu PDF côté Node ; `pako`, dépendance facultative
d'UTIF) : une alerte sur eux est sans objet.

## Mettre à jour

1. `npm pack <paquet>@<version>` et copier le(s) fichier(s) ici, dans un dossier ou un nom
   **versionné** (les fichiers sont mis en cache une semaine par les navigateurs).
2. Mettre à jour `package.json` (`npm install --package-lock-only --ignore-scripts`), les chemins et `VENDOR_SHA256` dans `web/ndf.js`
   (`sha256sum web/vendor/<fichier>`), ce tableau, et les empreintes du dossier
   cybersécurité (`docs/dossiers/dossier-cybersecurite.md`, chapitre 6).
3. `node --test tests/*.test.mjs`, puis un essai réel (PDF, HEIC, TIFF) dans sesame.
