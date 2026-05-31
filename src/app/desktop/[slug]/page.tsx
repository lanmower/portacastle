import { AuthScreen } from "@/components/auth/AuthScreen";
import { DesktopShell } from "../desktop-shell";
import { IS_STATIC_EXPORT, STATIC_GUEST_USER } from "@/lib/static-export";

// Under static export every dynamic route must enumerate its params at build
// time. Workspace slugs are created client-side at runtime, so we emit a single
// placeholder page; the real slug is resolved client-side from the local
// workspace store (DesktopShell.targetSlug). Deep links still work because the
// SPA reads the slug from the URL after hydration.
export function generateStaticParams() {
  return IS_STATIC_EXPORT ? [{ slug: "workspace" }] : [];
}

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // Static export (GitHub Pages): no server session -- boot the guest desktop
  // and let the client resolve the workspace slug from local state.
  if (IS_STATIC_EXPORT) {
    return <DesktopShell user={STATIC_GUEST_USER} targetSlug={slug} />;
  }

  const { getSession } = await import("@/lib/auth/session");
  const session = await getSession();

  if (!session) {
    return <AuthScreen allowGuest />;
  }

  return <DesktopShell user={session} targetSlug={slug} />;
}
