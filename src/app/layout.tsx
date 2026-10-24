import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Nav } from "@/components/Nav";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ByteX TradeLab",
  description: "Multi-market paper trading simulator, backtester and automatic trade journal. Education only — no real orders.",
  appleWebApp: { capable: true, title: "TradeLab", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0e13",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex h-full flex-col overflow-hidden">
        <Nav />
        {/* Bottom padding leaves room for the phone tab bar and the home indicator. */}
        <main className="min-h-0 flex-1 pb-[calc(56px+env(safe-area-inset-bottom))] md:pb-0">{children}</main>
      </body>
    </html>
  );
}
