require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { Schema } = mongoose;
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
// FRONT_URL peut contenir un chemin (https://lk10ar.github.io/moldova/) : on ne garde que l'origine (schéma + domaine)
// FRONT_URL peut contenir plusieurs adresses séparées par des virgules, avec ou sans https:// ou chemin.
const origins = [...new Set(['https://lk10ar.github.io', ...(process.env.FRONT_URL || '').split(',')]
  .map(s => s.trim()).filter(Boolean)
  .map(s => { try { return new URL(/^https?:\/\//.test(s) ? s : 'https://' + s).origin; } catch { return ''; } })
  .filter(Boolean))];
app.use(cors({
  origin: (o, cb) => cb(null, !o || origins.includes(o)),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'], maxAge: 86400
}));
app.use(express.json({ limit: '200kb' }));
app.get('/', (q, r) => r.send('Moldova Explorer API OK'));

/* ---------- Schémas (images = URL String) ---------- */
const i18n = { fr: String, en: String, es: String, ro: String, ru: String };
const url = { type: String, trim: true, match: /^https?:\/\//, default: undefined };
const base = {
  slug: { type: String, unique: true, index: true, required: true },
  title: i18n, summary: i18n,
  status: { type: String, enum: ['draft', 'published'], default: 'draft' },
  cover: url, gallery: [url],
  videos: [url], links: [{ label: String, url }],
  sub: String, w: String, reg: String, st: String, seeded: Boolean, when: i18n,
  location: { lat: Number, lng: Number }
};
const make = (name, extra = {}) =>
  mongoose.model(name, new Schema({ ...base, ...extra }, { timestamps: true }));

const Circuit = make('Circuit', {
  region: { type: String, enum: ['centre', 'nord', 'sud', 'gagaouzie', 'transnistrie'] },
  days: Number, nights: Number, groupMin: { type: Number, default: 10 },
  transport: { type: String, enum: ['bus', 'velo', 'pied'] },
  lodging: [{ type: String, enum: ['hotel', 'pension', 'habitant', 'auberge'] }],
  itinerary: [{ day: Number, title: i18n, text: i18n }], priceFrom: Number
});
const Activity = make('Activity', {
  category: String,
  wilaya: String /* district ; mettre 'transnistrie' pour la section Transnistrie */, location: { lat: Number, lng: Number },
  route: { start: { name: String, lat: Number, lng: Number }, end: { name: String, lat: Number, lng: Number } }
});
const Restaurant = make('Restaurant', {
  type: String,
  address: String, wilaya: String /* district ; mettre 'transnistrie' pour la section Transnistrie */, location: { lat: Number, lng: Number }
});
const Heritage = make('Heritage', {
  kind: String, period: String, wilaya: String /* district ; mettre 'transnistrie' pour la section Transnistrie */,
  location: { lat: Number, lng: Number }
});
const News = make('News', { body: i18n, publishedAt: { type: Date, default: Date.now }, tags: [String] });

const Candidate = mongoose.model('Candidate', new Schema({
  target: { type: String, enum: ['Activity', 'Restaurant', 'Heritage'] },
  source: String, externalId: String, name: String, summary: String, photoUrl: String,
  location: { lat: Number, lng: Number },
  state: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }
}, { timestamps: true }).index({ source: 1, externalId: 1 }, { unique: true }));

const AdminUser = mongoose.model('AdminUser', new Schema({
  email: { type: String, unique: true }, passwordHash: String,
  role: { type: String, enum: ['admin', 'editor'], default: 'editor' }
}));

const models = { circuits: Circuit, activities: Activity, restaurants: Restaurant, heritage: Heritage, news: News };

/* ---------- Réglages de la page d'accueil, gérés depuis l'admin ----------
   galerie « Un pays en images », cartes « Par où commencer », vidéo / photo du header,
   thème (couleurs + polices), ordre et visibilité des sections, textes modifiables. */
const Setting = mongoose.model('Setting', new Schema({ key: { type: String, unique: true }, value: Schema.Types.Mixed }, { timestamps: true, minimize: false }));
const LANGS = ['fr', 'en', 'es', 'ro', 'ru'];
const HEX = /^#[0-9a-f]{6}$/i;
const FONT_H = ['Playfair Display', 'Cormorant Garamond', 'DM Serif Display', 'Fraunces', 'Lora', 'Montserrat', 'Poppins', 'Space Grotesk', 'Syne', 'Bebas Neue', 'Unbounded'];
const FONT_B = ['Georgia', 'Inter', 'DM Sans', 'Manrope', 'Nunito', 'Lora', 'Poppins', 'Montserrat', 'system-ui'];
const SECTIONS = ['intro', 'stack', 'gallery', 'globe', 'catalogue'];
const CARDS = ['c', 'g', 'h', 't'];
const TEXT_KEYS = ['h1', 'sub', 'eye', 'c1', 'c2', 'st', 'kStack', 'tStack', 'kGal', 'tGal', 'kEarth', 'tEarth', 'dEarth', 'kCat', 'tCat', 'fH'];
const isUrl = v => typeof v === 'string' && /^https?:\/\//i.test(v.trim());
const uniq = a => [...new Set(a)];
const i18nClean = (o, max) => { const r = {}; if (o && typeof o === 'object') for (const l of LANGS) if (typeof o[l] === 'string' && o[l].trim()) r[l] = o[l].trim().slice(0, max); return r; };
function cleanHome(b = {}) {
  const gallery = (Array.isArray(b.gallery) ? b.gallery : []).slice(0, 80)
    .filter(g => g && isUrl(g.url))
    .map(g => ({ url: g.url.trim(), caption: i18nClean(g.caption, 160), link: typeof g.link === 'string' ? g.link.trim().slice(0, 300) : '' }));
  const cards = {};
  for (const k of CARDS) {
    const c = b.cards && b.cards[k]; if (!c || typeof c !== 'object') continue;
    const o = { title: i18nClean(c.title, 120), text: i18nClean(c.text, 400) };
    if (isUrl(c.image)) o.image = c.image.trim();
    if (c.off === true) o.off = true;
    if (Object.keys(o.title).length || Object.keys(o.text).length || o.image || o.off) cards[k] = o;
  }
  // apparence : couleurs (p1, ac, bg, cat, ft), polices (ff, fb), mode
  const t = b.theme && typeof b.theme === 'object' ? b.theme : {}, theme = {};
  for (const k of ['p1', 'ac', 'bg', 'cat', 'ft']) if (HEX.test(t[k] || '')) theme[k] = t[k].toLowerCase();
  if (FONT_H.includes(t.ff)) theme.ff = t.ff;
  if (FONT_B.includes(t.fb)) theme.fb = t.fb;
  if (['dark', 'light', 'auto'].includes(t.mode)) theme.mode = t.mode;
  // ordre et visibilité des sections
  const secIn = Array.isArray(b.sections) ? b.sections : [];
  const sections = uniq(secIn.map(x => x && x.id).filter(id => SECTIONS.includes(id)))
    .map(id => ({ id, on: id === 'catalogue' ? true : secIn.find(x => x && x.id === id).on !== false }));
  // textes : { fr: { h1: '…' }, en: { … } }
  const texts = {};
  if (b.texts && typeof b.texts === 'object') for (const l of LANGS) {
    const src = b.texts[l]; if (!src || typeof src !== 'object') continue;
    const o = {}; for (const k of TEXT_KEYS) if (typeof src[k] === 'string' && src[k].trim()) o[k] = src[k].trim().slice(0, 700);
    if (Object.keys(o).length) texts[l] = o;
  }
  return {
    gallery, cards, theme, sections, texts,
    cardOrder: uniq((Array.isArray(b.cardOrder) ? b.cardOrder : []).filter(k => CARDS.includes(k))),
    heroVideo: isUrl(b.heroVideo) ? b.heroVideo.trim() : '',
    heroImage: isUrl(b.heroImage) ? b.heroImage.trim() : ''
  };
}
const getHome = async () => { const d = await Setting.findOne({ key: 'home' }).lean(); return cleanHome((d && d.value) || {}); };

/* ---------- API publique ---------- */
const pub = express.Router();
pub.get('/settings/home', async (req, res) => { try { res.set('Cache-Control', 'public, max-age=30'); res.json(await getHome()); } catch (e) { res.status(500).json({ error: e.message }); } });
pub.get('/:c', async (req, res) => {
  const M = models[req.params.c];
  if (!M) return res.sendStatus(404);
  maybeEnrich(); // déclenchement en arrière-plan (cache 24 h)
  res.json(await M.find({ status: 'published' }).sort('-updatedAt').lean());
});
app.use('/api', pub);

/* ---------- Auth ---------- */
const auth = (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || '').slice(7), process.env.JWT_SECRET); next(); }
  catch { res.sendStatus(401); }
};
app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), async (req, res) => {
  const u = await AdminUser.findOne({ email: String(req.body.email || '').toLowerCase() });
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.passwordHash))) return res.sendStatus(401);
  res.json({ token: jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '8h' }) });
});

