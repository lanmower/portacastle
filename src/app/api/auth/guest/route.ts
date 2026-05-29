import { NextResponse } from "next/server";
import { getSession, createGuestSession } from "@/lib/auth/session";

export async function POST() {
  const existing = await getSession();
  if (existing) {
    return NextResponse.json({ error: "Already authenticated" }, { status: 400 });
  }

  // Rate limiting (Vercel firewall) is gone with the remote-VM backend: guest
  // sessions are local and create no remote resources.
  await createGuestSession();
  return NextResponse.json({ ok: true });
}
