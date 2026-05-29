import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

// In-page sandboxes consume no remote quota, so workspaces are unlimited
// regardless of role (the old remote-VM per-role caps are gone).
const WORKSPACE_LIMITS: Record<string, number> = {
  admin: Infinity,
  user: Infinity,
  guest: Infinity,
};

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Local-only mode (no Neon DB): no linked accounts to look up.
  const dbConfigured = !!process.env.DATABASE_URL;
  const [vercelAccount] = dbConfigured
    ? await db
        .select({
          provider: accounts.provider,
          providerAccountId: accounts.providerAccountId,
          scope: accounts.scope,
          createdAt: accounts.createdAt,
        })
        .from(accounts)
        .where(
          and(eq(accounts.userId, session.id), eq(accounts.provider, "vercel")),
        )
    : [undefined];

  const workspaceLimit = WORKSPACE_LIMITS[session.role] ?? WORKSPACE_LIMITS.user;

  return NextResponse.json({
    ...session,
    workspaceLimit: workspaceLimit === Infinity ? null : workspaceLimit,
    vercelConnected: !!vercelAccount,
    vercelAccount: vercelAccount
      ? {
          providerAccountId: vercelAccount.providerAccountId,
          scope: vercelAccount.scope,
          connectedAt: vercelAccount.createdAt,
        }
      : null,
  });
}
