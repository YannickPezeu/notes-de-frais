# Dossiers de validation

Les `.md` de ce dossier sont la source ; les PDF sont générés dans `docs/` :

```bash
python docs/dossiers/build_dossiers.py
```

(Python + reportlab ; polices Segoe UI de Windows.) Chaque `.md` du dossier, sauf ce README, donne un PDF.

## Ce que le Markdown accepte

| Markdown | Rendu PDF |
|---|---|
| En-tête `---` … `---` | `pdf` (nom du fichier), `en-tete` (haut de page), `version` et `date` (pied de page), `auteur`, `sujet` (propriétés du PDF) |
| `# Titre` puis `*sous-titre en italique*` | titre du document et sous-titre gris |
| `## 1. Chapitre` / `### Intertitre` | titre de chapitre / intertitre (jamais seul en bas de page) |
| Tableau dont la ligne d'en-tête est vide (`\|  \|  \|`) | fiche sans en-tête (Responsable, Date…) |
| Tableau ordinaire | en-tête grisé ; **la longueur des tirets** de la ligne `\|---\|------\|` fixe la largeur relative des colonnes |
| Cellule entièrement en `` `code` `` | police à chasse fixe, coupée tous les 32 caractères (empreintes SHA-256) |
| `> texte` | encadré rouge (point d'attention) |
| `- [ ] option` sous un intertitre `## Avis…` | encadré d'avis à cocher et signer, titré par l'intertitre |
| `<small>texte</small>` | note en petit, grise |
| `![…](schema-flux.svg)` | schéma des flux, dessiné en vectoriel (le `.svg` est régénéré à chaque build pour l'aperçu Markdown) |
| `**gras**`, `*italique*`, `` `code` ``, listes `-` et `1.` | comme attendu ; espaces insécables ajoutées avant `; : ?` et dans `« »` |

Le schéma se modifie dans `flow_diagram()` de `build_dossiers.py`.
