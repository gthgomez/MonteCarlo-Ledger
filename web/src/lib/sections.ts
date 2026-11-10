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
  home: "How am I doing?",
  money: "What do I have?",
  budget: "Where is it going?",
  bills: "What payments are coming?",
  plan: "Can I afford a change?",
  future: "What could happen?",
  advanced: "What assumptions drive this?",
};

export function sectionFromHash(hash: string): Section | null {
  const name = hash.replace(/^#/, "");
  return (SECTIONS as readonly string[]).includes(name) ? (name as Section) : null;
}
