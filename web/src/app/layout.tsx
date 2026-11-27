import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MonteCarlo — Understand your money",
  description:
    "A local-first plan for what you have, what is coming, and what a change might do. Forecasts stay on your device.",
};

const themeBoot = `var t;try{t=localStorage.getItem("mc-theme");}catch(e){}document.documentElement.setAttribute("data-theme",t==="dark"||t==="light"?t:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
        {children}
      </body>
    </html>
  );
}
