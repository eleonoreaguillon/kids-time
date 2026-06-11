// ─────────────────────────────────────────────────────────────────────────────
// Helpers purs : dates, ages, formattage, parsing, calcul des stats DRIEETS
// ─────────────────────────────────────────────────────────────────────────────

import {
  AGE_BANDS,
  DEFAULT_RULES,
  type AgeBand,
  type Child,
  type ChildRole,
  type Rules,
  type Session,
  type SessionStats,
} from "./types";

export function getAge(dob: string): number {
  const t = new Date(), b = new Date(dob);
  let a = t.getFullYear() - b.getFullYear();
  const m = t.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--;
  return a;
}

export function getAgeBand(dob: string): AgeBand {
  const a = getAge(dob);
  if (a < 3) return "0-2";
  if (a < 6) return "3-5";
  if (a < 12) return "6-11";
  if (a < 16) return "12-16";
  return "16-18"; // >= 16. Les 18+ ne sont plus mineurs mais on les rattache
                  // a cette tranche : un message majeur·e est affiche en UI.
}

export function isMinor(dob: string): boolean {
  return getAge(dob) < 18;
}

// Assure que toutes les bandes d'age sont presentes dans rules (retro-compat
// pour les projets crees avant l'ajout de "16-18").
export function normalizeRules(rules: Rules): Rules {
  const next: any = JSON.parse(JSON.stringify(rules));
  for (const band of AGE_BANDS) {
    if (!next.maxWorkMinutes[band]) next.maxWorkMinutes[band] = { ...DEFAULT_RULES.maxWorkMinutes[band] };
    if (!next.mandatoryBreakAfterMinutes[band]) next.mandatoryBreakAfterMinutes[band] = { ...DEFAULT_RULES.mandatoryBreakAfterMinutes[band] };
  }
  // Retro-compat des flags d'affichage : default true
  if (next.showAmplitudeOverage === undefined) next.showAmplitudeOverage = true;
  return next as Rules;
}

export function formatMinutes(min: number | null | undefined): string {
  if (min == null || isNaN(min)) return "0min";
  const h = Math.floor(Math.abs(min) / 60), m = Math.abs(min) % 60, s = min < 0 ? "-" : "";
  if (h === 0) return `${s}${m}min`;
  if (m === 0) return `${s}${h}h`;
  return `${s}${h}h${String(m).padStart(2, "0")}`;
}

