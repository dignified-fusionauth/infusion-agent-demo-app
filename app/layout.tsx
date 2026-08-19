import type { Metadata } from "next";
import { Chivo, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// A technical display face + neutral body + a true code mono — deliberately
// distinct from the siblings (Works' Space Grotesk, Market's Sora, Bank's
// Fraunces). The mono carries all the ids, scopes, and tokens on screen.
const display = Chivo({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const body = Inter({
  variable: "--font-body",
  subsets: ["latin"],
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: "InFusion Agent — a FusionAuth demo for agentic AI",
  description:
    "An internal AI assistant showing FusionAuth authenticating and authorizing a non-human identity: OAuth-scoped MCP tool calls, scope-filtered RAG, and two independent authorization checks.",
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
      className={`${display.variable} ${body.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-surface text-ink font-[family-name:var(--font-body)]">
        {children}
      </body>
    </html>
  );
}
