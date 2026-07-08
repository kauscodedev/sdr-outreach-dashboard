import type { Metadata } from "next";
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * Type system (Phase-1 design system):
 *  - Hanken Grotesk — the UI voice: a characterful humanist grotesque, legible at small
 *    sizes and dense tables, with clean tabular figures.
 *  - JetBrains Mono — the "instrument" voice, reserved for headline metric values so numbers
 *    read like a precision panel and align perfectly in columns.
 * next/font inlines both at build time (no runtime/CDN request), exposed as CSS variables.
 */
const sans = Hanken_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
  weight: ["400", "500", "600", "700", "800"],
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: "SDR Outreach Coverage",
  description: "Unique outbound contacts & companies tapped per SDR, by US/Eastern time period — sourced from HubSpot.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
