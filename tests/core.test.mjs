// node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCore } from './load-core.mjs';

const Core = loadCore();
const FIX = JSON.parse(readFileSync(new URL('./fixtures/batch-responses.json', import.meta.url), 'utf8'));
const parse = (name) => Core.parseBatch(FIX[name].body, FIX[name].contentType);

test('montants suisses, européens et anglo-saxons', () => {
  assert.equal(Core.parseAmount("1'234,50"), 1234.5);
  assert.equal(Core.parseAmount('27,40'), 27.4);
  assert.equal(Core.parseAmount('1,234.50'), 1234.5);
  assert.equal(Core.parseAmount('CHF 46.00'), 46);
  assert.equal(Core.parseAmount(12), 12);
  assert.ok(Number.isNaN(Core.parseAmount('')));
});

test('dates SAP : heure locale stockée comme UTC (valeurs de la capture)', () => {
  assert.equal(Core.toSapDate('2026-09-24', '08:00'), '/Date(1790236800000)/');
  assert.equal(Core.toSapDate('2026-09-24', '18:00'), '/Date(1790272800000)/');
  assert.equal(Core.toSapDate('2026-09-24'), '/Date(1790208000000)/');
  assert.deepEqual(Core.fromSapDate('/Date(1790236800000)/'), { date: '2026-09-24', time: '08:00' });
});

test('JSON OData : dates écrites "\\/Date(…)\\/" comme l\'app Fiori', () => {
  const s = Core.odataJson({ FromDate: '/Date(1790236800000)/', Reason: 'Voyage à Neuchâtel' });
  assert.equal(s, '{"FromDate":"\\/Date(1790236800000)\\/","Reason":"Voyage à Neuchâtel"}');
  assert.equal(JSON.parse(s).FromDate, '/Date(1790236800000)/');
});

test('buildBatch : une écriture par changeset, GET hors changeset, Content-Length en octets', () => {
  const { contentType, body } = Core.buildBatch([
    { method: 'GET', path: "TravelAndExpenseHeaders('x')" },
    { method: 'POST', path: 'Expenses', body: { Memo: 'é' } },
    { method: 'POST', path: 'SaveHeader?TravelAndExpenseHeaderID=%27x%27&UserAction=2' },
  ], 'TOKEN');
  const boundary = /boundary=(.+)$/.exec(contentType)[1];
  assert.equal(body.split(`--${boundary}\r\n`).length - 1, 3);
  assert.ok(body.endsWith(`--${boundary}--\r\n`));
  assert.match(body, /GET TravelAndExpenseHeaders\('x'\) HTTP\/1\.1/);
  assert.match(body, /Content-Length: 13\r\n/); // {"Memo":"é"} = 13 octets en UTF-8 (é = 2)
  assert.equal((body.match(/changeset_/g) || []).length, 6); // 2 changesets × (déclaration + ouverture + fermeture)
  assert.match(body, /x-csrf-token: TOKEN/);
});

test('parseBatch : réponse réelle de SaveHeader', () => {
  const [r] = parse('save');
  assert.equal(r.status, 200);
  assert.equal(r.data.d.SaveHeader.TravelAndExpenseHeaderID, '000123450010100005_____');
  const msgs = Core.parseSapMessage(r.headers['sap-message']);
  assert.deepEqual(msgs, [{ severity: 'S', text: 'Expense report 0010100005 was saved' }]);
  assert.equal(Core.responseError(r), null);
});

test('parseBatch : deux changesets, et une erreur SAP cachée dans un 201', () => {
  const res = parse('two_cost_assignments');
  assert.equal(res.length, 2);
  assert.equal(res[0].status, 201);
  assert.equal(Core.responseError(res[0]), 'Required entry field "Fund" is empty');
});

test('parseBatch : 204 sans corps (MERGE)', () => {
  const [r] = parse('header_merge');
  assert.equal(r.status, 204);
  assert.equal(r.data, null);
  assert.equal(Core.responseError(r), null);
});

test('responseError : erreur HTTP OData', () => {
  const r = { status: 400, headers: {}, data: { error: { message: { value: 'Fund 999 does not exist' }, innererror: { errordetails: [{ message: 'détail' }] } } } };
  assert.equal(Core.responseError(r), 'Fund 999 does not exist — détail');
});

