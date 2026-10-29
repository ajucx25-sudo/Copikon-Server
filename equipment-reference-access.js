export const EQUIPMENT_DOCUMENT_KEYS = new Set([
  "erpMaintenanceOrders","erpMaintenancePlans","erpMaintenanceContracts","erpServiceContracts","erpSalesInvoices",
]);
export const isEquipmentResource = path => /^\/api\/erp\/client-equipment(?:\/|$)/i.test(path);
export const isEquipmentDocumentResource = path =>
  /^\/api\/erp\/(?:maintenance-orders|maintenance-plans|maintenance-contracts|service-contracts|sales-invoices)(?:\/|$)/i.test(path);
const id = value => (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) &&
  Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const fail = message => {throw Object.assign(new Error(message),{status:409});};

// Only sold-equipment references belong to this register. Explicit rental and
// external-equipment references retain their separate existing domains.
export function soldEquipmentReferences(document) {
  const refs = [];
  let visited = 0;
  const walk = (node, inheritedKind, depth) => {
    if (node == null || typeof node !== "object") return;
    if (++visited > 50000 || depth > 32) fail("Documento demasiado complejo para validar sus equipos.");
    const kind = node.kind ?? node.source ?? inheritedKind;
    for (const [key,value] of Object.entries(node)) {
      if (/^(?:clientEquipment|equipment)Ids?$/.test(key)) {
        if (value == null) continue;
        const explicitSold = key.startsWith("clientEquipment");
        if (explicitSold && ["externo","alquiler"].includes(kind)) fail("La referencia de equipo vendido tiene un tipo incompatible.");
        if (!explicitSold && ["externo","alquiler"].includes(kind)) continue;
        if (kind != null && !["venta","odoo-baifa-sales"].includes(kind)) fail("Tipo de referencia de equipo no reconocido.");
        const values = key.endsWith("Ids") ? value : [value];
        if (!Array.isArray(values)) fail("La lista de equipos debe ser un arreglo de identificadores.");
        for (const value of values) {
          if (!id(value)) fail("Referencia de equipo inválida.");
          refs.push({id:id(value),nestedClientId:node.clientId});
        }
      } else if (key === "equipments" && value != null && !Array.isArray(value)) {
        fail("La lista de equipos del contrato debe ser un arreglo.");
      } else if (value && typeof value === "object") walk(value,kind,depth+1);
    }
  };
  walk(document,undefined,0);
  return refs;
}

export function validateEquipmentDocuments(rows, previous, equipment) {
  const oldById = new Map(previous.map(row=>[String(row.id),row]));
  const equipmentById = new Map(equipment.map(row=>[id(row.id),row]));
  for (const row of rows) {
    const old = oldById.get(String(row.id));
    // Unchanged historical documents stay intact, including legacy orphan refs.
    if (old && JSON.stringify(old) === JSON.stringify(row)) continue;
    const refs = soldEquipmentReferences(row);
    if (!refs.length) continue;
    const clientId = id(row.clientId);
    if (!clientId) fail("Selecciona el cliente vinculado al equipo vendido.");
    for (const ref of refs) {
      const found = equipmentById.get(ref.id);
      if (!found) fail("El equipo vendido no existe. Actualiza el listado antes de guardar.");
      if (["externo","alquiler"].includes(found.source)) fail("La referencia no corresponde a un equipo vendido.");
      if (id(found.clientId) !== clientId ||
          (ref.nestedClientId != null && id(ref.nestedClientId) !== clientId)) {
        fail("El equipo vendido pertenece a otro cliente.");
      }
    }
  }
}