/* ---------- Back-office (CRUD) ---------- */
const admin = express.Router();
admin.use(auth);
admin.get('/candidates', async (q, r) => r.json(await Candidate.find({ state: 'pending' }).sort('-createdAt').limit(100)));
admin.post('/candidates/:id/approve', async (q, r) => {
  const c = await Candidate.findById(q.params.id);
  if (!c) return r.sendStatus(404);
  const M = mongoose.model(c.target);
  await M.create({ slug: slugify(c.name) + '-' + String(c._id).slice(-4), title: { fr: c.name },
    summary: { fr: c.summary }, cover: c.photoUrl, location: c.location, status: 'draft' });
  c.state = 'approved'; await c.save(); r.sendStatus(200);
});
admin.post('/candidates/:id/reject', async (q, r) => { await Candidate.findByIdAndUpdate(q.params.id, { state: 'rejected' }); r.sendStatus(200); });
/* Import des fiches qui étaient codées en dur dans index.html (sans écraser ce qui existe déjà) */
admin.post('/seed', async (q, r) => {
  try {
    const data = require('./seed-data.json');
    let added = 0;
    for (const [col, docs] of Object.entries(data)) {
      for (const d of [...docs].reverse()) {           // ordre inversé : l'affichage trie par date décroissante
        if (await models[col].exists({ slug: d.slug })) continue;
        await models[col].create({ ...d, status: 'published', seeded: true }); added++;
      }
    }
    r.json({ added });
  } catch (e) { r.status(500).json({ error: e.message }); }
});
admin.get('/settings/home', async (q, r) => { try { r.json(await getHome()); } catch (e) { r.status(500).json({ error: e.message }); } });
admin.put('/settings/home', async (q, r) => {
  try {
    const value = cleanHome(q.body);
    await Setting.findOneAndUpdate({ key: 'home' }, { key: 'home', value }, { upsert: true, new: true });
    r.json(value);
  } catch (e) { r.status(400).json({ error: e.message }); }
});
admin.param('c', (q, r, next, c) => models[c] ? next() : r.sendStatus(404));
admin.get('/:c', async (q, r) => r.json(await models[q.params.c].find().sort('-updatedAt').limit(200)));
admin.post('/:c', async (q, r) => {
  try { r.status(201).json(await models[q.params.c].create(q.body)); }
  catch (e) { r.status(400).json({ error: e.message }); }
});
admin.put('/:c/:id', async (q, r) => {
  try { r.json(await models[q.params.c].findByIdAndUpdate(q.params.id, q.body, { new: true, runValidators: true })); }
  catch (e) { r.status(400).json({ error: e.message }); }
});
admin.delete('/:c/:id', async (q, r) => { await models[q.params.c].findByIdAndDelete(q.params.id); r.sendStatus(204); });
app.use('/api/admin', admin);

