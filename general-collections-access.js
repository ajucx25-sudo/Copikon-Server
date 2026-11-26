import { isAdministrator, permissionList } from "./secure-access.js";

export function generalAccess(user, area = "adm-contabilidad") {
  if (!user || user.isPartner || user.isExternal || user.isExternalProvider ||
      user.providerId != null || ["partner_externo", "tecnico_externo"].includes(user.level)) return false;
  return isAdministrator(user) || user.level === "directiva" || permissionList(user.moduleAccess).includes(area);
}

export function financeGuard(sessions) {
  return async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const user = await sessions.authenticate(req);
      if (!user) return res.status(401).json({message:"Inicia sesión."});
      const path = req.path.toLowerCase().replace(/\/$/, "");
      const areas = path === "/companies" ? ["adm-contabilidad", "adm-tesoreria", "adm-finanzas", "adm-bitacora"] :
        path === "/balance" ? ["adm-contabilidad", "adm-tesoreria"] : ["adm-contabilidad"];
      if (!areas.some(area => generalAccess(user, area))) return res.status(403).json({message:"Sin permiso de Administración."});
      next();
    } catch { return res.status(503).json({message:"No se pudo verificar la sesión."}); }
  };
}
export function ownsNotice(user, n) {
  if (!user || user.isPartner || user.level === "partner_externo") return false;
  if (n.module === "administracion" || n.dedupe_key?.startsWith("promise:"))
    return generalAccess(user) && !!n.recipient && [user.username,user.email].includes(n.recipient);
  return user.id != null && n.userId != null && String(user.id) === String(n.userId);
}
export const daysToDate = (date, today) => date ? (Date.parse(date+"T00:00:00Z")-Date.parse(today+"T00:00:00Z"))/86400000 : null;
export const noticeForBell = (user,n) => !n.dedupe_key?.startsWith("promise:") ? n : ({
  ...n, userId:user.id, message:n.body, link:n.url, type:n.urgency, createdAt:new Date(n.created_at).toISOString()
});
