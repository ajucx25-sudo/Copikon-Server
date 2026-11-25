export const isLocationContactPath = path => /^\/api\/generators\/posventa\/equipment\/[1-9]\d*\/location-contact\/?$/i.test(path);
export function planLocationContact(body, equipment, clients, id) {
  const fail=(status,message)=>({status,message});
  if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(k=>!["location","contact","expectedClientId"].includes(k)))return fail(400,"Campos no permitidos.");
  const fields=["location","contact"].filter(k=>Object.hasOwn(body,k));
  if(!fields.length||fields.some(k=>typeof body[k]!=="string"||body[k].trim().length>(k==="location"?1000:250)))return fail(400,"Revisa la ubicación y la persona de contacto.");
  const eq=equipment.find(r=>String(r.id)===id);
  if(!eq||eq.active===false||["externo","alquiler"].includes(eq.source))return fail(404,"Equipo vendido no disponible.");
  const client=clients.find(c=>c.id!=null&&String(c.id)===String(eq.clientId));
  if(fields.includes("contact")&&(!client||!Number.isSafeInteger(body.expectedClientId)||body.expectedClientId!==Number(client.id)))return fail(409,"El cliente vinculado cambió o no está disponible. Vuelve a abrir la ficha.");
  const result={equipmentId:eq.id,clientId:client?.id??null};
  for(const k of fields)result[k]=body[k].trim()||null;
  return {status:200,result};
}
