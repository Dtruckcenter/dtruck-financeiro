// API da Dtruck Financeiro — Cloudflare Workers + D1.
// Login próprio com e-mail e senha (senhas com PBKDF2-SHA256, sessão em cookie HttpOnly).
//
// Variáveis de ambiente (Worker > Settings > Variables and Secrets):
//   ADMIN_EMAILS   e-mail(s) autorizados a criar o PRIMEIRO administrador (só vale enquanto não há usuários)
//   DFE_TOKEN      token do robô que consulta a Receita (GitHub Actions); sem ele as rotas /api/robo ficam desligadas
// Binding D1: DB

const COLLECTIONS = new Set(['clientes', 'pecas', 'lancamentos', 'notas', 'config', 'dfe', 'dfefila', 'sys', 'os', 'laudos', 'laudofotos', 'categorias']);
const FORA_DO_SYNC = new Set(['dfexml', 'laudofotos']);   // grandes: baixados só quando abertos
const ADMIN_ONLY = new Set(['config']);
const ROBOT_ONLY = new Set(['dfe', 'sys']);          // só o robô da Receita grava aqui
const CHAVE_RE = /^\d{44}$/;
const ROLES = new Set(['admin', 'usuario', 'operador', 'leitura']);
// Módulos do sistema e o que cada nível libera. Nível: '' (sem acesso), 'ver' ou 'editar'.
const MODULOS = ['painel', 'pagar', 'receber', 'os', 'lancamentos', 'notas', 'fluxo', 'dre', 'clientes', 'pecas', 'entrada', 'laudos'];
const SO_VER = new Set(['painel', 'fluxo', 'dre']);
function permsDe(u) {
  if (u.role === 'admin') return Object.fromEntries(MODULOS.map(m => [m, SO_VER.has(m) ? 'ver' : 'editar']));
  let p = null; try { p = u.perms ? JSON.parse(u.perms) : null; } catch { p = null; }
  if (!p) {           // perfis antigos
    const lvl = u.role === 'leitura' ? 'ver' : 'editar';
    p = Object.fromEntries(MODULOS.map(m => [m, SO_VER.has(m) ? 'ver' : lvl]));
  }
  return Object.fromEntries(MODULOS.map(m => [m, ['ver', 'editar'].includes(p[m]) ? (SO_VER.has(m) ? 'ver' : p[m]) : '']));
}
function limparPerms(p) {
  if (!p || typeof p !== 'object') return null;
  return Object.fromEntries(MODULOS.map(m => [m, ['ver', 'editar'].includes(p[m]) ? (SO_VER.has(m) ? 'ver' : p[m]) : '']));
}
const pode = (me, ...mods) => mods.some(m => me.perms[m]);
const editaAlgum = (me, ...mods) => mods.some(m => me.perms[m] === 'editar');
// Coleções que cada pessoa recebe na sincronização, conforme os módulos liberados
function colecoesVisiveis(me) {
  const c = new Set(['config', 'categorias']);
  if (pode(me, 'painel', 'pagar', 'receber', 'lancamentos', 'fluxo', 'dre') || editaAlgum(me, 'notas')) c.add('lancamentos');
  if (pode(me, 'painel', 'receber', 'lancamentos', 'notas', 'clientes', 'entrada', 'os', 'laudos')) c.add('clientes');
  if (pode(me, 'painel', 'pecas', 'notas', 'entrada', 'lancamentos', 'os')) c.add('pecas');
  if (pode(me, 'os')) c.add('os');
  if (pode(me, 'laudos')) c.add('laudos');
  if (pode(me, 'notas', 'entrada')) c.add('notas');
  if (pode(me, 'entrada')) { c.add('dfe'); c.add('dfefila'); c.add('sys'); }
  return c;
}
// Quem pode gravar em cada coleção (para lançamentos, depende de ser entrada ou saída)
function podeGravar(me, col, dados) {
  if (me.role === 'admin') return true;
  switch (col) {
    case 'clientes': return editaAlgum(me, 'clientes', 'notas', 'entrada', 'os', 'laudos');
    case 'pecas': return editaAlgum(me, 'pecas', 'notas', 'entrada', 'lancamentos', 'os');
    case 'os': return editaAlgum(me, 'os');
    case 'categorias': return editaAlgum(me, 'lancamentos', 'pagar', 'receber');
    case 'laudos': case 'laudofotos': return editaAlgum(me, 'laudos');
    case 'notas': return editaAlgum(me, 'notas', 'entrada');
    case 'dfefila': return editaAlgum(me, 'entrada');
    case 'lancamentos':
      if (editaAlgum(me, 'lancamentos', 'notas')) return true;
      // a OS fatura gerando contas a receber ligadas a ela
      if (editaAlgum(me, 'os') && dados.every(d => !d || (d.osId && d.tipo === 'entrada'))) return true;
      return dados.every(d => !d || (d.tipo === 'saida' ? me.perms.pagar === 'editar' : d.tipo === 'entrada' ? me.perms.receber === 'editar' : false));
    default: return false;
  }
}
const ID_RE = /^[A-Za-z0-9_-]{1,190}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const MAX_BODY = 256 * 1024;
const PBKDF2_ITER = 100000;               // máximo aceito pelo WebCrypto do Workers
const SESSION_DAYS = 30;
const MIN_PASS = 8;
const LOCK_WINDOW_MS = 15 * 60 * 1000;    // janela do limite de tentativas
const MAX_FAIL_EMAIL = 5;                 // erros por e-mail na janela
const MAX_FAIL_IP = 20;                   // erros por IP na janela
const COOKIE = 'dt_session';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS docs (
     col TEXT NOT NULL, id TEXT NOT NULL, data TEXT, deleted INTEGER NOT NULL DEFAULT 0,
     seq INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT,
     PRIMARY KEY (col, id))`,
  `CREATE INDEX IF NOT EXISTS docs_seq ON docs(seq)`,
  `CREATE TABLE IF NOT EXISTS audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, email TEXT, action TEXT NOT NULL,
     col TEXT NOT NULL, doc_id TEXT NOT NULL, data TEXT)`,
  `CREATE TABLE IF NOT EXISTS users (
     email TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL,
     pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, iterations INTEGER NOT NULL,
     active INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_login INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL, ip TEXT, ua TEXT)`,
  `CREATE INDEX IF NOT EXISTS sessions_email ON sessions(email)`,
  `CREATE TABLE IF NOT EXISTS login_fail (
     k TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)`,
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map(s => db.prepare(s)));
  try { await db.prepare(`ALTER TABLE users ADD COLUMN perms TEXT`).run(); } catch { /* coluna já existe */ }
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS numeracao (
      tipo TEXT PRIMARY KEY, nome TEXT NOT NULL, prefixo TEXT NOT NULL DEFAULT '', com_ano INTEGER NOT NULL DEFAULT 0,
      digitos INTEGER NOT NULL DEFAULT 4, reinicia_ano INTEGER NOT NULL DEFAULT 0, proximo INTEGER NOT NULL DEFAULT 1,
      ano INTEGER NOT NULL DEFAULT 0, ultimo TEXT, ultimo_em INTEGER)`),
    // padrões: OS 2026-0001 (recomeça a cada ano); laudo 006 (continua do laudo 005 feito antes do sistema)
    db.prepare(`INSERT OR IGNORE INTO numeracao (tipo, nome, prefixo, com_ano, digitos, reinicia_ano, proximo, ano) VALUES ('os', 'Ordem de serviço', '', 1, 4, 1, 1, 0)`),
    db.prepare(`INSERT OR IGNORE INTO numeracao (tipo, nome, prefixo, com_ano, digitos, reinicia_ano, proximo, ano) VALUES ('laudo', 'Laudo técnico', '', 0, 3, 0, 6, 0)`),
  ]);
  schemaReady = true;
}

