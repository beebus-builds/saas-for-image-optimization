require('dotenv').config();
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const PORT = process.env.PORT || 3000;

const app = express();

// Raw body for Stripe webhook
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret); }
    catch { return res.status(400).json({ error: 'Invalid signature' }); }
    res.json({ received: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Database with sql.js ─────────────────────────────
let db;
async function initDb() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const dbPath = path.join(__dirname, '..', 'data.db');
  try { const buf = fs.readFileSync(dbPath); db = new SQL.Database(buf); }
  catch { db = new SQL.Database(); }
  db.run(`CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY, name TEXT DEFAULT 'Default',
    key TEXT UNIQUE NOT NULL, created_at TEXT DEFAULT (datetime('now')), active INTEGER DEFAULT 1
  )`);
  saveDb();
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(path.join(__dirname, '..', 'data.db'), Buffer.from(data));
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql); stmt.bind(params);
  if (stmt.step()) { const cols = stmt.getColumnNames(); const row = stmt.get(); stmt.free(); const obj = {}; cols.forEach((c,i)=>obj[c]=row[i]); return obj; }
  stmt.free(); return null;
}
function dbRun(sql, params = []) { db.run(sql, params); saveDb(); }
function dbAll(sql, params = []) { const s=db.prepare(sql); s.bind(params); const r=[]; while(s.step()) r.push(s.getAsObject()); s.free(); return r; }

