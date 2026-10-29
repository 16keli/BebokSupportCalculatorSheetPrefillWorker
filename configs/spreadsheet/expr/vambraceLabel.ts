// Sheet-side cell transform for the vambrace level dropdown (3.9.2+: main F12,
// DPS C10). Renders the snapshot's vambrace field as the dropdown's
// "<level> (<grade>)" text, e.g. "10 (epic)" / "10 (leg.)" / "15 (relic)". Each
// grade only lists a level range (epic 0-10, leg. 10-15, relic 15-20, ancient
// 20-25), so the level is clamped into it. Blank when there is no vambrace (the
// cell then keeps the template default; the checkbox cell writes FALSE).
// Bindings (TransformCtx): raw.
import { transform } from "../../_context.ts";

const GRADES: Record<string, { label: string; min: number; max: number }> = {
  epic: { label: "epic", min: 0, max: 10 },
  legend: { label: "leg.", min: 10, max: 15 },
  relic: { label: "relic", min: 15, max: 20 },
  ancient: { label: "ancient", min: 20, max: 25 },
};

export default transform<void, string>(({ raw }) => {
  const v = raw as { level: number; grade: string } | null;
  if (!v) return "";
  const g = GRADES[v.grade] ?? GRADES.epic!;
  const level = Math.min(g.max, Math.max(g.min, v.level));
  return `${level} (${g.label})`;
});
