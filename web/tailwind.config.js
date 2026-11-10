/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        canvas: "var(--canvas)",
        surface: "var(--surface)",
        inset: "var(--inset)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        line: "var(--line)",
        accent: "var(--accent)",
        "on-accent": "var(--on-accent)",
        danger: "var(--danger)",
        warning: "var(--warning)",
        positive: "var(--positive)",
        "danger-soft": "var(--danger-soft)",
        "warning-soft": "var(--warning-soft)",
        "positive-soft": "var(--positive-soft)",
        "accent-soft": "var(--accent-soft)",
      },
      boxShadow: {
        card: "var(--shadow)",
      },
    },
  },
  plugins: [],
};
