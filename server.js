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
const origins = (process.env.FRONT_URL || 'https://lk10ar.github.io').split(',')
  .map(s => { try { return new URL(s.trim()).origin; } catch { return ''; } }).filter(Boolean);
app.use(cors({ origin: origins, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'], maxAge: 86400 }));
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
  videos: [url], links: [{ label: String, url }]
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
  category: { type: String, enum: ['vin', 'nature', 'urbain', 'artisanat'] },
  wilaya: String /* district ; mettre 'transnistrie' pour la section Transnistrie */, location: { lat: Number, lng: Number },
  route: { start: { name: String, lat: Number, lng: Number }, end: { name: String, lat: Number, lng: Number } }
});
const Restaurant = make('Restaurant', {
  type: { type: String, enum: ['gastronomique', 'street-food', 'traditionnel'] },
  address: String, wilaya: String /* district ; mettre 'transnistrie' pour la section Transnistrie */, location: { lat: Number, lng: Number }
});
const Heritage = make('Heritage', {
  kind: { type: String, enum: ['monastere', 'forteresse', 'musee', 'site'] }, period: String, wilaya: String /* district ; mettre 'transnistrie' pour la section Transnistrie */,
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

/* ---------- API publique ---------- */
const pub = express.Router();
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
