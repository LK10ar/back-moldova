const API = 'https://back-djazair.onrender.com'; // URL de l'API Render, sans / final
const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('t') || '';
const api = (p, o = {}) => fetch(API + '/api/admin/' + p, { ...o, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } });
const show = () => { $('login').classList.toggle('hide', !!token); $('app').classList.toggle('hide', !token); if (token) load(); };
$('go').onclick = async () => {
  const r = await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: $('em').value, password: $('pw').value }) });
  if (!r.ok) return $('err').textContent = 'Identifiants incorrects';
  token = (await r.json()).token; sessionStorage.setItem('t', token); show();
};
$('col').onchange = load;
$('f').cover.oninput = e => $('pv').src = e.target.value;
async function load() {
  const c = $('col').value, cand = c === 'candidates';
  $('f').classList.toggle('hide', cand);
  const r = await api(c);
  if (r.status === 401) { token = ''; sessionStorage.removeItem('t'); return show(); }
  const d = await r.json();
  $('list').innerHTML = '';
  d.forEach(x => {
    const row = document.createElement('div'); row.className = 'row';
    const t = document.createElement('span'); t.textContent = cand ? x.name + ' (' + x.source + ')' : ((x.title && x.title.fr) || x.slug) + ' — ' + x.status;
    row.append(t);
    const b = (label, fn) => { const e = document.createElement('button'); e.textContent = label; e.onclick = fn; row.append(e); };
    if (cand) { b('Valider', async () => { await api('candidates/' + x._id + '/approve', { method: 'POST' }); load(); });
                b('Rejeter', async () => { await api('candidates/' + x._id + '/reject', { method: 'POST' }); load(); }); }
    else b('Supprimer', async () => { if (confirm('Supprimer ?')) { await api(c + '/' + x._id, { method: 'DELETE' }); load(); } });
    $('list').append(row);
  });
}
$('f').onsubmit = async e => {
  e.preventDefault(); const f = e.target;
  let extra = {}; try { extra = f.extra.value ? JSON.parse(f.extra.value) : {}; } catch { return $('msg').textContent = 'JSON invalide'; }
  const body = { slug: f.slug.value, status: f.status.value, cover: f.cover.value || undefined,
    title: { fr: f.fr.value, en: f.en.value, es: f.es.value, ro: f.ro ? f.ro.value : '', ru: f.ru ? f.ru.value : '' }, ...extra };
  const r = await api($('col').value, { method: 'POST', body: JSON.stringify(body) });
  $('msg').textContent = r.ok ? 'Enregistré' : (await r.json()).error;
  if (r.ok) { f.reset(); $('pv').removeAttribute('src'); load(); }
};
show();