test('expenseForMerge reproduit ce que l\'UI renvoie (sans __metadata ni *_FC ni navigations)', () => {
  const exp = parse('expense_create')[0].data.d;
  const e = Core.expenseForMerge(exp);
  assert.ok(!('__metadata' in e));
  assert.ok(!Object.keys(e).some((k) => k.endsWith('_FC')));
  assert.ok(!('Attachments' in e) && !('CostAssignments' in e));
  assert.ok(!('__metadata' in e.ReceiptAmount));
  assert.ok('FullName_FC' in e.Address, 'les *_FC imbriqués restent, comme dans la capture');
  assert.equal(e.ExpenseID, '000123450000000000_____E001_____');
});

test('headerForMerge garde les métadonnées mais retire les navigations', () => {
  const hdr = parse('header_create')[0].data.d;
  const h = Core.headerForMerge(hdr);
  assert.equal(h.__metadata.type, 'PAOC_TRV_SRV.TravelAndExpenseHeader');
  assert.ok(!('Claims' in h) && !('ExpenseTypes' in h));
  assert.ok('FromDate_DATE_FC' in h);
});

const IDS = new Set(Core.FALLBACK_EXPENSE_TYPES.map((t) => t.id));

test('normalizeExtraction : champs propres, type inconnu remplacé, avertissements', () => {
  const ok = Core.normalizeExtraction({ is_receipt: true, vendor: 'CFF', date: '2026-09-24', amount: '46,00', tip: 0, currency: 'chf', expense_type: 'E110', city: 'Neuchâtel', country: 'ch', confidence: 'high', notes: '' }, IDS);
  assert.equal(ok.amount, 46);
  assert.equal(ok.currency, 'CHF');
  assert.equal(ok.country, 'CH');
  assert.deepEqual(ok.warnings, []);

  const bad = Core.normalizeExtraction({ vendor: 'Hôtel', date: '24.09.2026', amount: null, currency: '??', expense_type: 'HOTEL' }, IDS);
  assert.equal(bad.type, 'E160');
  assert.equal(bad.date, '');
  assert.equal(bad.amount, null);
  assert.equal(bad.warnings.length, 4);

  assert.equal(Core.normalizeExtraction({ is_receipt: false, notes: 'photo de chat' }, IDS).isReceipt, false);
});

test('pourboire → ligne Tip séparée ; voyage déduit des justificatifs', () => {
  const ex = Core.normalizeExtraction({ vendor: 'Brasserie', date: '2026-09-24', amount: 44, tip: 4, currency: 'CHF', expense_type: 'E230', city: 'Neuchâtel', country: 'CH', description: 'Souper' }, IDS);
  const lines = [
    ...Core.linesFromExtraction(ex, 1),
    { date: '2026-09-23', city: 'Lausanne', country: 'CH', amount: 46, currency: 'CHF' },
  ];
  assert.equal(lines[1].type, 'E240');
  assert.equal(lines[1].amount, 4);
  const trip = Core.inferTrip(lines);
  assert.equal(trip.fromDate, '2026-09-23');
  assert.equal(trip.toDate, '2026-09-24');
  assert.equal(trip.purpose, 'Voyage à Neuchâtel');
  assert.deepEqual(trip.foreignCountries, []);
});

test('pourboire tranché par l\'arithmétique, quel que soit l\'avis du modèle', () => {
  const base = { vendor: 'x', date: '2026-09-24', currency: 'CHF', expense_type: 'E230' };
  // Ticket resto : articles 44 = TOTAL 44, pourboire 4 imprimé dessous → en plus.
  // Le modèle avait proposé tantôt 44, tantôt 40 : les deux donnent 44.
  for (const guess of [44, 40]) {
    const r = Core.normalizeExtraction({ ...base, amount: guess, printed_total: '44.00', items_sum: 44, tip: '4.00' }, IDS);
    assert.equal(r.amount, 44);
    assert.equal(r.tip, 4);
    assert.deepEqual(r.warnings, []);
  }
  // Taxi berlinois : Fahrpreis 27,40 + Trinkgeld 2,60 = Gesamt 30,00 → inclus.
  const taxi = Core.normalizeExtraction({ ...base, expense_type: 'E130', currency: 'EUR', amount: 30, printed_total: '30,00', items_sum: '27,40', tip: '2,60' }, IDS);
  assert.equal(taxi.amount, 27.4);
  assert.equal(taxi.tip, 2.6);
  // Pas de détail des articles : on garde l'estimation et on prévient.
  const flou = Core.normalizeExtraction({ ...base, amount: 50, printed_total: 55, items_sum: null, tip: 5 }, IDS);
  assert.equal(flou.amount, 50);
  assert.match(flou.warnings.join(), /Pourboire : impossible de vérifier/);
  // Sans pourboire : le total imprimé sert si l'estimation manque.
  assert.equal(Core.normalizeExtraction({ ...base, amount: null, printed_total: 46, tip: 0 }, IDS).amount, 46);
});

