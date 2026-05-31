import { AuthScreen } from "@/components/auth/AuthScreen";
import { DesktopShell } from "./desktop-shell";
import { IS_STATIC_EXPORT, STATIC_GUEST_USER } from "@/lib/static-export";

export default async function DesktopPage() {
  // Static export (GitHub Pages): no server session -- boot straight into the
  // DB-less guest desktop. Everything below runs in-page via the WASM sandbox.
  if (IS_STATIC_EXPORT) {
    return <DesktopShell user={STATIC_GUEST_USER} />;
  }

  const { getSession } = await import("@/lib/auth/session");
  const session = await getSession();

  if (!session) {
    const showDevAuth = process.env.NODE_ENV === "development";
    return <AuthScreen showDevAuth={showDevAuth} allowGuest />;
  }

  return <DesktopShell user={session} />;
}
