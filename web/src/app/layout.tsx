import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MonteCarlo Ledger — Personal Cash Flow & Risk Engine",
  description: "Free, zero-knowledge personal finance timeline and Monte Carlo risk forecast. Run scenarios locally or sync end-to-end encrypted with your CLI.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 antialiased selection:bg-cyan-500/30 selection:text-cyan-200">
        {children}
      </body>
    </html>
  );
}
