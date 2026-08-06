import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { claimLocalWorkspace, getDatabase, localWorkspaceOwnerId } from "./database.mjs";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "reelio_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 10;
const PLAN_ENTITLEMENTS = Object.freeze({
  free: ["content.read", "video.create", "mode.quick", "mode.prompt", "mode.conversation"],
  creator: ["content.read", "video.create", "mode.quick", "mode.prompt", "mode.conversation", "mode.long", "tools.run", "brand.manage", "publish"],
  studio: ["content.read", "video.create", "mode.quick", "mode.prompt", "mode.conversation", "mode.long", "tools.run", "brand.manage", "publish", "automations.manage", "providers.manage"],
});

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export function authSetupRequired() {
  return !localWorkspaceOwnerId();
}

export async function registerOwner({ email, password, displayName }) {
  if (!authSetupRequired()) throw new AuthError("This local installation already has an account. Sign in instead.", 409);
  const normalizedEmail = normalizeEmail(email);
  const normalizedName = normalizeDisplayName(displayName, normalizedEmail);
  validatePassword(password);
  const now = new Date().toISOString();
  const user = {
    id: randomUUID(),
    email: normalizedEmail,
    displayName: normalizedName,
    passwordHash: await hashPassword(password),
    createdAt: now,
    updatedAt: now,
  };
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO users (id, email, display_name, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(user.id, user.email, user.displayName, user.passwordHash, user.createdAt, user.updatedAt);
    if (!claimLocalWorkspace(user.id)) throw new AuthError("This local installation already has an account. Sign in instead.", 409);
    db.prepare(`
      INSERT INTO subscriptions (
        user_id, plan_code, status, included_renders, renders_used,
        current_period_start, current_period_end, created_at, updated_at
      ) VALUES (?, 'studio', 'active', 200, 0, ?, NULL, ?, ?)
    `).run(user.id, now, now, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (error instanceof AuthError) throw error;
    if (String(error?.message ?? "").includes("UNIQUE")) throw new AuthError("An account with this email already exists.", 409);
    throw error;
  }
  return publicUser(user, subscriptionForUser(user.id));
}

export async function authenticateCredentials(email, password) {
  const normalizedEmail = normalizeEmail(email);
  if (typeof password !== "string") throw new AuthError("Email or password is incorrect.", 401);
  const row = getDatabase().prepare(`
    SELECT u.id, u.email, u.display_name, u.password_hash, u.created_at, u.updated_at,
      sub.plan_code, sub.status AS subscription_status, sub.included_renders, sub.renders_used,
      sub.current_period_start, sub.current_period_end
    FROM users u
    JOIN subscriptions sub ON sub.user_id = u.id
    WHERE u.email = ?
  `).get(normalizedEmail);
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    // Keep unknown-email and incorrect-password timing in the same rough class.
    if (!row) await hashPassword("invalid-local-password");
    throw new AuthError("Email or password is incorrect.", 401);
  }
  return publicUser({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }, subscriptionFromRow(row));
}

