// API da Dtruck Financeiro — Cloudflare Pages Functions + D1.
// Todas as rotas exigem login pelo Cloudflare Access (o token JWT é verificado aqui).
//
// Variáveis de ambiente (Pages > Settings > Variables and Secrets):
//   ACCESS_TEAM_DOMAIN  ex.: dtruck.cloudflareaccess.com
//   ACCESS_AUD          "Application Audience (AUD) Tag" da aplicação no Access
//   ADMIN_EMAILS        e-mails separados por vírgula com perfil administrador
//   READONLY_EMAILS     e-mails separados por vírgula com perfil só leitura (opcional)
//   DEV_EMAIL           SÓ para teste local; nunca configure em produção
// Binding D1: DB

const COLLECTIONS = new Set(['clientes', 'pecas', 'lancamentos', 'notas', 'config']);
const ADMIN_ONLY = new Set(['config']);
const ID_RE = /^[A-Za-z0-9_-]{1,190}$/;
const MAX_BODY = 256 * 1024;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS docs (
     col TEXT NOT NULL, id TEXT NOT NULL, data TEXT, deleted INTEGER NOT NULL DEFAULT 0,
     seq INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT,
     PRIMARY KEY (col, id))`,
  `CREATE INDEX IF NOT EXISTS docs_seq ON docs(seq)`,
  `CREATE TABLE IF NOT EXISTS audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, email TEXT, action TEXT NOT NULL,
     col TEXT NOT NULL, doc_id TEXT NOT NULL, data TEXT)`,
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map(s => db.prepare(s)));
  schemaReady = true;
}

// ---------- Autenticação (Cloudflare Access) ----------
let certCache = { at: 0, keys: [] };
const b64urlBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function accessEmail(request, env) {
  if (env.DEV_EMAIL) return env.DEV_EMAIL;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  let header, payload;
  try { header = b64urlJson(h); payload = b64urlJson(p); } catch { return null; }
  const team = 'https://' + env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (Date.now() - certCache.at > 3600e3 || !certCache.keys.some(k => k.kid === header.kid)) {
    const r = await fetch(team + '/cdn-cgi/access/certs');
    if (!r.ok) return null;
    certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = certCache.keys.find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(h + '.' + p));
  if (!ok) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== team) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  return String(payload.email || '').toLowerCase() || null;
}

const list = v => String(v || '').toLowerCase().split(/[,;\s]+/).filter(Boolean);
function roleOf(email, env) {
  if (list(env.ADMIN_EMAILS).includes(email)) return 'admin';
  if (list(env.READONLY_EMAILS).includes(email)) return 'leitura';
  return 'operador';
}

// ---------- Utilidades ----------
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const fail = (status, msg) => json({ error: msg }, status);

function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) deepMerge(a[k], v);
    else a[k] = v;
  }
  return a;
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return { tooBig: true };
  try {
    const b = JSON.parse(text);
    if (!b || typeof b.data !== 'object' || Array.isArray(b.data) || b.data === null) return { bad: true };
    return { data: b.data };
  } catch { return { bad: true }; }
}

async function writeDoc(db, col, id, data, deleted, email, action) {
  const now = Date.now();
  await db.batch([
    db.prepare(
      `INSERT INTO docs (col, id, data, deleted, seq, updated_at, updated_by)
       VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(seq), 0) + 1 FROM docs), ?5, ?6)
       ON CONFLICT (col, id) DO UPDATE SET data = excluded.data, deleted = excluded.deleted,
         seq = excluded.seq, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).bind(col, id, deleted ? null : JSON.stringify(data), deleted ? 1 : 0, now, email),
    db.prepare(`INSERT INTO audit (at, email, action, col, doc_id, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
      .bind(now, email, action, col, id, deleted ? null : JSON.stringify(data)),
  ]);
}

// ---------- Rotas ----------
export async function onRequest({ request, env, params }) {
  if (!env.DB) return fail(500, 'Banco D1 não configurado (binding DB).');
  const email = await accessEmail(request, env);
  if (!email) return fail(401, 'Não autenticado');
  const role = roleOf(email, env);
  await ensureSchema(env.DB);

  const parts = [].concat(params.path || []);
  const method = request.method;

  if (parts[0] === 'me' && method === 'GET') return json({ email, role });

  if (parts[0] === 'sync' && method === 'GET') {
    const since = Math.max(0, parseInt(new URL(request.url).searchParams.get('since') || '0', 10) || 0);
    const LIMIT = 2000;
    const { results } = await env.DB.prepare(
      `SELECT col, id, data, deleted, seq FROM docs WHERE seq > ?1 ORDER BY seq LIMIT ?2`
    ).bind(since, LIMIT + 1).all();
    const more = results.length > LIMIT;
    return json({ docs: more ? results.slice(0, LIMIT) : results, more });
  }

  if (parts[0] === 'docs' && parts.length === 3) {
    const [, col, id] = parts;
    if (!COLLECTIONS.has(col) || !ID_RE.test(id)) return fail(400, 'Caminho inválido');
    if (role === 'leitura') return fail(403, 'Perfil só leitura');
    if (ADMIN_ONLY.has(col) && role !== 'admin') return fail(403, 'Só administradores alteram configurações');

    if (method === 'PUT') {
      const b = await readBody(request);
      if (b.tooBig) return fail(413, 'Registro grande demais');
      if (b.bad) return fail(400, 'Corpo inválido');
      await writeDoc(env.DB, col, id, b.data, false, email, 'set');
      return new Response(null, { status: 204 });
    }
    if (method === 'PATCH') {
      const b = await readBody(request);
      if (b.tooBig) return fail(413, 'Registro grande demais');
      if (b.bad) return fail(400, 'Corpo inválido');
      const row = await env.DB.prepare(`SELECT data FROM docs WHERE col = ?1 AND id = ?2 AND deleted = 0`).bind(col, id).first();
      if (!row) return fail(404, 'Registro não encontrado');
      await writeDoc(env.DB, col, id, deepMerge(JSON.parse(row.data), b.data), false, email, 'update');
      return new Response(null, { status: 204 });
    }
    if (method === 'DELETE') {
      await writeDoc(env.DB, col, id, null, true, email, 'delete');
      return new Response(null, { status: 204 });
    }
    return fail(405, 'Método não permitido');
  }

  return fail(404, 'Rota não encontrada');
}
