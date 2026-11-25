import {AsyncLocalStorage} from "node:async_hooks";
import {isEquipmentDocumentResource} from "./equipment-reference-access.js";
import {LEAD_LOCK} from "./flash-quote-workflow.js";
export const collectionContext = new AsyncLocalStorage();
export const CLIENT_LOCK = 176202210;
export const isPricelistClientMutation = (path, method) =>
  (method === "DELETE" && /^\/api\/pricelists\/[^/]+\/?$/i.test(path)) ||
  (method === "POST" && /^\/api\/pricelists\/[^/]+\/assign-clients\/?$/i.test(path));
const leadWriter=(path,method)=>(/^\/api\/erp\/leads(?:\/|$)/i.test(path)&&["POST","PATCH","PUT","DELETE"].includes(method))||
  /^\/api\/erp\/sale-orders\/from-lead(?:\/|$)/i.test(path)&&["GET","POST"].includes(method);
export const requiresCollectionTransaction = (path, method) => leadWriter(path,method)||["POST","PATCH","PUT","DELETE"].includes(method) &&
  (/^\/api\/admin\/finanzas\/payment-promises(?:\/|$)/i.test(path)||/^\/api\/generators\/administracion\/cuentas-por-cobrar\/\d+\/plan\/?$/i.test(path)||isEquipmentDocumentResource(path) || /^\/api\/(?:technical-providers|technical-certifications|erp\/(?:infra-maintenance-orders|infra-maintenance-plans|maintenance-orders|maintenance-plans|service-orders|rental-maintenance|visits|service-contracts|rental-contracts|operating-expenses|clients|client-equipment))(?:\/|$)/i.test(path) ||
   /^\/api\/generators\/posventa\/equipment(?:\/|$)/i.test(path) ||
   /^\/api\/pricelists(?:\/|$)/i.test(path) ||
   /^\/api\/sync\/(?:migrate|seed)$/i.test(path));

export async function runCollectionTransaction(pool, req, res, fn, lockProducts=false) {
  const db = await pool.connect();
  const originalJson = res.json;
  let response, hasResponse = false;
  // These routes return JSON only. Do not acknowledge before the commit is durable.
  res.json = function(body) {response = body; hasResponse = true; return this;};
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(41577113)");
    if(!leadWriter(req.path,req.method))await db.query("SELECT pg_advisory_xact_lock($1)", [CLIENT_LOCK]);
    if(lockProducts){
      await db.query("INSERT INTO kv(key,value,updated_at) VALUES($1,'[]'::jsonb,$2) ON CONFLICT(key) DO NOTHING",["erpProducts",Date.now()]);
      await db.query("SELECT key FROM kv WHERE key=$1 FOR UPDATE",["erpProducts"]);
    }
    if(leadWriter(req.path,req.method)||/^\/api\/sync\/(?:seed|migrate)\/?$/i.test(req.path))await db.query("SELECT pg_advisory_xact_lock($1)",[LEAD_LOCK]);
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
