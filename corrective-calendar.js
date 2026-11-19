import {isAdministrator,permissionList} from "./secure-access.js";
import {dossierRights} from "./technician-dossier.js";

// This agenda is a read-only projection. No contact, financial or dossier data.
export function registerCorrectiveCalendar(app,{sessions,readCol}){
  // The same source is also used by service, sales, rental and warranty views.
  app.use("/api/erp/maintenance-orders",async(req,res,next)=>{
    if(!["GET","HEAD"].includes(req.method))return next();
    res.set("Cache-Control","private, no-store");
    try{
      const u=await sessions.authenticate(req);
      if(!u)return res.status(401).json({message:"Inicia sesión."});
      if(!dossierRights(u,await readCol("departments")).generators&&!(isAdministrator(u)&&!u.isExternal&&!u.isExternalProvider&&!u.isPartner&&u.providerId==null&&!["partner_externo","tecnico_externo"].includes(u.level)))return res.status(403).json({message:"Sin acceso a las órdenes de Generators."});
      next();
    }catch{return res.status(503).json({message:"No se pudo verificar el acceso."});}
  });
  app.get("/api/generators/maintenance/corrective-calendar",async(req,res)=>{
    res.set("Cache-Control","private, no-store");
    try{
      const u=await sessions.authenticate(req);
      if(!u)return res.status(401).json({message:"Inicia sesión."});
      if(u.isPartner||u.isExternal||u.isExternalProvider||u.providerId!=null||["partner_externo","tecnico_externo"].includes(u.level)||
        !(isAdministrator(u)||permissionList(u.moduleAccess).some(x=>["generators-mantenimiento","generators-tecnico","generators-alquiler"].includes(x))))
        return res.status(403).json({message:"Sin permiso para consultar la agenda de mantenimiento."});
      const text=v=>typeof v==="string"?v:"";
      const orders=(await readCol("erpMaintenanceOrders")).filter(o=>o?.serviceType==="correctivo").map(o=>({
        id:o.id,code:text(o.code),client:text(o.clientName),equipment:text(o.productName)||[text(o.externalBrand),text(o.externalModel)].filter(Boolean).join(" ")||text(o.productCode),
        technician:text(o.technicianName),source:text(o.source),status:text(o.status),date:text(o.scheduledDate)
      }));
      return res.json({orders});
    }catch{return res.status(503).json({message:"No se pudo consultar el calendario correctivo."});}
  });
}
