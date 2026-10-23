export const isEquipmentMutation = (path, method) =>
  /^\/api\/erp\/client-equipment(?:\/|$)/i.test(path) && ["PATCH","PUT","DELETE"].includes(method);
export const isPosventaEquipmentPath = path => /^\/api\/generators\/posventa\/equipment(?:\/|$)/i.test(path);
const fields = ["installedAt","commissionedAt","warrantyMonths","invoiceNumber"];
export function validateEquipmentEdit(body, legacy = false) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).length) return {error:"Envía los datos del equipo que deseas modificar."};
  if (Object.keys(body).some(key => ["id","__proto__","constructor","prototype"].includes(key) || (!legacy && !fields.includes(key)))) return {error:"La solicitud contiene campos que no se pueden editar."};
  const patch = legacy ? {...body} : {};
  for (const field of fields) {
    if (!Object.hasOwn(body,field)) continue;
    const value = body[field];
    if (value === null || value === "") { patch[field] = null; continue; }
    if (field === "warrantyMonths") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < (legacy ? 0 : 1) || value > 120) return {error:"El plazo debe ser un número entero de 1 a 120 meses."};
    } else if (typeof value !== "string") return {error:"Las fechas y la factura deben ser texto."};
    if (field === "invoiceNumber") {
      if (value.trim().length > 120) return {error:"La factura admite hasta 120 caracteres."};
      patch[field] = value.trim() || null;
    } else if (field === "warrantyMonths") patch[field] = value;
    else {
      const date = legacy ? value.slice(0,10) : value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
        new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date ||
        (value.length > 10 && !Number.isFinite(Date.parse(value)))) return {error:"La fecha de instalación o puesta en marcha no es válida."};
      patch[field] = value;
    }
  }
  return {patch};
}
