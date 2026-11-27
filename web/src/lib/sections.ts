export const SECTIONS = ["home", "money", "budget", "bills", "plan", "future", "advanced"] as const;

export type Section = (typeof SECTIONS)[number];

export const SECTION_LABEL: Record<Section, string> = {
  home: "Home",
  money: "Money",
  budget: "Budget",
  bills: "Bills",
  plan: "Plan",
  future: "Future",
  advanced: "Advanced",
};

export const SECTION_QUESTION: Record<Section, string> = {
  home: "What’s available, what’s coming, and what needs attention.",
  money: "Record cash, confirm paydays, and review activity.",
  budget: "Compare recorded spending with your monthly targets.",
  bills: "See what’s due and record payments you’ve made.",
  plan: "Try a what-if before changing your real plan.",
  future: "See where your balance may go and what could change it.",
  advanced: "Set your reserve, forecast window, and risk assumptions.",
};

export function sectionFromHash(hash: string): Section | null {
  const name = hash.replace(/^#/, "");
  return (SECTIONS as readonly string[]).includes(name) ? (name as Section) : null;
}
