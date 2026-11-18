import {isAdministrator,permissionList} from "./secure-access.js";
const eq=(a,b)=>a!=null&&b!=null&&String(a)===String(b);
const partner=u=>!!u?.isPartner||u?.level==="partner_externo";
const sales=u=>permissionList(u?.moduleAccess).includes("generators-ventas");
export const manageLeads=u=>!!u&&!partner(u)&&!u.providerId&&(isAdministrator(u)||(sales(u)&&["coordinador","gerente","director"].includes(u.level)));
export function visibleLead(u,l){
  if(!u||!l)return false;
  if(partner(u))return eq(l.salesPartnerId,u.salesPartnerId);
  if(u.providerId!=null)return l.inspectionAssigneeType==="externo"&&eq(l.inspectionProviderId,u.providerId);
  return manageLeads(u)||(sales(u)&&eq(l.assigneeId,u.id))||(eq(l.inspectionBy,u.id)&&permissionList(u.moduleAccess).some(k=>["generators-ventas","generators-tecnico"].includes(k)));
}
const fail=(msg,s=403)=>{throw Object.assign(new Error(msg),{status:s});};
export function authorizeLeadWrite(user,old,data,method){
  if(!user)fail("Inicia sesión.",401);
  if(old&&!visibleLead(user,old))fail("Oportunidad no encontrada.",404);
  if(method==="DELETE"){if(!manageLeads(user))fail("Requiere autorización de gerencia.");return;}
  if(!data||typeof data!=="object"||Array.isArray(data)||["__proto__","constructor","prototype","id"].some(k=>Object.hasOwn(data,k)))fail("Campos no válidos.",400);
  if(Object.keys(data).some(k=>/^odoo/i.test(k)&&(!old||data[k]!==old[k])))fail("Los vínculos de Odoo solo se cambian desde la integración.");
  if(manageLeads(user))return;
  if(!old){
    if(partner(user)){if(!eq(data.salesPartnerId,user.salesPartnerId))fail("Partner no válido.");}
    else if(!sales(user)||user.providerId!=null)fail("Sin permiso para crear oportunidades.");
    if(data.assigneeId!=null&&!eq(data.assigneeId,user.id)||data.inspectionProviderId!=null||data.inspectionBy!=null||data.inspectionAssigneeType!=null||(!partner(user)&&data.salesPartnerId!=null))fail("La asignación requiere autorización de gerencia.");
    if(!partner(user))data.assigneeId=user.id;
    return;
  }
  for(const key of ["assigneeId","inspectionBy","salesPartnerId","inspectionProviderId","inspectionAssigneeType"]){
    if(Object.hasOwn(data,key)&&data[key]!==old[key])fail("La reasignación requiere autorización de gerencia.");
  }
}
