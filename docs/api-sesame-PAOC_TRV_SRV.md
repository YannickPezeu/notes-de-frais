# API sesame — service OData `PAOC_TRV_SRV`

Rétro-ingénierie à partir d'une capture réseau (HAR, 24.09.2026) de la création
manuelle d'une note de frais dans *My Travel and Expenses* (sesame.epfl.ch).
`PAOC_TRV_SRV` est le service **standard SAP** de l'app Fiori « My Travel and
Expenses », étendu par EPFL (champs `Z*`, schéma `Z2`).

## Transport

- Base : `https://sesame.epfl.ch/sap/opu/odata/sap/PAOC_TRV_SRV/` (OData **V2**)
- Toutes les opérations passent par `POST $batch` (`multipart/mixed`), une
  opération d'écriture par *changeset*.
- Auth : cookie de session SSO (`sap-webdisp-session`, …) + en-tête
  `x-csrf-token` (à obtenir par un `GET` avec `x-csrf-token: Fetch`).
  → le code doit tourner **dans l'origine sesame.epfl.ch** (userscript /
  bookmarklet), CORS interdit les appels depuis une autre origine.
- Les messages métier arrivent dans l'en-tête `sap-message` de chaque réponse
  (JSON, textes URL-encodés, `severity` `E`/`S`/…). Un `201 Created` peut
  contenir une erreur (`"Required entry field \"Fund\" is empty"`) : **toujours
  lire `sap-message`**.

## Modèle « brouillon en session »

La note n'a pas de numéro tant qu'elle n'est pas sauvée. Le brouillon vit dans
le buffer de la session SAP (soft state) sous l'ID temporaire
`<PERNR 8 chiffres>0000000000_____` (ex. `000123450000000000_____`).
`SaveHeader` le persiste et renvoie l'ID définitif
(`000123450010100005_____` → note n° 10100005).
⇒ toute la séquence doit se faire dans la même session, sans rechargement.

## Séquence de création (observée)

| # | Opération | Corps (essentiel) |
|---|---|---|
| 1 | `POST TravelAndExpenseHeaders` | `{"SchemaID":"Z2","PersonalNumber":"00012345","UserAction":1}` → brouillon, dates par défaut = aujourd'hui 08:00–18:00, destination Suisse |
| 2 | `GET UserProfiles('<PERNR>')/CostObjects?$filter=CostObjectTypeID eq '5'` | liste des fonds de l'utilisateur (recherche) |
| 3 | `GET ApproverListSet?$filter=Funds eq '<fonds>' and Onbehalfuser eq '<SCIPER>'` | approbateurs FC possibles pour ce fonds |
| 4 | `POST CostAssignments` | `{"Percentage":"100","CostObjectID":"1121-1","CostObjectDescription":"…","Fistl":"F1121","TravelAndExpenseHeaderID":"<id brouillon>","LineId":"0","HasOtp":false}` |
| 5 | `MERGE TravelAndExpenseHeaders('<id>')` | objet header complet renvoyé par (1), modifié : `Reason` (= Purpose), `Commentary`, `FromDate`/`ToDate`, `Approver` (SCIPER), `ApproverName`, `ZapprovalNote`, `SciperBenef`… |
| 6 | `POST Expenses` | `{"TravelAndExpenseHeaderID":"<id>","ExpenseTypeID":"E230"}` → ligne `…E001_____` |
| 7 | `MERGE Expenses('<id>E001_____')` | objet expense complet renvoyé par (6), modifié : `ReceiptAmount.Value`/`CurrencyCode`, `ExpenseDate`, `Memo`, `Receiptno` |
| 8 | `POST CostAssignments` | ré-envoi de l'imputation avec `CostAssignmentID` et `Fund` renseignés |
| 9 | `POST SaveHeader?TravelAndExpenseHeaderID='<id>'&UserAction=2` | **Save** → `"Expense report 0010100005 was saved"` |

