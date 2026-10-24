// سيرفر موقع دوري درب المستقل. بدون مكتبات خارجية، يحتاج Node.js 18 أو أحدث.
// التشغيل:  ADMIN_PASSWORD=كلمة_سر_قوية node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const UPLOADS = path.join(DATA_DIR, 'uploads');

if (ADMIN_PASSWORD.length < 8) {
  console.error('لازم تحدد ADMIN_PASSWORD (8 أحرف على الأقل). مثال:\n  ADMIN_PASSWORD=كلمة_سر_قوية node server.js');
  process.exit(1);
}
fs.mkdirSync(UPLOADS, {recursive: true});

/* ---------- ملفات البيانات ---------- */
const file = (n) => path.join(DATA_DIR, n);
function readJson(n, def) { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch (e) { return def; } }
function writeJson(n, v) { const tmp = file(n) + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v)); fs.renameSync(tmp, file(n)); }

let SECRET = '';
try { SECRET = fs.readFileSync(file('secret.key'), 'utf8'); } catch (e) {}
if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(file('secret.key'), SECRET, {mode: 0o600}); }

const EXT = {'image/png':'png', 'image/jpeg':'jpg', 'image/webp':'webp', 'image/gif':'gif', 'image/svg+xml':'svg'};
// يحوّل كل صورة مضمّنة (data:image) إلى ملف في uploads ويستبدلها برابط قصير
function extractImages(o) {
  if (typeof o === 'string') {
    const m = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/.exec(o);
    if (!m || !EXT[m[1]]) return o;
    const buf = Buffer.from(m[2], 'base64');
    const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + '.' + EXT[m[1]];
    const p = path.join(UPLOADS, name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, buf);
    return '/uploads/' + name;
  }
  if (Array.isArray(o)) return o.map(extractImages);
  if (o && typeof o === 'object') { const r = {}; for (const k of Object.keys(o)) r[k] = extractImages(o[k]); return r; }
  return o;
}

