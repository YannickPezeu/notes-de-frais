// Lecture d'un justificatif par GLM-5.3-Flash (RCP EPFL).
// Le prompt est fixé ICI, côté serveur : /extract ne sait faire qu'une chose,
// lire un justificatif, ce qui ôte tout intérêt à détourner le point d'accès.

export const MODEL = process.env.RCP_MODEL || 'zai-org/GLM-5.3-Flash';
export const RCP_URL = (process.env.RCP_URL || 'https://inference.rcp.epfl.ch/v1').replace(/\/$/, '') + '/chat/completions';

import { EXPENSE_TYPES } from './expense-types.mjs';

const MAX_TYPES = 100;
const TYPE_ID = /^[A-Z0-9]{3,4}$/;

/**
 * Types de frais envoyés par le client (relus dans SAP). Validation stricte :
 * ce sont les seules données du client qui entrent dans le prompt.
 */
export function validateTypes(types) {
  if (!Array.isArray(types) || !types.length || types.length > MAX_TYPES) throw new Error('liste de types de frais invalide');
  const ids = types.map((t) => String(t?.id ?? ''));
  if (ids.some((id) => !TYPE_ID.test(id))) throw new Error('type de frais invalide');
  // Seuls les identifiants connus, avec NOS libellés : le texte envoyé par le client est ignoré.
  const known = [...new Set(ids)].filter((id) => EXPENSE_TYPES.has(id)).map((id) => ({ id, label: EXPENSE_TYPES.get(id) }));
  if (!known.length) throw new Error('aucun type de frais connu');
  return known;
}

export function buildPrompt(types) {
  return `You read one expense receipt (photo or scan) for an EPFL travel expense report.
Return ONLY a JSON object, no prose, no markdown fence:
{
  "is_receipt": true,
  "vendor": "merchant name",
  "date": "YYYY-MM-DD",
  "amount": 0.00,
  "printed_total": 0.00,
  "items_sum": 0.00,
  "tip": 0.00,
  "currency": "CHF",
  "expense_type": "E110",
  "city": "city of the expense",
  "country": "CH",
  "description": "short description in French, e.g. Train Lausanne–Neuchâtel aller-retour",
  "confidence": "high",
  "notes": ""
}
Rules:
- date: the day the expense happened (travel date for a ticket, not the purchase date if they differ). Swiss/European receipts write dates DD.MM.YYYY or DD/MM/YYYY.
- Decimal comma means decimal point (27,40 = 27.40). Ignore VAT lines everywhere.
- printed_total: the TOTAL / Gesamt / Summe / Total line exactly as printed (the largest final total if several), null if none.
- items_sum: the sum of the individual item, fare or service lines, WITHOUT the tip and without VAT lines; null if the receipt lists no individual lines.
- tip: tip/gratuity/Trinkgeld/pourboire/Service if written on the receipt, else 0.
- Copy printed_total, items_sum and tip as printed: do NOT decide yourself whether the tip is included in the total, the program checks it.
- amount: your best estimate of what was paid EXCLUDING the tip (used only when the numbers above are missing).
- currency: ISO 4217 code (CHF, EUR, USD, GBP...).
- country: ISO 3166-1 alpha-2 code.
- expense_type: exactly one ID from this list:
${types.map((t) => `  ${t.id} ${t.label}`).join('\n')}
  Meals: breakfast before 10:30, lunch 10:30–16:00, dinner after 16:00 (use the time on the receipt). Hotel/accommodation, if absent from the list: use the closest "other travel fees" type and write "hôtel" in notes.
- confidence: "high" if every field is clearly readable, "medium" if you inferred something, "low" if the image is hard to read.
- notes: in French, anything the user should double-check. Empty string if nothing. Never comment on whether the tip is included: the program checks it.
- If the image is not a receipt/invoice/ticket, return {"is_receipt": false, "notes": "..."}.`;
}

const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
export const MAX_IMAGE_CHARS = 4_000_000; // ≈ 3 Mo d'image ; le client envoie ~300 Ko (photo) à ~2 Mo (3 pages de PDF empilées)

export function validateImage(image) {
  if (typeof image !== 'string' || image.length > MAX_IMAGE_CHARS || !IMAGE_DATA_URL.test(image)) {
    throw new Error('image attendue : data URL JPEG, PNG ou WebP de moins de 3 Mo');
  }
  return image;
}

export function buildRcpBody(image, types) {
  return {
    model: MODEL,
    // Seul levier de réflexion qui marche sur GLM-5.x (bancs du 15-16.09.2026) ;
    // `enable_thinking:false` ferait fuiter la réflexion dans `content`.
    reasoning_effort: 'low',
    temperature: 0,
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: buildPrompt(types) },
        { type: 'image_url', image_url: { url: image } },
      ],
    }],
  };
}

/** Premier objet JSON de la réponse (tolère les ```json … ```). */
export function parseJsonLoose(text) {
  if (!text) throw new Error('réponse vide du modèle');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('pas de JSON dans la réponse du modèle');
  return JSON.parse(text.slice(start, end + 1));
}

// Tri des pages d'un PDF de plusieurs pages : une page à la fois, avant toute extraction.
// Le regroupement en justificatifs est fait par le client, en code (Core.groupPages).
export const CLASSIFY_PROMPT = `You see ONE page of a PDF that may contain several expense receipts, invoices or tickets, possibly spread over several pages, mixed with other pages (terms and conditions, cover letter, blank page, advertising).
Return ONLY a JSON object, no prose, no markdown fence:
{
  "kind": "receipt",
  "vendor": "merchant name",
  "document_number": "invoice / receipt / ticket / booking number",
  "page_number": 1,
  "starts_document": true,
  "has_total": true
}
Rules:
- kind: "receipt" if this page is (part of) a receipt, invoice, ticket, booking confirmation or payment proof, including a continuation page of one; "other" for anything else.
- vendor: as printed, null if not visible on this page.
- document_number: the invoice/receipt/ticket/booking number exactly as printed, null if none on this page.
- page_number: the page number printed on the page for its own document ("Page 2/3", "Seite 2 von 3", "2/3" → 2), null if none printed.
- starts_document: true if this page is the first page of a document (header with merchant name/logo/address, title such as Facture/Invoice/Rechnung/Quittung), false if it clearly continues a previous page.
- has_total: true if a final total amount to pay (TOTAL, Gesamt, Montant dû…) is printed on this page.`;

export function buildClassifyBody(image) {
  return {
    model: MODEL,
    reasoning_effort: 'low',
    temperature: 0,
    max_tokens: 300,
    messages: [{ role: 'user', content: [{ type: 'text', text: CLASSIFY_PROMPT }, { type: 'image_url', image_url: { url: image } }] }],
  };
}

export const extract = ({ image, types }, apiKey, fetchImpl = fetch) =>
  callRcp(buildRcpBody(validateImage(image), validateTypes(types)), apiKey, fetchImpl);

export const classify = ({ image }, apiKey, fetchImpl = fetch) =>
  callRcp(buildClassifyBody(validateImage(image)), apiKey, fetchImpl);

async function callRcp(body, apiKey, fetchImpl) {
  const res = await fetchImpl(RCP_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    const err = new Error(`RCP HTTP ${res.status}`);
    err.detail = detail;
    err.upstream = true;
    throw err;
  }
  const json = await res.json();
  return {
    result: parseJsonLoose(json.choices?.[0]?.message?.content),
    usage: json.usage ?? null,
  };
}