Conseil d'implémentation : pour les `MERGE`, partir de l'objet renvoyé par le
`POST`/`GET` précédent et ne modifier que les champs voulus (c'est ce que fait
l'UI) plutôt que construire l'objet de zéro.

Dates : format OData V2 `"\/Date(<ms epoch>)\/"`. `FromDate`/`ToDate` sont en
UTC-comme-heure-locale (1790236800000 = 24.09.2026 08:00 affiché).

## Types de frais (schéma Z2, 51 types)

Obtenus par `GET TravelAndExpenseHeaders('<id>')/ExpenseTypes`. Tous `/Cash`,
catégorie 4, sauf `MILE` (kilométrage, catégorie 12).

| ID | Libellé | ID | Libellé |
|---|---|---|---|
| E110 | Train - Rail | E360 | Office Supplies |
| E120 | Rental car - Vehicle | E370 | Computer Consumables |
| E130 | Taxi | E380 | Printing works |
| E140 | Bus-Metro-Public Transp | E390 | Postage letters & parcels |
| E150 | Parking | E400 | Service Fees computer |
| E160 | Other Travel Fees | E410 | Wifi Network fees |
| E170 | Excursions & Museum | E420 | Peripheral devices |
| E210 | Breakfast-Morning meal | E430 | Computer licenses |
| E220 | Lunch-Midday-Noon meal | E440 | Soft purchase maintenance |
| E230 | Dinner-Evening meal | E450 | Speakers/Guests |
| E240 | Tip | E460 | Customs taxes |
| E250 | Consular - Visas Fees | E470 | Membership fees |
| E260 | Registration, tuition | E480 | Single book purchases |
| E270 | Entertain costs | E490 | Data banks Purch/registr |
| E290 | Biochemicals Products | E500 / E505 | Publication/Reprint costs (Cash / Inv.) |
| E300 | Laboratory Supplies | E510 | Mobile phone charges |
| E310 | Electronic equipment | E560 | Agency Fees |
| E320 | Workshop Supplies | E580 | Furniture exl. DII |
| E330 | Pers. Training extra mur | E590 | Job advertisement |
| E340 | Medical Expenses | E600 | Translation/writing fees |
| E350 | Gifts for staff | E610 | Scientif reasearch analys |
| E620 | Patent & copyright | E630 | Document digital support |
| E640 | Purchase electronic book | E650 | Paper mag subsription |
| E660 | Electr mag subsription | E670 | Docum interlibrary |
| E680 | E-Book Subsription | MILE | Mileage |

⚠️ Pas de type « Hôtel » dans ce schéma (Z2 = voyage d'un jour en Suisse ?).
À vérifier avec un voyage multi-jours / à l'étranger : la liste dépend
probablement du schéma et de la destination.

## Upload d'un justificatif (capturé le 24.09.2026)

**Hors `$batch`**, requête directe, fichier brut dans le corps :

```
GET  /sap/opu/odata/sap/PAOC_TRV_SRV/            (x-csrf-token: Fetch → jeton frais)
POST /sap/opu/odata/sap/PAOC_TRV_SRV/Expenses('<id note>E002_____')/Attachments
     Content-Type: application/octet-stream
     slug: 1000022635.jpg
     Content-Disposition: attachment; filename="1000022635.jpg"
     x-csrf-token: <jeton>
     x-requested-with: XMLHttpRequest
     <octets du fichier>
→ 201, Location: …/Attachments('<GUID 64 hex>')
  sap-message: "Document stored successfully" (severity S)
```

- Le justificatif est rattaché à **la ligne de frais** (`Expenses(...)`), pas
  au header. Les pièces du header passent sans doute par
  `TravelAndExpenseHeaders('<id>')/Attachments` (non capturé, pas nécessaire).
- La ligne doit exister avant l'upload (`POST Expenses` d'abord).
- Relecture : `GET Expenses('<id>')?$expand=Attachments`.
- Les autres en-têtes vus (`requestid…`, `filenamerequestid…`, `sap-passport`)
  sont propres au contrôle UploadCollection d'UI5 ; a priori inutiles.

## Modifier une note existante

`GET TravelAndExpenseHeaders('<id>')?$expand=…&mode=MOD&lock=X` pose le verrou
et charge la note dans le buffer ; ensuite mêmes opérations qu'à la création
(nouvelle ligne → `E002_____`, etc.) puis `SaveHeader`.

## Voyage de plusieurs jours à l'étranger (capture « voyage », 24.09.2026)

Note de test 12.10–14.10.2026, Berlin, 1 frais de 50 EUR, puis supprimée.

- **Profil** : `GET UserProfiles?$expand=Schemas` → `PersonalNumber` (entrée `Isself: true`),
  centre de coûts, devise. Schémas disponibles : `01` Domestic Trip, `02` Foreign
  Trip, `03` Supplies, `Z1` Trip-related EX, `Z2` Non Trip-related EX. **L'app EPFL
  crée toujours en `Z2`**, même pour un voyage à l'étranger.
- **Types de frais** : la liste est identique (51 types) pour ce voyage ; toujours
  pas de type hôtel. Question ouverte aux finances.
- **Dates** : `MERGE TravelAndExpenseHeaders` avec `FromDate`/`ToDate` ; SAP recale
  seul `BeginningDate` de la destination.
- **Destination** : `GET Destinations('<id>_1M____')` puis `MERGE` du même objet avec
  `Address.Country = "DE"`, `Address.Location = "berlin"` (texte libre),
  `PerDiemRegion = ""`, `PerDiemRegionDescription = ""`. L'UI consulte aussi
  `Countries` (215 pays, `{CountryID, Description}`), `Regions?$filter=CountryID eq 'DE'`
  et `…/Cities`, mais n'en a pas besoin pour enregistrer.
- **Devise étrangère** : `ReceiptAmount {Value:"50", CurrencyCode:"EUR"}` suffit ; SAP
  calcule `ExchangeRate` (0,94390) et `ConvertedAmount` (47,20 CHF).
- **Champs obligatoires par type** : l'UI crée un frais de chaque type au chargement
  (`POST Mileages` + 51 `POST Expenses` dans un seul `$batch`) ; les `sap-message`
  cumulés montrent que **« Name » (fournisseur, champ `SeName`) est exigé par la
  plupart des types**. Autres : `E370` Ticket Number ; `E130` Taxi City + Country ;
  `E170`/`E390` Participants, Other Guests… ; `E580`/`E620` Location ;
  `E390`/`E610` From/To Date. La note s'enregistre malgré tout (les frais du 1er test
  n'avaient pas de Name) : à confirmer type par type.
- **Justificatif sur le brouillon** : `POST Expenses('<brouillon>E001_____')/Attachments`
  marche (201) et survit au Save. **Un JPEG de 7,2 Mo est refusé (400, corps vide)** ;
  24 Ko acceptés. Le script réduit toute photo de plus de 4 Mo.
- **Suppression** : `DELETE TravelAndExpenseHeaders('<id>')` → 204.

## Pas encore capturé

- **Submit** (probablement `SaveHeader` avec un autre `UserAction`) —
  volontairement hors périmètre : l'outil ne fait que des brouillons.
- Modification de la destination (pays / voyage à l'étranger, multi-jours).
- Lignes `MILE` (kilométrage) et frais dans une devise étrangère.
