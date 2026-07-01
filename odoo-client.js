// odoo-client.js — Cliente JSON-RPC de Odoo para Copikon Intranet
// Reutilizable, con cache de UID por 30 min y timeout de request de 25s.

const ODOO_URL     = process.env.ODOO_URL     || 'https://www.copikon.com';
const ODOO_DB      = process.env.ODOO_DB      || '';
const ODOO_LOGIN   = process.env.ODOO_LOGIN   || '';
const ODOO_API_KEY = process.env.ODOO_API_KEY || '';

let cachedUid = null;
let cachedUidAt = 0;
const UID_TTL_MS = 30 * 60 * 1000; // 30 min

function isConfigured() {
  return !!(ODOO_URL && ODOO_DB && ODOO_LOGIN && ODOO_API_KEY);
}

async function rawCall(service, method, args, timeoutMs = 25000) {
  if (!isConfigured()) {
    throw new Error('Odoo no está configurado en el servidor. Faltan variables de entorno ODOO_URL / ODOO_DB / ODOO_LOGIN / ODOO_API_KEY.');
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ODOO_URL}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args } }),
      signal: ctrl.signal,
    });
    const data = await res.json();
    if (data.error) {
      const msg = data.error.data?.message || data.error.message || JSON.stringify(data.error).slice(0, 400);
      const err = new Error(`Odoo: ${msg}`);
      err.odooError = data.error;
      throw err;
    }
    return data.result;
  } finally {
    clearTimeout(t);
  }
}

async function getUid(force = false) {
  const now = Date.now();
  if (!force && cachedUid && (now - cachedUidAt) < UID_TTL_MS) return cachedUid;
  const uid = await rawCall('common', 'login', [ODOO_DB, ODOO_LOGIN, ODOO_API_KEY]);
  if (!uid) throw new Error('Odoo: login falló (uid vacío). Revisa DB/usuario/API key.');
  cachedUid = uid;
  cachedUidAt = now;
  return uid;
}

// Wrapper principal para ejecutar cualquier método del ORM Odoo
async function execute(model, method, positionalArgs = [], kwargs = {}) {
  const uid = await getUid();
  try {
    return await rawCall('object', 'execute_kw', [
      ODOO_DB, uid, ODOO_API_KEY, model, method, positionalArgs, kwargs
    ]);
  } catch (e) {
    // Si es error de sesión, reintenta una vez re-loginándose
    const msg = e.message || '';
    if (/session|expired|access denied|Access Denied|not authorized/i.test(msg)) {
      const uid2 = await getUid(true);
      return await rawCall('object', 'execute_kw', [
        ODOO_DB, uid2, ODOO_API_KEY, model, method, positionalArgs, kwargs
      ]);
    }
    throw e;
  }
}

// Helpers convenience
async function searchRead(model, domain = [], fields = [], opts = {}) {
  return execute(model, 'search_read', [domain, fields], opts);
}
async function readGroup(model, domain, fields, groupby, opts = {}) {
  return execute(model, 'read_group', [domain, fields, groupby], opts);
}
async function count(model, domain = []) {
  return execute(model, 'search_count', [domain]);
}

async function ping() {
  const uid = await getUid(true);
  const ver = await rawCall('common', 'version', []);
  return { ok: true, uid, url: ODOO_URL, db: ODOO_DB, version: ver.server_version, uidCachedFor: 0 };
}

export {
  isConfigured,
  ping,
  execute,
  searchRead,
  readGroup,
  count,
  getUid,
};
