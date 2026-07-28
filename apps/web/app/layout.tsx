import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { SwRegister } from "@/components/sw-register";

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-pjs",
  subsets: ["latin"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jbmono",
  subsets: ["latin"],
  display: "swap",
});

// Link previews break without an absolute base: Next emits relative image URLs
// and no crawler can resolve them. The deployment's own hostname is the fallback
// so a preview works before anyone remembers to set the auth URL.
const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const appUrl = process.env.BETTER_AUTH_URL ?? (vercelUrl ? `https://${vercelUrl}` : undefined);

export const metadata: Metadata = {
  title: {
    default: "Wezesha Restock",
    template: "%s · Wezesha Restock",
  },
  description: "Stock replenishment for beauty retailers.",
  applicationName: "Wezesha Restock",
  metadataBase: appUrl ? new URL(appUrl) : undefined,
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Wezesha",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/icons/icon-192.png",
  },
  openGraph: {
    title: "Wezesha Restock",
    description: "Stock replenishment for beauty retailers.",
    siteName: "Wezesha Restock",
    type: "website",
    url: appUrl,
  },
  twitter: {
    // The wide card, not the thumbnail: the generated image carries the pitch.
    card: "summary_large_image",
    title: "Wezesha Restock",
    description: "Stock replenishment for beauty retailers.",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0e17" },
  ],
};

/* Runs before first paint so the stored/system theme applies without a flash. */
const themeInit = `(function () {
  try {
    var t = localStorage.getItem("wezesha-theme");
    if (t !== "light" && t !== "dark") {
      t = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.dataset.theme = t;
  } catch (e) {
    document.documentElement.dataset.theme = "light";
  }
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${jakarta.variable} ${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full font-sans">
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
