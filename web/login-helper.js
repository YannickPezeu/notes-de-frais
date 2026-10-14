// Servi à la place de ndf.js tant que l'usager n'est pas connecté (ou que sa session a expiré).
// Propose la connexion EPFL dans une petite fenêtre, puis recharge le vrai script : le panneau
// déjà ouvert (et ses lignes) est alors simplement réaffiché.
// La fenêtre s'ouvre sur un clic dans ce cadre : ouverte d'office, un bloqueur la refuserait.
(() => {
  if (!/(^|\.)sesame\.epfl\.ch$/.test(window.location.hostname)) return; // seulement dans sesame
  const BASE = '{{BASE}}';
  const ORIGIN = new URL(BASE).origin;
  document.getElementById('ndf-login-host')?.remove();

  const host = document.createElement('div');
  host.id = 'ndf-login-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .box { position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 320px; max-width: calc(100vw - 32px);
        box-sizing: border-box; padding: 16px 18px; border-radius: 12px; background: #fff; color: #1d1d1f;
        font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.25); }
      h1 { font-size: 15px; margin: 0 0 6px; }
      p { margin: 0 0 12px; }
      .go { font: inherit; font-weight: 700; padding: 8px 16px; border: 0; border-radius: 999px; background: #d0021b; color: #fff; cursor: pointer; }
      .x { position: absolute; top: 8px; right: 10px; font: 16px system-ui; border: 0; background: none; cursor: pointer; color: #5a5a60; }
      .msg { margin: 10px 0 0; color: #b00020; }
    </style>
    <div class="box" role="dialog" aria-label="Connexion EPFL">
      <button class="x" title="Fermer">✕</button>
      <h1>🧾 Note de frais automatique</h1>
      <p>Connectez-vous avec votre compte EPFL pour continuer.</p>
      <button class="go">Se connecter</button>
      <p class="msg" hidden></p>
    </div>`;
  document.body.appendChild(host);

  let opened = false;
  const cleanup = () => {
    window.removeEventListener('message', onMessage);
    window.removeEventListener('focus', onFocus);
    host.remove();
  };
  const reload = () => {
    cleanup();
    const s = document.createElement('script');
    s.src = `${BASE}/ndf.js?t=${Date.now()}`;
    document.body.appendChild(s);
  };
  const onMessage = (e) => { if (e.origin === ORIGIN && e.data === 'ndf-login-ok') reload(); };
  // Retour sur sesame après la connexion (si la fenêtre n'a pas pu prévenir cette page) : on réessaie.
  const onFocus = () => { if (opened) reload(); };
  window.addEventListener('message', onMessage);
  window.addEventListener('focus', onFocus);

  root.querySelector('.x').onclick = cleanup;
  root.querySelector('.go').onclick = () => {
    const w = window.open(`${BASE}/login?popup=1`, 'ndf-login', 'width=520,height=680');
    if (w) { opened = true; return; }
    const msg = root.querySelector('.msg');
    msg.hidden = false;
    msg.textContent = `Fenêtre bloquée : autorisez les fenêtres pop-up pour sesame.epfl.ch, ou connectez-vous sur ${BASE} puis recliquez sur le favori.`;
  };
})();
