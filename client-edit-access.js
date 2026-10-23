// This policy protects updates/deletion of an existing ERP client. Creation and
// reads keep their existing contracts; POST never overwrites an existing ID.
export const isClientMutation = (path, method) =>
  /^\/api\/erp\/clients(?:\/|$)/i.test(path) && ["PATCH", "PUT", "DELETE"].includes(method);

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
