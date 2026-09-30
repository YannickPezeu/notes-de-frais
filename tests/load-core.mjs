// Charge la partie `Core` du script client (web/ndf.js) sous Node, sans navigateur.
// Même « realm » que les tests (runInThisContext) : sinon les objets rendus ont
// d'autres prototypes et assert.deepStrictEqual les juge différents.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = new URL('../web/ndf.js', import.meta.url);

export function loadCore() {
  const module = { exports: {} };
  const wrapped = `(function (module) {\n${readFileSync(SRC, 'utf8')}\n})`;
  vm.runInThisContext(wrapped, { filename: SRC.pathname })(module);
  return module.exports;
}