export function createSession(userId) {
  purgeExpiredSessions();
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const session = {
    id: randomUUID(),
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
  };
  getDatabase().prepare(`
    INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(session.id, session.userId, session.tokenHash, session.expiresAt, session.createdAt, session.lastSeenAt);
  return { token, expiresAt: session.expiresAt };
}

export function authenticateRequest(request) {
  const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
  if (!token) return null;
  const row = getDatabase().prepare(`
    SELECT s.id AS session_id, s.expires_at, s.last_seen_at,
      u.id, u.email, u.display_name, u.created_at, u.updated_at,
      sub.plan_code, sub.status AS subscription_status, sub.included_renders, sub.renders_used,
      sub.current_period_start, sub.current_period_end
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    JOIN subscriptions sub ON sub.user_id = u.id
    WHERE s.token_hash = ?
  `).get(hashToken(token));
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    getDatabase().prepare("DELETE FROM auth_sessions WHERE id = ?").run(row.session_id);
    return null;
  }
  if (Date.now() - Date.parse(row.last_seen_at) > 15 * 60 * 1000) {
    getDatabase().prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), row.session_id);
  }
  return {
    sessionId: row.session_id,
    user: publicUser({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }, subscriptionFromRow(row)),
  };
}

export function deleteSession(request) {
  const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
  if (token) getDatabase().prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hashToken(token));
}

export function sessionCookie(token, request, expiresAt) {
  const secure = Boolean(request.socket?.encrypted) || process.env.NODE_ENV === "production" && process.env.REELIO_AUTH_SECURE_COOKIE === "true";
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(request) {
  const secure = Boolean(request.socket?.encrypted) || process.env.NODE_ENV === "production" && process.env.REELIO_AUTH_SECURE_COOKIE === "true";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function entitlementsForSubscription(subscription) {
  if (!subscription || !["active", "trialing"].includes(subscription.status)) return ["content.read"];
  return [...(PLAN_ENTITLEMENTS[subscription.planCode] ?? PLAN_ENTITLEMENTS.free)];
}

export function assertEntitlement(identity, entitlement) {
  if (!identity?.user) throw new AuthError("Sign in to continue.", 401);
  if (!identity.user.entitlements.includes(entitlement)) {
    throw new AuthError(`Your ${identity.user.subscription.planCode} plan does not include this feature.`, 403);
  }
}

export function assertResourceAccess(identity, resource) {
  assertEntitlement(identity, "content.read");
  if (!resource?.ownerUserId || resource.ownerUserId !== identity.user.id) {
    throw new AuthError("This resource belongs to another account.", 403);
  }
}

export function consumeRenderAllowance(userId) {
  const result = getDatabase().prepare(`
    UPDATE subscriptions
    SET renders_used = renders_used + 1, updated_at = ?
    WHERE user_id = ?
      AND status IN ('active', 'trialing')
      AND renders_used < included_renders
  `).run(new Date().toISOString(), userId);
  if (result.changes !== 1) {
    const subscription = subscriptionForUser(userId);
    if (!subscription || !["active", "trialing"].includes(subscription.status)) {
      throw new AuthError("Your subscription is not active. Update billing before starting another render.", 403);
    }
    throw new AuthError(`Your ${subscription.planCode} plan has reached its ${subscription.includedRenders}-render limit for this period.`, 403);
  }
  return subscriptionForUser(userId);
}

export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || typeof encoded !== "string") return false;
  const [algorithm, n, r, p, saltValue, hashValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64url");
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltValue, "base64url"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  }));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError("Enter a valid email address.");
  return email;
}

function normalizeDisplayName(value, email) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  const fallback = email.split("@")[0];
  const normalized = name || fallback;
  if (normalized.length < 2 || normalized.length > 80) throw new AuthError("Name must be between 2 and 80 characters.");
  return normalized;
}

function validatePassword(value) {
  if (typeof value !== "string" || value.length < PASSWORD_MIN_LENGTH) throw new AuthError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (value.length > 128) throw new AuthError("Password must be 128 characters or fewer.");
}

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function cookieValue(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function purgeExpiredSessions() {
  getDatabase().prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(new Date().toISOString());
}

function subscriptionForUser(userId) {
  const row = getDatabase().prepare(`
    SELECT plan_code, status AS subscription_status, included_renders, renders_used,
      current_period_start, current_period_end
    FROM subscriptions WHERE user_id = ?
  `).get(userId);
  return row ? subscriptionFromRow(row) : null;
}

function subscriptionFromRow(row) {
  return {
    planCode: row.plan_code,
    status: row.subscription_status,
    includedRenders: Number(row.included_renders ?? 0),
    rendersUsed: Number(row.renders_used ?? 0),
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end ?? null,
  };
}

function publicUser(user, subscription) {
  const normalizedSubscription = subscription ?? {
    planCode: "free",
    status: "active",
    includedRenders: 0,
    rendersUsed: 0,
    currentPeriodStart: user.createdAt,
    currentPeriodEnd: null,
  };
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    subscription: normalizedSubscription,
    entitlements: entitlementsForSubscription(normalizedSubscription),
    createdAt: user.createdAt,
  };
}
