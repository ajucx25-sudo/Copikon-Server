import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const hash = value => createHash("sha256").update(String(value)).digest("hex");
const derive = promisify(scrypt);
const PASSWORD_RE = /^\$copikon-scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
export async function hashPassword(password) {
  if (typeof password !== "string" || !password || PASSWORD_RE.test(password)) return password;
  const salt = randomBytes(16).toString("hex");
  const digest = await derive(password, salt, 64);
  return `$copikon-scrypt$${salt}$${digest.toString("hex")}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || !password || typeof stored !== "string" || !stored) return false;
  const match = stored.match(PASSWORD_RE);
  if (!match) return false; // Startup migrates legacy passwords before accepting traffic.
  const actual = await derive(password, match[1], 64);
  return timingSafeEqual(actual, Buffer.from(match[2], "hex"));
}
export async function protectCredentials(users) {
  const protectedUsers = [];
  for (const user of users) {
    protectedUsers.push(user?.password ? { ...user, password: await hashPassword(user.password) } : user);
  }
  return protectedUsers;
}
export const credentialDigest = user => hash(user.password ?? "");
export function safeUser(user) {
  if (!user) return user;
  const { password, passwordHash, ...safe } = user;
  return safe;
}
export function permissionList(value) {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
export const isAdministrator = user => user?.level === "ceo" || user?.username === "admin";
export function canAccessPath(user, path, method) {
  if (isAdministrator(user)) return true;
  const modules = permissionList(user?.moduleAccess);
  if (/^\/api\/(?:admin\/(?:users|sales-partners|providers|technical-providers)|sync)(?:\/|$)/.test(path)) return false;
  if (/^\/api\/sales-partners(?:\/|$)/.test(path)) return method === "GET" && !user.isPartner;
  if (/^\/api\/employees(?:\/|$)/.test(path)) {
    return method === "GET" && !user.isPartner;
  }
  if (/^\/api\/logistica(?:\/|$)/.test(path)) return modules.some(m => m.startsWith("logistica-"));
  if (/^\/api\/generators\/price-list-/.test(path)) return modules.includes("generators-ventas");
  return true; // Other routes retain their own existing object/role policy.
}

export function createSessions(pool, readCol, buildPartnerUser) {
  async function issue(user, partner = false) {
    const token = `srv-${partner ? "p" : ""}${user.id}-${randomBytes(32).toString("hex")}`;
    await pool.query(
      "INSERT INTO secure_sessions (token_hash, subject, credential_digest, expires_at) VALUES ($1,$2,$3,$4)",
      [hash(token), `${partner ? "p" : "e"}:${user.id}`, credentialDigest(user), Date.now() + 12 * 60 * 60 * 1000],
    );
    return token;
  }
  async function authenticate(req) {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!/^srv-(?:p)?\d+-[a-f0-9]{64}$/.test(token)) return null;
    const result = await pool.query("SELECT subject, credential_digest, expires_at FROM secure_sessions WHERE token_hash=$1", [hash(token)]);
    const session = result.rows[0];
    if (!session || Number(session.expires_at) <= Date.now()) return null;
    const [kind, id] = session.subject.split(":");
    const users = await readCol(kind === "p" ? "salesPartners" : "employees");
    const user = users.find(u => String(u.id) === id);
    if (!user || ["inactive", "disabled", "inactivo"].includes(user.status) ||
        user.canLogin === false || user.canLogin === 0 || user.canLogin === "false" ||
        credentialDigest(user) !== session.credential_digest) return null;
    return kind === "p" ? buildPartnerUser(user) : safeUser(user);
  }
  async function revoke(req) {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    await pool.query("DELETE FROM secure_sessions WHERE token_hash=$1", [hash(token)]);
  }
  return { issue, authenticate, revoke };
}
