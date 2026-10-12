// Statistiques d'usage : par jour, combien de personnes (dont nouvelles), d'appels et de
// jetons ; par mois, combien de personnes (dont nouvelles) ; au total, combien de personnes
// depuis la mise en service. Aucun nom, e-mail ni identifiant en clair n'est enregistré.
//
// Pour compter les personnes, on garde une empreinte HMAC de leur identifiant d'annuaire,
// avec une clé fixe dérivée d'un secret qui n'est pas dans le fichier (clé fixe : sinon une
// même personne compterait comme nouvelle à chaque changement de clé). Ces empreintes sont
// pseudonymisées : qui détient le secret et l'annuaire peut les rapprocher des comptes.
//  - liste globale (tant que le service existe) : personnes au total, nouvelles personnes ;
//  - listes du jour et du mois en cours, effacées à la clôture : personnes distinctes.
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// Jour et mois à l'heure suisse (un appel à 00:30 compte pour le jour qui commence).
const DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' });
export const dayOf = (date) => DAY.format(date);

const VERSION = 2; // v1 : clés par jour et par mois, sans liste globale
const emptyDay = () => ({ users: 0, newUsers: 0, logins: 0, extract: 0, classify: 0, errors: 0, promptTokens: 0, completionTokens: 0 });

/**
 * file : fichier JSON persistant (absent : en mémoire seulement) ; secret : pour la clé des
 * empreintes (le changer fait repartir de zéro le décompte des personnes) ; now : horloge (tests).
 */
export function createStats({ file = '', secret, now = () => new Date(), flushMs = 15_000, log = console.error } = {}) {
  let data = { version: VERSION, days: {}, months: {}, users: [], open: { day: '', dayUsers: [], month: '', monthUsers: [] } };
  if (file && existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      // Empreintes d'une ancienne version : incomparables avec les nouvelles, on ne garde que les nombres.
      if (saved.version !== VERSION) { saved.users = []; saved.open = data.open; }
      data = { ...data, ...saved, version: VERSION };
    } catch (e) { log(`statistiques illisibles (${e.message}) : on repart de zéro`); }
  }
  const allUsers = new Set(data.users);
  const dayUsers = new Set(data.open.dayUsers);
  const monthUsers = new Set(data.open.monthUsers);
  const key = createHmac('sha256', secret).update('ndf-stats-v2').digest();
  const tag = (id) => createHmac('sha256', key).update(String(id)).digest('hex').slice(0, 16);

  // Changement de jour ou de mois : la liste de la période close est effacée.
  function roll() {
    const day = dayOf(now());
    const month = day.slice(0, 7);
    if (data.open.day !== day) { data.open.day = day; dayUsers.clear(); }
    if (data.open.month !== month) { data.open.month = month; monthUsers.clear(); }
    data.days[day] = { ...emptyDay(), ...data.days[day] };
    data.months[month] = { users: 0, newUsers: 0, ...data.months[month] };
    return { d: data.days[day], m: data.months[month] };
  }

  function seen(id) {
    const { d, m } = roll();
    const t = tag(id);
    if (!allUsers.has(t)) { allUsers.add(t); d.newUsers++; m.newUsers++; }
    if (!dayUsers.has(t)) { dayUsers.add(t); d.users++; }
    if (!monthUsers.has(t)) { monthUsers.add(t); m.users++; }
    return d;
  }

  let dirty = false;
  let timer = null;
  function flush() {
    if (!file || !dirty) return;
    dirty = false;
    data.users = [...allUsers];
    data.open.dayUsers = [...dayUsers];
    data.open.monthUsers = [...monthUsers];
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 }); // lisible par le seul compte du service
      renameSync(`${file}.tmp`, file); // jamais de fichier à moitié écrit
    } catch (e) { log(`statistiques non enregistrées : ${e.message}`); }
  }
  const touch = () => {
    dirty = true;
    if (file && !timer) timer = setTimeout(() => { timer = null; flush(); }, flushMs).unref();
  };

  return {
    /** Appel au modèle réussi ou non ; usage = { prompt_tokens, completion_tokens } de RCP. */
    call(id, kind, usage, ok = true) {
      const d = seen(id);
      d[kind] = (d[kind] || 0) + 1;
      if (!ok) d.errors++;
      d.promptTokens += usage?.prompt_tokens || 0;
      d.completionTokens += usage?.completion_tokens || 0;
      touch();
    },
    login(id) { seen(id).logins++; touch(); },
    /** Nombres seuls (jamais les empreintes), du plus récent au plus ancien. */
    summary() {
      roll();
      const byMonth = {};
      for (const [day, d] of Object.entries(data.days)) {
        const m = (byMonth[day.slice(0, 7)] ??= { activeDays: 0, userDays: 0 });
        if (d.users) m.activeDays++;
        m.userDays += d.users;
      }
      return {
        totalUsers: allUsers.size,
        days: Object.entries(data.days).sort(([a], [b]) => b.localeCompare(a)).map(([day, d]) => ({ day, ...d })),
        months: Object.entries(data.months).sort(([a], [b]) => b.localeCompare(a)).map(([month, m]) => ({
          month, users: m.users, newUsers: m.newUsers, ...byMonth[month],
          // Fréquence : jours d'utilisation par personne dans le mois.
          daysPerUser: m.users ? Math.round(((byMonth[month]?.userDays || 0) / m.users) * 10) / 10 : 0,
        })),
      };
    },
    flush() { dirty = true; flush(); },
  };
}