/* ---------- Enrichissement automatique ---------- */
const slugify = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function fromWikipedia() {
  const u = 'https://fr.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=' +
    encodeURIComponent('site touristique Moldavie') +
    '&gsrlimit=20&prop=extracts|pageimages&exintro=1&explaintext=1&piprop=original';
  const { query } = await (await fetch(u)).json();
  return Object.values((query && query.pages) || {}).map(p => ({
    target: 'Heritage', source: 'wikipedia', externalId: String(p.pageid), name: p.title,
    summary: (p.extract || '').slice(0, 500), photoUrl: p.original && p.original.source
  }));
}
async function fromGoogle(q, target) {
  if (!process.env.GOOGLE_PLACES_KEY) return [];
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_PLACES_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.editorialSummary' },
    body: JSON.stringify({ textQuery: q, languageCode: 'fr', regionCode: 'MD' })
  });
  return (((await r.json()).places) || []).map(p => ({
    target, source: 'google', externalId: p.id, name: p.displayName && p.displayName.text,
    summary: p.editorialSummary && p.editorialSummary.text,
    location: { lat: p.location.latitude, lng: p.location.longitude }
  }));
}
async function enrich() {
  const res = await Promise.allSettled([
    fromWikipedia(),
    fromGoogle('restaurants Chișinău', 'Restaurant'),
    fromGoogle('cave viticole Moldavie', 'Activity'),
    fromGoogle('sites touristiques Transnistrie', 'Activity')
  ]);
  const items = res.flatMap(r => r.status === 'fulfilled' ? r.value : []).filter(i => i.name);
  if (items.length) await Candidate.bulkWrite(items.map(i => ({ updateOne: {
    filter: { source: i.source, externalId: i.externalId }, update: { $setOnInsert: i }, upsert: true } })));
  return items.length;
}
let lastRun = 0;
function maybeEnrich() {
  if (Date.now() - lastRun < 24 * 3600 * 1000) return;
  lastRun = Date.now();
  enrich().catch(e => console.error('enrich', e.message));
}
app.post('/internal/enrich', async (q, r) => {
  if (q.headers['x-cron-secret'] !== process.env.CRON_SECRET) return r.sendStatus(403);
  r.json({ added: await enrich() });
});

/* ---------- Démarrage ---------- */
(async () => {
  app.listen(process.env.PORT || 3000, () => console.log('Moldova Explorer en ligne, origines CORS :', origins.join(', ')));
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
    if (ADMIN_EMAIL && ADMIN_PASSWORD && !(await AdminUser.exists({}))) {
      await AdminUser.create({ email: ADMIN_EMAIL.toLowerCase(), passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12), role: 'admin' });
      console.log('Admin créé :', ADMIN_EMAIL);
    }
  } catch (e) { console.error('MongoDB :', e.message); }
})();
