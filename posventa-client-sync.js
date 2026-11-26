import {createHash, randomUUID} from "node:crypto";
import {EQUIPMENT_DOCUMENT_KEYS} from "./equipment-reference-access.js";
import {recordWelcomes} from "./posventa-welcome.js";

export const POSVENTA_SYNC_PATH = "/api/generators/posventa/equipment/sync-from-clients";
export const POSVENTA_SYNC_POLICY = "clients-to-posventa-append-v1";
const text = value => typeof value === "string" ? value.trim() : "";
const id = value => (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) &&
  Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = message => { throw Object.assign(new Error(message), {status:409}); };
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const invoiceKey = (clientId, invoice) => `${clientId}:${text(invoice).toLocaleUpperCase("es")}`;

// Pure, append-only plan. The route reads its inputs inside the same transaction
// and advisory lock used by client imports, equipment edits and pricelist writers.
export function planPosventaClientSync(clients, equipment, {now = new Date().toISOString(), actorId = null, reservedIds = []} = {}) {
  const today = new Intl.DateTimeFormat("en-CA", {timeZone:"America/Caracas",
    year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(now));
  const keys = new Map(), ids = new Set(), manualInvoices = new Set();
  let maxId = 0;
  for (const value of reservedIds) {
    if (id(value)) maxId = Math.max(maxId,id(value));
  }
  for (const row of equipment) {
    const rowId = id(row?.id);
    if (!rowId || ids.has(rowId)) fail("El parque contiene identificadores inválidos o repetidos. No se crearon equipos.");
    ids.add(rowId); maxId = Math.max(maxId, rowId);
    if (row.odooUnitKey != null) {
      if (typeof row.odooUnitKey !== "string" || !/^odoo:[1-9]\d*:[1-9]\d*:[1-9]\d*:[1-9]\d*$/.test(row.odooUnitKey) ||
          keys.has(row.odooUnitKey)) fail("Hay referencias Odoo inválidas o repetidas en Posventa. Requieren revisión.");
      keys.set(row.odooUnitKey, row);
    } else if (id(row.clientId) && text(row.invoiceNumber) && row.active !== false &&
               !["externo","alquiler"].includes(row.source)) {
      manualInvoices.add(invoiceKey(id(row.clientId), row.invoiceNumber));
    }
  }
  const clientIds = new Set();
  for (const client of clients) {
    const clientId = id(client?.id);
    if (!clientId || clientIds.has(clientId)) fail("Existen identificadores de cliente inválidos o repetidos.");
    clientIds.add(clientId);
  }
  const groups = new Map(), blocked = new Set(), issues = [];
  let eligibleClients = 0;
  for (const client of clients) {
    if (client.syncStatus !== "synced") continue;
    let evidence;
    try { evidence = JSON.parse(client.odooBaifaSales); } catch {}
    if (!evidence || evidence.since !== "2022-01-01" || !id(evidence.invoiceCount) ||
        !Array.isArray(evidence.sales) || !Array.isArray(evidence.credits) || !text(evidence.policyVersion)) {
      issues.push({clientId:id(client.id), reason:"Evidencia BAIFA incompleta; cliente no importado."});
      continue;
    }
    eligibleClients++;
    if (evidence.sales.length > 10000) fail("El volumen excede el límite de revisión (10.000 líneas por cliente).");
    for (const row of evidence.sales) {
      const companyId = id(row?.companyId), lineId = id(row?.lineId);
      const identity = companyId && lineId ? `${companyId}:${lineId}` : null;
      const invalid = reason => {
        if (identity) blocked.add(identity);
        issues.push({clientId:id(client.id), invoice:text(row?.invoice), reason});
      };
      if (![1,12].includes(companyId) || !lineId || !id(row?.invoiceId) || !id(row?.productId) ||
          !text(row?.invoice) || !text(row?.product) || !text(client.name)) {
        invalid("Identificación de venta incompleta o compañía fuera del alcance."); continue;
      }
      if (typeof row.quantity !== "number" || !Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 1000) {
        invalid("Cantidad inválida (se admiten de 1 a 1.000 unidades enteras por línea)."); continue;
      }
      if (!validDate(row.date) || row.date < "2022-01-01" || row.date > today) {
        invalid("Fecha de factura inválida o fuera del período."); continue;
      }
      const line = {clientId:id(client.id), clientName:text(client.name), companyId, lineId,
        invoiceId:id(row.invoiceId), productId:id(row.productId), invoice:text(row.invoice),
        date:row.date, product:text(row.product), quantity:row.quantity,
        creditReview:evidence.credits.length > 0, policyVersion:evidence.policyVersion,
        observedAt:typeof evidence.observedAt === "string" ? evidence.observedAt : null};
      const group = groups.get(identity) || [];
      group.push(line); groups.set(identity, group);
    }
  }
  const additions = [], pending = [];
  let sourceUnits = 0, alreadyExisting = 0, pendingCreditUnits = 0, pendingConflictUnits = 0;
  for (const [identity, group] of groups) {
    const line = group[0];
    if (blocked.has(identity)) continue;
    if (group.some(other => JSON.stringify(other) !== JSON.stringify(line))) {
      issues.push({clientId:line.clientId, invoice:line.invoice, reason:"Línea repetida con datos o clientes contradictorios."});
      continue;
    }
    sourceUnits += line.quantity;
    if (sourceUnits > 10000) fail("El origen supera 10.000 unidades. No se realizó una importación parcial.");
    for (let unitNumber = 1; unitNumber <= line.quantity; unitNumber++) {
      const key = `odoo:${line.companyId}:${line.invoiceId}:${line.lineId}:${unitNumber}`;
      const previous = keys.get(key);
      if (previous) {
        const source = previous.odooSource;
        if (id(previous.clientId) !== line.clientId || !source ||
            id(source.companyId) !== line.companyId || id(source.invoiceId) !== line.invoiceId ||
            id(source.lineId) !== line.lineId || id(source.unitNumber) !== unitNumber ||
            id(source.productId) !== line.productId) {
          pendingConflictUnits++;
          pending.push({key, clientId:line.clientId, invoice:line.invoice, reason:"La ficha existente tiene una asociación distinta. Se conservó sin cambios."});
        } else alreadyExisting++;
        continue;
      }
      if (line.creditReview || manualInvoices.has(invoiceKey(line.clientId,line.invoice))) {
        const reason = line.creditReview ? "Cliente con notas de crédito: requiere revisión previa." :
          "Existe una ficha manual con esta factura; revisar antes de crear otra.";
        if (line.creditReview) pendingCreditUnits++; else pendingConflictUnits++;
        pending.push({key,clientId:line.clientId,invoice:line.invoice,reason}); continue;
      }
      if (!Number.isSafeInteger(++maxId)) fail("No se pudo asignar un identificador seguro.");
      const code = /^\[([^\]]+)\]/.exec(line.product)?.[1]?.trim() || null;
      additions.push({
        id:maxId, clientId:line.clientId, clientName:line.clientName, brand:"BAIFA", category:"Generador",
        model:code ? `SKU ${code} · modelo por verificar` : "Modelo por verificar",
        productCode:code, productDescription:line.product, modelEvidence:"explicit-unverified-sku-label",
        source:"odoo-baifa-sales", active:true, odooUnitKey:key,
        invoiceNumber:line.invoice, invoiceDate:line.date,
        serial:null, capacity:null, location:null, installedAt:null, commissionedAt:null,
        warrantyMonths:null, warrantyHours:null, lastServiceDate:null, yearOfManufacture:null, specs:{},
        notes:`Ventas → Clientes. Factura ${line.invoice}. Unidad ${unitNumber} de ${line.quantity} de la línea ${line.lineId}. Descripción literal: ${line.product}`,
        createdAt:now, createdBy:actorId,
        odooSource:{companyId:line.companyId,invoiceId:line.invoiceId,lineId:line.lineId,productId:line.productId,
          unitNumber,lineQuantity:line.quantity,observedAt:line.observedAt,
          clientPolicyVersion:line.policyVersion,importPolicyVersion:POSVENTA_SYNC_POLICY},
      });
    }
  }
  return {additions, result:{ok:true,policyVersion:POSVENTA_SYNC_POLICY,source:"stored-clients",syncedAt:now,
    created:additions.length,alreadyExisting,preserved:equipment.length,total:equipment.length+additions.length,
    eligibleClients,sourceUnits,pendingCreditUnits,pendingConflictUnits,issues,pending}};
}

