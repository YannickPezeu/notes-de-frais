// Extraction réelle sur RCP, avec le prompt du serveur et la normalisation du client.
// Usage : node tests/extract-live.mjs [images…]   (défaut : tests/receipts/*)
// Clé lue dans .env (API-KEY=…), jamais affichée.
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore } from './load-core.mjs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const key = env['API-KEY'] || env.RCP_API_KEY;
if (!key) throw new Error('API-KEY absente de .env');

const { extract } = await import('../server/extract.mjs');
const Core = loadCore();
const types = Core.FALLBACK_EXPENSE_TYPES;
const ids = new Set(types.map((t) => t.id));

const dir = fileURLToPath(new URL('./receipts/', import.meta.url));
const files = process.argv.length > 2 ? process.argv.slice(2)
  : readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map((f) => join(dir, f));

for (const f of files) {
  const mime = { '.png': 'image/png', '.webp': 'image/webp' }[extname(f).toLowerCase()] || 'image/jpeg';
  const image = `data:${mime};base64,${readFileSync(f).toString('base64')}`;
  const t0 = Date.now();
  try {
    const { result, usage } = await extract({ image, types }, key);
    const ex = Core.normalizeExtraction(result, ids);
    console.log(`\n== ${f.split(/[\\/]/).pop()}  (${((Date.now() - t0) / 1000).toFixed(1)} s, ${usage?.completion_tokens} jetons, réflexion ${usage?.completion_tokens_details?.reasoning_tokens ?? '?'})`);
    for (const l of Core.linesFromExtraction(ex, 1)) console.log(`   ${l.type} ${l.date} ${l.amount} ${l.currency}  « ${l.memo} »  [${l.city}, ${l.country}]`);
    if (ex.warnings?.length) console.log('   ⚠', ex.warnings.join(' | '));
  } catch (e) {
    console.log(`\n== ${f}  ÉCHEC : ${e.message} ${e.detail || ''}`);
  }
}
