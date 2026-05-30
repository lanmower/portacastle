import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { IS_STATIC_EXPORT, asset } from "@/lib/static-export";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Sandcastle",
  description: "Cloud desktop environment powered by Vercel Sandbox",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className="tailwind bg-white !min-h-screen dark:bg-black"
    >
      {/* Static export (GitHub Pages) can't set COOP/COEP response headers, but
          the in-page blink sandbox needs cross-origin isolation for
          SharedArrayBuffer. The coi-serviceworker shim injects those headers
          client-side (one reload on first visit) so crossOriginIsolated becomes
          true. beforeInteractive => it registers before the app/wasm loads.
          Loaded from the base-pathed URL so its SW scope covers the project
          subpath. Not needed in server mode (real headers are sent there). */}
      {IS_STATIC_EXPORT && (
        <Script
          src={asset("/coi-serviceworker.js")}
          strategy="beforeInteractive"
        />
      )}
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider
          attribute="class"
          storageKey="sandcastle-theme"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