export async function persistSoldPark({readCol, writeCol, source, actorId=null,preview=false}) {
      const clients = await readCol("erpClients"), equipment = await readCol("erpClientEquipment");
      // Do not reuse IDs already referenced by historical service documents.
      const reservedIds = [];
      const collect = value => {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          if (/^(?:clientEquipment|equipment)Ids?$/.test(key)) {
            reservedIds.push(...(Array.isArray(child) ? child : [child]));
          } else if (child && typeof child === "object") collect(child);
        }
      };
      for (const key of EQUIPMENT_DOCUMENT_KEYS) {
        collect(await readCol(key));
      }
      const {buildPlan}=await import("./baifa-client-sync.js");
      if(source.companies.length!==1||source.companies[0].id!==12||
        source.customers.some(c=>[...c.sales,...c.credits].some(s=>s.companyId!==12)))throw Error("Compañía de origen no válida.");
      const matched=buildPlan(clients,source,equipment.map(e=>e.clientId));
      const currentIds=new Set(clients.map(c=>Number(c.id))),included=new Set(matched.actions.map(a=>a.id));
      const verified=matched.next.filter(c=>included.has(c.id));
      const {additions,result}=planPosventaClientSync(verified,equipment,{actorId,reservedIds});
      result.source="odoo";result.upstream="odoo";result.companyId=12;result.observedAt=source.observedAt;
      for(const p of [...matched.conflicts,...matched.pending])result.issues.push({reason:p.reason||"Identidad de cliente pendiente de revisión."});
      // Do not replace the sales directory or truncate historical sales evidence.
      // Create only missing client references that have new, validated equipment.
      const needs=new Set(additions.map(e=>e.clientId));
      const newClients=verified.filter(c=>!currentIds.has(c.id)&&needs.has(c.id));
      if(preview)return {...result,preview:true,newClients:newClients.length};
      if(newClients.length)await writeCol(`adminMaintenance:soldParkClientBackup:${randomUUID()}`,clients);
      if(newClients.length)await writeCol("erpClients",[...clients,...newClients]);
      await recordWelcomes(additions,readCol,writeCol,result.syncedAt);
      if (additions.length) {
        // Private audit collection, not exposed by the generic REST route map.
        const receipt = `adminMaintenance:posventaClientSync:${randomUUID()}`;
        await writeCol(`${receipt}:backup`,equipment);
        await writeCol("erpClientEquipment",[...equipment,...additions]);
        await writeCol(receipt,[{...result,actorId,createdIds:additions.map(row=>row.id),newClientIds:newClients.map(c=>c.id),
          sourceHash:hash(verified),beforeHash:hash(equipment),afterHash:hash([...equipment,...additions])}]);
      }
      return result;
}

export function registerPosventaClientSync(app,{sync}){
  app.post(POSVENTA_SYNC_PATH,async(req,res)=>{
    if(req.body!=null&&(typeof req.body!=="object"||Array.isArray(req.body)||Object.keys(req.body).length))
      return res.status(400).json({message:"La actualización no acepta datos de clientes ni equipos."});
    try{res.json(await sync(req.verifiedUser.id));}
    catch(e){res.status(e.status===409?409:502).json({message:e.status===409?e.message:"No se completó la actualización desde Odoo. El parque anterior se conserva."});}
  });
}
