// node --test tests/ — compteurs d'usage (server/stats.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStats, dayOf } from '../server/stats.mjs';

const SECRET = 's'.repeat(40);
const clock = (iso) => { const c = { t: new Date(iso) }; c.now = () => c.t; c.set = (x) => { c.t = new Date(x); }; return c; };
const USAGE = { prompt_tokens: 1000, completion_tokens: 50 };
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'ndf-stats-')), 'stats.json');

test('jour à l\'heure suisse', () => {
  assert.equal(dayOf(new Date('2026-09-30T21:59:00Z')), '2026-09-30');
  assert.equal(dayOf(new Date('2026-09-30T22:30:00Z')), '2026-10-01', '00:30 à Lausanne = jour suivant');
  assert.equal(dayOf(new Date('2026-12-31T23:30:00Z')), '2027-01-01', 'heure d\'hiver (UTC+1)');
});

test('personnes par jour, par mois et au total ; nouvelles personnes ; appels, jetons, erreurs', () => {
  const c = clock('2026-09-29T08:00:00Z');
  const s = createStats({ secret: SECRET, now: c.now });
  s.login('oid-alice');
  s.call('oid-alice', 'extract', USAGE);
  s.call('oid-alice', 'classify', USAGE);
  s.call('oid-bob', 'extract', USAGE);
  s.call('oid-bob', 'extract', null, false);
  let { totalUsers, days, months } = s.summary();
  assert.deepEqual(days[0], { day: '2026-09-29', users: 2, newUsers: 2, logins: 1, extract: 3, classify: 1, errors: 1, promptTokens: 3000, completionTokens: 150 },
    'l’appel en erreur ne compte pas de jetons');
  assert.equal(totalUsers, 2);

  // Jour suivant : Alice revient (pas nouvelle), Carol arrive (nouvelle).
  c.set('2026-09-30T09:00:00Z');
  s.call('oid-alice', 'extract', USAGE);
  s.call('oid-carol', 'extract', USAGE);
  ({ totalUsers, days, months } = s.summary());
  assert.deepEqual([days[0].day, days[0].users, days[0].newUsers], ['2026-09-30', 2, 1]);
  assert.equal(days[1].users, 2, 'la veille est conservée');
  assert.deepEqual(months[0], { month: '2026-09', users: 3, newUsers: 3, activeDays: 2, userDays: 4, daysPerUser: 1.3 });
  assert.equal(totalUsers, 3);

  // Mois suivant : Alice n'est pas « nouvelle », Dave oui. Le total ne recompte pas Alice.
  c.set('2026-10-01T09:00:00Z');
  s.call('oid-alice', 'extract', USAGE);
  s.call('oid-dave', 'extract', USAGE);
  ({ totalUsers, months } = s.summary());
  assert.deepEqual(months.map((m) => [m.month, m.users, m.newUsers]), [['2026-10', 2, 1], ['2026-09', 3, 3]]);
  assert.equal(totalUsers, 4);
});

test('persistance : compteurs et liste globale gardés au redémarrage, sans aucun identifiant en clair', () => {
  const file = tmpFile();
  const c = clock('2026-09-29T08:00:00Z');
  const a = createStats({ file, secret: SECRET, now: c.now });
  a.call('oid-alice', 'extract', USAGE);
  a.call('ip:10.0.0.7', 'extract', USAGE);
  a.flush();
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes('oid-alice') && !raw.includes('10.0.0.7'), 'ni identifiant ni IP en clair');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600, 'lisible par le seul compte du service');

  // Redémarrage le même jour : Alice n'est ni recomptée ni « nouvelle ».
  const b = createStats({ file, secret: SECRET, now: c.now });
  b.call('oid-alice', 'classify', USAGE);
  assert.deepEqual([b.summary().days[0].users, b.summary().days[0].newUsers, b.summary().totalUsers], [2, 2, 2]);

  // Redémarrage un mois plus tard : Alice reconnue (clé fixe), donc pas nouvelle.
  c.set('2026-11-03T08:00:00Z');
  const later = createStats({ file, secret: SECRET, now: c.now });
  later.call('oid-alice', 'extract', USAGE);
  assert.deepEqual([later.summary().months[0].users, later.summary().months[0].newUsers, later.summary().totalUsers], [1, 0, 2]);

  // Autre secret : les empreintes ne permettent pas de reconnaître Alice.
  const other = createStats({ file, secret: 't'.repeat(40), now: c.now });
  other.call('oid-alice', 'extract', USAGE);
  assert.equal(other.summary().totalUsers, 3);

  // Clôture du jour : la liste du jour est effacée, la liste globale reste.
  b.flush();
  c.set('2026-09-30T08:00:00Z');
  b.call('oid-bob', 'extract', USAGE);
  b.flush();
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.open.day, '2026-09-30');
  assert.equal(saved.open.dayUsers.length, 1);
  assert.equal(saved.users.length, 3);
});

test('ancien format (clés par période) : nombres gardés, empreintes écartées', () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({ days: { '2026-09-29': { users: 5, logins: 2, extract: 9, classify: 0, errors: 0, promptTokens: 1, completionTokens: 1 } },
    months: { '2026-09': { users: 5 } }, open: { day: '2026-09-29', dayUsers: ['a', 'b'], month: '2026-09', monthUsers: ['a', 'b'] } }));
  const s = createStats({ file, secret: SECRET, now: () => new Date('2026-09-29T12:00:00Z') });
  s.call('oid-alice', 'extract', USAGE);
  const { days, totalUsers } = s.summary();
  assert.deepEqual([days[0].users, days[0].extract, totalUsers], [6, 10, 1]);
});

test('fichier abîmé : on repart de zéro sans planter', () => {
  const file = tmpFile();
  writeFileSync(file, '{ pas du json');
  const logs = [];
  const s = createStats({ file, secret: SECRET, log: (m) => logs.push(m) });
  s.call('oid-alice', 'extract', USAGE);
  assert.equal(s.summary().days[0].users, 1);
  assert.match(logs[0], /illisibles/);
});