test('anti-doublon : lignes déjà présentes dans une note SAP (format Claims réel)', () => {
  // Format des Claims relus dans SAP (capture du 24.09.2026) : montants en chaîne à 4 décimales.
  const claim = (type, value, cur, ms) => ({ ExpenseTypeID: type, FromDate: `/Date(${ms})/`, ReceiptAmount: { Value: value, CurrencyCode: cur } });
  const claims = [claim('E110', '46.0000', 'CHF', 1790208000000), claim('E130', '27.4000', 'EUR', Date.UTC(2026, 9, 12))];
  const l = (type, date, amount, currency) => ({ type, date, amount, currency });
  const m = Core.matchExistingClaims([
    l('E110', '2026-09-24', 46, 'CHF'),   // identique → doublon
    l('E130', '2026-10-12', 27.4, 'EUR'), // identique → doublon
    l('E110', '2026-09-25', 46, 'CHF'),   // autre jour
    l('E230', '2026-09-24', 46, 'CHF'),   // autre type
    l('E130', '2026-10-12', 27.4, 'CHF'), // autre devise
  ], claims);
  assert.deepEqual(m.map((x) => x.line.type + x.line.date), ['E1102026-09-24', 'E1302026-10-12']);
  assert.ok(Core.overlaps('2026-09-24', '2026-10-12', '2026-10-12', '2026-10-14'));
  assert.ok(!Core.overlaps('2026-09-24', '2026-09-24', '2026-09-25', '2026-09-26'));
});

test('destination déduite : pays étranger le plus fréquent et sa ville, sinon la Suisse', () => {
  const l = (country, city, date = '2026-10-12') => ({ country, city, date, amount: 10, currency: 'EUR' });
  const berlin = Core.inferTrip([l('CH', 'Lausanne'), l('DE', 'Berlin'), l('DE', 'Berlin', '2026-10-14'), l('DE', 'München')]);
  assert.equal(berlin.destCountry, 'DE');
  assert.equal(berlin.destCity, 'Berlin');
  assert.equal(berlin.purpose, 'Voyage à Berlin');
  assert.deepEqual(berlin.foreignCountries, ['DE']);
  assert.equal(berlin.toDate, '2026-10-14');
  const suisse = Core.inferTrip([l('CH', 'Lausanne'), l('CH', 'Neuchâtel')]);
  assert.equal(suisse.destCountry, 'CH');
  assert.equal(suisse.destCity, 'Neuchâtel', 'le campus ne compte pas comme destination');
});

test('destinationForMerge reproduit le MERGE envoyé par l\'UI pour Berlin', () => {
  const ui = FIX.destination_merge_by_ui;
  const ours = Core.destinationForMerge(FIX.destination_get, 'DE', 'berlin');
  for (const k of ['DestinationID', 'BeginningDate', 'PerDiemRegion', 'PerDiemRegionDescription', 'DestinationType']) assert.deepEqual(ours[k], ui[k], k);
  assert.equal(ours.Address.Country, 'DE');
  assert.equal(ours.Address.Location, 'berlin');
  assert.ok(!Object.values(ours).some((v) => v && typeof v === 'object' && '__deferred' in v));
});

test('doublons : même date, même montant, même devise (pourboires ignorés)', () => {
  const l = (amount, date, isTip) => ({ amount, date, currency: 'CHF', isTip });
  assert.deepEqual(Core.findDuplicates([l(46, '2026-09-24'), l(4, '2026-09-24', true), l(46, '2026-09-24')]), [[0, 2]]);
});

test('noms de fichiers ASCII pour l\'en-tête slug', () => {
  assert.equal(Core.asciiFileName('Reçu café.JPG', 0), 'justificatif-01.jpg');
  assert.equal(Core.asciiFileName('billet.pdf', 11), 'justificatif-12.pdf');
});

test('liste de secours : 50 types, sans le kilométrage', () => {
  assert.equal(Core.FALLBACK_EXPENSE_TYPES.length, 50);
  assert.ok(!IDS.has('MILE'));
});

