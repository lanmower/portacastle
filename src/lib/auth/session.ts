import { cookies } from "next/headers";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";

const SESSION_COOKIE = "sandcastle_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

// Local-only mode: when no Neon DB is configured the app still runs fully
// in-page (the whole point of the in-page sandbox migration). Guest sessions
// become cookie-only with a synthesized local identity -- no DB insert/lookup.
const DB_CONFIGURED = !!process.env.DATABASE_URL;
// A guest token in DB-less mode is prefixed so getSession can reconstruct the
// identity without a database round-trip.
const LOCAL_GUEST_PREFIX = "local-guest:";

function getSecret(): string {
  // In production a real secret is required; in dev/local-only fall back to a
  // fixed dev secret so the desktop boots with zero env configuration.
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is not set");
  }
  return "sandcastle-dev-insecure-secret";
}

function sign(payload: string): string {
  const hmac = crypto.createHmac("sha256", getSecret());
  hmac.update(payload);
  return `${payload}.${hmac.digest("base64url")}`;
}

function verify(token: string): string | null {
  const lastDot = token.lastIndexOf(".");
  if (lastDot === -1) return null;
  const payload = token.slice(0, lastDot);
  const expected = sign(payload);
  if (token.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return null;
  }
  return payload;
}

export async function createSession(userId: string): Promise<void> {
  const jar = await cookies();
  const token = sign(userId);
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
}

export async function getSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const userId = verify(token);
  if (!userId) return null;

  // Local-only guest: reconstruct identity straight from the signed token, no DB.
  if (userId.startsWith(LOCAL_GUEST_PREFIX)) {
    const id = userId.slice(LOCAL_GUEST_PREFIX.length);
    return { id, email: null, name: "Guest", role: "guest" as const };
  }

  if (!DB_CONFIGURED) return null;
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return null;

  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export async function createGuestSession() {
  // DB-less local mode: mint a cookie-only guest with a synthesized id; no DB.
  if (!DB_CONFIGURED) {
    const id = crypto.randomUUID();
    await createSession(LOCAL_GUEST_PREFIX + id);
    return { id, email: null, name: "Guest", role: "guest" as const };
  }

  const [guest] = await db
    .insert(users)
    .values({
      name: "Guest",
      role: "guest",
    })
    .returning();

  await createSession(guest.id);
  return { id: guest.id, email: guest.email, name: guest.name, role: guest.role };
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}