let LEAGUE = readJson('league.json', null);
if (!LEAGUE) {
  try {
    LEAGUE = extractImages(JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8')));
    writeJson('league.json', LEAGUE);
    console.log('تم استيراد بيانات الدوري الأولية.');
  } catch (e) { console.error('ما لقيت seed.json ولا data/league.json'); process.exit(1); }
}

/* ---------- المجموعات المشتركة (رسائل، أخبار، تسجيل، ألعاب) ---------- */
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const POS = ['حارس مرمى', 'مدافع', 'ظهير أيمن', 'ظهير أيسر', 'وسط', 'جناح', 'مهاجم'];
const clubIds = () => new Set(((LEAGUE && LEAGUE.clubs) || []).map((c) => c.id));
const COLS = {
  // كل مجموعة: حد الحفظ، من يكتب، والتحقق من الحقول
  messages: {keep: 500, admin: false, gap: 5000, clean: (o, ctx) => { const h = str(o.h, 33), m = str(o.m, 200); return h && m ? {h, m, t: ctx.now} : null; }},
  news: {keep: 100, admin: true, clean: (o, ctx) => { const title = str(o.title, 120); return title ? {title, body: str(o.body, 1000), t: ctx.now} : null; }},
  picks: {keep: 20000, admin: false, keyed: true, gap: 1000, clean: (o, ctx) => { const id = str(o.id, 60), h = str(o.h, 33); return id && h && ['h', 'd', 'a'].includes(o.v) ? {id, h, v: o.v, t: ctx.now} : null; }},
  gamepts: {keep: 20000, admin: false, gap: 12000, clean: (o, ctx) => { const club = str(o.club, 40), pts = Math.floor(Number(o.pts)); return clubIds().has(club) && pts >= 0 && pts <= 60 ? {club, pts, h: str(o.h, 33), t: ctx.now} : null; }},
  players: {keep: 3000, admin: false, keyed: true, once: true, gap: 3000, clean: (o, ctx) => { const club = str(o.club, 40), name = str(o.name, 30), pos = str(o.pos, 20); return clubIds().has(club) && name && POS.includes(pos) ? {club, name, pos, h: str(o.h, 33), t: ctx.now} : null; }},
};
const STORE = {};
for (const n of Object.keys(COLS)) STORE[n] = readJson('c_' + n + '.json', COLS[n].keyed ? {} : []);
const save = (n) => writeJson('c_' + n + '.json', STORE[n]);
const listOf = (n) => (COLS[n].keyed ? Object.values(STORE[n]) : STORE[n]);

function listing(n, limit) {
  const all = listOf(n);
  if (n === 'gamepts') { // نجمّع النقاط لكل نادي (ترتيب اللعبة)
    const tot = {}; let last = 0;
    for (const g of all) { tot[g.club] = (tot[g.club] || 0) + g.pts; last = Math.max(last, g.t); }
    return Object.entries(tot).map(([club, pts]) => ({club, pts, t: last}));
  }
  return all.slice().sort((a, b) => b.t - a.t).slice(0, limit);
}

/* ---------- جلسة الإدارة ---------- */
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
function makeSid() { const exp = String(Date.now() + 7 * 864e5); return exp + '.' + sign(exp); }
function isAdmin(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return false;
  const [exp, sig] = m[1].split('.'); if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const hits = new Map(); // معدّل بسيط لكل IP
function limited(key, gapMs) { const now = Date.now(), last = hits.get(key) || 0; if (now - last < gapMs) return true; hits.set(key, now); return false; }
setInterval(() => { const cut = Date.now() - 3600e3; for (const [k, t] of hits) if (t < cut) hits.delete(k); }, 600e3).unref();
const fails = new Map();
const ipOf = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

/* ---------- HTTP ---------- */
const MIME = {'.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif', '.svg':'image/svg+xml', '.ico':'image/x-icon'};
const HEAD = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function send(res, code, body, extra) {
  const h = Object.assign({}, HEAD, extra || {});
  if (typeof body !== 'string' && !Buffer.isBuffer(body)) { body = JSON.stringify(body); h['content-type'] = 'application/json; charset=utf-8'; }
  res.writeHead(code, h); res.end(body);
}
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', (c) => { n += c.length; if (n > max) { reject(Object.assign(new Error('big'), {code: 413})); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { reject(Object.assign(new Error('json'), {code: 400})); } });
    req.on('error', reject);
  });
}
function serveFile(res, p, cache) {
  fs.readFile(p, (err, buf) => {
    if (err) return send(res, 404, 'Not found', {'content-type': 'text/plain'});
    send(res, 200, buf, {'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': cache});
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), p = url.pathname, ip = ipOf(req);
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';

    if (p === '/api/me') return send(res, 200, {admin: isAdmin(req)}, {'cache-control': 'no-store'});

    if (p === '/api/login' && req.method === 'POST') {
      const f = fails.get(ip) || {n: 0, t: Date.now()};
      if (Date.now() - f.t > 600e3) { f.n = 0; f.t = Date.now(); }
      if (f.n >= 5) return send(res, 429, {error: 'many'});
      const body = await readBody(req, 4096), a = Buffer.from(String(body.password || '')), b = Buffer.from(ADMIN_PASSWORD);
      const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!ok) { f.n++; fails.set(ip, f); return send(res, 401, {error: 'bad'}); }
      fails.delete(ip);
      return send(res, 200, {ok: true}, {'set-cookie': `sid=${makeSid()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}${secure ? '; Secure' : ''}`});
    }

    if (p === '/api/data') {
      if (req.method === 'GET') return send(res, 200, LEAGUE, {'cache-control': 'no-store'});
      if (req.method === 'PUT') {
        if (!isAdmin(req)) return send(res, 401, {error: 'auth'});
        if (!/application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, {error: 'type'});
        const body = await readBody(req, 60 * 1024 * 1024);
        if (!body || !Array.isArray(body.clubs) || !Array.isArray(body.matches) || body.clubs.length > 16) return send(res, 400, {error: 'shape'});
        LEAGUE = extractImages(body); writeJson('league.json', LEAGUE);
        return send(res, 200, LEAGUE);
      }
    }

    const mc = /^\/api\/c\/([a-z]+)(?:\/([^/]+))?$/.exec(p);
    if (mc && COLS[mc[1]]) {
      const n = mc[1], col = COLS[n];
      if (req.method === 'GET' && !mc[2]) {
        const lim = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 100));
        return send(res, 200, listing(n, lim), {'cache-control': 'no-store'});
      }
      const isAdd = req.method === 'POST' && !mc[2] && !col.keyed, isSet = req.method === 'PUT' && mc[2] && col.keyed;
      if (isAdd || isSet) {
        if (col.admin && !isAdmin(req)) return send(res, 401, {error: 'auth'});
        if (!col.admin && limited(n + '|' + ip, col.gap)) return send(res, 429, {error: 'slow'});
        const o = col.clean(await readBody(req, 8192), {now: Date.now()});
        if (!o) return send(res, 400, {error: 'invalid'});
        if (isAdd) { STORE[n].push(o); if (STORE[n].length > col.keep) STORE[n].splice(0, STORE[n].length - col.keep); }
        else {
          const id = decodeURIComponent(mc[2]).slice(0, 120);
          if (col.once && STORE[n][id]) return send(res, 409, {error: 'exists'});
          if (Object.keys(STORE[n]).length >= col.keep && !STORE[n][id]) return send(res, 507, {error: 'full'});
          STORE[n][id] = o;
        }
        save(n); return send(res, 200, {ok: true});
      }
      return send(res, 405, {error: 'method'});
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', {'content-type': 'text/plain'});
    if (p.startsWith('/uploads/')) {
      const name = path.basename(p); // يمنع الخروج من المجلد
      return serveFile(res, path.join(UPLOADS, name), 'public, max-age=31536000, immutable');
    }
    if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'no-cache');
    return send(res, 404, 'Not found', {'content-type': 'text/plain'});
  } catch (e) {
    send(res, e.code === 413 ? 413 : e.code === 400 ? 400 : 500, {error: 'fail'});
  }
});
server.listen(PORT, () => console.log(`موقع دوري درب شغال على http://localhost:${PORT}`));