test('types de frais relus dans SAP : suffixes retirés, kilométrage exclu, tri par libellé', () => {
  const types = Core.typesFromSap([
    { ExpenseTypeID: 'MILE', Description: 'Mileage', Category: 12 },
    { ExpenseTypeID: 'E505', Description: 'Publication/Reprint costs/Inv.', Category: 4 },
    { ExpenseTypeID: 'E110', Description: 'Train - Rail /Cash', Category: 4 },
    { ExpenseTypeID: 'E130', Description: 'Taxi /Cash', Category: 4 },
  ]);
  assert.deepEqual(types, [
    { id: 'E505', label: 'Publication/Reprint costs (invoice)' },
    { id: 'E130', label: 'Taxi' },
    { id: 'E110', label: 'Train - Rail' },
  ]);
});

test('formats de justificatif : type MIME, sinon extension', () => {
  const k = (name, type = '') => Core.fileKind({ name, type });
  assert.equal(k('facture.pdf', 'application/pdf'), 'pdf');
  assert.equal(k('FACTURE.PDF'), 'pdf');
  assert.equal(k('IMG_0042.HEIC'), 'heic'); // Windows : HEIC sans type MIME
  assert.equal(k('x', 'image/heif'), 'heic');
  assert.equal(k('scan.tif'), 'tiff');
  assert.equal(k('scan.tiff', 'image/tiff'), 'tiff');
  assert.equal(k('photo.jpg', 'image/jpeg'), 'image');
  assert.equal(k('photo.webp'), 'image');
  assert.equal(k('photo.jfif'), 'image');
  assert.equal(k('capture', 'image/png'), 'image'); // collé depuis le presse-papiers
  assert.equal(k('note.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), null);
  assert.equal(k('mail.eml'), null);
});

test('PDF de plusieurs pages : regroupement des pages en justificatifs', () => {
  const R = (o = {}) => ({ kind: 'receipt', vendor: null, document_number: null, page_number: null, starts_document: true, has_total: true, ...o });
  const g = (infos) => Core.groupPages(infos);

  // Facture d'hôtel sur 2 pages (« Page 2/2 »), puis 2 tickets de taxi de la même compagnie.
  let out = g([
    R({ vendor: 'Hôtel Bellevue', document_number: 'F-0917', page_number: 1, has_total: false }),
    R({ vendor: null, document_number: null, page_number: 2, starts_document: false }),
    R({ vendor: 'Taxi Zentrale', document_number: '4411' }),
    R({ vendor: 'Taxi Zentrale', document_number: '4412' }),
  ]);
  assert.deepEqual(out.groups.map((x) => x.pages), [[0, 1], [2], [3]]);

  // Même n° de document répété en tête de chaque page, même si le modèle croit à un début.
  out = g([R({ document_number: 'INV 2026/88' }), R({ document_number: 'inv-2026-88' })]);
  assert.deepEqual(out.groups.map((x) => x.pages), [[0, 1]]);

  // Conditions générales et page de garde écartées ; elles coupent le justificatif en cours.
  out = g([R({ kind: 'other' }), R(), R({ kind: 'other' }), R({ starts_document: false })]);
  assert.deepEqual(out.skipped, [0, 2]);
  assert.deepEqual(out.groups.map((x) => x.pages), [[1], [3]]);

  // Page 1 imprimée = nouveau document, même sans en-tête visible.
  out = g([R({ page_number: 1 }), R({ page_number: 1, starts_document: false })]);
  assert.equal(out.groups.length, 2);

  // Tri raté (réseau) : page lue à part, avec un avertissement, sans bloquer le reste.
  out = g([R(), { error: 'HTTP 502' }, R({ starts_document: false })]);
  assert.deepEqual(out.groups.map((x) => x.pages), [[0], [1], [2]]);
  assert.match(out.groups[1].warnings[0], /page 2 impossible \(HTTP 502\)/);

  // Justificatif de 5 pages : 1re page + les 2 dernières (le total est à la fin).
  out = g([R({ document_number: 'A1' }), ...Array.from({ length: 4 }, () => R({ document_number: 'A1', starts_document: false }))]);
  assert.deepEqual(out.groups[0].pages, [0, 3, 4]);
  assert.match(out.groups[0].warnings[0], /5 pages \(p\. 1, 2, 3, 4, 5\) : seules les pages 1, 4, 5/);

  // Tout est hors sujet.
  out = g([R({ kind: 'other' }), R({ kind: 'other' })]);
  assert.deepEqual(out, { skipped: [0, 1], groups: [] });
});
