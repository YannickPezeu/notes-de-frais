/*
 * Notes de frais EPFL — script chargé dans sesame par le favori (bookmarklet)
 * servi par server/server.mjs.
 *
 * Principe (voir docs/api-sesame-PAOC_TRV_SRV.md) : le script tourne DANS la
 * page sesame, il réutilise donc la session SSO de l'usager et parle au service
 * OData PAOC_TRV_SRV exactement comme l'app Fiori. Il ne fait que des
 * brouillons (Save) : l'usager relit et soumet lui-même dans sesame.
 * La lecture des justificatifs passe par POST {BASE}/extract : la clé RCP et le
 * prompt restent sur le serveur.
 *
 * Le fichier a deux parties :
 *  - `Core` : logique pure (parsing, $batch, dates) — testée sous Node par
 *    tests/core.test.mjs, qui charge ce fichier sans navigateur ;
 *  - l'interface et les appels réseau, qui ne tournent que dans sesame.
 */
(function () {
  'use strict';

  // Remplacés par le serveur à l'envoi du fichier : URL publique du service et
  // empreinte du fichier (sert à remplacer une version déjà chargée dans la page).
  const BASE_URL = '{{BASE}}';
  const VERSION = '{{VERSION}}';

  // ════════════════════════════════════════════════════════════════════════
  // Core — logique pure, sans DOM ni réseau
  // ════════════════════════════════════════════════════════════════════════
  const Core = (() => {
    // Types de frais du schéma Z2 (GET …/ExpenseTypes, capture du 24.09.2026) :
    // liste de secours, la liste réelle est relue dans SAP à l'ouverture.
    // MILE (kilométrage) est exclu : il se saisit autrement qu'un justificatif.
    const FALLBACK_EXPENSE_TYPES = [
      ['E110', 'Train - Rail'], ['E120', 'Rental car - Vehicle'], ['E130', 'Taxi'],
      ['E140', 'Bus-Metro-Public Transp'], ['E150', 'Parking'], ['E160', 'Other Travel Fees'],
      ['E170', 'Excursions & Museum'], ['E210', 'Breakfast-Morning meal'],
      ['E220', 'Lunch-Midday-Noon meal'], ['E230', 'Dinner-Evening meal'], ['E240', 'Tip'],
      ['E250', 'Consular - Visas Fees'], ['E260', 'Registration, tuition'],
      ['E270', 'Entertain costs'], ['E290', 'Biochemicals Products'],
      ['E300', 'Laboratory Supplies'], ['E310', 'Electronic equipment'],
      ['E320', 'Workshop Supplies'], ['E330', 'Pers. Training extra mur'],
      ['E340', 'Medical Expenses'], ['E350', 'Gifts for staff'], ['E360', 'Office Supplies'],
      ['E370', 'Computer Consumables'], ['E380', 'Printing works'],
      ['E390', 'Postage letters & parcels'], ['E400', 'Service Fees computer'],
      ['E410', 'Wifi Network fees'], ['E420', 'Peripheral devices'],
      ['E430', 'Computer licenses'], ['E440', 'Soft purchase maintenance'],
      ['E450', 'Speakers/Guests'], ['E460', 'Customs taxes'], ['E470', 'Membership fees'],
      ['E480', 'Single book purchases'], ['E490', 'Data banks Purch/registr'],
      ['E500', 'Publication/Reprint costs'], ['E505', 'Publication/Reprint costs (invoice)'],
      ['E510', 'Mobile phone charges'],
      ['E560', 'Agency Fees'], ['E580', 'Furniture exl. DII'], ['E590', 'Job advertisement'],
      ['E600', 'Translation/writing fees'], ['E610', 'Scientif reasearch analys'],
      ['E620', 'Patent & copyright'], ['E630', 'Document digital support'],
      ['E640', 'Purchase electronic book'], ['E650', 'Paper mag subsription'],
      ['E660', 'Electr mag subsription'], ['E670', 'Docum interlibrary'],
      ['E680', 'E-Book Subsription'],
    ].map(([id, label]) => ({ id, label }));
    const FALLBACK_TYPE = 'E160';

    /**
     * Liste SAP (ExpenseTypes) → [{id, label}] pour l'UI et le prompt du serveur.
     * « Train - Rail /Cash » → « Train - Rail » ; kilométrage exclu.
     */
    function typesFromSap(results) {
      return (results || [])
        .filter((t) => t.ExpenseTypeID && t.ExpenseTypeID !== 'MILE' && t.Category !== 12)
        .map((t) => ({ id: t.ExpenseTypeID, label: String(t.Description || t.ExpenseTypeID).replace(/\s*\/\s*Cash$/i, '').replace(/\s*\/\s*Inv\.?$/i, ' (invoice)').trim() }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }

    /** "1'234,50" / "27,40" / "1,234.50" / 46 → nombre, NaN si illisible. */
    function parseAmount(v) {
      if (typeof v === 'number') return v;
      if (typeof v !== 'string') return NaN;
      let s = v.replace(/[\s'’]/g, '').replace(/[^\d.,-]/g, '');
      const lastComma = s.lastIndexOf(',');
      const lastDot = s.lastIndexOf('.');
      if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
      return s ? Number(s) : NaN;
    }

    const round2 = (n) => Math.round(n * 100) / 100;
    const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

    const sameAmount = (a, b) => Math.abs(a - b) < 0.015;

    /**
     * Montant hors pourboire, décidé par l'arithmétique et non par le modèle :
     * le même ticket (total 44, articles 44, pourboire 4 imprimé dessous) était
     * lu tantôt 44 + 4, tantôt 40 + 4. Le modèle recopie les chiffres imprimés,
     * on tranche ici :
     *   articles = total           → pourboire EN PLUS du total (montant = total)
     *   articles + pourboire = total → pourboire INCLUS (montant = total − pourboire)
     * Sinon on garde l'estimation du modèle et on le signale.
     */
    function resolveTip(raw) {
      const total = parseAmount(raw.printed_total);
      const items = parseAmount(raw.items_sum);
      const tip = parseAmount(raw.tip);
      const estimate = parseAmount(raw.amount);
      if (!(tip > 0)) return { amount: estimate > 0 ? estimate : total, tip: 0, warning: null };
      if (total > 0 && items > 0) {
        if (sameAmount(items, total)) return { amount: total, tip, warning: null };
        if (sameAmount(items + tip, total)) return { amount: total - tip, tip, warning: null };
      }
      return { amount: estimate, tip, warning: 'Pourboire : impossible de vérifier s\'il est compris dans le total, contrôlez le montant.' };
    }

    /** Réponse brute du LLM → champs propres + avertissements pour l'usager. */
    function normalizeExtraction(raw, typeIds) {
      const warnings = [];
      if (raw && raw.is_receipt === false) {
        return { isReceipt: false, warnings: [raw.notes || "Ce document ne ressemble pas à un justificatif."] };
      }
      const { amount, tip, warning: tipWarning } = resolveTip(raw);
      if (tipWarning) warnings.push(tipWarning);
      const currency = String(raw.currency || '').trim().toUpperCase();
      let type = String(raw.expense_type || '').trim().toUpperCase();
      if (!typeIds.has(type)) {
        warnings.push(`Type de frais « ${raw.expense_type || '?'} » inconnu, remplacé par « Other Travel Fees ».`);
        type = FALLBACK_TYPE;
      }
      if (!isIsoDate(raw.date)) warnings.push('Date illisible : à compléter.');
      if (!(amount > 0)) warnings.push('Montant illisible : à compléter.');
      if (!/^[A-Z]{3}$/.test(currency)) warnings.push('Devise illisible : à compléter.');
      if (raw.confidence === 'low') warnings.push('Lecture incertaine : vérifiez tous les champs.');
      if (raw.notes) warnings.push(String(raw.notes));
      return {
        isReceipt: true,
        vendor: String(raw.vendor || '').trim(),
        date: isIsoDate(raw.date) ? raw.date : '',
        amount: amount > 0 ? round2(amount) : null,
        tip: tip > 0 ? round2(tip) : 0,
        currency: /^[A-Z]{3}$/.test(currency) ? currency : 'CHF',
        type,
        city: String(raw.city || '').trim(),
        country: String(raw.country || '').trim().toUpperCase().slice(0, 2),
        description: String(raw.description || '').trim(),
        confidence: raw.confidence || 'medium',
        warnings,
      };
    }

    /** Un justificatif → une ligne de frais, plus une ligne « Tip » s'il y a un pourboire. */
    function linesFromExtraction(ex, receiptId) {
      if (!ex.isReceipt) return [];
      const memo = [ex.description || ex.vendor].filter(Boolean).join('');
      const lines = [{
        receiptId, type: ex.type, date: ex.date, amount: ex.amount, currency: ex.currency,
        memo, vendor: ex.vendor, city: ex.city, country: ex.country, warnings: ex.warnings,
      }];
      if (ex.tip > 0) {
        lines.push({
          receiptId, type: 'E240', date: ex.date, amount: ex.tip, currency: ex.currency,
          memo: `Pourboire – ${ex.vendor}`.trim(), vendor: ex.vendor, city: ex.city,
          country: ex.country, warnings: [], isTip: true,
        });
      }
      return lines;
    }

    const HOME_CITIES = /^(lausanne|ecublens|renens|st-sulpice|saint-sulpice|chavannes)/i;

    const mostFrequent = (values) => {
      const counts = {};
      for (const v of values) counts[v] = (counts[v] || 0) + 1;
      return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    };

    /**
     * Dates du voyage = premier et dernier justificatif. Destination = pays
     * étranger le plus fréquent (sinon Suisse) et sa ville la plus fréquente hors
     * campus ; le but du voyage en découle.
     */
    function inferTrip(lines) {
      const dates = lines.map((l) => l.date).filter(isIsoDate).sort();
      const countries = [...new Set(lines.map((l) => l.country).filter(Boolean))];
      const foreignCountries = countries.filter((c) => c !== 'CH');
      const destCountry = mostFrequent(lines.map((l) => l.country).filter((c) => c && c !== 'CH')) || 'CH';
      const destCity = mostFrequent(lines
        .filter((l) => l.city && !HOME_CITIES.test(l.city) && (l.country || 'CH') === destCountry)
        .map((l) => l.city));
      return {
        fromDate: dates[0] || '',
        toDate: dates[dates.length - 1] || '',
        purpose: destCity ? `Voyage à ${destCity}` : '',
        destCountry,
        destCity,
        foreignCountries,
      };
    }

    /** Deux intervalles de dates ISO se chevauchent-ils ? */
    const overlaps = (aFrom, aTo, bFrom, bTo) => aFrom <= bTo && bFrom <= aTo;

    /**
     * Frais déjà présents dans une note SAP existante : même type, même jour,
     * même montant et même devise. `claims` = lignes `Claims` relues dans SAP.
     * Renvoie [{line, claim}] ; rien n'est conservé côté navigateur.
     */
    function matchExistingClaims(lines, claims) {
      const matches = [];
      for (const line of lines) {
        const claim = claims.find((c) => c.ExpenseTypeID === line.type
          && fromSapDate(c.FromDate)?.date === line.date
          && c.ReceiptAmount?.CurrencyCode === line.currency
          && sameAmount(Number(c.ReceiptAmount?.Value), Number(line.amount)));
        if (claim) matches.push({ line, claim });
      }
      return matches;
    }

    /** Doublons probables : même montant, même date, même devise. */
    function findDuplicates(lines) {
      const seen = new Map();
      const dups = [];
      lines.forEach((l, i) => {
        if (!l.amount || !l.date || l.isTip) return;
        const k = `${l.date}|${l.amount}|${l.currency}`;
        if (seen.has(k)) dups.push([seen.get(k), i]);
        else seen.set(k, i);
      });
      return dups;
    }

    // ── Dates OData V2 ────────────────────────────────────────────────────
    // SAP stocke l'heure locale « comme si » c'était de l'UTC :
    // 24.09.2026 08:00 affiché = /Date(1790236800000)/ = 2026-09-24T08:00Z.
    function toSapDate(isoDate, hhmm = '00:00') {
      const [y, m, d] = isoDate.split('-').map(Number);
      const [hh, mm] = hhmm.split(':').map(Number);
      return `/Date(${Date.UTC(y, m - 1, d, hh || 0, mm || 0)})/`;
    }
    function fromSapDate(s) {
      const ms = Number(/\/Date\((-?\d+)/.exec(s || '')?.[1]);
      if (!isFinite(ms)) return null;
      const iso = new Date(ms).toISOString();
      return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
    }
    /** JSON avec les dates au format littéral OData V2 "\/Date(…)\/" comme l'app Fiori. */
    function odataJson(obj) {
      return JSON.stringify(obj).replace(/"\/Date\((-?\d+)\)\/"/g, '"\\/Date($1)\\/"');
    }

    // ── Préparation des objets pour MERGE (copie du comportement de l'UI) ──
    const isNav = (v) => v && typeof v === 'object' && !Array.isArray(v) && ('__deferred' in v || Array.isArray(v.results));
    function stripNav(obj) {
      const o = {};
      for (const [k, v] of Object.entries(obj)) if (!isNav(v)) o[k] = v;
      return o;
    }
    function stripMeta(v) {
      if (Array.isArray(v)) return v.map(stripMeta);
      if (!v || typeof v !== 'object') return v;
      const o = {};
      for (const [k, x] of Object.entries(v)) if (k !== '__metadata') o[k] = stripMeta(x);
      return o;
    }
    /** Header : l'UI renvoie tout, métadonnées comprises, sans les navigations. */
    function headerForMerge(hdr) {
      return stripNav(hdr);
    }
    /**
     * Destination : l'UI renvoie l'objet relu, pays et lieu changés, région de
     * per diem vidée (capture « voyage » du 24.09.2026, Berlin).
     */
    function destinationForMerge(dest, country, city) {
      const o = stripNav(dest);
      o.Address = { ...dest.Address, Country: country, Location: city || '' };
      o.PerDiemRegion = '';
      o.PerDiemRegionDescription = '';
      return o;
    }
    /** Expense : l'UI renvoie tout SANS __metadata ni champs de contrôle *_FC de 1er niveau. */
    function expenseForMerge(exp) {
      const o = stripMeta(stripNav(exp));
      for (const k of Object.keys(o)) if (k.endsWith('_FC')) delete o[k];
      return o;
    }

    // ── $batch OData V2 ───────────────────────────────────────────────────
    const rnd = () => Math.random().toString(16).slice(2, 6);
    const utf8Length = (s) => new TextEncoder().encode(s).length;

    /** ops: [{method:'GET'|'POST'|'MERGE', path, body?}] — une écriture par changeset, comme UI5. */
    function buildBatch(ops, csrfToken) {
      const boundary = `batch_${rnd()}-${rnd()}-${rnd()}`;
      const common = 'Accept: application/json\r\nAccept-Language: en\r\n'
        + 'MaxDataServiceVersion: 2.0\r\nDataServiceVersion: 2.0\r\n'
        + (csrfToken ? `x-csrf-token: ${csrfToken}\r\n` : '');
      let out = '';
      for (const op of ops) {
        out += `--${boundary}\r\n`;
        if (op.method === 'GET') {
          out += 'Content-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n'
            + `GET ${op.path} HTTP/1.1\r\n${common}\r\n\r\n`;
          continue;
        }
        const cs = `changeset_${rnd()}-${rnd()}-${rnd()}`;
        const body = op.body === undefined ? '' : odataJson(op.body);
        out += `Content-Type: multipart/mixed; boundary=${cs}\r\n\r\n`
          + `--${cs}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n`
          + `${op.method} ${op.path} HTTP/1.1\r\n${common}`
          + (body ? `Content-Type: application/json\r\nContent-Length: ${utf8Length(body)}\r\n` : '')
          + `\r\n${body}\r\n--${cs}--\r\n\r\n`;
      }
      out += `--${boundary}--\r\n`;
      return { contentType: `multipart/mixed;boundary=${boundary}`, body: out };
    }

    function splitHead(text) {
      const m = /\r?\n\r?\n/.exec(text);
      return m ? [text.slice(0, m.index), text.slice(m.index + m[0].length)] : [text, ''];
    }
    function parseHeaders(block) {
      const h = {};
      for (const line of block.split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      return h;
    }
    const boundaryOf = (ct) => /boundary=("?)([^";]+)\1/i.exec(ct || '')?.[2];

    /** Réponse $batch → liste plate de {status, headers, data, raw}, dans l'ordre des opérations. */
    function parseBatch(text, contentType) {
      const boundary = boundaryOf(contentType);
      if (!boundary) throw new Error(`réponse $batch sans boundary (${contentType})`);
      const results = [];
      for (let part of text.split(`--${boundary}`).slice(1)) {
        if (part.startsWith('--')) break;
        part = part.replace(/^\r?\n/, '');
        const [mimeHead, content] = splitHead(part);
        const mime = parseHeaders(mimeHead);
        if (/multipart\/mixed/i.test(mime['content-type'] || '')) {
          results.push(...parseBatch(content, mime['content-type']));
          continue;
        }
        const [httpHead, body] = splitHead(content);
        const [statusLine, ...hdrLines] = httpHead.split(/\r?\n/);
        const status = Number(/HTTP\/\d\.\d (\d{3})/.exec(statusLine)?.[1] || 0);
        const headers = parseHeaders(hdrLines.join('\n'));
        const raw = body.replace(/\s+$/, '');
        let data = null;
        if (raw.startsWith('{')) { try { data = JSON.parse(raw); } catch { /* laissé en raw */ } }
        results.push({ status, headers, data, raw });
      }
      return results;
    }

    /** En-tête sap-message → [{severity, text}] (textes URL-encodés par SAP). */
    function parseSapMessage(header) {
      if (!header) return [];
      let m;
      try { m = JSON.parse(header); } catch { return [{ severity: '?', text: header }]; }
      const dec = (s) => { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch { return String(s); } };
      return (m.details || []).map((d) => ({ severity: d.severity || '', text: dec(d.text) }));
    }

    /** Message d'erreur lisible pour une réponse (statut HTTP ou message SAP de gravité E). */
    function responseError(res) {
      if (res.status >= 400 || res.status === 0) {
        const v = res.data?.error?.message?.value;
        const inner = (res.data?.error?.innererror?.errordetails || []).map((d) => d.message).filter(Boolean);
        return [v, ...inner].filter(Boolean).join(' — ') || `HTTP ${res.status}`;
      }
      const errs = parseSapMessage(res.headers['sap-message']).filter((d) => d.severity === 'E');
      return errs.length ? errs.map((d) => d.text).join(' — ') : null;
    }

    const asciiFileName = (name, i) => {
      const ext = (/\.([a-z0-9]{1,5})$/i.exec(name || '')?.[1] || 'jpg').toLowerCase();
      return `justificatif-${String(i + 1).padStart(2, '0')}.${ext}`;
    };

    /**
     * Nature d'un justificatif : type MIME, à défaut extension (sous Windows, un HEIC
     * d'iPhone arrive souvent sans type). null = format non pris en charge.
     */
    function fileKind(file) {
      const type = String(file?.type || '').toLowerCase();
      const ext = (/\.([a-z0-9]{1,5})$/i.exec(file?.name || '')?.[1] || '').toLowerCase();
      if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
      if (/^image\/hei[cf]/.test(type) || /^hei[cf]$/.test(ext)) return 'heic';
      if (type === 'image/tiff' || /^tiff?$/.test(ext)) return 'tiff';
      if (/^image\//.test(type) || /^(jpe?g|jfif|png|webp|gif|bmp|avif)$/.test(ext)) return 'image';
      return null;
    }

    const MAX_PAGES_PER_RECEIPT = 3;
    const pageList = (pages) => pages.map((i) => i + 1).join(', ');

    /**
     * Regroupe les pages d'un PDF en justificatifs, d'après le tri page par page (/classify).
     * Une page prolonge le justificatif en cours si elle le suit directement et porte le même
     * n° de document, un n° de page > 1, ou ne commence visiblement pas un document.
     * Les pages « other » (conditions générales, page de garde…) sont écartées et coupent
     * le justificatif en cours. Page dont le tri a échoué : justificatif à part.
     * → { groups: [{ pages: [index…], warnings }], skipped: [index…] }
     */
    function groupPages(infos) {
      const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      const groups = [];
      const skipped = [];
      let cur = null;
      infos.forEach((raw, i) => {
        const p = raw && typeof raw === 'object' ? raw : { error: 'tri absent' };
        if (p.kind === 'other' && !p.error) { skipped.push(i); cur = null; return; }
        const num = norm(p.document_number);
        const pageNo = Number.isInteger(p.page_number) ? p.page_number : null;
        let continues = false;
        if (cur && !p.error && !cur.error) {
          if (num && cur.num) continues = num === cur.num;
          else if (pageNo !== null) continues = pageNo > 1;
          else continues = p.starts_document === false;
        }
        if (continues) {
          cur.pages.push(i);
          cur.num ||= num;
        } else {
          cur = { pages: [i], num, error: Boolean(p.error), warnings: [] };
          if (p.error) cur.warnings.push(`Tri de la page ${i + 1} impossible (${p.error}) : lue comme un justificatif à part.`);
          groups.push(cur);
        }
      });
      return {
        skipped,
        groups: groups.map(({ pages, warnings }) => {
          if (pages.length <= MAX_PAGES_PER_RECEIPT) return { pages, warnings };
          // Le total est en fin de document : 1re page (fournisseur, date) + les dernières.
          const kept = [pages[0], ...pages.slice(-(MAX_PAGES_PER_RECEIPT - 1))];
          return { pages: kept, warnings: [...warnings, `Justificatif de ${pages.length} pages (p. ${pageList(pages)}) : seules les pages ${pageList(kept)} ont été lues.`] };
        }),
      };
    }

    return {
      groupPages, pageList,
      FALLBACK_EXPENSE_TYPES, typesFromSap, parseAmount, normalizeExtraction,
      linesFromExtraction, inferTrip, findDuplicates, matchExistingClaims, overlaps,
      toSapDate, fromSapDate, odataJson, stripNav, stripMeta, headerForMerge, expenseForMerge, destinationForMerge,
      buildBatch, parseBatch, parseSapMessage, responseError, asciiFileName, fileKind, isIsoDate,
    };
  })();

  // Sous Node (tests) : on exporte le cœur et on s'arrête là.
  if (typeof window === 'undefined' && typeof module !== 'undefined' && module.exports) { module.exports = Core; return; }
  if (typeof window === 'undefined') return;
  // Le favori recharge ce script à chaque clic. Même version déjà présente, ou
  // création en cours : on rouvre le panneau tel quel. Version plus ancienne
  // (mise à jour du serveur depuis l'ouverture de sesame) : on la remplace.
  const previous = window.__ndf;
  if (previous && (previous.version === VERSION || previous.busy)) { previous.open(); return; }
  if (previous) {
    try {
      if (previous.destroy) previous.destroy();
      else { // versions d'avant destroy() : panneau masqué (son écouteur de collage l'ignore alors), puis retiré
        previous.$?.('.overlay')?.classList.add('hidden');
        document.getElementById('ndf-epfl-host')?.remove();
      }
    } catch { /* on remplace quand même */ }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Préférences (fonds, approbateur, n° de personnel) : localStorage de sesame
  // ════════════════════════════════════════════════════════════════════════
  const Store = {
    get(key, def) {
      try { return localStorage.getItem(`ndf.${key}`) ?? def; } catch { return def; }
    },
    set(key, val) {
      try { localStorage.setItem(`ndf.${key}`, val); } catch { /* stockage indisponible : on s'en passe */ }
    },
    remove(key) {
      try { localStorage.removeItem(`ndf.${key}`); } catch { /* idem */ }
    },
  };
  // Plus rien de personnel dans le navigateur hormis fonds et approbateur préférés :
  // on efface ce que les versions précédentes y avaient laissé.
  Store.remove('pernr');
  Store.remove('created');

  // ════════════════════════════════════════════════════════════════════════
  // Client sesame (OData PAOC_TRV_SRV, même origine → cookies SSO de la page)
  // ════════════════════════════════════════════════════════════════════════
  const BASE = '/sap/opu/odata/sap/PAOC_TRV_SRV/';
  const q = (s) => encodeURIComponent(s).replace(/'/g, '%27');

  // Erreurs SAP qu'on laisse passer pendant la création pour les montrer à la fin.
  const REQUIRED_FIELD = /Required entry field/i;

  class Sesame {
    constructor(log) { this.log = log; this.csrf = null; this.warnings = []; }

    async fetchCsrf() {
      const r = await fetch(BASE, {
        credentials: 'include',
        headers: { 'x-csrf-token': 'Fetch', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!r.ok) throw new Error(`sesame inaccessible (HTTP ${r.status}) — êtes-vous connecté ?`);
      this.csrf = r.headers.get('x-csrf-token');
      if (!this.csrf) throw new Error('jeton CSRF introuvable');
    }

    async batch(ops, retried = false) {
      if (!this.csrf) await this.fetchCsrf();
      const { contentType, body } = Core.buildBatch(ops, this.csrf);
      const r = await fetch(BASE + '$batch', {
        method: 'POST', credentials: 'include', body,
        headers: { 'Content-Type': contentType, Accept: 'application/json', 'x-csrf-token': this.csrf, 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (r.status === 403 && !retried && /required/i.test(r.headers.get('x-csrf-token') || '')) {
        this.csrf = null;
        return this.batch(ops, true);
      }
      if (r.status !== 202 && r.status !== 200) throw new Error(`$batch refusé (HTTP ${r.status})`);
      const results = Core.parseBatch(await r.text(), r.headers.get('content-type'));
      if (results.length !== ops.length) throw new Error(`$batch : ${results.length} réponses pour ${ops.length} opérations`);
      return results;
    }

    /**
     * Une seule opération ; lève une erreur lisible si SAP la refuse. Les
     * erreurs SAP qui correspondent à `tolerate` (ex. champ obligatoire vide)
     * sont rendues comme avertissements au lieu d'interrompre la création.
     */
    async one(method, path, body, label, tolerate = null) {
      const [res] = await this.batch([{ method, path, body }]);
      const err = Core.responseError(res);
      for (const m of Core.parseSapMessage(res.headers['sap-message'])) {
        if (m.severity !== 'E') this.log(`  SAP (${m.severity || 'info'}) : ${m.text}`);
      }
      if (err && tolerate && res.status < 400 && tolerate.test(err)) {
        this.warnings.push(`${label} : ${err}`);
        this.log(`  ⚠ ${label} : ${err}`);
      } else if (err) {
        throw new Error(`${label} : ${err}`);
      }
      return res.data?.d ?? null;
    }
    get(path, label) { return this.one('GET', path, undefined, label); }
    post(path, body, label, tolerate) { return this.one('POST', path, body, label, tolerate); }
    merge(path, body, label, tolerate) { return this.one('MERGE', path, body, label, tolerate); }

    // ── Lectures ─────────────────────────────────────────────────────────
    async findPersonalNumber() {
      const fromUrl = /TravelAndExpenseHeaders(?:\(|%28)(?:'|%27)(\d{8})/.exec(location.href)?.[1];
      if (fromUrl) return fromUrl;
      let why = 'profil SAP sans numéro';
      try {
        const d = await this.get('UserProfiles', 'Profil');
        const me = (d?.results || []).find((p) => p.Isself) || d?.results?.[0];
        if (me?.PersonalNumber) return me.PersonalNumber;
      } catch (e) { why = e.message; this.log(`  (profil : ${e.message})`); }
      const typed = (window.prompt(`Numéro de personnel SAP introuvable automatiquement (${why}).\nIl apparaît dans sesame à côté de votre nom, ex. « Prénom Nom (12345) ».\nVotre numéro :`) || '').replace(/\D/g, '');
      if (!typed) throw new Error('numéro de personnel requis');
      return typed.padStart(8, '0');
    }

    draftId(pernr) { return `${pernr}0000000000_____`; }

    /**
     * Anti-doublon interrogeant SAP (rien n'est stocké dans le navigateur) :
     * notes de l'usager dont les dates chevauchent le voyage, relues en lecture
     * seule, puis comparaison ligne à ligne. → [{tripNumber, reason, matches}]
     */
    async findExistingExpenses(report) {
      const since = new Date(Date.parse(report.fromDate) - 90 * 86_400_000).toISOString().slice(0, 10);
      const d = await this.get(`TravelSummaries?$filter=${q(`FromDate ge datetime'${since}T00:00:00'`)}`, 'Notes existantes');
      const candidates = (d?.results || []).filter((s) => {
        const from = Core.fromSapDate(s.FromDate)?.date;
        const to = Core.fromSapDate(s.ToDate)?.date || from;
        return from && Core.overlaps(from, to, report.fromDate, report.toDate);
      }).slice(0, 10);
      const found = [];
      for (const s of candidates) {
        const id = s.TravelAndExpenseHeaderID;
        const hdr = await this.get(`TravelAndExpenseHeaders('${id}')?$expand=Claims&mode=DIS`, 'Lecture d\'une note existante');
        const matches = Core.matchExistingClaims(report.lines, hdr?.Claims?.results || []);
        if (matches.length) found.push({ tripNumber: String(Number(id.slice(8, 18))), reason: s.Reason || '', matches });
      }
      return found;
    }

    /** Crée le brouillon (comme le « + » de l'UI) puis le relit : la relecture porte SCIPER et nom. */
    async newDraft(pernr) {
      await this.post('TravelAndExpenseHeaders', {
        SchemaID: 'Z2', PersonalNumber: pernr, UserAction: 1,
        __metadata: { type: 'PAOC_TRV_SRV.TravelAndExpenseHeader' },
      }, 'Création du brouillon');
      return this.readHeader(this.draftId(pernr), 'MOD');
    }

    readHeader(id, mode, lock = false) {
      return this.get(`TravelAndExpenseHeaders('${id}')?$expand=Claims%2cDestinations%2cCostAssignments%2cAttachments&mode=${mode}${lock ? '&lock=X' : ''}`, 'Lecture de la note');
    }

    /** Types de frais autorisés pour ce brouillon (dépendent du schéma de voyage). */
    async expenseTypes(draftId) {
      const d = await this.get(`TravelAndExpenseHeaders('${draftId}')/ExpenseTypes?$skip=0&$top=500&$orderby=Description%20asc`, 'Types de frais');
      return Core.typesFromSap(d?.results);
    }

    /** Pays connus de SAP : [{id:'DE', label:'Germany (DE)'}]. */
    async countries() {
      const d = await this.get('Countries', 'Pays');
      return (d?.results || []).map((c) => ({ id: c.CountryID, label: c.Description || c.CountryID }));
    }

    async funds(pernr) {
      const d = await this.get(`UserProfiles('${pernr}')/CostObjects?$skip=0&$top=200&$orderby=Description%20asc&$filter=CostObjectTypeID%20eq%20%275%27`, 'Liste des fonds');
      return d?.results || [];
    }

    async approvers(fund, sciper) {
      const filter = `Funds eq '${fund}' and Onbehalfuser eq '${sciper}'`;
      const d = await this.get(`ApproverListSet?$skip=0&$top=50&$filter=${q(filter)}`, 'Liste des approbateurs');
      return d?.results || [];
    }

    async uploadAttachment(expenseId, blob, fileName) {
      if (!this.csrf) await this.fetchCsrf();
      const r = await fetch(`${BASE}Expenses('${expenseId}')/Attachments`, {
        method: 'POST', credentials: 'include', body: blob,
        headers: {
          'Content-Type': 'application/octet-stream', slug: fileName,
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'x-csrf-token': this.csrf, 'X-Requested-With': 'XMLHttpRequest', Accept: '*/*',
        },
      });
      const msgs = Core.parseSapMessage(r.headers.get('sap-message'));
      const errs = msgs.filter((m) => m.severity === 'E');
      if (!r.ok || errs.length) throw new Error(`Envoi de ${fileName} : ${errs.map((m) => m.text).join(' — ') || `HTTP ${r.status}`}`);
    }

    /** Ré-envoie les imputations telles que relues : l'UI le fait avant chaque Save. */
    async repostCostAssignments(hdr) {
      for (const ca of hdr.CostAssignments?.results || []) {
        await this.post('CostAssignments', Core.stripNav(ca), 'Imputation');
      }
    }

    async save(id) {
      const d = await this.post(`SaveHeader?TravelAndExpenseHeaderID=%27${id}%27&UserAction=2`, undefined, 'Enregistrement');
      const newId = d?.SaveHeader?.TravelAndExpenseHeaderID;
      if (!newId) throw new Error('Enregistrement : pas de numéro de note renvoyé');
      return newId;
    }

    // ── Création complète ────────────────────────────────────────────────
    /**
     * report = { pernr, purpose, comment, fromDate, fromTime, toDate, toTime,
     *            destCountry, destCity,
     *            fund (objet CostObject), approver (objet ApproverList), approverNote,
     *            lines: [{type, date, amount, currency, memo, vendor, file?}] }
     * Séquence observée dans l'UI (docs/api-sesame-PAOC_TRV_SRV.md), puis une 2e
     * passe pour les justificatifs. L'upload marche aussi sur le brouillon
     * (capture « voyage »), mais c'est la séquence en deux temps qui a été
     * validée en production.
     * Renvoie aussi `warnings` : champs que SAP juge obligatoires et vides.
     */
    async createReport(report, step) {
      const { pernr } = report;
      const draftId = this.draftId(pernr);
      this.warnings = [];

      step('Création du brouillon');
      let hdr = await this.newDraft(pernr);

      step('Imputation sur le fonds');
      const f = report.fund;
      await this.post('CostAssignments', {
        HasOtp: false, Percentage: '100',
        CostObjectDescription: `${f.CostObjectID} : ${f.Description} (${f.Fistl})`,
        Fistl: f.Fistl, CostObjectID: f.CostObjectID,
        TravelAndExpenseHeaderID: draftId, LineId: '0',
      }, 'Imputation');

      // Même ordre que l'UI (capture « voyage ») : dates → destination → approbateur.
      // Changer la destination efface l'approbateur déjà posé (vu le 24.09.2026,
      // note 10100003) : l'en-tête est donc réécrit APRÈS la destination.
      const headerFields = {
        Reason: report.purpose,
        Commentary: report.comment,
        FromDate: Core.toSapDate(report.fromDate, report.fromTime),
        ToDate: Core.toSapDate(report.toDate, report.toTime),
        Approver: report.approver.Bname,
        ApproverName: report.approver.NameText,
        ZapprovalNote: report.approverNote,
        UserAction: 1,
      };
      const writeHeader = async (current) => this.merge(`TravelAndExpenseHeaders('${draftId}')`,
        Object.assign(Core.headerForMerge(current), headerFields), 'Mise à jour de la note');

      step('Dates, but et approbateur');
      await writeHeader(hdr);

      // Destination par défaut = Suisse sans lieu ; on ne la touche que si elle diffère.
      // Relue après le MERGE de l'en-tête : SAP y recale la date de début.
      const destId = hdr.Destinations?.results?.[0]?.DestinationID;
      if (destId && (report.destCountry !== 'CH' || report.destCity)) {
        step(`Destination : ${report.destCountry}${report.destCity ? `, ${report.destCity}` : ''}`);
        const dest = await this.get(`Destinations('${destId}')`, 'Destination');
        await this.merge(`Destinations('${destId}')`, Core.destinationForMerge(dest, report.destCountry, report.destCity), 'Destination');
        step('Approbateur (reposé après la destination)');
        await writeHeader(await this.readHeader(draftId, 'MOD'));
      }

      const expenseIds = [];
      for (const [i, line] of report.lines.entries()) {
        step(`Frais ${i + 1}/${report.lines.length} : ${line.memo || line.type}`);
        const exp = await this.post('Expenses', {
          TravelAndExpenseHeaderID: draftId, ExpenseTypeID: line.type,
          __metadata: { type: 'PAOC_TRV_SRV.Expense' },
        }, `Frais ${i + 1}`);
        const e = Core.expenseForMerge(exp);
        Object.assign(e, {
          ReceiptAmount: { Value: line.amount.toFixed(2), CurrencyCode: line.currency, Decimals: 2 },
          ExpenseDate: Core.toSapDate(line.date),
          // Sans elles, SAP étend certains types (Tip) à toute la durée du voyage.
          FromDate: Core.toSapDate(line.date),
          ToDate: Core.toSapDate(line.date),
          Memo: (line.memo || '').slice(0, 200),
          // « Name » du fournisseur : obligatoire pour la plupart des types (capture « voyage »).
          SeName: (line.vendor || '').slice(0, 40),
        });
        // SAP convertit lui-même les devises étrangères (taux du jour, ConvertedAmount).
        await this.merge(`Expenses('${exp.ExpenseID}')`, e, `Frais ${i + 1} (${line.type})`, REQUIRED_FIELD);
        expenseIds.push(exp.ExpenseID);
      }

      step('Enregistrement');
      hdr = await this.readHeader(draftId, 'MOD');
      // Contrôle avant Save : un approbateur perdu en route est reposé, sinon signalé.
      if (hdr.Approver !== report.approver.Bname) {
        this.log(`  Approbateur relu : « ${hdr.ApproverName || 'vide'} » au lieu de « ${report.approver.NameText} » — on le repose.`);
        await writeHeader(hdr);
        hdr = await this.readHeader(draftId, 'MOD');
        if (hdr.Approver !== report.approver.Bname) this.warnings.push(`Approbateur FC non enregistré par SAP : choisissez « ${report.approver.NameText} » dans sesame.`);
      }
      await this.repostCostAssignments(hdr);
      const savedId = await this.save(draftId);
      const tripNumber = String(Number(savedId.slice(8, 18)));

      const withFiles = report.lines.map((l, i) => ({ l, i })).filter(({ l }) => l.file);
      if (withFiles.length) {
        step('Réouverture pour les justificatifs');
        hdr = await this.readHeader(savedId, 'MOD', true);
        await this.repostCostAssignments(hdr);
        const claims = (hdr.Claims?.results || []).slice().sort((a, b) => a.Position - b.Position);
        for (const [n, { l, i }] of withFiles.entries()) {
          // Même rang que la création ; à défaut, reconstruction de l'ID (…_____E001_____).
          const expId = claims[i]?.ExpenseID || `${savedId}${expenseIds[i].slice(savedId.length)}`;
          step(`Justificatif ${n + 1}/${withFiles.length}`);
          await this.uploadAttachment(expId, l.file.blob, l.file.name);
        }
        step('Enregistrement final');
        await this.save(savedId);
      }
      return { savedId, tripNumber, warnings: this.warnings };
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Justificatifs : décodage (image, HEIC, TIFF, PDF) et réduction avant envoi au LLM
  // ════════════════════════════════════════════════════════════════════════
  // Bibliothèques servies par NOTRE serveur (pas de CDN tiers dans une page sesame
  // connectée), chargées seulement au premier fichier qui en a besoin.
  const VENDOR = `${BASE_URL}/vendor`;
  const PDF_MAX_PAGES = 30;
  let pdfjsPromise;
  const umdCache = {};

  // Empreintes SHA-256 des bibliothèques tierces (web/vendor/README.md) : un fichier qui ne
  // correspond pas est refusé AVANT d'être exécuté. À changer avec la bibliothèque elle-même.
  const VENDOR_SHA256 = {
    'pdfjs-6.3.289/pdf.min.mjs': 'f401927e692efc7735e0cd528c490d0dd31b7f0972c122b7040df805be45cce4',
    'pdfjs-6.3.289/pdf.worker.min.mjs': 'a33cfe728c584fdba4fcc1fd54bcdc2f9f2f13889ddbb5b2bd1d0f8cbe49b84e',
    'heic2any-0.0.4.min.js': '0963cfa50e9e1e7e6af929a40a81e3e898a673f1270eafa6917dd137e4968164',
    'utif-3.1.0.js': 'e3e76115f49571e39624c3316a76b3c4c5b2c5ca518dfec4b66a9f7af8c6d059',
  };

  /** Bibliothèque téléchargée puis vérifiée octet pour octet (intégrité de sous-ressource « maison »). */
  async function fetchVerified(file) {
    const r = await fetch(`${VENDOR}/${file}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const bytes = await r.arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex !== VENDOR_SHA256[file]) throw new Error('empreinte inattendue, fichier refusé');
    return bytes;
  }
  // Code vérifié servi depuis la mémoire : le navigateur exécute exactement les octets contrôlés.
  const blobUrl = (bytes) => URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));

  function loadPdfjs() {
    pdfjsPromise ??= Promise.all([fetchVerified('pdfjs-6.3.289/pdf.min.mjs'), fetchVerified('pdfjs-6.3.289/pdf.worker.min.mjs')])
      .then(async ([lib, worker]) => {
        const m = await import(blobUrl(lib));
        m.GlobalWorkerOptions.workerSrc = blobUrl(worker);
        return m;
      }).catch((e) => { pdfjsPromise = null; throw new Error(`lecteur PDF indisponible (${e.message})`); });
    return pdfjsPromise;
  }

  /** Script UMD vérifié puis exécuté dans sa propre portée : aucune variable globale posée dans sesame. */
  function loadUmd(file) {
    umdCache[file] ??= fetchVerified(file).then((bytes) => new TextDecoder().decode(bytes)).then((src) => {
      const module = { exports: {} };
      new Function('module', 'exports', 'define', 'require', src)(module, module.exports, undefined, undefined);
      return module.exports;
    }).catch((e) => { delete umdCache[file]; throw new Error(`décodeur ${file} indisponible (${e.message})`); });
    return umdCache[file];
  }

  async function bitmapOf(blob) {
    try {
      return await createImageBitmap(blob);
    } catch {
      const url = URL.createObjectURL(blob);
      try {
        return await new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = () => rej(new Error('image illisible par le navigateur'));
          img.src = url;
        });
      } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
  }

  const newCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: Math.round(w), height: Math.round(h) });

  /**
   * Chaque page du PDF en JPEG (grand côté 1600 px, comme une photo). Au-delà de
   * PDF_MAX_PAGES, on s'arrête : ce n'est plus une liasse de justificatifs.
   */
  async function pdfToPages(file) {
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
    let doc;
    try {
      doc = await task.promise;
    } catch (e) {
      throw new Error(e.name === 'PasswordException' ? 'PDF protégé par mot de passe' : `PDF illisible (${e.message})`);
    }
    try {
      const pages = [];
      for (let i = 1; i <= Math.min(doc.numPages, PDF_MAX_PAGES); i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 1600 / Math.max(base.width, base.height) });
        const c = newCanvas(viewport.width, viewport.height);
        await page.render({ canvas: c, viewport, background: '#fff' }).promise;
        pages.push(c.toDataURL('image/jpeg', 0.85));
        page.cleanup();
      }
      const warnings = doc.numPages > PDF_MAX_PAGES ? [`PDF de ${doc.numPages} pages : seules les ${PDF_MAX_PAGES} premières ont été lues.`] : [];
      return { pages, warnings };
    } finally { task.destroy(); }
  }

  /** Pages d'un même justificatif empilées en une image (le modèle lit une image par appel). */
  async function stackPages(images) {
    if (images.length === 1) return images[0];
    const WIDTH = 1100; // lisible sans image démesurée (3 pages A4 ≈ 1100×4700)
    const bitmaps = await Promise.all(images.map(async (u) => bitmapOf(await dataUrlToBlob(u))));
    const heights = bitmaps.map((b) => Math.round(b.height * WIDTH / b.width));
    const out = newCanvas(WIDTH, heights.reduce((a, h) => a + h, 0));
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    let y = 0;
    bitmaps.forEach((b, i) => { ctx.drawImage(b, 0, y, WIDTH, heights[i]); y += heights[i]; b.close?.(); });
    return out.toDataURL('image/jpeg', 0.85);
  }

  async function tiffToCanvas(file) {
    const UTIF = await loadUmd('utif-3.1.0.js');
    const buf = await file.arrayBuffer();
    const ifds = UTIF.decode(buf).filter((d) => d.t256 && d.t257); // vraies pages (pas les vignettes EXIF)
    if (!ifds.length) throw new Error('TIFF illisible');
    UTIF.decodeImage(buf, ifds[0], ifds);
    const w = ifds[0].width, h = ifds[0].height;
    const c = newCanvas(w, h);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(UTIF.toRGBA8(ifds[0]).buffer), w, h), 0, 0);
    return { source: c, warnings: ifds.length > 1 ? [`TIFF de ${ifds.length} pages : seule la première a été lue.`] : [] };
  }

  /** Fichier → image dessinable, quel que soit le format. */
  async function decodeReceipt(file, kind) {
    if (kind === 'heic' || kind === 'tiff') {
      try { return { source: await bitmapOf(file) }; } catch { /* Safari lit HEIC et TIFF lui-même ; sinon décodeur */ }
      if (kind === 'tiff') return tiffToCanvas(file);
      const heic2any = await loadUmd('heic2any-0.0.4.min.js');
      const jpeg = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 }).catch((e) => { throw new Error(`HEIC illisible (${e?.message || e})`); });
      return { source: await bitmapOf(Array.isArray(jpeg) ? jpeg[0] : jpeg) };
    }
    return { source: await bitmapOf(file) };
  }

  function toJpegDataUrl(source, maxSide = 1600, quality = 0.85) {
    const k = Math.min(1, maxSide / Math.max(source.width, source.height));
    const canvas = newCanvas(source.width * k, source.height * k);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  }

  const dataUrlToBlob = (u) => fetch(u).then((r) => r.blob());

  /**
   * Prépare un justificatif : une image réduite par page pour le LLM (la 1re sert de
   * vignette) et le fichier à joindre dans sesame. PDF, JPEG et PNG de moins de 4 Mo
   * sont joints tels quels ; le reste (HEIC, TIFF, WebP, photo trop lourde…) en JPEG.
   */
  async function prepareReceipt(file, kind) {
    if (kind === 'pdf') return { ...(await pdfToPages(file)), attach: file };
    const { source, warnings = [] } = await decodeReceipt(file, kind);
    try {
      const keepOriginal = /^image\/(jpeg|png)$/.test(file.type) && file.size <= 4e6;
      const attach = keepOriginal ? file : await dataUrlToBlob(toJpegDataUrl(source, 2400, 0.85));
      return { pages: [toJpegDataUrl(source)], attach, warnings };
    } finally { source.close?.(); }
  }

  async function postLlm(route, payload) {
    let res;
    try {
      res = await fetch(`${BASE_URL}/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // cookie de session EPFL (même site epfl.ch)
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(100_000),
      });
    } catch (e) {
      throw new Error(`serveur de lecture injoignable (${e.name === 'TimeoutError' ? 'délai dépassé' : e.message})`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `serveur de lecture : HTTP ${res.status}`), { status: res.status });
    return body.result;
  }

  /** Lecture par le serveur : image réduite + types de frais autorisés → champs normalisés. */
  async function extractReceipt(image, types) {
    return Core.normalizeExtraction(await postLlm('extract', { image, types }), new Set(types.map((t) => t.id)));
  }

  /** Tri d'une page de PDF ; un seul nouvel essai (sauf quota dépassé), puis on rend l'erreur à groupPages. */
  async function classifyPage(image) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await postLlm('classify', { image });
      } catch (e) {
        if (attempt >= 1 || e.status === 429) return { error: e.message };
      }
    }
  }

  const thumbLabel = (file) => esc((/\.([a-z0-9]{1,5})$/i.exec(file.name || '')?.[1] || '?').toUpperCase());

  async function mapLimit(items, limit, fn) {
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }

  // ════════════════════════════════════════════════════════════════════════
  // Interface (Shadow DOM : isolée des styles SAP UI5)
  // ════════════════════════════════════════════════════════════════════════
  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .overlay { position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,.4);
    display: flex; justify-content: center; align-items: flex-start; overflow-y: auto; }
  .panel { background: #fff; color: #1d1d1f; width: min(860px, 100%); min-height: 100%;
    padding: 16px; font-size: 14px; line-height: 1.4; }
  @media (min-width: 700px) { .overlay { padding: 24px; } .panel { min-height: 0; border-radius: 10px; } }
  /* En-tête collé en haut du panneau : la croix reste visible quand on fait défiler. */
  header { display: flex; align-items: center; gap: 8px; margin: -16px -16px 12px; padding: 12px 16px;
    position: sticky; top: 0; z-index: 2; background: #fff; border-bottom: 1px solid #e3e3e8; }
  @media (min-width: 700px) { header { border-radius: 10px 10px 0 0; } }
  .done { margin: 12px 0 0; padding: 10px 12px; border-radius: 8px; background: #eaf7ee; color: #1a7f37; font-weight: 600; }
  header h1 { font-size: 18px; margin: 0; flex: 1; }
  button { font: inherit; cursor: pointer; border-radius: 6px; border: 1px solid #c8c8cc; background: #f5f5f7;
    padding: 7px 12px; color: inherit; }
  button.primary { background: #d0021b; border-color: #d0021b; color: #fff; font-weight: 600; }
  button:disabled { opacity: .5; cursor: default; }
  button.icon { border: 0; background: none; font-size: 18px; padding: 4px 8px; }
  input, select, textarea { font: inherit; padding: 6px 8px; border: 1px solid #c8c8cc; border-radius: 6px;
    width: 100%; background: #fff; color: inherit; }
  textarea { min-height: 52px; resize: vertical; }
  label { display: block; font-size: 12px; color: #555; margin-bottom: 3px; }
  .drop { border: 2px dashed #b0b0b8; border-radius: 10px; padding: 22px; text-align: center; color: #555; }
  .drop.over { border-color: #d0021b; background: #fff4f5; }
  .drop p { margin: 0 0 10px; }
  section { margin-top: 18px; }
  section h2 { font-size: 15px; margin: 0 0 8px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .grid .full { grid-column: 1 / -1; }
  @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
  .line { display: grid; grid-template-columns: 64px 1fr; gap: 10px; padding: 10px; border: 1px solid #e3e3e8;
    border-radius: 8px; margin-bottom: 8px; }
  .line.warn { border-color: #e8a33d; background: #fffaf0; }
  .line.err { border-color: #d0021b; background: #fff4f5; }
  .thumb { width: 64px; height: 84px; object-fit: cover; border-radius: 4px; background: #eee; display: flex;
    align-items: center; justify-content: center; font-size: 11px; color: #777; overflow: hidden; }
  .fields { display: grid; grid-template-columns: 2fr 1.2fr 1fr .8fr auto; gap: 6px; align-items: end; }
  .fields .memo { grid-column: 1 / -2; }
  @media (max-width: 560px) { .fields { grid-template-columns: 1fr 1fr; } .fields .memo { grid-column: 1 / -1; } }
  .msgs { grid-column: 1 / -1; font-size: 12px; color: #8a5a00; margin: 0; padding-left: 16px; }
  .status { font-size: 12px; color: #555; }
  .note { font-size: 12px; color: #555; background: #f5f5f7; border-radius: 6px; padding: 8px 10px; }
  .note.warn { background: #fff4e0; color: #7a4a00; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; flex-wrap: wrap; }
  .log { margin-top: 12px; font: 12px/1.45 ui-monospace, Consolas, monospace; background: #1d1d1f; color: #e8e8ea;
    border-radius: 6px; padding: 10px; max-height: 220px; overflow: auto; white-space: pre-wrap; }
  .ok { color: #1a7f37; font-weight: 600; }
  .hidden { display: none !important; }
  `;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => new Date().toISOString().slice(0, 10);

  class App {
    constructor() {
      this.receipts = []; // {id, file, kind, url, status, pages, attach, prepWarnings, progress}
      this.lines = [];    // {id, receiptId, type, date, amount, currency, memo, warnings, isTip}
      this.nextId = 1;
      this.busy = false;
      this.logLines = [];
      this.ctx = null;    // {pernr, sciper, name, funds}
      this.types = Core.FALLBACK_EXPENSE_TYPES; // remplacée par la liste SAP à la connexion
      this.ready = Promise.resolve();
      this.loading = false;
      this.version = VERSION;
      this.abort = new AbortController();
      this.sesame = new Sesame((m) => this.log(m));
      this.mount();
    }

    /** Retire le panneau et ses écouteurs de la page (remplacement par une version plus récente). */
    destroy() {
      this.abort.abort();
      this.receipts.forEach((r) => r.url && URL.revokeObjectURL(r.url));
      this.host.remove();
    }

    // ── Montage ──────────────────────────────────────────────────────────
    mount() {
      const host = document.createElement('div');
      host.id = 'ndf-epfl-host';
      document.body.appendChild(host);
      this.host = host;
      const root = host.attachShadow({ mode: 'open' });
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
      } catch {
        const st = document.createElement('style');
        st.textContent = CSS;
        root.appendChild(st);
      }
      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <div class="overlay hidden">
          <div class="panel" role="dialog" aria-label="Note de frais automatique">
            <header>
              <h1>🧾 Note de frais automatique</h1>
              <button class="icon" data-act="close" title="Fermer (recliquez sur le favori pour rouvrir)">✕</button>
            </header>
            <div class="drop">
              <p>Glissez vos justificatifs ici, ou collez-les (Ctrl+V)</p>
              <button data-act="pick" class="primary">📷 Ajouter photos ou PDF</button>
              <input type="file" class="hidden" accept="image/*,application/pdf,.pdf,.heic,.heif,.tif,.tiff" multiple>
            </div>
            <p class="done hidden" data-slot="done" role="status"></p>
            <section class="lines-sec hidden">
              <h2>Frais <span class="status" data-slot="lines-status"></span></h2>
              <div data-slot="lines"></div>
              <div class="note hidden" data-slot="dups"></div>
            </section>
            <section class="trip-sec hidden">
              <h2>Voyage</h2>
              <div class="grid">
                <div class="full"><label>But du voyage *</label><input data-f="purpose"></div>
                <div><label>Du *</label><div class="grid"><input type="date" data-f="fromDate"><input type="time" data-f="fromTime" value="08:00"></div></div>
                <div><label>Au</label><div class="grid"><input type="date" data-f="toDate"><input type="time" data-f="toTime" value="18:00"></div></div>
                <div><label>Pays de destination *</label><select data-f="destCountry"><option value="CH">Switzerland (CH)</option></select></div>
                <div><label>Ville de destination</label><input data-f="destCity"></div>
                <div class="full"><label>Commentaire</label><textarea data-f="comment"></textarea></div>
                <div><label>Fonds *</label><select data-f="fund"><option value="">Chargement…</option></select></div>
                <div><label>Approbateur FC *</label><select data-f="approver"><option value="">Choisir d'abord un fonds</option></select></div>
                <div class="full"><label>Note à l'approbateur</label><textarea data-f="approverNote"></textarea></div>
              </div>
              <p class="note warn hidden" data-slot="foreign"></p>
              <p class="note">La note est créée en <b>brouillon</b> (Save). Relisez-la dans sesame puis cliquez vous-même sur <b>Submit</b>.</p>
              <div class="actions">
                <button data-act="reset">Tout effacer</button>
                <button data-act="create" class="primary">Créer le brouillon dans sesame</button>
              </div>
            </section>
            <div class="log hidden"></div>
            <div class="actions hidden" data-slot="log-actions"><button data-act="copy-log">Copier le journal</button></div>
          </div>
        </div>`;
      root.appendChild(wrap);
      this.root = root;
      this.$ = (sel) => root.querySelector(sel);
      this.bind();
    }

    bind() {
      const r = this.root;
      r.addEventListener('click', (ev) => {
        const act = ev.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        const handlers = {
          close: () => this.close(),
          pick: () => this.$('input[type=file]').click(),
          reset: () => this.reset(),
          create: () => this.create(),
          'copy-log': () => navigator.clipboard?.writeText(this.logLines.join('\n')),
          'del-line': () => this.deleteLine(Number(ev.target.closest('[data-line]').dataset.line)),
        };
        handlers[act]?.();
      });
      this.$('input[type=file]').addEventListener('change', (ev) => { this.addFiles([...ev.target.files]); ev.target.value = ''; });
      const drop = this.$('.drop');
      drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (ev) => { ev.preventDefault(); drop.classList.remove('over'); this.addFiles([...ev.dataTransfer.files]); });
      // Écouteurs posés sur la page sesame : retirés par destroy() via ce signal.
      const { signal } = this.abort;
      document.addEventListener('paste', (ev) => {
        if (this.$('.overlay').classList.contains('hidden')) return;
        const files = [...(ev.clipboardData?.files || [])];
        if (files.length) { ev.preventDefault(); this.addFiles(files); }
      }, { signal });
      // Champs des lignes : mise à jour de l'état sans re-rendu (garde le focus).
      r.addEventListener('input', (ev) => {
        const el = ev.target;
        const lineEl = el.closest('[data-line]');
        if (lineEl && el.dataset.k) {
          const line = this.lines.find((l) => l.id === Number(lineEl.dataset.line));
          if (!line) return;
          line[el.dataset.k] = el.dataset.k === 'amount' ? Core.parseAmount(el.value) : el.dataset.k === 'currency' ? el.value.toUpperCase() : el.value;
        }
      });
      // Fermeture : clic sur le fond grisé (appui ET relâchement dehors, pour qu'une
      // sélection de texte qui déborde du panneau ne le ferme pas), ou touche Échap.
      const overlay = this.$('.overlay');
      let downOnBackdrop = false;
      overlay.addEventListener('pointerdown', (ev) => { downOnBackdrop = ev.target === overlay; });
      overlay.addEventListener('click', (ev) => { if (downOnBackdrop && ev.target === overlay) this.close(); });
      document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !overlay.classList.contains('hidden')) this.close(); }, { signal });
      this.$('[data-f=fund]').addEventListener('change', () => this.loadApprovers());
      // Un champ du voyage modifié à la main n'est plus pré-rempli par la lecture des justificatifs.
      r.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('input', () => { el.dataset.touched = '1'; }));
    }

    /** Masque le panneau sans rien perdre : recliquer sur le favori le rouvre tel quel. */
    close() {
      this.$('.overlay').classList.add('hidden');
    }

    open() {
      this.$('.overlay').classList.remove('hidden');
      if (!this.ctx && !this.loading) this.ready = this.loadContext();
    }

    // ── Contexte sesame : numéro de personnel, SCIPER, fonds, types de frais ──
    async loadContext() {
      this.loading = true;
      try {
        this.log('Connexion à sesame…');
        const pernr = await this.sesame.findPersonalNumber();
        const hdr = await this.sesame.newDraft(pernr); // brouillon de session, jamais enregistré
        const [funds, types, countries] = await Promise.all([
          this.sesame.funds(pernr),
          this.sesame.expenseTypes(this.sesame.draftId(pernr)).catch((e) => { this.log(`  (types de frais : ${e.message} — liste de secours)`); return []; }),
          this.sesame.countries().catch((e) => { this.log(`  (pays : ${e.message})`); return []; }),
        ]);
        if (types.length) this.types = types;
        if (countries.length) {
          const sel = this.$('[data-f=destCountry]');
          const current = sel.value;
          sel.innerHTML = countries.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
          sel.value = countries.some((c) => c.id === current) ? current : 'CH';
        }
        this.ctx = { pernr, sciper: hdr.SciperBenef, name: `${hdr.NameFirstBenef} ${hdr.NameLastBenef}`.trim(), funds };
        this.log(`Connecté : ${this.ctx.name} (SCIPER ${this.ctx.sciper}), ${funds.length} fonds, ${this.types.length} types de frais.`);
        const lastFund = Store.get('lastFund', '');
        this.$('[data-f=fund]').innerHTML = '<option value="">— choisir —</option>'
          + funds.map((f) => `<option value="${esc(f.CostObjectID)}" ${f.CostObjectID === lastFund ? 'selected' : ''}>${esc(`${f.CostObjectID} : ${f.Description} (${f.Fistl})`)}</option>`).join('');
        if (lastFund) await this.loadApprovers();
      } catch (e) {
        this.log(`⚠ ${e.message}`);
        this.$('[data-f=fund]').innerHTML = '<option value="">Erreur de chargement — fermez puis recliquez sur le favori</option>';
        this.ctx = null;
      } finally {
        this.loading = false;
        this.render();
      }
    }

    async loadApprovers() {
      const fund = this.$('[data-f=fund]').value;
      const sel = this.$('[data-f=approver]');
      if (!fund || !this.ctx) { sel.innerHTML = '<option value="">Choisir d\'abord un fonds</option>'; return; }
      sel.innerHTML = '<option value="">Chargement…</option>';
      try {
        this.approvers = await this.sesame.approvers(fund, this.ctx.sciper);
        const last = Store.get('lastApprover', '');
        sel.innerHTML = '<option value="">— choisir —</option>'
          + this.approvers.map((a) => `<option value="${esc(a.Bname)}" ${a.Bname === last ? 'selected' : ''}>${esc(a.NameText)}</option>`).join('');
      } catch (e) {
        sel.innerHTML = '<option value="">Erreur de chargement</option>';
        this.log(`⚠ ${e.message}`);
      }
    }

    // ── Justificatifs → lignes ───────────────────────────────────────────
    addFiles(files) {
      const accepted = files.filter((f) => Core.fileKind(f));
      const ignored = files.filter((f) => !Core.fileKind(f)).map((f) => f.name);
      if (ignored.length) this.log(`Ignoré(s) : ${ignored.join(', ')} — formats acceptés : photos (JPEG, PNG, HEIC, WebP, TIFF…) et PDF.`);
      for (const file of accepted) {
        const kind = Core.fileKind(file);
        // Vignette immédiate pour les formats que le navigateur affiche ; les autres l'ont une fois décodés.
        this.receipts.push({ id: this.nextId++, file, kind, url: kind === 'image' ? URL.createObjectURL(file) : '', status: 'pending' });
      }
      this.render();
      mapLimit(this.receipts.filter((r) => r.status === 'pending'), 3, (r) => this.analyze(r));
    }

    newLine(fields) {
      return { id: this.nextId++, type: 'E160', date: '', amount: null, currency: 'CHF', memo: '', warnings: [], ...fields };
    }

    /** Avancement dans la carte « Lecture de … », sans tout redessiner (l'usager tape peut-être ailleurs). */
    setProgress(r, text) {
      r.progress = text;
      const el = this.$(`[data-progress="${r.id}"]`);
      if (el) el.textContent = text;
    }

    async analyze(r) {
      r.status = 'reading';
      this.render();
      try {
        await this.ready; // les types de frais autorisés viennent de SAP
        const t0 = performance.now();
        if (!r.pages) {
          const { pages, attach, warnings } = await prepareReceipt(r.file, r.kind);
          if (r.url) URL.revokeObjectURL(r.url);
          Object.assign(r, { pages, attach, url: pages[0], prepWarnings: warnings });
          this.render();
        }
        // Plusieurs pages : tri page par page, puis une lecture par justificatif trouvé.
        const multi = r.pages.length > 1;
        let groups = [{ pages: [0], warnings: [] }];
        if (multi) {
          const infos = [];
          let done = 0;
          this.setProgress(r, ` — tri des pages 0/${r.pages.length}`);
          await mapLimit(r.pages, 3, async (image, i) => {
            infos[i] = await classifyPage(image);
            this.setProgress(r, ` — tri des pages ${++done}/${r.pages.length}`);
          });
          const sorted = Core.groupPages(infos);
          groups = sorted.groups;
          if (sorted.skipped.length) this.log(`${r.file.name} : page(s) ${Core.pageList(sorted.skipped)} écartée(s), ce ne sont pas des justificatifs.`);
          if (!groups.length) throw new Error(`aucune des ${r.pages.length} pages ne ressemble à un justificatif`);
          this.setProgress(r, ` — ${groups.length} justificatif(s) trouvé(s), lecture…`);
        }
        const perGroup = [];
        await mapLimit(groups, 3, async (g, gi) => {
          const where = multi ? [`Pages ${Core.pageList(g.pages)} du PDF.`] : [];
          try {
            const extraction = await extractReceipt(await stackPages(g.pages.map((i) => r.pages[i])), this.types);
            const lines = Core.linesFromExtraction(extraction, r.id);
            if (!lines.length) lines.push({ receiptId: r.id, warnings: extraction.warnings });
            lines[0].warnings = [...where, ...g.warnings, ...(lines[0].warnings || [])];
            perGroup[gi] = lines;
          } catch (e) {
            // Un justificatif illisible n'empêche pas de lire les autres pages du PDF.
            perGroup[gi] = [{ receiptId: r.id, warnings: [...where, ...g.warnings, `Lecture impossible : ${e.message}`], error: true }];
          }
        });
        const lines = perGroup.flat();
        if (r.prepWarnings?.length) lines[0].warnings = [...r.prepWarnings, ...(lines[0].warnings || [])];
        this.log(`Lu ${r.file.name}${multi ? ` (${r.pages.length} pages, ${groups.length} justificatif(s))` : ''} en ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
        this.lines = this.lines.filter((l) => l.receiptId !== r.id).concat(lines.map((l) => this.newLine(l)));
        r.status = 'done';
      } catch (e) {
        r.status = 'error';
        this.lines.push(this.newLine({ receiptId: r.id, warnings: [`Lecture impossible : ${e.message}`], error: true }));
        this.log(`⚠ ${r.file.name} : ${e.message}`);
      }
      this.sortLines();
      this.refreshTrip();
      this.render();
    }

    sortLines() {
      this.lines.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.receiptId - b.receiptId || (a.isTip ? 1 : 0) - (b.isTip ? 1 : 0));
    }

    deleteLine(id) {
      this.lines = this.lines.filter((l) => l.id !== id);
      const used = new Set(this.lines.map((l) => l.receiptId));
      this.receipts = this.receipts.filter((r) => used.has(r.id) || r.status === 'reading');
      this.render();
    }

    /** Pré-remplit dates et but à partir des justificatifs, sans écraser ce que l'usager a tapé. */
    refreshTrip() {
      const trip = Core.inferTrip(this.lines);
      const setUnlessTouched = (k, v) => { const el = this.$(`[data-f=${k}]`); if (el && !el.dataset.touched && v) el.value = v; };
      setUnlessTouched('purpose', trip.purpose);
      setUnlessTouched('fromDate', trip.fromDate);
      setUnlessTouched('toDate', trip.toDate || trip.fromDate);
      const countrySel = this.$('[data-f=destCountry]');
      if (!countrySel.dataset.touched && [...countrySel.options].some((o) => o.value === trip.destCountry)) countrySel.value = trip.destCountry;
      setUnlessTouched('destCity', trip.destCity);
      const foreign = this.$('[data-slot=foreign]');
      if (trip.foreignCountries.length > 1) {
        foreign.textContent = `Justificatifs de plusieurs pays (${trip.foreignCountries.join(', ')}). Une seule destination est créée : ajoutez les autres étapes dans sesame avant de soumettre.`;
        foreign.classList.remove('hidden');
      } else foreign.classList.add('hidden');
    }

    render() {
      const has = this.receipts.length > 0;
      this.$('.lines-sec').classList.toggle('hidden', !has);
      this.$('.trip-sec').classList.toggle('hidden', !has);
      const reading = this.receipts.filter((r) => r.status === 'reading' || r.status === 'pending').length;
      this.$('[data-slot=lines-status]').textContent = reading ? `— lecture de ${reading} justificatif(s)…` : `— ${this.lines.length} ligne(s)`;
      const byId = Object.fromEntries(this.receipts.map((r) => [r.id, r]));
      const typeOptions = (sel) => this.types.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
      const pendingCards = this.receipts.filter((r) => ['reading', 'pending'].includes(r.status)).map((r) => `
        <div class="line"><div class="thumb">${r.url ? `<img class="thumb" src="${r.url}" alt="">` : thumbLabel(r.file)}</div>
        <div class="status">Lecture de ${esc(r.file.name)}…<span data-progress="${r.id}">${esc(r.progress || '')}</span></div></div>`).join('');
      this.$('[data-slot=lines]').innerHTML = pendingCards + this.lines.map((l) => {
        const r = byId[l.receiptId];
        const cls = l.error ? 'err' : l.warnings?.length ? 'warn' : '';
        return `
        <div class="line ${cls}" data-line="${l.id}">
          <div class="thumb">${r?.url ? `<img class="thumb" src="${r.url}" alt="">` : r ? thumbLabel(r.file) : ''}</div>
          <div class="fields">
            <div><label>Type</label><select data-k="type">${typeOptions(l.type)}</select></div>
            <div><label>Date</label><input type="date" data-k="date" value="${esc(l.date)}"></div>
            <div><label>Montant</label><input inputmode="decimal" data-k="amount" value="${l.amount ?? ''}"></div>
            <div><label>Devise</label><input data-k="currency" maxlength="3" value="${esc(l.currency)}"></div>
            <div><button class="icon" data-act="del-line" title="Supprimer la ligne">🗑</button></div>
            <div class="memo"><label>Fournisseur</label><input data-k="vendor" value="${esc(l.vendor)}"></div>
            <div class="memo"><label>Description</label><input data-k="memo" value="${esc(l.memo)}"></div>
            ${l.warnings?.length ? `<ul class="msgs">${l.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
          </div>
        </div>`;
      }).join('');
      const dups = Core.findDuplicates(this.lines);
      const dupEl = this.$('[data-slot=dups]');
      dupEl.classList.toggle('hidden', !dups.length);
      dupEl.textContent = dups.length ? `⚠ ${dups.length} doublon(s) probable(s) : même date, même montant. Supprimez-les si c'est le même justificatif.` : '';
      this.$('[data-act=create]').disabled = this.busy || reading > 0 || !this.lines.length;
    }

    reset() {
      if (this.busy) return;
      this.receipts.forEach((r) => r.url && URL.revokeObjectURL(r.url));
      this.receipts = [];
      this.lines = [];
      this.root.querySelectorAll('[data-f]').forEach((el) => { delete el.dataset.touched; if (!['fund', 'approver', 'fromTime', 'toTime', 'destCountry'].includes(el.dataset.f)) el.value = ''; });
      this.$('[data-f=destCountry]').value = 'CH';
      this.render();
    }

    log(msg) {
      const line = `${new Date().toLocaleTimeString()}  ${msg}`;
      this.logLines.push(line);
      const el = this.$('.log');
      if (!el) return;
      el.classList.remove('hidden');
      this.$('[data-slot=log-actions]').classList.remove('hidden');
      el.textContent = this.logLines.slice(-200).join('\n');
      el.scrollTop = el.scrollHeight;
    }

    // ── Validation et création ───────────────────────────────────────────
    collect() {
      const v = (k) => this.$(`[data-f=${k}]`).value.trim();
      const errors = [];
      if (!this.ctx) errors.push('Connexion à sesame non établie (voir le journal).');
      const fund = this.ctx?.funds.find((f) => f.CostObjectID === v('fund'));
      const approver = (this.approvers || []).find((a) => a.Bname === v('approver'));
      if (!v('purpose')) errors.push('But du voyage manquant.');
      if (!Core.isIsoDate(v('fromDate'))) errors.push('Date de début manquante.');
      if (!fund) errors.push('Fonds manquant.');
      if (!approver) errors.push('Approbateur manquant.');
      if (!/^[A-Z]{2}$/.test(v('destCountry'))) errors.push('Pays de destination manquant.');
      const toDate = v('toDate') || v('fromDate');
      if (Core.isIsoDate(v('fromDate')) && toDate < v('fromDate')) errors.push('La date de fin précède la date de début.');
      this.lines.forEach((l, i) => {
        if (!Core.isIsoDate(l.date)) errors.push(`Ligne ${i + 1} : date manquante.`);
        if (!(l.amount > 0)) errors.push(`Ligne ${i + 1} : montant manquant.`);
        if (!/^[A-Z]{3}$/.test(l.currency || '')) errors.push(`Ligne ${i + 1} : devise invalide.`);
        if (Core.isIsoDate(l.date) && (l.date < v('fromDate') || l.date > toDate)) errors.push(`Ligne ${i + 1} : date hors des dates du voyage.`);
      });
      return {
        errors,
        report: {
          pernr: this.ctx?.pernr, purpose: v('purpose'), comment: v('comment'),
          destCountry: v('destCountry'), destCity: v('destCity'),
          fromDate: v('fromDate'), fromTime: v('fromTime') || '08:00', toDate, toTime: v('toTime') || '18:00',
          fund, approver, approverNote: v('approverNote'),
          lines: this.lines.map((l) => ({ ...l, file: null })),
        },
      };
    }

    async create() {
      if (this.busy) return;
      const { errors, report } = this.collect();
      if (errors.length) { this.log('Impossible de créer la note :\n  - ' + errors.join('\n  - ')); return; }
      this.busy = true;
      this.$('[data-slot=done]').classList.add('hidden');
      this.render();
      try {
        // Frais déjà dans sesame (second envoi, saisie manuelle, autre ordinateur) : on demande.
        this.log('Recherche de frais identiques dans vos notes sesame…');
        let existing = [];
        try { existing = await this.sesame.findExistingExpenses(report); } catch (e) { this.log(`  (vérification impossible : ${e.message})`); }
        if (existing.length) {
          const detail = existing.map((x) => `• note n° ${x.tripNumber}${x.reason ? ` « ${x.reason} »` : ''} : ${x.matches.map((m) => `${m.line.amount} ${m.line.currency} le ${m.line.date}`).join(', ')}`).join('\n');
          if (!window.confirm(`Ces frais existent déjà dans sesame :\n${detail}\n\nCréer quand même la note ?`)) {
            this.log('Création annulée : frais déjà présents dans sesame.');
            return;
          }
        }
        // Un justificatif est joint à SA première ligne (pas à la ligne « pourboire »).
        const attached = new Set();
        const byId = Object.fromEntries(this.receipts.map((r) => [r.id, r]));
        let n = 0;
        for (const [i, l] of this.lines.entries()) {
          const r = byId[l.receiptId];
          if (!r || attached.has(r.id)) continue;
          attached.add(r.id);
          // Préparé à la lecture : original, ou JPEG si format exotique / photo de plus de 4 Mo.
          // Lecture ratée : on joint l'original, l'usager a de toute façon la ligne à remplir.
          const blob = r.attach || r.file;
          const name = Core.asciiFileName(blob === r.file ? r.file.name : 'x.jpg', n++);
          report.lines[i].file = { blob, name };
        }
        this.log('— Création de la note —');
        const { tripNumber, warnings } = await this.sesame.createReport(report, (s) => this.log(s));
        if (warnings.length) {
          this.log(`⚠ Note n° ${tripNumber} : SAP signale des champs à compléter dans sesame avant de soumettre :\n  - ${warnings.join('\n  - ')}`);
        }
        Store.set('lastFund', report.fund.CostObjectID);
        Store.set('lastApprover', report.approver.Bname);
        this.log(`✅ Note n° ${tripNumber} enregistrée en brouillon. Rechargez la liste sesame (↻) pour la voir, relisez-la puis soumettez-la.`);
        // Panneau vidé : un nouveau clic ne peut plus recréer la même note.
        this.busy = false;
        this.reset();
        const done = this.$('[data-slot=done]');
        done.textContent = `✅ Note n° ${tripNumber} enregistrée en brouillon${warnings.length ? ' — des champs restent à compléter (voir le journal)' : ''}. Rechargez sesame pour la voir, relisez-la puis cliquez sur Submit.`;
        done.classList.remove('hidden');
      } catch (e) {
        this.log(`❌ ${e.message}\nLa note n'est peut-être que partiellement créée : vérifiez dans sesame et supprimez-la au besoin. « Copier le journal » pour signaler le problème.`);
      } finally {
        this.busy = false;
        this.render();
      }
    }
  }

  window.__ndf = new App();
  window.__ndf.open();
})();
