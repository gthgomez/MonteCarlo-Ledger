import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MonteCarlo — Understand your money",
  description:
    "A local-first plan for what you have, what is coming, and what a change might do. Forecasts stay on your device.",
};

const themeBoot = `try{var t=localStorage.getItem("mc-theme");if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t);}catch(e){}`;

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