// ---------- Utilidades ----------
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = s => Uint8Array.from(s.match(/../g).map(h => parseInt(h, 16)));
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const normEmail = e => String(e || '').trim().toLowerCase();
const list = v => String(v || '').toLowerCase().split(/[,;\s]+/).filter(Boolean);

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hashPassword(password, saltHex, iterations = PBKDF2_ITER) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations }, key, 256);
  return hex(bits);
}
async function newPasswordFields(password) {
  const salt = randomHex(16);
  return { pass_salt: salt, pass_hash: await hashPassword(password, salt), iterations: PBKDF2_ITER };
}
function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < MIN_PASS) return `A senha precisa ter pelo menos ${MIN_PASS} caracteres.`;
  if (p.length > 200) return 'Senha longa demais.';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Use letras e números na senha.';
  return null;
}

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
});
const fail = (status, msg, extra) => json({ error: msg }, status, extra);
const noContent = (extra = {}) => new Response(null, { status: 204, headers: { 'cache-control': 'no-store', ...extra } });

function cookieHeader(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
function readCookie(request) {
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})'));
  return m ? m[1] : null;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return { tooBig: true };
  try { const b = JSON.parse(text); return b && typeof b === 'object' && !Array.isArray(b) ? { body: b } : { bad: true }; }
  catch { return { bad: true }; }
}

function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) deepMerge(a[k], v);
    else a[k] = v;
  }
  return a;
}

