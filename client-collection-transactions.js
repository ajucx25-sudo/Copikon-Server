import {AsyncLocalStorage} from "node:async_hooks";
export const collectionContext = new AsyncLocalStorage();
export const CLIENT_LOCK = 176202210;
export const isPricelistClientMutation = (path, method) =>
  (method === "DELETE" && /^\/api\/pricelists\/[^/]+\/?$/i.test(path)) ||
  (method === "POST" && /^\/api\/pricelists\/[^/]+\/assign-clients\/?$/i.test(path));
export const requiresCollectionTransaction = (path, method) => ["POST","PATCH","PUT","DELETE"].includes(method) &&
  (/^\/api\/erp\/(?:clients|client-equipment)(?:\/|$)/i.test(path) ||
   /^\/api\/generators\/posventa\/equipment(?:\/|$)/i.test(path) ||
   /^\/api\/pricelists(?:\/|$)/i.test(path) ||
   /^\/api\/sync\/(?:migrate|seed)$/i.test(path));

export async function runCollectionTransaction(pool, req, res, fn) {
  const db = await pool.connect();
  const originalJson = res.json;
  let response, hasResponse = false;
  // These routes return JSON only. Do not acknowledge before the commit is durable.
  res.json = function(body) {response = body; hasResponse = true; return this;};
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock($1)", [CLIENT_LOCK]);
    await collectionContext.run(db, () => fn(req, res));
    if (!hasResponse) throw Error("La operación no generó una respuesta.");
    await db.query(res.statusCode >= 400 ? "ROLLBACK" : "COMMIT");
    res.json = originalJson;
    return res.json(response);
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {res.json = originalJson; db.release();}
}
