// Cliente de dados da Dtruck Financeiro.
// Imita a interface de documentos/coleções usada pela página e sincroniza com /api (Cloudflare D1).
(function () {
  const POLL_MS = 15000;
  const cache = new Map();        // "col/id" -> objeto
  const listeners = new Set();    // funções chamadas quando algo muda
  let seq = 0, me = null, timer = null, syncing = null;

  const notify = () => listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } });
  const clone = o => JSON.parse(JSON.stringify(o));
  const err = (code, message) => Object.assign(new Error(message || code), { code });

  async function call(method, url, body) {
    let r;
    try {
      r = await fetch(url, {
        method, credentials: 'same-origin',
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) { throw err('unavailable', 'Sem conexão com o servidor'); }
    if (r.status === 401) throw err('unauthenticated', 'Sessão expirada. Recarregue a página para entrar de novo.');
    if (r.status === 403) throw err('invalid_argument', 'Sem permissão');
    if (r.status === 404) throw err('not_found', 'Registro não encontrado');
    if (r.status === 413) throw err('quota_exceeded', 'Registro grande demais');
    if (!r.ok) throw err('unavailable', 'Erro no servidor (' + r.status + ')');
    return r.status === 204 ? null : r.json();
  }

  async function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      let more = true, changed = false;
      while (more) {
        const j = await call('GET', '/api/sync?since=' + seq);
        for (const d of j.docs) {
          const k = d.col + '/' + d.id;
          if (d.deleted) cache.delete(k); else cache.set(k, JSON.parse(d.data));
          if (d.seq > seq) seq = d.seq;
          changed = true;
        }
        more = j.more;
      }
      if (changed) notify();
    })().finally(() => { syncing = null; });
    return syncing;
  }

  const snap = (k) => ({
    id: k.split('/').pop(),
    exists: cache.has(k),
    data: () => (cache.has(k) ? clone(cache.get(k)) : undefined),
    metadata: { fromCache: false, hasPendingWrites: false },
  });

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  function docRef(col, id) {
    const k = col + '/' + id, url = '/api/docs/' + encodeURIComponent(col) + '/' + encodeURIComponent(id);
    return {
      id, path: k,
      async get() { return snap(k); },
      async set(data) {
        const prev = cache.get(k);
        cache.set(k, clone(data)); notify();
        try { await call('PUT', url, { data }); }
        catch (e) { if (prev === undefined) cache.delete(k); else cache.set(k, prev); notify(); throw e; }
      },
      async update(data) {
        if (!cache.has(k)) throw err('invalid_argument', 'Registro não existe');
        const prev = cache.get(k);
        cache.set(k, Object.assign(clone(prev), clone(data))); notify();
        try { await call('PATCH', url, { data }); }
        catch (e) { cache.set(k, prev); notify(); throw e; }
      },
      async delete() {
        const prev = cache.get(k);
        cache.delete(k); notify();
        try { await call('DELETE', url); }
        catch (e) { if (prev !== undefined) cache.set(k, prev); notify(); throw e; }
      },
      onSnapshot(next) { const f = () => next(snap(k)); listeners.add(f); setTimeout(f, 0); return () => listeners.delete(f); },
    };
  }

  function collectionRef(col) {
    const docs = () => [...cache.keys()].filter(k => k.startsWith(col + '/')).map(snap);
    return {
      path: col,
      doc: id => docRef(col, id || newId()),
      async add(data) { const r = docRef(col, newId()); await r.set(data); return r; },
      async get() { const d = docs(); return { docs: d, size: d.length, empty: !d.length }; },
      onSnapshot(next) {
        const f = () => { const d = docs(); next({ docs: d, size: d.length, empty: !d.length, metadata: { fromCache: false } }); };
        listeners.add(f); setTimeout(f, 0); return () => listeners.delete(f);
      },
    };
  }

  const db = {
    doc(path) { const p = path.split('/'); return docRef(p[0], p[1]); },
    collection(path) { return collectionRef(path); },
  };

  window.DtruckAPI = {
    // Faz o login (via Cloudflare Access), carrega todos os dados e começa a sincronizar.
    async init() {
      me = await call('GET', '/api/me');
      await sync();
      timer = setInterval(() => { if (!document.hidden) sync().catch(e => console.warn(e)); }, POLL_MS);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) sync().catch(() => {}); });
      return db;
    },
    me: () => me,
    sync,
  };
})();