// ─── Multer ─────────────────────────────────────────────
const upload = multer({
  dest: path.join(__dirname, '..', 'public', 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ─── Image Fetch Proxy ───────────────────────────────────
app.get('/api/fetch-image', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'url query param required' });
    const https = require('https');
    const http = require('http');
    const client = url.startsWith('https') ? https : http;
    client.get(url, (response) => {
      const ct = response.headers['content-type'] || '';
      if (!ct.startsWith('image/')) { res.status(400).json({ error: 'URL does not point to an image' }); response.resume(); return; }
      res.set('Content-Type', ct);
      response.pipe(res);
    }).on('error', () => res.status(502).json({ error: 'Failed to fetch image' }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Sharp Helper ────────────────────────────────────────
const FORMAT_MAP = { jpeg: 'jpeg', jpg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', avif: 'avif', tiff: 'tiff' };

async function sharpProcess(filePath, opts = {}) {
  let pipeline = sharp(filePath);
  const meta = await sharp(filePath).metadata();
  if (opts.width || opts.height) {
    pipeline = pipeline.resize(opts.width || null, opts.height || null, {
      fit: opts.fit || 'contain', withoutEnlargement: opts.withoutEnlargement !== false
    });
  }
  const fmt = FORMAT_MAP[opts.format] || (meta.format === 'svg' ? 'png' : meta.format);
  const q = opts.quality || 80;
  pipeline = pipeline.toFormat(fmt, fmt === 'png' ? { palette: true } : { quality: q });
  const buf = await pipeline.toBuffer();
  const outMeta = await sharp(buf).metadata();
  return { buffer: buf, format: outMeta.format, width: outMeta.width, height: outMeta.height, size: buf.length };
}

// ─── API Key Middleware ──────────────────────────────────
function apiKeyMiddleware(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'x-api-key header required' });
  const row = dbGet('SELECT * FROM api_keys WHERE key = ? AND active = 1', [key]);
  if (!row) return res.status(401).json({ error: 'Invalid or inactive API key' });
  req.apiUser = { keyId: row.id };
  next();
}

// ─── API Key Management Routes ──────────────────────────
app.get('/api/keys', (req, res) => {
  const keys = dbAll('SELECT id, name, key, created_at, active FROM api_keys');
  res.json(keys);
});

app.post('/api/keys', (req, res) => {
  const name = req.body.name || 'API Key ' + (dbAll('SELECT count(*) as c FROM api_keys')[0].c + 1);
  const id = uuidv4();
  const key = 'imgpro_' + uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '').slice(0, 12);
  dbRun('INSERT INTO api_keys (id, name, key) VALUES (?, ?, ?)', [id, name, key]);
  res.json({ id, name, key });
});

app.delete('/api/keys/:id', (req, res) => {
  const k = dbGet('SELECT id FROM api_keys WHERE id = ?', [req.params.id]);
  if (!k) return res.status(404).json({ error: 'Key not found' });
  dbRun('UPDATE api_keys SET active = 0 WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ─── API v1 Routes ──────────────────────────────────────
const apiV1Limiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Rate limit exceeded (60/min)' } });

app.post('/api/v1/compress', apiKeyMiddleware, apiV1Limiter, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const quality = parseInt(req.query.quality) || parseInt(req.body.quality) || 80;
    const format = (req.query.format || req.body.format || '').toLowerCase();
    const result = await sharpProcess(req.file.path, { quality, format });
    res.set('X-Image-Width', result.width); res.set('X-Image-Height', result.height);
    res.set('X-Image-Format', result.format);
    res.set('Content-Type', `image/${result.format === 'jpeg' ? 'jpeg' : result.format}`);
    res.send(result.buffer);
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { if (req.file) try { fs.unlinkSync(req.file.path); } catch {} }
});

app.post('/api/v1/convert', apiKeyMiddleware, apiV1Limiter, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const format = (req.query.format || req.body.format || 'jpeg').toLowerCase();
    if (!FORMAT_MAP[format]) return res.status(400).json({ error: 'Unsupported format: ' + format });
    const quality = parseInt(req.query.quality) || parseInt(req.body.quality) || 85;
    const result = await sharpProcess(req.file.path, { format, quality });
    res.set('X-Image-Width', result.width); res.set('X-Image-Height', result.height);
    res.set('Content-Type', `image/${result.format === 'jpeg' ? 'jpeg' : result.format}`);
    res.send(result.buffer);
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { if (req.file) try { fs.unlinkSync(req.file.path); } catch {} }
});

app.post('/api/v1/resize', apiKeyMiddleware, apiV1Limiter, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const width = parseInt(req.query.width) || parseInt(req.body.width) || null;
    const height = parseInt(req.query.height) || parseInt(req.body.height) || null;
    if (!width && !height) return res.status(400).json({ error: 'Provide width or height' });
    const fit = req.query.fit || req.body.fit || 'contain';
    const format = (req.query.format || req.body.format || '').toLowerCase();
    const quality = parseInt(req.query.quality) || parseInt(req.body.quality) || 85;
    const result = await sharpProcess(req.file.path, { width, height, fit, format, quality });
    res.set('X-Image-Width', result.width); res.set('X-Image-Height', result.height);
    res.set('Content-Type', `image/${result.format === 'jpeg' ? 'jpeg' : result.format}`);
    res.send(result.buffer);
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { if (req.file) try { fs.unlinkSync(req.file.path); } catch {} }
});

app.post('/api/v1/info', apiKeyMiddleware, apiV1Limiter, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const meta = await sharp(req.file.path).metadata();
    res.json({ width: meta.width, height: meta.height, format: meta.format, size: req.file.size,
      space: meta.space, channels: meta.channels, density: meta.density || null, hasAlpha: !!meta.hasAlpha,
      aspectRatio: meta.width && meta.height ? +(meta.width / meta.height).toFixed(4) : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { if (req.file) try { fs.unlinkSync(req.file.path); } catch {} }
});

// ─── API Docs ────────────────────────────────────────────
app.get('/api/v1/docs', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>ImagePro API v1 Docs</title>
<style>body{font-family:sans-serif;background:#0a0a10;color:#e4e4ec;max-width:900px;margin:0 auto;padding:30px 20px}
pre{background:#1e1e32;padding:16px;border-radius:8px;overflow-x:auto;font-size:.85rem}
code{background:#1e1e32;padding:2px 6px;border-radius:4px;font-size:.85rem}
h2{border-bottom:1px solid #2a2a3a;padding-bottom:8px;margin-top:30px}
.endpoint{background:#12121e;padding:16px 20px;border-radius:8px;margin:12px 0;border-left:4px solid #6c5ce7}
.endpoint .url{font-weight:bold;font-size:1rem;color:#a29bfe}
.endpoint .desc{color:#8a8aa0;font-size:.85rem;margin:4px 0 8px}
table{width:100%;border-collapse:collapse;font-size:.85rem}
td,th{border:1px solid #2a2a3a;padding:8px 12px;text-align:left}
</style></head><body>
<h1>&#x1F4F7; ImagePro API v1</h1>
<p>Server-side image processing API. All endpoints require an API key.</p>
<h2>Authentication</h2><p>Include your API key in the <code>x-api-key</code> header:</p>
<pre>curl -H "x-api-key: imgpro_xxx" https://yourdomain.com/api/v1/compress</pre>
<h2>Endpoints</h2>
<div class="endpoint"><div class="url">POST /api/v1/compress</div><div class="desc">Compress/reduce file size</div><table><tr><th>Param</th><th>Type</th><th>Default</th><th>Description</th></tr><tr><td>image</td><td>file</td><td>required</td><td>Image file</td></tr><tr><td>quality</td><td>int</td><td>80</td><td>1-100</td></tr><tr><td>format</td><td>string</td><td>original</td><td>jpeg, png, webp, avif</td></tr></table>
<pre>curl -X POST -H "x-api-key: imgpro_xxx" -F "image=@photo.jpg" -F "quality=70" https://.../api/v1/compress > out.jpg</pre></div>
<div class="endpoint"><div class="url">POST /api/v1/convert</div><div class="desc">Convert image format</div><table><tr><th>Param</th><th>Type</th><th>Default</th><th>Description</th></tr><tr><td>image</td><td>file</td><td>required</td><td>Image file</td></tr><tr><td>format</td><td>string</td><td>jpeg</td><td>jpeg, png, webp, gif, avif, tiff</td></tr><tr><td>quality</td><td>int</td><td>85</td><td>1-100</td></tr></table>
<pre>curl -X POST -H "x-api-key: imgpro_xxx" -F "image=@photo.png" -F "format=webp" https://.../api/v1/convert > out.webp</pre></div>
<div class="endpoint"><div class="url">POST /api/v1/resize</div><div class="desc">Resize to dimensions</div><table><tr><th>Param</th><th>Type</th><th>Default</th><th>Description</th></tr><tr><td>image</td><td>file</td><td>required</td><td>Image file</td></tr><tr><td>width</td><td>int</td><td>-</td><td>Target width</td></tr><tr><td>height</td><td>int</td><td>-</td><td>Target height</td></tr></table>
<pre>curl -X POST -H "x-api-key: imgpro_xxx" -F "image=@photo.jpg" -F "width=800" https://.../api/v1/resize > resized.jpg</pre></div>
<div class="endpoint"><div class="url">POST /api/v1/info</div><div class="desc">Image metadata (JSON)</div>
<pre>curl -X POST -H "x-api-key: imgpro_xxx" -F "image=@photo.jpg" https://.../api/v1/info</pre></div>
<h2>Rate Limits</h2><p>60 reqs/min per key. <code>429</code> when exceeded.</p>
<h2>Errors</h2><p><code>401</code> bad key, <code>400</code> bad params, <code>429</code> rate limit, <code>500</code> server error</p>
</body></html>`);
});

// ─── Static Files ────────────────────────────────────────
const uploadsPath = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath, { recursive: true });
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Start ───────────────────────────────────────────────
async function start() {
  await initDb();
  app.listen(PORT, () => { console.log(`ImagePro running at http://localhost:${PORT}`); });
}
start();
