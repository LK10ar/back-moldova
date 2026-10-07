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
  trace: Schema.Types.Mixed /* parcours : GeoJSON FeatureCollection (LineString + Points) */,
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
    summary: { fr: c.summary }, cover: c.photoUrl, location: c.location, w: c.source === 'wikipedia' ? c.name : undefined, status: 'draft' });
  c.state = 'approved'; await c.save(); r.sendStatus(200);
});
admin.post('/candidates/:id/reject', async (q, r) => { await Candidate.findByIdAndUpdate(q.params.id, { state: 'rejected' }); r.sendStatus(200); });
admin.post('/candidates/refresh', async (q, r) => { try { r.json({ added: await enrich() }); } catch (e) { r.status(500).json({ error: e.message }); } });
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

/* ---------- Propositions automatiques : Wikipédia (recherches + lieux autour des villes), filtrées sur la Moldavie ---------- */
const MD_BORDER = [[26.6179,48.259],[26.6251,48.2829],[26.6361,48.2949],[26.6691,48.3088],[26.6798,48.3302],[26.6994,48.3251],[26.7359,48.2918],[26.7546,48.2861],[26.7744,48.2872],[26.7857,48.2941],[26.7894,48.3259],[26.7775,48.3662],[26.7881,48.376],[26.8169,48.3717],[26.8256,48.3778],[26.8319,48.3914],[26.8428,48.3937],[26.876,48.384],[26.9432,48.3513],[26.9811,48.3557],[26.9906,48.3624],[27.0331,48.3602],[27.0254,48.3899],[27.0263,48.3971],[27.0374,48.3997],[27.1758,48.3618],[27.2086,48.3606],[27.2465,48.3737],[27.306,48.4237],[27.3422,48.4361],[27.3614,48.4328],[27.3898,48.415],[27.4035,48.4115],[27.4809,48.4514],[27.5038,48.4724],[27.5452,48.4724],[27.583,48.486],[27.6048,48.4841],[27.6069,48.4578],[27.627,48.4513],[27.7518,48.452],[27.7853,48.4416],[27.8648,48.3989],[27.9264,48.3394],[27.9671,48.3289],[28.0559,48.3215],[28.0764,48.3149],[28.0928,48.3021],[28.0983,48.2841],[28.0787,48.2449],[28.0933,48.2374],[28.1311,48.2396],[28.1621,48.2572],[28.1785,48.2589],[28.1894,48.2231],[28.1999,48.2117],[28.217,48.2081],[28.2403,48.2116],[28.2945,48.2365],[28.3577,48.2386],[28.3682,48.2306],[28.37,48.2116],[28.3634,48.191],[28.3222,48.1632],[28.3156,48.1493],[28.3174,48.1354],[28.3286,48.127],[28.3496,48.1297],[28.3886,48.1686],[28.4116,48.1707],[28.4273,48.1634],[28.4369,48.1499],[28.4357,48.1347],[28.419,48.1222],[28.4474,48.0828],[28.4796,48.0649],[28.49,48.0655],[28.5011,48.1128],[28.5193,48.1491],[28.5416,48.156],[28.5736,48.155],[28.6656,48.1293],[28.7712,48.1245],[28.7993,48.1118],[28.8276,48.057],[28.8325,48.0248],[28.8557,48.0079],[28.8826,47.9768],[28.9148,47.9531],[28.9504,47.9348],[28.9808,47.9264],[29.0172,47.9311],[29.061,47.9698],[29.0927,47.9802],[29.124,47.976],[29.148,47.9554],[29.1726,47.891],[29.236,47.8707],[29.2328,47.8571],[29.1867,47.8182],[29.1777,47.8007],[29.1778,47.7897],[29.1874,47.7832],[29.222,47.7748],[29.2347,47.7668],[29.2386,47.756],[29.197,47.7175],[29.1915,47.6863],[29.1924,47.6509],[29.1821,47.6132],[29.1305,47.5596],[29.1174,47.5333],[29.1304,47.4932],[29.1556,47.45],[29.1639,47.4394],[29.1821,47.4299],[29.2019,47.4466],[29.2184,47.4516],[29.2326,47.4463],[29.2507,47.4254],[29.2814,47.4115],[29.3008,47.3782],[29.3458,47.3658],[29.3589,47.3527],[29.3676,47.3082],[29.3808,47.293],[29.4096,47.2798],[29.4417,47.2821],[29.4592,47.2935],[29.4809,47.3383],[29.521,47.3389],[29.5566,47.324],[29.5701,47.3068],[29.5793,47.2836],[29.5802,47.2604],[29.5687,47.2431],[29.544,47.2343],[29.5404,47.2125],[29.5506,47.1602],[29.5448,47.1356],[29.5304,47.1237],[29.4809,47.1175],[29.4779,47.1115],[29.5201,47.0599],[29.531,47.066],[29.5514,47.0902],[29.5702,47.0914],[29.5949,47.0746],[29.6021,47.061],[29.603,47.0458],[29.5954,47.0321],[29.5725,47.0118],[29.5587,46.9457],[29.5675,46.9347],[29.5985,46.9354],[29.6319,46.9144],[29.6962,46.9047],[29.7125,46.8934],[29.7358,46.8672],[29.7541,46.858],[29.8436,46.8541],[29.8722,46.8377],[29.8896,46.8072],[29.9174,46.814],[29.9282,46.8098],[29.9318,46.7724],[29.9511,46.7431],[29.9526,46.7247],[29.9444,46.6625],[29.9319,46.6324],[29.9313,46.6192],[29.9497,46.5789],[29.9381,46.5573],[29.8988,46.5531],[29.9019,46.5308],[29.9161,46.5188],[29.9602,46.5059],[29.9706,46.4917],[29.9893,46.4987],[30.0028,46.4942],[30.0217,46.4707],[30.0141,46.462],[30.077,46.4228],[30.102,46.4307],[30.1316,46.4228],[30.1072,46.3919],[30.0811,46.3742],[30.0373,46.3689],[29.9187,46.3737],[29.8847,46.3642],[29.8478,46.3415],[29.8281,46.3394],[29.8082,46.3547],[29.8067,46.3809],[29.8003,46.3984],[29.7796,46.4211],[29.7269,46.4558],[29.7141,46.4712],[29.7138,46.4431],[29.7029,46.4283],[29.6827,46.4229],[29.6544,46.4227],[29.648,46.4164],[29.6529,46.3919],[29.6455,46.3756],[29.6321,46.3661],[29.6156,46.3618],[29.583,46.3697],[29.5556,46.4042],[29.5414,46.413],[29.4809,46.4252],[29.4733,46.4398],[29.4862,46.4625],[29.4864,46.4759],[29.4809,46.482],[29.4576,46.4847],[29.4368,46.4767],[29.4182,46.4625],[29.3747,46.4162],[29.3621,46.4159],[29.3208,46.4687],[29.3067,46.472],[29.2891,46.4516],[29.2859,46.4395],[29.2901,46.4102],[29.2833,46.3974],[29.2592,46.3944],[29.2229,46.3665],[29.2007,46.3571],[29.1837,46.3672],[29.1834,46.3776],[29.2056,46.4061],[29.2068,46.5025],[29.2002,46.524],[29.1842,46.538],[29.1627,46.5381],[29.0749,46.5037],[29.0203,46.4895],[28.9458,46.4548],[28.9254,46.4328],[28.9192,46.4047],[28.9449,46.3207],[28.9458,46.305],[28.9329,46.2726],[28.9335,46.259],[29.0098,46.2044],[29.0154,46.1826],[29.0035,46.1589],[28.9808,46.1321],[28.9464,46.1051],[28.9388,46.0893],[28.9412,46.0647],[28.9589,46.021],[28.9569,46.0014],[28.932,45.9932],[28.7576,45.9612],[28.7402,45.9532],[28.7292,45.9386],[28.7284,45.922],[28.7464,45.8706],[28.745,45.8505],[28.7383,45.8376],[28.7064,45.8211],[28.6698,45.812],[28.6733,45.7869],[28.6698,45.7773],[28.6436,45.7665],[28.5767,45.7619],[28.5606,45.7432],[28.5676,45.7246],[28.5614,45.7166],[28.5152,45.702],[28.474,45.6579],[28.5113,45.635],[28.5231,45.5932],[28.5369,45.5798],[28.5104,45.571],[28.4982,45.5587],[28.5065,45.5206],[28.502,45.5087],[28.4809,45.502],[28.4168,45.5038],[28.3419,45.5176],[28.2705,45.5215],[28.2173,45.4933],[28.1995,45.4618],[28.1659,45.4946],[28.1654,45.5283],[28.1409,45.5602],[28.0621,45.5936],[28.1077,45.6244],[28.1537,45.6275],[28.168,45.6325],[28.1618,45.6454],[28.155,45.7618],[28.1289,45.795],[28.1133,45.8254],[28.1105,45.8543],[28.1311,45.8714],[28.1174,45.8952],[28.125,45.9184],[28.1149,45.9332],[28.0827,46.0147],[28.0969,46.0597],[28.0902,46.0734],[28.1008,46.082],[28.1274,46.1353],[28.1447,46.1832],[28.111,46.2256],[28.109,46.2341],[28.1321,46.2399],[28.1311,46.2624],[28.1352,46.2693],[28.1778,46.287],[28.1929,46.3112],[28.1904,46.3511],[28.2071,46.3582],[28.2129,46.3887],[28.2333,46.4018],[28.2261,46.4154],[28.2402,46.4203],[28.2461,46.4279],[28.2458,46.4755],[28.2341,46.4781],[28.219,46.5037],[28.2211,46.5412],[28.2248,46.5487],[28.2341,46.5531],[28.2254,46.5696],[28.2471,46.6072],[28.2474,46.6208],[28.2341,46.6624],[28.1781,46.7398],[28.1782,46.7586],[28.1378,46.8062],[28.1215,46.8343],[28.1243,46.8616],[28.1131,46.8714],[28.1136,46.8948],[28.0969,46.9026],[28.1054,46.9177],[28.1023,46.9351],[28.0827,46.9715],[28.037,47.0165],[28.028,47.033],[28.0083,47.0263],[27.9631,47.0434],[27.9387,47.0466],[27.9384,47.0611],[27.8438,47.1144],[27.8499,47.1285],[27.8066,47.1446],[27.7947,47.1558],[27.8077,47.1625],[27.7883,47.2043],[27.7524,47.2389],[27.7536,47.2514],[27.7333,47.2756],[27.7228,47.2833],[27.6978,47.2875],[27.6717,47.2999],[27.6369,47.3067],[27.5999,47.3607],[27.5724,47.3752],[27.5803,47.406],[27.5625,47.4165],[27.5694,47.4386],[27.583,47.4507],[27.5759,47.4604],[27.5482,47.4743],[27.5072,47.478],[27.4731,47.4918],[27.4595,47.5332],[27.4421,47.5366],[27.4284,47.581],[27.3971,47.5891],[27.3692,47.6083],[27.304,47.6665],[27.2811,47.693],[27.272,47.715],[27.2951,47.7182],[27.2875,47.7523],[27.2647,47.7646],[27.2449,47.7926],[27.2192,47.8138],[27.2534,47.8281],[27.2458,47.8366],[27.2124,47.8479],[27.2124,47.8895],[27.1607,47.9217],[27.1783,47.9379],[27.1783,47.9441],[27.151,47.9578],[27.1698,47.9738],[27.1688,47.9831],[27.1572,47.992],[27.1437,47.9868],[27.1215,48.0132],[27.0958,48.0056],[27.089,48.0198],[27.1093,48.0261],[27.1093,48.0335],[27.0592,48.0581],[27.0417,48.0773],[27.0343,48.1018],[27.0474,48.1165],[27.0428,48.1273],[27.0251,48.135],[27.0127,48.1281],[26.9666,48.1434],[26.9666,48.1496],[26.9862,48.1504],[26.9976,48.1579],[26.9976,48.1666],[26.9631,48.1754],[26.9506,48.1975],[26.9381,48.2048],[26.908,48.1845],[26.8977,48.209],[26.8555,48.2378],[26.8447,48.2333],[26.8219,48.2525],[26.8049,48.2583],[26.7637,48.2527],[26.744,48.2556],[26.7331,48.2707],[26.7224,48.2598],[26.7115,48.2613],[26.6885,48.2748],[26.6657,48.2742],[26.6179,48.259]];   // [lon, lat]
const inMD = (lo, la) => { let c = false; for (let i = 0, j = MD_BORDER.length - 1; i < MD_BORDER.length; j = i++) { const [xi, yi] = MD_BORDER[i], [xj, yj] = MD_BORDER[j]; if ((yi > la) !== (yj > la) && lo < (xj - xi) * (la - yi) / (yj - yi) + xi) c = !c; } return c; };
const W = words => new RegExp('(?<![\\p{L}])(?:' + words.join('|') + ')(?![\\p{L}])', 'iu');
const RE_MD = /moldav|moldova|transnistr|chișinău|chisinau|tiraspol|bender|orhei|soroca|gagaouz|bessarab|dniestr|cricova|saharna|comrat|cahul|bălți|balti/i;
const RE_TOUR = W(['monastère', 'monastere', 'église', 'eglise', 'cathédrale', 'cathedrale', 'forteresse', 'fortification', 'château', 'chateau', 'musée', 'musee', 'palais', 'parc', 'réserve', 'reserve', 'lac', 'grotte', 'caverne', 'cascade', 'gorge', 'cave', 'caves', 'vin', 'vins', 'vignoble', 'domaine', 'distillerie', 'brasserie', 'monument', 'mémorial', 'memorial', 'théâtre', 'theatre', 'jardin', 'ruines', 'archéologique', 'archeologique', 'patrimoine', 'statue', 'arc', 'synagogue', 'mosquée', 'mosquee', 'cimetière', 'cimetiere', 'manoir', 'cuisine', 'plat', 'fromage', 'gastronomie', 'randonnée', 'randonnee', 'sentier', 'canyon', 'marais', 'forêt', 'foret', 'rivière', 'fleuve', 'curiosité', 'touristique', 'attraction']);
const RE_ACT = W(['grotte', 'caverne', 'cascade', 'lac', 'réserve', 'reserve', 'parc', 'gorge', 'forêt', 'foret', 'randonnée', 'randonnee', 'sentier', 'canyon', 'marais', 'plage', 'paysage', 'zoo', 'rivière', 'fleuve', 'colline', 'carrière', 'gypse']);
const RE_FOOD = W(['vin', 'vins', 'vignoble', 'vignobles', 'cave', 'caves', 'domaine', 'restaurant', 'cuisine', 'gastronomie', 'fromage', 'distillerie', 'brasserie', 'cognac', 'mămăligă', 'plat', 'spécialité']);
const kindOf = t => RE_ACT.test(t) ? 'Activity' : RE_FOOD.test(t) ? 'Restaurant' : 'Heritage';
const UA = { 'User-Agent': 'MoldovaExplorer/1.0 (https://lk10ar.github.io/moldova; contact via site)' };
const WIKI = 'https://fr.wikipedia.org/w/api.php?action=query&format=json&prop=extracts|pageimages|coordinates&exintro=1&explaintext=1&exlimit=20&piprop=original&colimit=max&redirects=1&origin=*';
const wiki = async qs => { const r = await fetch(WIKI + qs, { headers: UA, signal: AbortSignal.timeout(15000) }); const j = await r.json(); return Object.values((j.query && j.query.pages) || {}); };
function wikiItem(p) {
  const c = p.coordinates && p.coordinates[0], extract = (p.extract || '').trim();
  if (extract.length < 60) return null;                                        // ébauches vides
  if (c && !inMD(c.lon, c.lat)) return null;                                    // hors Moldavie (Roumanie, Ukraine, France…)
  const txt = p.title + ' ' + extract.slice(0, 400);
  if (!c && !RE_MD.test(txt)) return null;
  if (!RE_TOUR.test(txt)) return null;                                          // villages sans intérêt touristique
  return { target: kindOf(p.title + ' ' + extract.slice(0, 220)), source: 'wikipedia', externalId: String(p.pageid), name: p.title,
    summary: extract.slice(0, 500), photoUrl: p.original && p.original.source, location: c ? { lat: c.lat, lng: c.lon } : undefined };
}
const WIKI_QUERIES = ['monastère Moldavie', 'forteresse Moldavie', 'château Moldavie', 'musée Moldavie', 'parc national Moldavie', 'réserve naturelle Moldavie', 'lac Moldavie', 'grotte Moldavie',
  'cascade Moldavie', 'vin moldave', 'cave viticole Moldavie', 'domaine viticole Moldavie', 'cuisine moldave', 'plat traditionnel moldave', 'église Moldavie', 'cathédrale Chișinău', 'monument Chișinău',
  'patrimoine Transnistrie', 'Transnistrie site touristique', 'Gagaouzie', 'Orheiul Vechi', 'Soroca', 'Bender forteresse', 'Tiraspol', 'mémorial Moldavie', 'théâtre Chișinău', 'jardin botanique Moldavie',
  'site archéologique Moldavie', 'synagogue Moldavie', 'mosquée Moldavie', 'cimetière Moldavie', 'manoir Moldavie', 'monastère Țipova', 'Căpriana', 'Curchi', 'Hîncu', 'Mileștii Mici', 'Purcari', 'Cricova'];
