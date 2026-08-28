import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Inventory Audit Engine",
  description:
    "Retail inventory audit: lost sales from stockouts, dead stock, overstock and data quality.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-gray-200 bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
            <Link href="/" className="flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-indigo-600" />
              <span className="text-sm font-semibold tracking-tight text-gray-900">
                Inventory Audit Engine
              </span>
            </Link>
            <span className="text-xs text-gray-400">retail analytics</span>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
        <footer className="mx-auto max-w-5xl px-4 pb-8 sm:px-6">
          <p className="border-t border-gray-200 pt-4 text-xs text-gray-400">
            Money figures are reported as ranges; the engine states what it
            could not see.
          </p>
        </footer>
      </body>
    </html>
  );
}