// ---------- Sessões e limite de tentativas ----------
async function currentUser(request, db) {
  const token = readCookie(request);
  if (!token) return null;
  const th = await sha256(token);
  const row = await db.prepare(
    `SELECT u.email, u.name, u.role, u.perms, u.must_change, s.expires_at FROM sessions s
     JOIN users u ON u.email = s.email WHERE s.token_hash = ?1 AND u.active = 1`
  ).bind(th).first();
  if (!row || row.expires_at < Date.now()) return null;
  // renova a sessão quando passou da metade do prazo
  if (row.expires_at - Date.now() < SESSION_DAYS * 864e5 / 2) {
    await db.prepare(`UPDATE sessions SET expires_at = ?1 WHERE token_hash = ?2`).bind(Date.now() + SESSION_DAYS * 864e5, th).run();
  }
  return { email: row.email, name: row.name, role: row.role, perms: permsDe(row), mustChange: !!row.must_change, tokenHash: th };
}

async function startSession(db, email, request) {
  const token = randomHex(32);
  const now = Date.now();
  await db.batch([
    db.prepare(`INSERT INTO sessions (token_hash, email, created_at, expires_at, ip, ua) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
      .bind(await sha256(token), email, now, now + SESSION_DAYS * 864e5, request.headers.get('cf-connecting-ip') || '', (request.headers.get('user-agent') || '').slice(0, 200)),
    db.prepare(`UPDATE users SET last_login = ?1 WHERE email = ?2`).bind(now, email),
    db.prepare(`DELETE FROM sessions WHERE expires_at < ?1`).bind(now),
  ]);
  return cookieHeader(token, SESSION_DAYS * 86400);
}

async function failCount(db, k) {
  const r = await db.prepare(`SELECT count, window_start FROM login_fail WHERE k = ?1`).bind(k).first();
  if (!r || Date.now() - r.window_start > LOCK_WINDOW_MS) return 0;
  return r.count;
}
async function addFail(db, k) {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO login_fail (k, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT (k) DO UPDATE SET
       count = CASE WHEN ?2 - window_start > ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN ?2 - window_start > ?3 THEN ?2 ELSE window_start END`
  ).bind(k, now, LOCK_WINDOW_MS).run();
}

async function audit(db, email, action, col, id, data) {
  await db.prepare(`INSERT INTO audit (at, email, action, col, doc_id, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(Date.now(), email, action, col, id, data == null ? null : JSON.stringify(data)).run();
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
      .bind(now, email, action, col, id, deleted || col === 'dfexml' ? null : JSON.stringify(data)),
  ]);
}

const userOut = u => ({ email: u.email, name: u.name, role: u.role === 'admin' ? 'admin' : 'usuario', perms: permsDe(u), active: !!u.active, mustChange: !!u.must_change, lastLogin: u.last_login || null, createdAt: u.created_at });

// ---------- Rotas ----------
export async function onRequest({ request, env, params }) {
  if (!env.DB) return fail(500, 'Banco D1 não configurado (binding DB).');
  const db = env.DB;
  await ensureSchema(db);
  const parts = [].concat(params.path || []);
  const method = request.method;
  const route = parts.join('/');

  if (parts[0] === 'robo') return robo(request, env, db, parts, method);

  // Proteção contra requisições de outros sites: toda escrita precisa deste cabeçalho.
  if (method !== 'GET' && request.headers.get('x-dtruck') !== '1') return fail(403, 'Requisição recusada');

  // ----- Rotas públicas -----
  if (route === 'setup' && method === 'GET') {
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM users`).first();
    return json({ needsSetup: !n.n });
  }

  if (route === 'setup' && method === 'POST') {
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM users`).first();
    if (n.n) return fail(409, 'O sistema já tem usuários. Entre com seu e-mail e senha.');
    const r = await readJson(request); if (!r.body) return fail(400, 'Dados inválidos');
    const email = normEmail(r.body.email), name = String(r.body.name || '').trim().slice(0, 80);
    if (!list(env.ADMIN_EMAILS).includes(email)) return fail(403, 'Este e-mail não está autorizado a criar o primeiro administrador.');
    const prob = passwordProblem(r.body.password); if (prob) return fail(400, prob);
    const now = Date.now(), pf = await newPasswordFields(r.body.password);
    await db.prepare(`INSERT INTO users (email, name, role, pass_hash, pass_salt, iterations, active, must_change, created_at, updated_at)
      VALUES (?1, ?2, 'admin', ?3, ?4, ?5, 1, 0, ?6, ?6)`).bind(email, name, pf.pass_hash, pf.pass_salt, pf.iterations, now).run();
    await audit(db, email, 'setup', 'users', email, { role: 'admin' });
    return noContent({ 'set-cookie': await startSession(db, email, request) });
  }

  if (route === 'login' && method === 'POST') {
    const r = await readJson(request); if (!r.body) return fail(400, 'Dados inválidos');
    const email = normEmail(r.body.email), password = String(r.body.password || '');
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    const kE = 'e:' + email, kI = 'i:' + ip;
    if (await failCount(db, kE) >= MAX_FAIL_EMAIL || await failCount(db, kI) >= MAX_FAIL_IP)
      return fail(429, 'Muitas tentativas erradas. Aguarde 15 minutos e tente de novo.');
    const u = await db.prepare(`SELECT * FROM users WHERE email = ?1`).bind(email).first();
    // calcula o hash mesmo se o usuário não existir, para não revelar quais e-mails existem pelo tempo de resposta
    const h = await hashPassword(password, u ? u.pass_salt : '00'.repeat(16), u ? u.iterations : PBKDF2_ITER);
    if (!u || !u.active || !timingSafeEqual(h, u.pass_hash)) {
      await addFail(db, kE); await addFail(db, kI);
      return fail(401, 'E-mail ou senha incorretos.');
    }
    await db.prepare(`DELETE FROM login_fail WHERE k = ?1`).bind(kE).run();
    return json({ ok: true, mustChange: !!u.must_change }, 200, { 'set-cookie': await startSession(db, email, request) });
  }

  if (route === 'logout' && method === 'POST') {
    const token = readCookie(request);
    if (token) await db.prepare(`DELETE FROM sessions WHERE token_hash = ?1`).bind(await sha256(token)).run();
    return noContent({ 'set-cookie': cookieHeader('', 0) });
  }

  // ----- Daqui para baixo precisa estar logado -----
  const me = await currentUser(request, db);
  if (!me) return fail(401, 'Não autenticado');

  if (route === 'me' && method === 'GET') return json({ email: me.email, name: me.name, role: me.role === 'admin' ? 'admin' : 'usuario', perms: me.perms, mustChange: me.mustChange });

  // Token do robô, para o administrador copiar e colar no GitHub
  if (route === 'robo-token' && method === 'GET') {
    if (me.role !== 'admin' || me.mustChange) return fail(403, 'Só administradores');
    if (!env.DFE_TOKEN) return fail(404, 'Token do robô não configurado no servidor');
    return json({ token: env.DFE_TOKEN, accessId: env.CF_ACCESS_CLIENT_ID || '', accessSecret: env.CF_ACCESS_CLIENT_SECRET || '' });
  }

  if (route === 'password' && method === 'POST') {
    const r = await readJson(request); if (!r.body) return fail(400, 'Dados inválidos');
    const u = await db.prepare(`SELECT * FROM users WHERE email = ?1`).bind(me.email).first();
    const h = await hashPassword(String(r.body.current || ''), u.pass_salt, u.iterations);
    if (!timingSafeEqual(h, u.pass_hash)) return fail(400, 'A senha atual está incorreta.');
    const prob = passwordProblem(r.body.password); if (prob) return fail(400, prob);
    if (r.body.password === r.body.current) return fail(400, 'A nova senha precisa ser diferente da atual.');
    const pf = await newPasswordFields(r.body.password);
    await db.batch([
      db.prepare(`UPDATE users SET pass_hash = ?1, pass_salt = ?2, iterations = ?3, must_change = 0, updated_at = ?4 WHERE email = ?5`)
        .bind(pf.pass_hash, pf.pass_salt, pf.iterations, Date.now(), me.email),
      // encerra as outras sessões desta pessoa
      db.prepare(`DELETE FROM sessions WHERE email = ?1 AND token_hash <> ?2`).bind(me.email, me.tokenHash),
    ]);
    await audit(db, me.email, 'password', 'users', me.email, null);
    return noContent();
  }

  // Quem está com senha provisória só pode trocar a senha.
  if (me.mustChange) return fail(403, 'Defina uma nova senha para continuar.');

  if (route === 'sync' && method === 'GET') {
    const since = Math.max(0, parseInt(new URL(request.url).searchParams.get('since') || '0', 10) || 0);
    const LIMIT = 2000;
    const { results } = await db.prepare(
      `SELECT col, id, data, deleted, seq FROM docs WHERE seq > ?1 AND col NOT IN ('dfexml', 'laudofotos') ORDER BY seq LIMIT ?2`
    ).bind(since, LIMIT + 1).all();
    const more = results.length > LIMIT;
    const vis = colecoesVisiveis(me);
    // documentos de módulos não liberados são omitidos (o número de sequência continua avançando)
    const docs = (more ? results.slice(0, LIMIT) : results).map(d => vis.has(d.col) ? d : { col: '_', id: '_', data: null, deleted: 1, seq: d.seq });
    return json({ docs, more });
  }

  if (parts[0] === 'docs' && parts.length === 3) {
    const [, col, id] = parts;
    if (!COLLECTIONS.has(col) || !ID_RE.test(id)) return fail(400, 'Caminho inválido');
    if (ADMIN_ONLY.has(col) && me.role !== 'admin') return fail(403, 'Só administradores alteram configurações');
    if (ROBOT_ONLY.has(col)) return fail(403, 'Estes dados vêm da Receita e não podem ser alterados');
    const atualRow = await db.prepare(`SELECT data FROM docs WHERE col = ?1 AND id = ?2 AND deleted = 0`).bind(col, id).first();
    const atual = atualRow ? JSON.parse(atualRow.data) : null;
    if (method === 'PUT' || method === 'PATCH') {
      const r = await readJson(request);
      if (r.tooBig) return fail(413, 'Registro grande demais');
      if (!r.body || !r.body.data || typeof r.body.data !== 'object' || Array.isArray(r.body.data)) return fail(400, 'Corpo inválido');
      let data = r.body.data;
      if (method === 'PATCH') {
        if (!atual) return fail(404, 'Registro não encontrado');
        data = deepMerge(JSON.parse(atualRow.data), data);
      }
      if (!podeGravar(me, col, [atual, data])) return fail(403, 'Você não tem permissão para alterar isto. Peça ao administrador.');
      await writeDoc(db, col, id, data, false, me.email, method === 'PUT' ? 'set' : 'update');
      return noContent();
    }
    if (method === 'DELETE') {
      if (!podeGravar(me, col, [atual])) return fail(403, 'Você não tem permissão para excluir isto. Peça ao administrador.');
      await writeDoc(db, col, id, null, true, me.email, 'delete');
      return noContent();
    }
    return fail(405, 'Método não permitido');
  }

  // Leitura de um documento que fica fora da sincronização (fotos de laudo)
  if (parts[0] === 'doc' && parts.length === 3 && method === 'GET') {
    const [, col, id] = parts;
    if (col !== 'laudofotos' || !ID_RE.test(id)) return fail(400, 'Caminho inválido');
    if (!pode(me, 'laudos')) return fail(403, 'Sem permissão');
    const row = await db.prepare(`SELECT data FROM docs WHERE col = ?1 AND id = ?2 AND deleted = 0`).bind(col, id).first();
    if (!row) return fail(404, 'Não encontrado');
    return json(JSON.parse(row.data));
  }

  // XML completo de uma nota recebida pela Receita (fica fora da sincronização por ser grande)
  if (parts[0] === 'xml' && parts.length === 2 && method === 'GET') {
    if (!CHAVE_RE.test(parts[1])) return fail(400, 'Chave inválida');
    if (!pode(me, 'entrada', 'notas')) return fail(403, 'Sem permissão');
    const row = await db.prepare(`SELECT data FROM docs WHERE col = 'dfexml' AND id = ?1 AND deleted = 0`).bind(parts[1]).first();
    if (!row) return fail(404, 'XML ainda não disponível');
    return json({ xml: JSON.parse(row.data).xml });
  }

  // ----- Numeração de documentos (OS, laudos…) -----
  if (parts[0] === 'numeracao') {
    const ano = new Date(Date.now() - 3 * 3600e3).getUTCFullYear();   // horário de Brasília
    const formatar = (r, n, y) => [r.prefixo, r.com_ano ? String(y) : '', String(n).padStart(r.digitos, '0')].filter(Boolean).join('-');
    if (parts.length === 1 && method === 'GET') {
      const { results } = await db.prepare(`SELECT * FROM numeracao ORDER BY tipo`).all();
      return json({ ano, tipos: results.map(r => {
        const prox = r.reinicia_ano && r.ano && r.ano !== ano ? 1 : r.proximo;
        return { ...r, com_ano: !!r.com_ano, reinicia_ano: !!r.reinicia_ano, exemplo: formatar(r, prox, ano), proximoEfetivo: prox };
      }) });
    }
    const tipo = parts[1];
    const modulo = { os: 'os', laudo: 'laudos' }[tipo];
    if (!modulo) return fail(404, 'Tipo de documento desconhecido');
    // próximo número: atômico, sem repetir mesmo com duas pessoas salvando juntas
    if (parts.length === 3 && parts[2] === 'proximo' && method === 'POST') {
      if (!editaAlgum(me, modulo) && me.role !== 'admin') return fail(403, 'Sem permissão');
      const r = await db.prepare(
        `UPDATE numeracao SET proximo = CASE WHEN reinicia_ano = 1 AND ano <> 0 AND ano <> ?1 THEN 2 ELSE proximo + 1 END,
           ano = ?1, ultimo_em = ?2 WHERE tipo = ?3
         RETURNING proximo - 1 AS n, prefixo, com_ano, digitos`
      ).bind(ano, Date.now(), tipo).first();
      if (!r) return fail(404, 'Numeração não configurada');
      const numero = formatar(r, r.n, ano);
      await db.prepare(`UPDATE numeracao SET ultimo = ?1 WHERE tipo = ?2`).bind(numero, tipo).run();
      await audit(db, me.email, 'numero', 'numeracao', tipo, { numero });
      return json({ numero });
    }
    if (parts.length === 2 && method === 'PUT') {
      if (me.role !== 'admin') return fail(403, 'Só administradores alteram a numeração');
      const b = await readJson(request); if (!b.body) return fail(400, 'Dados inválidos');
      const x = b.body, prefixo = String(x.prefixo || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const digitos = Math.min(8, Math.max(1, parseInt(x.digitos, 10) || 4)), proximo = Math.max(1, parseInt(x.proximo, 10) || 1);
      await db.prepare(`UPDATE numeracao SET prefixo = ?1, com_ano = ?2, digitos = ?3, reinicia_ano = ?4, proximo = ?5, ano = ?6 WHERE tipo = ?7`)
        .bind(prefixo, x.com_ano ? 1 : 0, digitos, x.reinicia_ano ? 1 : 0, proximo, ano, tipo).run();
      await audit(db, me.email, 'config', 'numeracao', tipo, { prefixo, com_ano: !!x.com_ano, digitos, reinicia_ano: !!x.reinicia_ano, proximo });
      return noContent();
    }
    return fail(405, 'Método não permitido');
  }

  // ----- Usuários (só administradores) -----
  if (parts[0] === 'users') {
    if (me.role !== 'admin') return fail(403, 'Só administradores gerenciam usuários');
    const adminsAtivos = async () => (await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`).first()).n;

    if (parts.length === 1 && method === 'GET') {
      const { results } = await db.prepare(`SELECT * FROM users ORDER BY name, email`).all();
      return json({ users: results.map(userOut) });
    }
    if (parts.length === 1 && method === 'POST') {
      const r = await readJson(request); if (!r.body) return fail(400, 'Dados inválidos');
      const email = normEmail(r.body.email), name = String(r.body.name || '').trim().slice(0, 80), role = r.body.role === 'admin' ? 'admin' : 'usuario';
      const perms = role === 'admin' ? null : limparPerms(r.body.perms);
      if (!EMAIL_RE.test(email)) return fail(400, 'E-mail inválido.');
      if (role !== 'admin' && (!perms || !Object.values(perms).some(Boolean))) return fail(400, 'Marque pelo menos um módulo para este usuário.');
      const prob = passwordProblem(r.body.password); if (prob) return fail(400, prob);
      if (await db.prepare(`SELECT 1 FROM users WHERE email = ?1`).bind(email).first()) return fail(409, 'Já existe um usuário com este e-mail.');
      const now = Date.now(), pf = await newPasswordFields(r.body.password);
      await db.prepare(`INSERT INTO users (email, name, role, pass_hash, pass_salt, iterations, active, must_change, created_at, updated_at, perms)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1, ?7, ?7, ?8)`).bind(email, name, role, pf.pass_hash, pf.pass_salt, pf.iterations, now, perms ? JSON.stringify(perms) : null).run();
      await audit(db, me.email, 'create', 'users', email, { name, role, perms });
      return noContent();
    }
    if (parts.length === 2) {
      const email = normEmail(decodeURIComponent(parts[1]));
      const u = await db.prepare(`SELECT * FROM users WHERE email = ?1`).bind(email).first();
      if (!u) return fail(404, 'Usuário não encontrado');
      if (method === 'PATCH') {
        const r = await readJson(request); if (!r.body) return fail(400, 'Dados inválidos');
        const b = r.body, sets = [], vals = [], kill = [];
        if (b.name !== undefined) { sets.push('name = ?'); vals.push(String(b.name).trim().slice(0, 80)); }
        if (b.role !== undefined) {
          const role = b.role === 'admin' ? 'admin' : 'usuario';
          if (u.role === 'admin' && role !== 'admin' && u.active && await adminsAtivos() <= 1) return fail(400, 'Precisa existir pelo menos um administrador ativo.');
          if (email === me.email && role !== 'admin') return fail(400, 'Você não pode tirar o seu próprio acesso de administrador.');
          sets.push('role = ?'); vals.push(role);
          if (role !== 'admin') {
            const perms = limparPerms(b.perms);
            if (!perms || !Object.values(perms).some(Boolean)) return fail(400, 'Marque pelo menos um módulo para este usuário.');
            sets.push('perms = ?'); vals.push(JSON.stringify(perms));
          }
        }
        if (b.active !== undefined) {
          if (!b.active && email === me.email) return fail(400, 'Você não pode desativar o seu próprio acesso.');
          if (!b.active && u.role === 'admin' && u.active && await adminsAtivos() <= 1) return fail(400, 'Precisa existir pelo menos um administrador ativo.');
          sets.push('active = ?'); vals.push(b.active ? 1 : 0); if (!b.active) kill.push(email);
        }
        if (b.password !== undefined) {
          const prob = passwordProblem(b.password); if (prob) return fail(400, prob);
          const pf = await newPasswordFields(b.password);
          sets.push('pass_hash = ?', 'pass_salt = ?', 'iterations = ?', 'must_change = 1'); vals.push(pf.pass_hash, pf.pass_salt, pf.iterations);
          kill.push(email);
        }
        if (!sets.length) return fail(400, 'Nada para alterar.');
        sets.push('updated_at = ?'); vals.push(Date.now());
        const sql = `UPDATE users SET ${sets.map((s, i) => s.replace('?', '?' + (i + 1))).join(', ')} WHERE email = ?${sets.length + 1}`;
        const stmts = [db.prepare(sql).bind(...vals, email)];
        if (kill.length) stmts.push(db.prepare(`DELETE FROM sessions WHERE email = ?1`).bind(email));
        await db.batch(stmts);
        await audit(db, me.email, b.password !== undefined ? 'reset_password' : 'update', 'users', email, { name: b.name, role: b.role, perms: b.perms, active: b.active });
        return noContent();
      }
      if (method === 'DELETE') {
        if (email === me.email) return fail(400, 'Você não pode excluir o seu próprio usuário.');
        if (u.role === 'admin' && u.active && await adminsAtivos() <= 1) return fail(400, 'Precisa existir pelo menos um administrador ativo.');
        await db.batch([
          db.prepare(`DELETE FROM sessions WHERE email = ?1`).bind(email),
          db.prepare(`DELETE FROM users WHERE email = ?1`).bind(email),
        ]);
        await audit(db, me.email, 'delete', 'users', email, null);
        return noContent();
      }
    }
    return fail(405, 'Método não permitido');
  }

  return fail(404, 'Rota não encontrada');
}