const GEO_CENTERS = [[47.0105, 28.8638], [47.754, 27.9184], [47.3831, 28.8236], [48.1578, 28.2972], [45.9075, 28.1889], [46.2975, 28.6567], [46.8403, 29.6433], [46.83, 29.47], [47.21, 27.8], [48.17, 27.31],
  [46.83, 28.59], [46.64, 29.41], [47.136, 28.86], [46.93, 28.8], [47.12, 28.45], [47.642, 28.955], [47.53, 29.08], [46.1, 29.65], [45.65, 28.9], [46.5, 28.2], [47.9, 28.4], [47.6, 28.1], [47.0, 28.0],
  [46.75, 28.95], [46.2, 28.9], [45.95, 28.65], [48.3, 27.55], [47.5, 27.55], [46.3, 29.1], [47.3, 29.2], [47.8, 28.6], [46.6, 28.6]];
async function pool(tasks, n = 6) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) { const t = tasks[i++]; try { out.push(await t()); } catch (e) { console.error('wiki', e.message); } } })); return out.flat(); }
async function fromWikipedia() {
  const tasks = [
    ...WIKI_QUERIES.map(q => () => wiki('&generator=search&gsrlimit=20&gsrsearch=' + encodeURIComponent(q))),
    ...GEO_CENTERS.map(([la, lo]) => () => wiki('&generator=geosearch&ggslimit=20&ggsradius=10000&ggscoord=' + la + '%7C' + lo))
  ];
  const seen = new Set();
  return (await pool(tasks)).map(wikiItem).filter(i => i && !seen.has(i.externalId) && seen.add(i.externalId));
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
  let added = 0;
  if (items.length) { const r = await Candidate.bulkWrite(items.map(i => ({ updateOne: {
    filter: { source: i.source, externalId: i.externalId }, update: { $setOnInsert: i }, upsert: true } })), { ordered: false }); added = r.upsertedCount || 0; }
  console.log('enrich: ' + items.length + ' trouvées, ' + added + ' nouvelles');
  return added;
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
