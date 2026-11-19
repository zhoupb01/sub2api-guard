import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const sessionName = "guard_session";
const sessionMaxAge = 30 * 24 * 60 * 60;
const loginWindow = 15 * 60_000;
const maxFailures = 5;

function sessionCookie(value: string, maxAge: number) {
  return `${sessionName}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export const expiredSessionCookie = sessionCookie("", 0);

export function createAuth(password: string) {
  const passwordDigest = createHash("sha256").update(password).digest();
  const sign = (expiry: string) => createHmac("sha256", password).update(`guard-session-v1|${expiry}`).digest();

  return {
    matchesPassword(candidate: string) {
      return timingSafeEqual(passwordDigest, createHash("sha256").update(candidate).digest());
    },
    hasSession(cookie: string | null, now: number) {
      const parts = cookie?.match(/^([1-9]\d*)\.([0-9a-f]{64})$/);
      if (!parts) return false;
      const [, expiry, signature] = parts;
      if (Number(expiry) <= Math.floor(now / 1_000)) return false;
      return timingSafeEqual(sign(expiry), Buffer.from(signature, "hex"));
    },
    sessionCookie(now: number) {
      const expiry = String(Math.floor(now / 1_000) + sessionMaxAge);
      const value = `${expiry}.${sign(expiry).toString("hex")}`;
      return sessionCookie(value, sessionMaxAge);
    },
  };
}

export function createLoginLimiter() {
  const failuresByIp = new Map<string, number[]>();
  let nextSweep = 0;

  return (ip: string, now: number, matchesPassword: () => boolean) => {
    const cutoff = now - loginWindow;
    if (now >= nextSweep) {
      for (const [address, failures] of failuresByIp) {
        if (failures[failures.length - 1] <= cutoff) failuresByIp.delete(address);
      }
      nextSweep = now + loginWindow;
    }

    const recent = failuresByIp.get(ip)?.filter((time) => time > cutoff) ?? [];
    if (recent.length >= maxFailures) return "limited";
    if (matchesPassword()) return "accepted";
    recent.push(now);
    failuresByIp.set(ip, recent);
    return "rejected";
  };
}