// ---------- Contas a pagar automáticas a partir da NF-e do fornecedor ----------
const TPAG = { '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de crédito', '04': 'Cartão de débito', '15': 'Boleto', '16': 'Transferência', '17': 'PIX', '18': 'Transferência' };
const PAGO_NA_HORA = new Set(['01', '03', '04', '16', '17', '18']);
async function contasAPagar(db, chave, n, por) {
  if (n.finNFe && n.finNFe !== '1') return [];            // devolução, complementar, ajuste: sem conta a pagar
  if (n.operacaoFinanceira === false) return [];          // remessa, comodato, conserto...
  const data = String(n.dhEmi || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const nome = n.emitNome || n.emitCnpj || 'Fornecedor';
  const parcelas = (n.parcelas && n.parcelas.length) ? n.parcelas : [{ n: '', venc: data, valor: n.valor }];
  if (!parcelas.some(p => p.valor > 0)) return [];
  const semParcelas = !(n.parcelas && n.parcelas.length);
  const pago = semParcelas && PAGO_NA_HORA.has(n.tPag || '');
  const forma = TPAG[n.tPag] || (semParcelas ? 'Boleto' : 'Boleto');
  const ids = [];
  for (let i = 0; i < parcelas.length; i++) {
    const p = parcelas[i], id = `nfe${chave}p${i + 1}`;
    await writeDoc(db, 'lancamentos', id, {
      tipo: 'saida', descricao: `NF-e ${n.numero} · ${nome}${parcelas.length > 1 ? ` (${i + 1}/${parcelas.length})` : ''}`,
      data: p.venc || data, categoria: n.categoria || 'compra_pecas', valor: Math.round(p.valor * 100) / 100, forma,
      documento: `NF-e ${n.numero}${parcelas.length > 1 ? ' parc. ' + (p.n || i + 1) : ''}`,
      obs: 'Criada automaticamente pela nota do fornecedor baixada da Receita.',
      pago, dataPagamento: pago ? data : '', clienteId: '', fornecedor: nome, pecaId: '', qtd: 0,
      notaId: chave, auto: true, exemplo: false, criadoEm: Date.now(),
    }, false, por, 'set');
    ids.push(id);
  }
  return ids;
}

// ---------- Robô da Receita (Distribuição DF-e via GitHub Actions) ----------
async function robo(request, env, db, parts, method) {
  const auth = request.headers.get('authorization') || '';
  if (!env.DFE_TOKEN || env.DFE_TOKEN.length < 32 || !timingSafeEqual(auth, 'Bearer ' + env.DFE_TOKEN)) return fail(401, 'Não autorizado');
  const BOT = 'robo-receita';
  const getDoc = async (col, id) => {
    const r = await db.prepare(`SELECT data FROM docs WHERE col = ?1 AND id = ?2 AND deleted = 0`).bind(col, id).first();
    return r ? JSON.parse(r.data) : null;
  };

  // O que o robô precisa saber antes de consultar a Receita
  if (parts[1] === 'estado' && method === 'GET') {
    const st = (await getDoc('sys', 'dfe')) || {};
    const { results: dfe } = await db.prepare(`SELECT id, data FROM docs WHERE col = 'dfe' AND deleted = 0`).all();
    const docs = dfe.map(r => ({ id: r.id, ...JSON.parse(r.data) }));
    const agora = Date.now();
    const { results: fila } = await db.prepare(`SELECT id FROM docs WHERE col = 'dfefila' AND deleted = 0`).all();
    return json({
      ultNSU: st.ultNSU || '000000000000000',
      // resumos que ainda não receberam "Ciência da Operação"
      semCiencia: docs.filter(d => d.status === 'resumo' && !d.ciencia && !d.cienciaRecusada && d.situacao !== 'cancelada').map(d => d.id).slice(0, 40),
      // ciência enviada há mais de 2 h e o XML completo ainda não chegou pelo NSU: buscar pela chave
      semXml: docs.filter(d => d.status === 'resumo' && d.ciencia && agora - d.ciencia > 2 * 3600e3 && (!d.ultimaBusca || agora - d.ultimaBusca > 6 * 3600e3)).map(d => d.id).slice(0, 10),
      // chaves bipadas no sistema que a Receita ainda não entregou
      fila: fila.map(r => r.id).filter(id => !docs.some(d => d.id === id && d.status === 'completa')).slice(0, 10),
    });
  }

  // Resultado de uma rodada
  if (parts[1] === 'lote' && method === 'POST') {
    const text = await request.text();
    if (text.length > 20 * 1024 * 1024) return fail(413, 'Lote grande demais');
    let b; try { b = JSON.parse(text); } catch { return fail(400, 'Corpo inválido'); }
    const agora = Date.now();
    for (const d of b.docs || []) {
      if (!CHAVE_RE.test(d.chave || '')) continue;
      const atual = (await getDoc('dfe', d.chave)) || {};
      const novo = { ...atual, ...d.resumo, chave: d.chave, recebidoEm: atual.recebidoEm || agora };
      if (d.xml) {
        novo.status = 'completa';
        await writeDoc(db, 'dfexml', d.chave, { xml: d.xml }, false, BOT, 'set');
      } else if (!atual.status) novo.status = 'resumo';
      if (atual.situacao === 'cancelada' || (d.resumo && d.resumo.situacao === 'cancelada')) novo.situacao = 'cancelada';
      if (novo.situacao === 'cancelada' && atual.lancAuto && atual.lancAuto.length) {
        // nota cancelada pelo fornecedor: remove as contas a pagar automáticas que ainda não foram pagas
        for (const id of atual.lancAuto) {
          const l = await getDoc('lancamentos', id);
          if (l && !l.pago) await writeDoc(db, 'lancamentos', id, null, true, BOT, 'delete');
        }
        novo.lancAuto = [];
      }
      if (novo.status === 'completa' && novo.situacao !== 'cancelada' && !(atual.lancAuto && atual.lancAuto.length) && !(await getDoc('notas', d.chave)))
        novo.lancAuto = await contasAPagar(db, d.chave, novo, BOT);
      await writeDoc(db, 'dfe', d.chave, novo, false, BOT, 'set');
      if (novo.status === 'completa') await writeDoc(db, 'dfefila', d.chave, null, true, BOT, 'delete');
    }
    for (const ch of b.ciencia || []) {
      const atual = await getDoc('dfe', ch); if (!atual) continue;
      await writeDoc(db, 'dfe', ch, { ...atual, ciencia: agora }, false, BOT, 'update');
    }
    for (const c of b.cienciaRecusada || []) {
      const atual = await getDoc('dfe', c.chave); if (!atual) continue;
      await writeDoc(db, 'dfe', c.chave, { ...atual, cienciaRecusada: String(c.msg || '').slice(0, 200) }, false, BOT, 'update');
    }
    for (const ch of b.buscadas || []) {
      const atual = await getDoc('dfe', ch);
      if (atual) await writeDoc(db, 'dfe', ch, { ...atual, ultimaBusca: agora }, false, BOT, 'update');
    }
    for (const f of b.filaRespostas || []) {
      const atual = await getDoc('dfefila', f.chave); if (!atual) continue;
      await writeDoc(db, 'dfefila', f.chave, { ...atual, ultimaBusca: agora, resposta: String(f.msg || '').slice(0, 300) }, false, BOT, 'update');
    }
    if (!b.final && b.ok !== false) return noContent();
    const st = (await getDoc('sys', 'dfe')) || {};
    await writeDoc(db, 'sys', 'dfe', {
      ...st,
      ultNSU: /^\d{15}$/.test(b.ultNSU || '') ? b.ultNSU : (st.ultNSU || '000000000000000'),
      ultimaConsulta: agora,
      ultimoStatus: String(b.status || '').slice(0, 300),
      ok: !!b.ok,
    }, false, BOT, 'set');
    return noContent();
  }
  return fail(404, 'Rota não encontrada');
}
