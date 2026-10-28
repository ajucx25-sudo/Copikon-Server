// Client reads and writes require verified internal access. Manual creation
// cannot forge Odoo provenance; POST never overwrites an existing ID.
export const isClientMutation = (path, method) =>
  /^\/api\/erp\/clients(?:\/|$)/i.test(path) && ["PATCH", "PUT", "DELETE"].includes(method);
export const isClientResource = path => /^\/api\/erp\/clients(?:\/|$)/i.test(path);

export function validateClientCreate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {error:"Datos de cliente inválidos."};
  const allowed = new Set(["id","name","rif","contact","contactName","phone","email","address","city","state","sector","status","notes","createdAt",
    "classification","region","chamber","assignedSellerId","leadSource","firstContactDate","lastVisitDate","totalPurchases","creditLimit","paymentTerms",
    "convertedFromLeadId","type","odooId","odooRef","syncStatus","lastSyncAt"]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) return {error:"El alta contiene campos reservados o no permitidos."};
  if (body.odooId || body.odooRef || body.lastSyncAt || (body.syncStatus && body.syncStatus !== "pending"))
    return {error:"La procedencia Odoo solo puede ser registrada por la sincronización del servidor."};
  const numeric = new Set(["id","assignedSellerId","convertedFromLeadId","odooId"]);
  for (const [key,value] of Object.entries(body)) {
    if (value == null) continue;
    if (numeric.has(key)) {
      if (!Number.isSafeInteger(value) || value < 0) return {error:"Identificador inválido."};
    } else if (typeof value !== "string" || value.length > (key === "notes" ? 5000 : 1000)) return {error:"Campo de cliente inválido."};
  }
  const checked = validateClientEdit(Object.fromEntries(Object.entries(body).filter(([key])=>Object.hasOwn(limits,key))));
  if (checked.error || typeof body.name !== "string" || !body.name.trim()) return {error:checked.error || "Nombre obligatorio."};
  return {patch:{...body,...checked.patch,syncStatus:"pending"}};
}

const limits = { name: 250, rif: 80, contact: 250, phone: 80, email: 254, address: 1000, city: 100, state: 100 };
export function validateClientEdit(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).length) {
    return { error: "Envía los datos del cliente que deseas modificar." };
  }
  const patch = {};
  for (const [field, raw] of Object.entries(body)) {
    if (!Object.hasOwn(limits, field)) return { error: "La solicitud contiene campos que no se pueden editar." };
    if (raw !== null && typeof raw !== "string") return { error: "Los datos del cliente deben ser texto." };
    const value = raw?.trim() || null;
    if (field === "name" && !value) return { error: "El nombre del cliente es obligatorio." };
    if (value && value.length > limits[field]) return { error: `El campo ${field} excede la longitud permitida.` };
    if (field === "email" && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return { error: "El correo electrónico no es válido." };
    }
    patch[field] = value;
  }
  return { patch };
}