export function formatTime(v: string | Date | undefined): string {
  if (!v) return "--:--";
  return new Date(v).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export function isVacation(child: Child, dateStr: string): boolean {
  return (child.vacation_periods || []).some(p => dateStr >= p.start && dateStr <= p.end);
}

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function timeStrToISO(dateStr: string, timeStr: string): string {
  return new Date(`${dateStr}T${timeStr}:00`).toISOString();
}

export function isoToTimeStr(iso: string | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export function normalize(s: string): string {
  return s.toLowerCase().trim().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function splitFullName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function detectRole(val: string): ChildRole | null {
  const n = normalize(String(val || "")).trim();
  if (!n) return null;
  if (n === "role" || n === "rôle") return "role";
  if (n === "silhouette") return "silhouette";
  if (n === "figurant" || n === "figurant.e" || n === "figuration" || n === "figurante") return "figurant";
  if (n.includes("silhouette")) return "silhouette";
  if (n.includes("figurant") || n.includes("figuration")) return "figurant";
  if (n.includes("role") || n.includes("rôle")) return "role";
  return null;
}

export function parseExcelDate(val: any): string {
  if (!val) return "";
  if (typeof val === "number") { const d = new Date((val - 25569) * 86400 * 1000); return d.toISOString().slice(0, 10); }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) { const [d, m, y] = trimmed.split("/"); return `${y}-${m}-${d}`; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parsed = new Date(trimmed); if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return "";
}

export function guessColumn(headers: string[], candidates: string[]): string | null {
  const normalized = headers.map(x => normalize(x || ""));
  for (const cand of candidates) {
    const nc = normalize(cand);
    const idx = normalized.findIndex(x => x === nc || x.includes(nc) || nc.includes(x));
    if (idx !== -1) return headers[idx];
  }
  return null;
}

// Tri des enfants : Rôle → Silhouette → Figurant → (sans statut), puis alpha
const ROLE_ORDER: Record<string, number> = { role: 0, silhouette: 1, figurant: 2 };
export function sortByRoleThenAlpha(cs: Child[]): Child[] {
  return [...cs].sort((a, b) => {
    const ra = ROLE_ORDER[a.role ?? ""] ?? 3, rb = ROLE_ORDER[b.role ?? ""] ?? 3;
    if (ra !== rb) return ra - rb;
    return `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, "fr");
  });
}

// Calcul des stats DRIEETS d'une session (travail, amplitude, pauses…)
export function computeSessionStats(session: Session | undefined, rules: Rules): SessionStats | null {
  if (!session?.start_time) return null;
  const now = session.end_time ? new Date(session.end_time) : new Date();
  const start = new Date(session.start_time);
  const amplitudeMin = Math.floor((now.getTime() - start.getTime()) / 60000);
  const events = session.events || [];
  let workMin = 0, breakMin = 0, validBreakMin = 0, dejeunerMin = 0, schoolMin = 0, lastRef = start;
  const breakSlots: SessionStats["breakSlots"] = [];
  for (const ev of events) {
    const t = new Date(ev.time), dur = Math.floor((t.getTime() - lastRef.getTime()) / 60000);
    if (ev.type === "pause_start" || ev.type === "dejeuner_start" || ev.type === "school_start") {
      workMin += dur; lastRef = t;
    } else if (ev.type === "pause_end") {
      const valid = dur >= rules.minBreakMinutes;
      breakSlots.push({ start: lastRef.toISOString(), end: t.toISOString(), durationMin: dur, valid, kind: "pause" });
      if (valid) validBreakMin += dur; else workMin += dur;
      breakMin += dur; lastRef = t;
    } else if (ev.type === "dejeuner_end") {
      breakSlots.push({ start: lastRef.toISOString(), end: t.toISOString(), durationMin: dur, valid: true, kind: "dejeuner" });
      dejeunerMin += dur; lastRef = t;
    } else if (ev.type === "school_end") {
      breakSlots.push({ start: lastRef.toISOString(), end: t.toISOString(), durationMin: dur, valid: false, kind: "school" });
      schoolMin += dur; lastRef = t;
    }
  }
  const lastDur = Math.floor((now.getTime() - lastRef.getTime()) / 60000);
  if (session.status === "paused") {
    const valid = lastDur >= rules.minBreakMinutes;
    breakSlots.push({ start: lastRef.toISOString(), end: now.toISOString(), durationMin: lastDur, valid, kind: "pause" });
    if (valid) validBreakMin += lastDur; else workMin += lastDur;
    breakMin += lastDur;
  } else if (session.status === "dejeuner") {
    breakSlots.push({ start: lastRef.toISOString(), end: now.toISOString(), durationMin: lastDur, valid: true, kind: "dejeuner" });
    dejeunerMin += lastDur;
  } else if (session.status === "school") {
    breakSlots.push({ start: lastRef.toISOString(), end: now.toISOString(), durationMin: lastDur, valid: false, kind: "school" });
    schoolMin += lastDur;
  } else {
    workMin += lastDur;
  }
  let timeSinceBreak: number | null = null;
  if (session.status === "working") {
    const last = [...events].reverse().find(e => e.type === "pause_end" || e.type === "dejeuner_end" || e.type === "school_end");
    timeSinceBreak = Math.floor((now.getTime() - new Date(last ? last.time : session.start_time).getTime()) / 60000);
  }
  return { amplitudeMin, workMin, breakMin, validBreakMin, dejeunerMin, schoolMin, timeSinceBreak, start, now, breakSlots };
}
