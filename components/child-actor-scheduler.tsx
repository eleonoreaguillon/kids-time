"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export type Period = "school" | "vacation";
export type AgeBand = "0-2" | "3-5" | "6-11" | "12-16" | "16-18";
export type ChildRole = "role" | "silhouette" | "figurant";

export interface Rules {
  maxWorkMinutes: Record<AgeBand, Record<Period, number>>;
  mandatoryBreakAfterMinutes: Record<AgeBand, Record<Period, number>>;
  maxAmplitudeMinutes: number;
  minBreakMinutes: number;
  minRestBetweenDays: number;
  maxDaysPerWeek: number;
}

export interface VacationPeriod { start: string; end: string; }
export interface Derogation { date: string; end_time: string; } // ex: { date: "2025-04-21", end_time: "23:00" }

export interface Child {
  id: string;
  project_id: string;
  first_name: string;
  last_name: string;
  dob: string;
  vacation_periods: VacationPeriod[];
  role?: ChildRole;
  archived?: boolean; // fix #3
  derogations?: Derogation[];
  school_tracking?: boolean; // active le bouton "📚 Suivi scolaire" pour cet enfant
}

export interface Group {
  id: string;
  project_id: string;
  name: string;
  child_ids: string[];
}

export interface SessionEvent { type: "pause_start" | "pause_end" | "dejeuner_start" | "dejeuner_end" | "school_start" | "school_end"; time: string; }

export interface Session {
  start_time?: string;
  end_time?: string;
  status?: "working" | "paused" | "dejeuner" | "school" | "done";
  events?: SessionEvent[];
}

export interface ShootingDay {
  id: string;
  project_id: string;
  date: string;
  child_ids: string[];
  sessions: Record<string, Session>;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  rules: Rules;
  created_at: string;
  children: Child[];
  groups: Group[];
  shootingDays: Record<string, ShootingDay>;
  share_token?: string | null;
  /** Indique seulement si un mot de passe est defini, jamais sa valeur. */
  share_password_set?: boolean;
}

export interface SessionStats {
  amplitudeMin: number;
  workMin: number;
  breakMin: number;
  validBreakMin: number;
  dejeunerMin: number;
  schoolMin: number;
  timeSinceBreak: number | null;
  start: Date;
  now: Date;
  breakSlots: { start: string; end: string; durationMin: number; valid: boolean; kind: "pause" | "dejeuner" | "school" }[];
}

const DEFAULT_RULES: Rules = {
  maxWorkMinutes: {
    "0-2":  { school: 60,  vacation: 60  },
    "3-5":  { school: 120, vacation: 120 },
    "6-11": { school: 180, vacation: 240 },
    "12-16":{ school: 240, vacation: 360 },
    // 16-18 (revolus) : 8h/jour (Code du travail, mineurs >= 16 ans)
    "16-18":{ school: 480, vacation: 480 },
  },
  mandatoryBreakAfterMinutes: {
    "0-2":  { school: 30,  vacation: 30  },
    "3-5":  { school: 60,  vacation: 60  },
    "6-11": { school: 90,  vacation: 120 },
    "12-16":{ school: 120, vacation: 180 },
    // 16-18 : pause obligatoire de 30 min apres 4h30 de travail continu
    "16-18":{ school: 270, vacation: 270 },
  },
  maxAmplitudeMinutes: 480,
  minBreakMinutes: 15,
  minRestBetweenDays: 840,
  maxDaysPerWeek: 5,
};

const AGE_BANDS: AgeBand[] = ["0-2", "3-5", "6-11", "12-16", "16-18"];
export const AGE_BAND_LABELS: Record<AgeBand, string> = {
  "0-2": "< 3 ans", "3-5": "3-5 ans", "6-11": "6-11 ans", "12-16": "12-15 ans", "16-18": "16-17 ans",
};
// Repos quotidien minimum (en minutes) : 14h pour < 16 ans, 12h pour 16-18
const MIN_DAILY_REST_BY_BAND: Record<AgeBand, number> = {
  "0-2": 14 * 60, "3-5": 14 * 60, "6-11": 14 * 60, "12-16": 14 * 60, "16-18": 12 * 60,
};
// Heure par defaut au-dela de laquelle le travail necessite une derogation
const DEFAULT_NIGHT_LIMIT_BY_BAND: Record<AgeBand, string> = {
  "0-2": "20:00", "3-5": "20:00", "6-11": "20:00", "12-16": "20:00",
  // 16-18 : derogation requise pour travailler entre 22h et minuit
  "16-18": "22:00",
};
export const ROLE_LABELS: Record<ChildRole, string> = { role: "Rôle", silhouette: "Silhouette", figurant: "Figurant·e" };
export const ROLE_COLORS: Record<ChildRole, string> = {
  role:       "bg-purple-900/40 text-purple-300 border-purple-700",
  silhouette: "bg-cyan-900/40 text-cyan-300 border-cyan-700",
  figurant:   "bg-orange-900/40 text-orange-300 border-orange-700",
};
export const ALL_ROLES: ChildRole[] = ["role", "silhouette", "figurant"];

// Tri des enfants : Rôle → Silhouette → Figurant → (sans statut), puis alphabétique
const ROLE_ORDER: Record<string, number> = { role: 0, silhouette: 1, figurant: 2 };
export function sortByRoleThenAlpha(cs: Child[]): Child[] {
  return [...cs].sort((a, b) => {
    const ra = ROLE_ORDER[a.role ?? ""] ?? 3, rb = ROLE_ORDER[b.role ?? ""] ?? 3;
    if (ra !== rb) return ra - rb;
    return `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, "fr");
  });
}

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
  return "16-18"; // >= 16 (les 18+ ne sont plus mineurs mais on les rattache
                  // a cette tranche : un message majeur·e est affiche en UI)
}
export function isMinor(dob: string): boolean { return getAge(dob) < 18; }

// Assure que toutes les bandes d'age sont presentes dans rules (retro-compat
// pour les projets crees avant l'ajout de "16-18").
export function normalizeRules(rules: Rules): Rules {
  const next: any = JSON.parse(JSON.stringify(rules));
  for (const band of AGE_BANDS) {
    if (!next.maxWorkMinutes[band]) next.maxWorkMinutes[band] = { ...DEFAULT_RULES.maxWorkMinutes[band] };
    if (!next.mandatoryBreakAfterMinutes[band]) next.mandatoryBreakAfterMinutes[band] = { ...DEFAULT_RULES.mandatoryBreakAfterMinutes[band] };
  }
  return next as Rules;
}
export function formatMinutes(min: number | null | undefined): string {
  if (min == null || isNaN(min)) return "0min";
  const h = Math.floor(Math.abs(min) / 60), m = Math.abs(min) % 60, s = min < 0 ? "-" : "";
  if (h === 0) return `${s}${m}min`; if (m === 0) return `${s}${h}h`;
  return `${s}${h}h${String(m).padStart(2, "0")}`;
}
export function formatTime(v: string | Date | undefined): string {
  if (!v) return "--:--";
  return new Date(v).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
export function isVacation(child: Child, dateStr: string): boolean {
  return (child.vacation_periods || []).some(p => dateStr >= p.start && dateStr <= p.end);
}
function todayStr(): string { return new Date().toISOString().slice(0, 10); }
function nowISO(): string   { return new Date().toISOString(); }
function timeStrToISO(dateStr: string, timeStr: string): string {
  return new Date(`${dateStr}T${timeStr}:00`).toISOString();
}
function isoToTimeStr(iso: string | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
function normalize(s: string): string {
  return s.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function splitFullName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}
function detectRole(val: string): ChildRole | null {
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
function parseExcelDate(val: any): string {
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
function guessColumn(headers: string[], candidates: string[]): string | null {
  const normalized = headers.map(x => normalize(x || ""));
  for (const cand of candidates) {
    const nc = normalize(cand);
    const idx = normalized.findIndex(x => x === nc || x.includes(nc) || nc.includes(x));
    if (idx !== -1) return headers[idx];
  }
  return null;
}
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

// ─── Export helpers ──────────────────────────────────────────────────────────
export function buildExportRows(project: Project, dateStr: string) {
  const day = project.shootingDays[dateStr]; if (!day) return [];
  const rows: any[] = [];
  // Tri statut → nom de famille (alpha) pour des exports cohérents avec l'écran
  const orderedChildren = sortByRoleThenAlpha((day.child_ids || []).map(id => project.children.find(c => c.id === id)).filter(Boolean) as Child[]);
  for (const child of orderedChildren) {
    const childId = child.id;
    const session = day.sessions?.[childId];
    const vacation = isVacation(child, dateStr);
    const band = getAgeBand(child.dob);
    const period: Period = vacation ? "vacation" : "school";
    const maxWork = project.rules.maxWorkMinutes[band][period];
    const maxAmp = project.rules.maxAmplitudeMinutes;
    const stats = computeSessionStats(session, project.rules);
    const workOver = stats ? Math.max(0, stats.workMin - maxWork) : 0;
    const ampOver = stats ? Math.max(0, stats.amplitudeMin - maxAmp) : 0;
    const breakSlotsStr = stats?.breakSlots.filter(b => b.valid && b.kind === "pause").map(b => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join(" / ") || "--";
    const dejeunerSlotsStr = stats?.breakSlots.filter(b => b.kind === "dejeuner").map(b => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join(" / ") || "--";
    const schoolSlotsStr = stats?.breakSlots.filter(b => b.kind === "school").map(b => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join(" / ") || "--";
    rows.push({
      "Nom Prénom": `${child.first_name} ${child.last_name}`.trim(),
      "Statut": child.role ? ROLE_LABELS[child.role] : "--",
      "Date de naissance": child.dob, "Tranche d'âge": band,
      "Période": vacation ? "Vacances" : "Scolaire",
      "Heure de convocation": session?.start_time ? formatTime(session.start_time) : "--",
      "Heure de fin": session?.end_time ? formatTime(session.end_time) : "--",
      "Durée totale de travail": stats ? formatMinutes(stats.workMin) : "--",
      "Temps de travail autorisé": formatMinutes(maxWork),
      "Dépassement travail": workOver > 0 ? formatMinutes(workOver) : "0",
      "Pause déjeuner": stats ? formatMinutes(stats.dejeunerMin) : "--",
      "Plages déjeuner": dejeunerSlotsStr,
      "Suivi scolaire": stats ? formatMinutes(stats.schoolMin) : "--",
      "Plages suivi scolaire": schoolSlotsStr,
      "Durée totale des pauses": stats ? formatMinutes(stats.breakMin) : "--",
      "Pauses valides": stats ? formatMinutes(stats.validBreakMin) : "--",
      "Plages horaires des pauses": breakSlotsStr,
      "Amplitude de présence": stats ? formatMinutes(stats.amplitudeMin) : "--",
      "Amplitude autorisée": formatMinutes(maxAmp),
      "Dépassement amplitude": ampOver > 0 ? formatMinutes(ampOver) : "0",
      _child: child, _session: session, _stats: stats, _maxWork: maxWork, _maxAmp: maxAmp, _vacation: vacation, _band: band, _date: dateStr,
    });
  }
  return rows;
}

export function exportDayToXLSX(project: Project, dateStr: string) {
  const day = project.shootingDays[dateStr]; if (!day) return;
  const allRows = buildExportRows(project, dateStr);
  const clean = (rows: any[]) => rows.map(r => { const o: any = {}; for (const k of Object.keys(r)) { if (!k.startsWith("_")) o[k] = r[k]; } return o; });
  const headers = Object.keys(allRows[0] || {}).filter(k => !k.startsWith("_"));
  const toCsv = (rows: any[]) => [headers.join(";"), ...rows.map(r => headers.map(h => `"${String(r[h] || "").replace(/"/g, '""')}"`).join(";"))].join("\n");
  if (typeof window !== "undefined" && (window as any).XLSX) {
    const XLSX = (window as any).XLSX; const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(clean(allRows)), "Tous");
    for (const role of ALL_ROLES) { const rr = allRows.filter(r => r._child?.role === role); if (rr.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(clean(rr)), ROLE_LABELS[role]); }
    const nr = allRows.filter(r => !r._child?.role); if (nr.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(clean(nr)), "Non défini");
    XLSX.writeFile(wb, `KidsTime_${dateStr}_${project.name}.xlsx`);
  } else {
    const blob = new Blob(["\uFEFF" + toCsv(allRows)], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `KidsTime_${dateStr}_${project.name}.csv`; a.click(); URL.revokeObjectURL(url);
  }
}

// Fix #8: PDF opens in new tab with a back button via postMessage / history
export function exportDayToPDF(project: Project, dateStr: string) {
  const day = project.shootingDays[dateStr]; if (!day) return;
  const dateLabel = new Date(dateStr + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const childTable = (row: any) => {
    const { _child: child, _session: session, _stats: stats, _maxWork: maxWork, _maxAmp: maxAmp, _vacation: vacation, _band: band } = row;
    const workOver = stats ? Math.max(0, stats.workMin - maxWork) : 0;
    const ampOver = stats ? Math.max(0, stats.amplitudeMin - maxAmp) : 0;
    const bStr = stats?.breakSlots.filter((b: any) => b.valid && b.kind === "pause").map((b: any) => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join("<br>") || "--";
    const dStr = stats?.breakSlots.filter((b: any) => b.kind === "dejeuner").map((b: any) => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join("<br>") || "--";
    const sStr = stats?.breakSlots.filter((b: any) => b.kind === "school").map((b: any) => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join("<br>") || "--";
    const showSchool = child.school_tracking || (stats && stats.schoolMin > 0);
    return `<table><tr><th colspan="4">${child.first_name} ${child.last_name}${child.role ? ` — ${ROLE_LABELS[child.role as ChildRole]}` : ""} — ${getAge(child.dob)} ans (${band} ans) — ${vacation ? "Vacances" : "Scolaire"}</th></tr>
      <tr><td><b>Convocation</b><br>${session?.start_time ? formatTime(session.start_time) : "--"}</td><td><b>Fin</b><br>${session?.end_time ? formatTime(session.end_time) : "--"}</td><td><b>Amplitude</b><br>${stats ? formatMinutes(stats.amplitudeMin) : "--"}</td><td><b>Max amplitude</b><br>${formatMinutes(maxAmp)}</td></tr>
      <tr><td><b>Travail total</b><br>${stats ? formatMinutes(stats.workMin) : "--"}</td><td><b>Max travail</b><br>${formatMinutes(maxWork)}</td><td><b>Dépass. travail</b><br><span class="${workOver > 0 ? "over" : "ok"}">${workOver > 0 ? formatMinutes(workOver) : "OK"}</span></td><td><b>Dépass. amplitude</b><br><span class="${ampOver > 0 ? "over" : "ok"}">${ampOver > 0 ? formatMinutes(ampOver) : "OK"}</span></td></tr>
      <tr><td><b>🍽 Déjeuner</b><br>${stats ? formatMinutes(stats.dejeunerMin) : "--"}</td><td><b>Plages déjeuner</b><br>${dStr}</td><td><b>Pauses valides</b><br>${stats ? formatMinutes(stats.validBreakMin) : "--"}</td><td><b>Plages de pauses</b><br>${bStr}</td></tr>
      ${showSchool ? `<tr><td><b>📚 Suivi scolaire</b><br>${stats ? formatMinutes(stats.schoolMin) : "--"}</td><td colspan="3"><b>Plages suivi scolaire</b><br>${sStr}</td></tr>` : ""}</table>`;
  };
  const allRows = buildExportRows(project, dateStr);
  // Fix #8: add a visible ← Retour button in the PDF page
  let html = `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:Arial,sans-serif;font-size:11px;color:#111;padding:16px}
    .back-btn{display:inline-block;margin-bottom:16px;padding:8px 16px;background:#1e3a5f;color:white;border:none;border-radius:8px;font-size:13px;cursor:pointer;text-decoration:none}
    h1{font-size:16px;margin-bottom:4px}h2{font-size:12px;color:#444;margin-bottom:12px;font-weight:normal}
    h3{font-size:11px;color:#1e3a5f;border-bottom:2px solid #1e3a5f;padding-bottom:3px;margin:16px 0 8px}
    table{width:100%;border-collapse:collapse;margin-bottom:12px}
    th{background:#1e3a5f;color:white;padding:5px 6px;text-align:left;font-size:9px}
    td{padding:4px 6px;border-bottom:1px solid #e5e7eb;vertical-align:top;font-size:9px}
    tr:nth-child(even) td{background:#f8fafc}.over{color:#dc2626;font-weight:bold}.ok{color:#16a34a}
    .footer{margin-top:20px;font-size:8px;color:#999;text-align:center}
    @media print{.back-btn{display:none}}
  </style></head><body>
  <button class="back-btn" onclick="window.close()">← Retour</button>
  <h1>KidsTime — Récapitulatif par enfant</h1><h2>${dateLabel} · ${project.name}</h2>`;
  for (const role of ALL_ROLES) { const rr = allRows.filter(r => r._child?.role === role); if (rr.length > 0) { html += `<h3>${ROLE_LABELS[role]} (${rr.length})</h3>`; html += rr.map(childTable).join(""); } }
  const nr = allRows.filter(r => !r._child?.role); if (nr.length > 0) { html += `<h3>Statut non défini (${nr.length})</h3>`; html += nr.map(childTable).join(""); }
  html += `<div class="footer">Généré par KidsTime · Éléonore Aguillon · ACMA Fiction · ${new Date().toLocaleDateString("fr-FR")}</div></body></html>`;
  const w = window.open("", "_blank"); if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 500); }
}

// Fix #4: export all days for a single child
export function exportChildAllDays(project: Project, child: Child) {
  const days = Object.entries(project.shootingDays)
    .filter(([, day]) => day.child_ids?.includes(child.id))
    .sort(([a], [b]) => a.localeCompare(b));
  if (days.length === 0) { alert("Cet enfant n'a aucune journée enregistrée."); return; }

  const childTable = (dateStr: string, day: ShootingDay) => {
    const session = day.sessions?.[child.id];
    const vacation = isVacation(child, dateStr);
    const band = getAgeBand(child.dob);
    const period: Period = vacation ? "vacation" : "school";
    const maxWork = project.rules.maxWorkMinutes[band][period];
    const maxAmp = project.rules.maxAmplitudeMinutes;
    const stats = computeSessionStats(session, project.rules);
    const workOver = stats ? Math.max(0, stats.workMin - maxWork) : 0;
    const ampOver = stats ? Math.max(0, stats.amplitudeMin - maxAmp) : 0;
    const bStr = stats?.breakSlots.filter(b => b.valid && b.kind === "pause").map((b) => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join(", ") || "--";
    const dStr = stats?.breakSlots.filter(b => b.kind === "dejeuner").map((b) => `🍽 ${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join(", ") || "--";
    const sStr = stats?.breakSlots.filter(b => b.kind === "school").map((b) => `📚 ${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join(", ") || "--";
    const dateLabel = new Date(dateStr + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
    return `<tr>
      <td>${dateLabel}</td>
      <td>${vacation ? "🌴 Vac." : "🏫 Scol."}</td>
      <td>${session?.start_time ? formatTime(session.start_time) : "--"}</td>
      <td>${session?.end_time ? formatTime(session.end_time) : "--"}</td>
      <td><span style="color:${ampOver > 0 ? "#dc2626" : stats && stats.amplitudeMin === maxAmp ? "#ea580c" : "#16a34a"}">${stats ? formatMinutes(stats.amplitudeMin) : "--"} / ${formatMinutes(maxAmp)}</span></td>
      <td><span style="color:${workOver > 0 ? "#dc2626" : "#16a34a"}">${stats ? formatMinutes(stats.workMin) : "--"} / ${formatMinutes(maxWork)}</span></td>
      <td>${stats ? formatMinutes(stats.dejeunerMin) : "--"}</td>
      ${child.school_tracking ? `<td>${stats ? formatMinutes(stats.schoolMin) : "--"}</td>` : ""}
      <td>${stats ? formatMinutes(stats.validBreakMin) : "--"}</td>
      <td style="font-size:8px">${dStr ? dStr + " | " : ""}${bStr}${child.school_tracking && stats && stats.schoolMin > 0 ? " | " + sStr : ""}</td>
    </tr>`;
  };

  let html = `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:Arial,sans-serif;font-size:10px;padding:16px}
  .back-btn{display:inline-block;margin-bottom:16px;padding:8px 16px;background:#1e3a5f;color:white;border:none;border-radius:8px;font-size:13px;cursor:pointer}
  h1{font-size:16px}h2{font-size:12px;color:#444;font-weight:normal;margin-bottom:12px}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th{background:#1e3a5f;color:white;padding:5px 6px;text-align:left;font-size:9px}
  td{padding:4px 6px;border-bottom:1px solid #e5e7eb;vertical-align:top}
  tr:nth-child(even) td{background:#f8fafc}
  .footer{margin-top:20px;font-size:8px;color:#999;text-align:center}
  @media print{.back-btn{display:none}}</style></head><body>
  <button class="back-btn" onclick="window.close()">← Retour</button>
  <h1>KidsTime — Journées de ${child.first_name} ${child.last_name}</h1>
  <h2>${child.role ? ROLE_LABELS[child.role] + " · " : ""}${getAge(child.dob)} ans · Tranche ${AGE_BAND_LABELS[getAgeBand(child.dob)]} · ${project.name}</h2>
  <table><thead><tr>
    <th>Date</th><th>Période</th><th>Début</th><th>Fin</th><th>Amplitude</th><th>Travail / Max</th><th>🍽 Déjeuner</th>${child.school_tracking ? "<th>📚 Suivi sco.</th>" : ""}<th>Pauses valides</th><th>Plages déjeuner / pauses${child.school_tracking ? " / sco." : ""}</th>
  </tr></thead><tbody>`;
  for (const [dateStr, day] of days) { html += childTable(dateStr, day); }
  html += `</tbody></table>
  <div class="footer">Généré par KidsTime · Éléonore Aguillon · ACMA Fiction · ${new Date().toLocaleDateString("fr-FR")}</div></body></html>`;
  const w = window.open("", "_blank"); if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 500); }
}

// Fix #5 + #6: export global project recap (one row per child per day + summary tab)
export function exportProjectGlobal(project: Project) {
  const sortedDates = Object.keys(project.shootingDays).sort();
  if (sortedDates.length === 0) { alert("Aucune journée de tournage dans ce projet."); return; }

  // Build global summary table: one row per (child, day)
  const allRows: any[] = [];
  for (const dateStr of sortedDates) {
    const day = project.shootingDays[dateStr];
    const orderedChildren = sortByRoleThenAlpha((day.child_ids || []).map(id => project.children.find(c => c.id === id)).filter(Boolean) as Child[]);
    for (const child of orderedChildren) {
      const childId = child.id;
      const session = day.sessions?.[childId];
      const vacation = isVacation(child, dateStr);
      const band = getAgeBand(child.dob);
      const period: Period = vacation ? "vacation" : "school";
      const maxWork = project.rules.maxWorkMinutes[band][period];
      const maxAmp = project.rules.maxAmplitudeMinutes;
      const stats = computeSessionStats(session, project.rules);
      const workOver = stats ? Math.max(0, stats.workMin - maxWork) : 0;
      const ampOver = stats ? Math.max(0, stats.amplitudeMin - maxAmp) : 0;
      allRows.push({
        "Date": dateStr,
        "Nom Prénom": `${child.first_name} ${child.last_name}`.trim(),
        "Statut": child.role ? ROLE_LABELS[child.role] : "--",
        "Tranche d'âge": band,
        "Période": vacation ? "Vacances" : "Scolaire",
        "Convocation": session?.start_time ? formatTime(session.start_time) : "--",
        "Fin": session?.end_time ? formatTime(session.end_time) : "--",
        "Travail": stats ? formatMinutes(stats.workMin) : "--",
        "Max travail": formatMinutes(maxWork),
        "Dépass. travail": workOver > 0 ? formatMinutes(workOver) : "OK",
        "Amplitude": stats ? formatMinutes(stats.amplitudeMin) : "--",
        "Max amplitude": formatMinutes(maxAmp),
        "Dépass. amplitude": ampOver > 0 ? formatMinutes(ampOver) : "OK",
        "Pauses valides": stats ? formatMinutes(stats.validBreakMin) : "--",
        "Pauses totales": stats ? formatMinutes(stats.breakMin) : "--",
        "Suivi scolaire": stats ? formatMinutes(stats.schoolMin) : "--",
      });
    }
  }

  if (typeof window !== "undefined" && (window as any).XLSX) {
    const XLSX = (window as any).XLSX; const wb = XLSX.utils.book_new();
    // Sheet 1: all rows
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allRows), "Récapitulatif global");
    // Sheet 2: per child summary (total across all days)
    const childSummary: any[] = [];
    for (const child of sortByRoleThenAlpha(project.children.filter(c => !c.archived))) {
      const childDays = sortedDates.filter(d => project.shootingDays[d]?.child_ids?.includes(child.id));
      if (childDays.length === 0) continue;
      let totalWork = 0, totalBreak = 0, totalAmp = 0, totalSchool = 0, depassWork = 0, depassAmp = 0;
      for (const dateStr of childDays) {
        const day = project.shootingDays[dateStr];
        const session = day.sessions?.[child.id];
        const vacation = isVacation(child, dateStr);
        const band = getAgeBand(child.dob);
        const period: Period = vacation ? "vacation" : "school";
        const maxWork = project.rules.maxWorkMinutes[band][period];
        const maxAmp = project.rules.maxAmplitudeMinutes;
        const stats = computeSessionStats(session, project.rules);
        if (stats) { totalWork += stats.workMin; totalBreak += stats.validBreakMin; totalAmp += stats.amplitudeMin; totalSchool += stats.schoolMin; depassWork += Math.max(0, stats.workMin - maxWork); depassAmp += Math.max(0, stats.amplitudeMin - maxAmp); }
      }
      childSummary.push({
        "Nom Prénom": `${child.first_name} ${child.last_name}`.trim(),
        "Statut": child.role ? ROLE_LABELS[child.role] : "--",
        "Tranche d'âge": getAgeBand(child.dob),
        "Nb journées": childDays.length,
        "Total travail": formatMinutes(totalWork),
        "Total amplitude": formatMinutes(totalAmp),
        "Total pauses valides": formatMinutes(totalBreak),
        "Total suivi scolaire": formatMinutes(totalSchool),
        "Total dépass. travail": depassWork > 0 ? formatMinutes(depassWork) : "OK",
        "Total dépass. amplitude": depassAmp > 0 ? formatMinutes(depassAmp) : "OK",
      });
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(childSummary), "Par enfant");
    XLSX.writeFile(wb, `KidsTime_Projet_${project.name}.xlsx`);
  } else {
    // CSV fallback
    const headers = Object.keys(allRows[0] || []);
    const csv = [headers.join(";"), ...allRows.map(r => headers.map(h => `"${String(r[h] || "").replace(/"/g, '""')}"`).join(";"))].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `KidsTime_Projet_${project.name}.csv`; a.click(); URL.revokeObjectURL(url);
  }
}

// Fix #6: PDF global recap — one section per child, dates as columns (format DRIEETS)
export function exportProjectGlobalPDF(project: Project) {
  const sortedDates = Object.keys(project.shootingDays).sort();
  if (sortedDates.length === 0) { alert("Aucune journée de tournage dans ce projet."); return; }

  const fmtHHMM = (min: number | null | undefined): string => {
    if (!min || min <= 0) return "";
    const h = Math.floor(min / 60), m = min % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };
  const DAY_LETTERS = ["D","L","M","M","J","V","S"];
  const MONTH_NAMES = ["JANVIER","FÉVRIER","MARS","AVRIL","MAI","JUIN","JUILLET","AOÛT","SEPTEMBRE","OCTOBRE","NOVEMBRE","DÉCEMBRE"];

  const monthSpans: { month: string; count: number }[] = [];
  for (const d of sortedDates) {
    const month = MONTH_NAMES[new Date(d + "T12:00:00").getMonth()];
    if (!monthSpans.length || monthSpans[monthSpans.length - 1].month !== month) monthSpans.push({ month, count: 1 });
    else monthSpans[monthSpans.length - 1].count++;
  }

  const TH  = (bg: string) => `style="background:${bg};color:white;border:1px solid #bbb;text-align:center;font-size:7px;padding:3px 2px"`;
  const TDL = `style="text-align:left;padding:3px 6px;border:1px solid #ccc;font-size:8px;background:#f4f6fb;white-space:nowrap"`;
  const TDV = (extra="") => `style="text-align:center;padding:2px 3px;border:1px solid #ccc;font-size:8px;${extra}"`;
  const TDT = (extra="") => `style="text-align:center;padding:2px 4px;border:1px solid #ccc;font-weight:bold;font-size:8px;background:#e8eef8;${extra}"`;

  const headerMonths = monthSpans.map(s => `<th colspan="${s.count}" ${TH("#1e3a5f")}>${s.month}</th>`).join("");
  const headerJours  = sortedDates.map(d => `<th ${TH("#2d4a6f")}>${DAY_LETTERS[new Date(d+"T12:00:00").getDay()]}</th>`).join("");
  const headerDates  = sortedDates.map(d => `<th ${TH("#3d5a7f")}>${new Date(d+"T12:00:00").getDate()}</th>`).join("");

  let html = `<html><head><meta charset="utf-8">
  <style>
    body{font-family:Arial,sans-serif;font-size:8px;padding:12px;color:#111}
    .back-btn{display:inline-block;margin-bottom:12px;padding:8px 16px;background:#1e3a5f;color:white;border:none;border-radius:8px;font-size:13px;cursor:pointer}
    h1{font-size:14px;margin-bottom:2px}h2{font-size:10px;color:#444;font-weight:normal;margin-bottom:10px}
    .child-block{margin-bottom:24px;page-break-inside:avoid}
    table{border-collapse:collapse}
    .over{color:#dc2626;font-weight:bold}
    .footer{margin-top:16px;font-size:7px;color:#999;text-align:center}
    @media print{.back-btn{display:none}}
  </style></head><body>
  <button class="back-btn" onclick="window.close()">← Retour</button>
  <h1>KidsTime — Récapitulatif global</h1>
  <h2>${project.name} · Généré le ${new Date().toLocaleDateString("fr-FR")}</h2>`;

  for (const child of sortByRoleThenAlpha(project.children.filter(c => !c.archived))) {
    type DayData = { inDay: boolean; session?: Session; vacation: boolean; maxWork: number; maxAmp: number; stats: SessionStats | null };
    const dd: Record<string, DayData> = {};
    for (const dateStr of sortedDates) {
      const day = project.shootingDays[dateStr];
      const inDay = (day.child_ids || []).includes(child.id);
      const vacation = isVacation(child, dateStr);
      const band = getAgeBand(child.dob);
      const period: Period = vacation ? "vacation" : "school";
      dd[dateStr] = {
        inDay, vacation,
        session: inDay ? day.sessions?.[child.id] : undefined,
        maxWork: project.rules.maxWorkMinutes[band][period],
        maxAmp: project.rules.maxAmplitudeMinutes,
        stats: inDay ? computeSessionStats(day.sessions?.[child.id], project.rules) : null,
      };
    }
    const childDates = sortedDates.filter(d => dd[d].inDay);
    if (childDates.length === 0) continue;

    let totWork = 0, totDejeuner = 0, totValidPause = 0, totSchool = 0, totAmp = 0, totWorkOver = 0, totAmpOver = 0;
    for (const d of childDates) {
      const { stats, maxWork, maxAmp } = dd[d];
      if (stats) {
        totWork += stats.workMin; totDejeuner += stats.dejeunerMin;
        totValidPause += stats.validBreakMin;
        totSchool += stats.schoolMin;
        totAmp += stats.amplitudeMin;
        totWorkOver += Math.max(0, stats.workMin - maxWork);
        totAmpOver  += Math.max(0, stats.amplitudeMin - maxAmp);
      }
    }

    const cells = (fn: (d: DayData) => string) =>
      sortedDates.map(ds => {
        const d = dd[ds];
        if (!d.inDay) return `<td ${TDV(d.vacation ? "background:#fffbeb" : "")}></td>`;
        return `<td ${TDV(d.vacation ? "background:#fffbeb" : "")}>${fn(d)}</td>`;
      }).join("");

    html += `<div class="child-block"><table>
      <thead>
        <tr>
          <td ${TDL} style="text-align:left;padding:3px 6px;border:1px solid #ccc;font-size:8px;background:#1e3a5f;color:white;font-weight:bold;white-space:nowrap">
            ${child.first_name} ${child.last_name}${child.role ? ` — ${ROLE_LABELS[child.role]}` : ""}&nbsp;(${childDates.length} jour${childDates.length > 1 ? "s" : ""})
          </td>
          <th ${TH("#374151")}>TOTAL</th>${headerMonths}
        </tr>
        <tr>
          <td ${TDL} style="text-align:left;padding:2px 6px;border:1px solid #ccc;font-size:7px;color:#666;background:#f4f6fb">JOUR</td>
          <td ${TDV()}></td>${headerJours}
        </tr>
        <tr>
          <td ${TDL} style="text-align:left;padding:2px 6px;border:1px solid #ccc;font-size:7px;color:#666;background:#f4f6fb">DATE</td>
          <td ${TDV()}></td>${headerDates}
        </tr>
        <tr>
          <td ${TDL} style="text-align:left;padding:2px 6px;border:1px solid #ccc;font-size:7px;color:#b45309;background:#fffbeb">VACANCES</td>
          <td ${TDV()}></td>
          ${sortedDates.map(ds => `<td ${TDV(dd[ds].inDay && dd[ds].vacation ? "background:#fffbeb;color:#b45309;font-weight:bold" : "")}>${dd[ds].inDay && dd[ds].vacation ? "VAC" : ""}</td>`).join("")}
        </tr>
      </thead>
      <tbody>
        <tr><td ${TDL}>Heure de convocation</td><td ${TDT()}></td>${cells(d => d.session?.start_time ? formatTime(d.session.start_time) : "")}</tr>
        <tr><td ${TDL}>Durée de pause déjeuner</td><td ${TDT()}></td>${cells(d => fmtHHMM(d.stats?.dejeunerMin ?? 0))}</tr>
        <tr><td ${TDL}>Durée des autres pauses</td><td ${TDT()}></td>${cells(d => fmtHHMM(d.stats?.validBreakMin ?? 0))}</tr>
        ${child.school_tracking || totSchool > 0 ? `<tr><td ${TDL}>📚 Suivi scolaire</td><td ${TDT()}>${fmtHHMM(totSchool)}</td>${cells(d => fmtHHMM(d.stats?.schoolMin ?? 0))}</tr>` : ""}
        <tr>
          <td ${TDL} style="text-align:left;padding:3px 6px;border:1px solid #ccc;font-size:8px;background:#f4f6fb;font-weight:bold;white-space:nowrap">Durée totale de travail (plateau, HMC, attente)</td>
          <td ${TDT()}></td>
          ${cells(d => `<b>${fmtHHMM(d.stats?.workMin ?? 0)}</b>`)}
        </tr>
        <tr><td ${TDL}>Heure de fin de journée</td><td ${TDT()}></td>${cells(d => d.session?.end_time ? formatTime(d.session.end_time) : "")}</tr>
        <tr><td ${TDL}>Temps de travail autorisé</td><td ${TDT()}></td>${cells(d => fmtHHMM(d.maxWork))}</tr>
        <tr>
          <td ${TDL} style="text-align:left;padding:3px 6px;border:1px solid #ccc;font-size:8px;background:#fff5f5;color:#dc2626;white-space:nowrap">Dépassement temps de travail</td>
          <td ${TDT(totWorkOver > 0 ? "color:#dc2626" : "")}>${fmtHHMM(totWorkOver)}</td>
          ${cells(d => { const ov = Math.max(0,(d.stats?.workMin??0)-d.maxWork); return ov>0?`<span class="over">${fmtHHMM(ov)}</span>`:""; })}
        </tr>
        <tr>
          <td ${TDL} style="text-align:left;padding:3px 6px;border:1px solid #ccc;font-size:8px;background:#f4f6fb;font-weight:bold;white-space:nowrap">Amplitude de présence</td>
          <td ${TDT()}></td>
          ${cells(d => { const amp = d.stats?.amplitudeMin ?? 0; const over = amp > d.maxAmp; const warn = amp === d.maxAmp && amp > 0; return `<b style="color:${over ? "#dc2626" : warn ? "#ea580c" : "inherit"}">${fmtHHMM(amp)}</b>`; })}
        </tr>
        <tr><td ${TDL}>Amplitude autorisée</td><td ${TDT()}></td>${cells(d => fmtHHMM(d.maxAmp))}</tr>
        <tr>
          <td ${TDL} style="text-align:left;padding:3px 6px;border:1px solid #ccc;font-size:8px;background:#fff5f5;color:#dc2626;white-space:nowrap">Dépassement amplitude</td>
          <td ${TDT(totAmpOver > 0 ? "color:#dc2626" : "")}>${fmtHHMM(totAmpOver)}</td>
          ${cells(d => { const ov = Math.max(0,(d.stats?.amplitudeMin??0)-d.maxAmp); return ov>0?`<span class="over">${fmtHHMM(ov)}</span>`:""; })}
        </tr>
      </tbody>
    </table></div>`;
  }

  html += `<div class="footer">Généré par KidsTime · Éléonore Aguillon · ACMA Fiction · ${new Date().toLocaleDateString("fr-FR")}</div></body></html>`;
  const w = window.open("", "_blank"); if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 500); }
}

// ─── UI Primitives ────────────────────────────────────────────────────────────
type BadgeColor = "green" | "red" | "amber" | "blue" | "slate" | "purple" | "cyan" | "orange";
function Badge({ children, color = "slate" }: { children: React.ReactNode; color?: BadgeColor }) {
  const cls: Record<BadgeColor, string> = {
    green: "bg-emerald-900/40 text-emerald-300 border-emerald-700", red: "bg-red-900/40 text-red-300 border-red-700",
    amber: "bg-amber-900/40 text-amber-300 border-amber-700", blue: "bg-blue-900/40 text-blue-300 border-blue-700",
    slate: "bg-slate-700/60 text-slate-300 border-slate-600", purple: "bg-purple-900/40 text-purple-300 border-purple-700",
    cyan: "bg-cyan-900/40 text-cyan-300 border-cyan-700", orange: "bg-orange-900/40 text-orange-300 border-orange-700",
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${cls[color]}`}>{children}</span>;
}
function RoleBadge({ role }: { role?: ChildRole }) {
  if (!role) return null;
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${ROLE_COLORS[role]}`}>{ROLE_LABELS[role]}</span>;
}
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4" onClick={onClose}>
      <div className="bg-[#0c1420] border border-slate-700 rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-slate-700/60">
          <h2 className="text-base font-bold text-white">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl leading-none w-10 h-10 flex items-center justify-center">×</button>
        </div>
        <div className="p-4 pb-8">{children}</div>
      </div>
    </div>
  );
}
function TextInput({ label, required: req, ...props }: { label?: string; required?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex flex-col gap-1">
      {label && <label className="text-[10px] text-slate-400 uppercase tracking-[0.15em] font-semibold flex items-center gap-1">{label}{req && <span className="text-red-400">*</span>}</label>}
      <input required={req} className="bg-slate-800/80 border border-slate-600 rounded-lg px-3 py-3 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors placeholder:text-slate-600" {...props} />
    </div>
  );
}
type BtnVariant = "primary" | "secondary" | "danger" | "ghost";
function Btn({ children, variant = "primary", className = "", ...props }: { children: React.ReactNode; variant?: BtnVariant; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const v: Record<BtnVariant, string> = {
    primary: "bg-blue-600 hover:bg-blue-500 text-white", secondary: "bg-slate-700 hover:bg-slate-600 text-white",
    danger: "bg-red-800 hover:bg-red-700 text-white", ghost: "text-slate-400 hover:text-white border border-slate-700 hover:border-slate-500",
  };
  return <button className={`px-4 py-3 rounded-xl text-sm font-semibold transition-colors ${v[variant]} ${className}`} {...props}>{children}</button>;
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState<any>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_ev, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);
  if (session === undefined) return <div className="min-h-screen bg-[#080d16] flex items-center justify-center"><div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;
  if (!session) return <AuthPage onAuth={setSession} />;
  return <MainApp session={session} onSignOut={() => supabase.auth.signOut()} />;
}

// Fix #2: persistent login — supabase handles session persistence by default via localStorage
// We also add autocomplete attributes so the browser/iPhone offers to save the password
function AuthPage({ onAuth }: { onAuth: (s: any) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState(""); const [pass, setPass] = useState("");
  const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(""); setLoading(true);
    try {
      if (mode === "login") { const { data, error } = await supabase.auth.signInWithPassword({ email, password: pass }); if (error) throw error; onAuth(data.session); }
      else { const { error } = await supabase.auth.signUp({ email, password: pass }); if (error) throw error; setError("✅ Compte créé ! Vérifiez votre e-mail puis connectez-vous."); setMode("login"); }
    } catch (err: any) { setError(err.message); } setLoading(false);
  }
  return (
    <div className="min-h-screen bg-[#080d16] flex flex-col items-center justify-center px-4" style={{ fontFamily: "'DM Mono', monospace" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap" rel="stylesheet" />
      <div className="fixed inset-0 opacity-[0.025]" style={{ backgroundImage: "linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)", backgroundSize: "40px 40px" }} />
      <div className="relative z-10 mb-8 text-center">
        <div className="text-[10px] text-blue-400 tracking-[0.4em] uppercase mb-2">Audiovisuel · Mineurs</div>
        <h1 className="text-5xl font-extrabold tracking-tight" style={{ fontFamily: "Syne, sans-serif" }}><span className="text-white">KIDS</span><span className="text-blue-500">TIME</span></h1>
        <div className="mt-4 max-w-sm mx-auto text-slate-400 text-sm leading-relaxed border-t border-slate-800 pt-4">
          Outil dédié aux coachs et responsables enfants dans l&apos;audiovisuel.
          <div className="mt-2 text-blue-400 font-semibold text-xs tracking-wider">Éléonore Aguillon · ACMA Fiction</div>
        </div>
      </div>
      <div className="relative z-10 w-full max-w-sm bg-slate-900/70 border border-slate-700 rounded-2xl p-6 backdrop-blur">
        <div className="flex mb-5 bg-slate-800 rounded-xl p-1">
          {(["login", "signup"] as const).map(m => <button key={m} onClick={() => { setMode(m); setError(""); }} className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all ${mode === m ? "bg-blue-600 text-white" : "text-slate-400 hover:text-white"}`}>{m === "login" ? "Connexion" : "Créer un compte"}</button>)}
        </div>
        {/* Fix #2: autocomplete attributes for password saving */}
        <form onSubmit={submit} className="space-y-3" autoComplete="on">
          <TextInput label="Adresse e-mail" type="email" autoComplete="email" placeholder="vous@exemple.com" value={email} onChange={e => setEmail(e.target.value)} required />
          <TextInput label="Mot de passe" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="••••••••" value={pass} onChange={e => setPass(e.target.value)} required />
          {error && <div className={`text-xs px-3 py-2 rounded-lg ${error.startsWith("✅") ? "bg-emerald-900/40 text-emerald-300" : "bg-red-900/40 text-red-300"}`}>{error}</div>}
          <button type="submit" disabled={loading} className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-3.5 rounded-xl font-bold text-sm transition-colors">{loading ? "Chargement…" : mode === "login" ? "Se connecter" : "Créer mon compte"}</button>
        </form>
      </div>
    </div>
  );
}

function MainApp({ session, onSignOut }: { session: any; onSignOut: () => void }) {
  const [view, setView] = useState<"home" | "project" | "shooting">("home");
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const userId = session.user.id;
  const notifiedRef = useRef<Set<string>>(new Set());

  // Demande la permission de notification (notif en avant-plan, sans push serveur)
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  // Notif quand on approche / dépasse le timing max pendant une journée en cours
  useEffect(() => {
    if (view !== "shooting" || !activeProject || !activeDate) return;
    const check = () => {
      const day = activeProject.shootingDays[activeDate];
      if (!day) return;
      for (const child of activeProject.children) {
        const session = day.sessions?.[child.id];
        if (!session?.start_time || session.status === "done") continue;
        const vacation = isVacation(child, activeDate);
        const band = getAgeBand(child.dob);
        const period: Period = vacation ? "vacation" : "school";
        const maxWork = activeProject.rules.maxWorkMinutes[band][period];
        const maxAmp = activeProject.rules.maxAmplitudeMinutes;
        const stats = computeSessionStats(session, activeProject.rules);
        if (!stats) continue;
        const name = `${child.first_name} ${child.last_name}`;
        const notify = (key: string, title: string, body: string) => {
          if (notifiedRef.current.has(key)) return;
          notifiedRef.current.add(key);
          if ("Notification" in window && Notification.permission === "granted") {
            try { new Notification(title, { body, icon: "/favicon.ico" }); } catch {}
          }
        };
        if (stats.workMin >= maxWork * 0.8 && stats.workMin < maxWork) {
          notify(`work-warn-${child.id}-${activeDate}`, "⚠ Temps de travail", `${name} approche du max (${formatMinutes(stats.workMin)} / ${formatMinutes(maxWork)})`);
        }
        if (stats.workMin >= maxWork) {
          notify(`work-over-${child.id}-${activeDate}`, "🔴 Dépassement travail", `${name} a dépassé le temps max de travail !`);
        }
        if (stats.amplitudeMin >= maxAmp * 0.9 && stats.amplitudeMin < maxAmp) {
          notify(`amp-warn-${child.id}-${activeDate}`, "⚠ Amplitude", `${name} approche de l'amplitude max (${formatMinutes(stats.amplitudeMin)} / ${formatMinutes(maxAmp)})`);
        }
        if (stats.amplitudeMin >= maxAmp) {
          notify(`amp-over-${child.id}-${activeDate}`, "🔴 Amplitude dépassée", `${name} a dépassé l'amplitude maximale !`);
        }
      }
    };
    check();
    const interval = setInterval(check, 60000);
    return () => clearInterval(interval);
  }, [view, activeProject, activeDate]);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from("projects").select("*").eq("user_id", userId).order("created_at");
    setProjects((data || []) as Project[]); setLoading(false);
  }, [userId]);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  async function loadFullProject(id: string): Promise<Project> {
    const [{ data: proj }, { data: children }, { data: groups }, { data: days }] = await Promise.all([
      supabase.from("projects").select("*").eq("id", id).single(),
      supabase.from("children").select("*").eq("project_id", id),
      supabase.from("groups").select("*").eq("project_id", id),
      supabase.from("shooting_days").select("*").eq("project_id", id),
    ]);
    const shootingDays: Record<string, ShootingDay> = {};
    (days || []).forEach((d: ShootingDay) => { shootingDays[d.date] = d; });
    const mappedChildren = (children || []).map((c: any) => ({ ...c, role: c.child_role ?? undefined }));
    // Derive un booleen et evite d exposer le hash bcrypt aux composants enfants
    const projAny: any = { ...(proj || {}) };
    const share_password_set = !!projAny.share_password;
    delete projAny.share_password;
    // Retro-compat : ajoute les bandes d age manquantes dans les regles
    if (projAny.rules) projAny.rules = normalizeRules(projAny.rules);
    return { ...projAny, share_password_set, children: mappedChildren, groups: groups || [], shootingDays };
  }

  async function openProject(id: string) {
    setLoading(true);
    const f = await loadFullProject(id);
    setActiveProject(f);
    const today = todayStr();
    const todayDay = f.shootingDays?.[today];
    if (todayDay && (todayDay.child_ids || []).length > 0) {
      setActiveDate(today);
      setView("shooting");
    } else {
      setView("project");
    }
    setLoading(false);
  }

  async function refreshActive() {
    if (!activeProject?.id) return;
    const f = await loadFullProject(activeProject.id); setActiveProject(f);
  }

  async function createProject(name: string) {
    const { data } = await supabase.from("projects").insert({ user_id: userId, name, rules: DEFAULT_RULES }).select().single();
    if (data) { await loadProjects(); openProject(data.id); }
  }

  async function deleteProject(id: string) { await supabase.from("projects").delete().eq("id", id); loadProjects(); }

  async function generateShareToken(projectId: string): Promise<string> {
    const token = crypto.randomUUID();
    await supabase.from("projects").update({ share_token: token }).eq("id", projectId);
    await refreshActive();
    return token;
  }
  async function setSharePassword(projectId: string, password: string | null) {
    // Passe par une RPC qui hash le mot de passe cote serveur (bcrypt).
    // Le client ne stocke jamais la valeur en clair en base.
    const { error } = await supabase.rpc("set_project_share_password", { p_project_id: projectId, p_password: password });
    if (error) throw error;
    await refreshActive();
  }
  async function revokeShareToken(projectId: string) {
    await supabase.from("projects").update({ share_token: null }).eq("id", projectId);
    await supabase.rpc("set_project_share_password", { p_project_id: projectId, p_password: null });
    await refreshActive();
  }

  async function addChild(child: { firstName: string; lastName: string; dob: string; vacationPeriods: VacationPeriod[]; role: ChildRole | null; derogations?: Derogation[]; schoolTracking?: boolean }) {
    const { error } = await supabase.from("children").insert({
      project_id: activeProject!.id, first_name: child.firstName.trim(), last_name: child.lastName.trim(),
      dob: child.dob, vacation_periods: child.vacationPeriods || [], child_role: child.role ?? null,
      derogations: child.derogations || [], school_tracking: child.schoolTracking ?? false,
    });
    if (error) { console.error("addChild error:", error); return; }
    await refreshActive();
  }

  async function addChildren(children: { firstName: string; lastName: string; dob: string; vacationPeriods: VacationPeriod[]; role: ChildRole | null; derogations?: Derogation[]; schoolTracking?: boolean }[]) {
    if (children.length === 0) return;
    const rows = children.map(c => ({ project_id: activeProject!.id, first_name: c.firstName, last_name: c.lastName, dob: c.dob, vacation_periods: c.vacationPeriods || [], child_role: c.role ?? null, derogations: c.derogations || [], school_tracking: c.schoolTracking ?? false }));
    const { error } = await supabase.from("children").insert(rows);
    if (error) { console.error("Import error:", error); throw error; }
    await refreshActive();
  }

  async function updateChild(id: string, data: { firstName: string; lastName: string; dob: string; vacationPeriods: VacationPeriod[]; role: ChildRole | null; derogations?: Derogation[]; schoolTracking?: boolean }) {
    const { error } = await supabase.from("children").update({ first_name: data.firstName.trim(), last_name: data.lastName.trim(), dob: data.dob, vacation_periods: data.vacationPeriods || [], child_role: data.role ?? null, derogations: data.derogations || [], school_tracking: data.schoolTracking ?? false }).eq("id", id);
    if (error) { console.error("updateChild error:", error); return; }
    await refreshActive();
  }

  // Fix #3: archive child
  async function archiveChild(id: string, archived: boolean) {
    await supabase.from("children").update({ archived }).eq("id", id);
    await refreshActive();
  }

  async function removeChild(id: string) { await supabase.from("children").delete().eq("id", id); await refreshActive(); }
  async function addGroup(name: string) { await supabase.from("groups").insert({ project_id: activeProject!.id, name, child_ids: [] }); await refreshActive(); }
  async function updateGroup(id: string, data: Partial<Group>) { await supabase.from("groups").update(data).eq("id", id); await refreshActive(); }
  async function removeGroup(id: string) { await supabase.from("groups").delete().eq("id", id); await refreshActive(); }

  async function updateRules(fn: (r: Rules) => Rules) {
    const r = fn(activeProject!.rules);
    await supabase.from("projects").update({ rules: r }).eq("id", activeProject!.id);
    setActiveProject(p => p ? { ...p, rules: r } : p);
  }

  async function renameProject(name: string) {
    const clean = name.trim();
    if (!clean || !activeProject) return;
    await supabase.from("projects").update({ name: clean }).eq("id", activeProject.id);
    setActiveProject(p => p ? { ...p, name: clean } : p);
    await loadProjects();
  }

  async function getOrCreateDay(dateStr: string): Promise<ShootingDay> {
    let day = activeProject!.shootingDays[dateStr];
    if (!day) { const { data } = await supabase.from("shooting_days").insert({ project_id: activeProject!.id, date: dateStr, child_ids: [], sessions: {} }).select().single(); day = data as ShootingDay; }
    return day;
  }
  async function updateDaySessions(dateStr: string, sessions: Record<string, Session>) { const day = await getOrCreateDay(dateStr); await supabase.from("shooting_days").update({ sessions }).eq("id", day.id); await refreshActive(); }
  async function toggleChildOnDay(dateStr: string, childId: string) {
    const day = await getOrCreateDay(dateStr); const ids = day.child_ids || [];
    const newIds = ids.includes(childId) ? ids.filter(i => i !== childId) : [...ids, childId];
    await supabase.from("shooting_days").update({ child_ids: newIds }).eq("id", day.id); await refreshActive();
  }
  async function addGroupToDay(dateStr: string, groupId: string) {
    const group = activeProject!.groups.find(g => g.id === groupId); if (!group) return;
    const day = await getOrCreateDay(dateStr);
    const ids = [...new Set([...(day.child_ids || []), ...group.child_ids])];
    await supabase.from("shooting_days").update({ child_ids: ids }).eq("id", day.id); await refreshActive();
  }
  async function removeGroupFromDay(dateStr: string, groupId: string) {
    const group = activeProject!.groups.find(g => g.id === groupId); if (!group) return;
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const ids = (day.child_ids || []).filter(id => !group.child_ids.includes(id));
    await supabase.from("shooting_days").update({ child_ids: ids }).eq("id", day.id); await refreshActive();
  }
  async function startSessionsSequentially(dateStr: string, childIds: string[], timeISO?: string) {
    const day = await getOrCreateDay(dateStr); const sessions = { ...(day.sessions || {}) }; let changed = false;
    for (const childId of childIds) { if (!sessions[childId]?.start_time) { sessions[childId] = { start_time: timeISO || nowISO(), events: [], status: "working" }; changed = true; } }
    if (!changed) return;
    await supabase.from("shooting_days").update({ sessions }).eq("id", day.id); await refreshActive();
  }
  async function startSession(dateStr: string, childId: string, timeISO?: string) { await startSessionsSequentially(dateStr, [childId], timeISO); }
  async function cancelSession(dateStr: string, childId: string) { const day = activeProject!.shootingDays[dateStr]; if (!day) return; const sessions = { ...(day.sessions || {}) }; delete sessions[childId]; await updateDaySessions(dateStr, sessions); }
  async function applyEventToChildren(dateStr: string, childIds: string[], eventType: "pause_start" | "pause_end" | "dejeuner_start" | "dejeuner_end" | "school_start" | "school_end", timeISO?: string) {
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const sessions = { ...(day.sessions || {}) };
    for (const childId of childIds) {
      const s = sessions[childId]; if (!s?.start_time || s.status === "done") continue;
      if (eventType === "pause_start" && s.status !== "working") continue;
      if (eventType === "dejeuner_start" && s.status !== "working") continue;
      if (eventType === "school_start" && s.status !== "working") continue;
      // Pour school_start, on filtre aussi sur le flag de l'enfant
      if (eventType === "school_start") {
        const child = activeProject!.children.find(c => c.id === childId);
        if (!child?.school_tracking) continue;
      }
      // "pause_end" sert aussi à reprendre depuis un déjeuner ou un suivi scolaire (smart resume)
      if (eventType === "pause_end" && s.status !== "paused" && s.status !== "dejeuner" && s.status !== "school") continue;
      if (eventType === "dejeuner_end" && s.status !== "dejeuner") continue;
      if (eventType === "school_end" && s.status !== "school") continue;
      // Si pause_end mais enfant en déjeuner ou suivi scolaire → enregistrer le bon end
      const actualType: SessionEvent["type"] =
        (eventType === "pause_end" && s.status === "dejeuner") ? "dejeuner_end"
        : (eventType === "pause_end" && s.status === "school") ? "school_end"
        : eventType;
      const newStatus: Session["status"] =
        actualType === "pause_start" ? "paused"
        : actualType === "dejeuner_start" ? "dejeuner"
        : actualType === "school_start" ? "school"
        : "working";
      sessions[childId] = { ...s, status: newStatus, events: [...(s.events || []), { type: actualType, time: timeISO || nowISO() }] };
    }
    await updateDaySessions(dateStr, sessions);
  }
  async function cancelLastEvent(dateStr: string, childId: string) {
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const sessions = { ...(day.sessions || {}) }; const s = { ...sessions[childId] }; if (!s?.events?.length) return;
    const events = [...s.events]; events.pop(); const lastEv = events[events.length - 1];
    let status: Session["status"] = "working";
    if (lastEv?.type === "pause_start") status = "paused";
    else if (lastEv?.type === "dejeuner_start") status = "dejeuner";
    else if (lastEv?.type === "school_start") status = "school";
    sessions[childId] = { ...s, events, status, end_time: undefined }; await updateDaySessions(dateStr, sessions);
  }
  async function endSessions(dateStr: string, childIds: string[], timeISO?: string) {
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const sessions = { ...(day.sessions || {}) };
    for (const childId of childIds) {
      const s = sessions[childId]; if (!s?.start_time || s.status === "done") continue;
      const events = [...(s.events || [])];
      if (s.status === "paused") events.push({ type: "pause_end", time: timeISO || nowISO() });
      else if (s.status === "dejeuner") events.push({ type: "dejeuner_end", time: timeISO || nowISO() });
      else if (s.status === "school") events.push({ type: "school_end", time: timeISO || nowISO() });
      sessions[childId] = { ...s, end_time: timeISO || nowISO(), status: "done", events };
    }
    await updateDaySessions(dateStr, sessions);
  }
  async function reopenSession(dateStr: string, childId: string) { const day = activeProject!.shootingDays[dateStr]; if (!day) return; const sessions = { ...(day.sessions || {}) }; sessions[childId] = { ...sessions[childId], status: "working", end_time: undefined }; await updateDaySessions(dateStr, sessions); }
  async function editEventTime(dateStr: string, childId: string, eventIndex: number, newTimeISO: string) { const day = activeProject!.shootingDays[dateStr]; if (!day) return; const sessions = { ...(day.sessions || {}) }; const s = { ...sessions[childId] }; const events = [...(s.events || [])]; events[eventIndex] = { ...events[eventIndex], time: newTimeISO }; s.events = events; sessions[childId] = s; await updateDaySessions(dateStr, sessions); }
  async function editStartTime(dateStr: string, childId: string, newTimeISO: string) { const day = activeProject!.shootingDays[dateStr]; if (!day) return; const sessions = { ...(day.sessions || {}) }; sessions[childId] = { ...sessions[childId], start_time: newTimeISO }; await updateDaySessions(dateStr, sessions); }
  async function editEndTime(dateStr: string, childId: string, newTimeISO: string) { const day = activeProject!.shootingDays[dateStr]; if (!day) return; const sessions = { ...(day.sessions || {}) }; sessions[childId] = { ...sessions[childId], end_time: newTimeISO }; await updateDaySessions(dateStr, sessions); }

  const Fonts = () => <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap" rel="stylesheet" />;
  if (loading && view === "home") return <div className="min-h-screen bg-[#080d16] flex items-center justify-center"><Fonts /><div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;

  if (view === "home") return <><Fonts /><OfflineBanner /><HomeView projects={projects} userEmail={session.user.email} onCreate={createProject} onOpen={openProject} onSignOut={onSignOut} /></>;
  if (view === "project" && activeProject) return <><Fonts /><OfflineBanner /><ProjectView project={activeProject}
    onBack={() => { setView("home"); loadProjects(); }}
    onAddChild={addChild} onAddChildren={addChildren} onUpdateChild={updateChild} onRemoveChild={removeChild}
    onArchiveChild={archiveChild}
    onAddGroup={addGroup} onUpdateGroup={updateGroup} onRemoveGroup={removeGroup} onUpdateRules={updateRules}
    onOpenDay={date => { setActiveDate(date); setView("shooting"); }}
    onExportProjectPDF={() => exportProjectGlobalPDF(activeProject)}
    onExportChildDays={child => exportChildAllDays(activeProject, child)}
    onRename={renameProject}
    onDelete={() => { deleteProject(activeProject.id); setView("home"); loadProjects(); }}
    onGenerateShareToken={() => generateShareToken(activeProject.id)}
    onSetSharePassword={(pwd) => setSharePassword(activeProject.id, pwd)}
    onRevokeShareToken={() => revokeShareToken(activeProject.id)}
  /></>;
  if (view === "shooting" && activeProject && activeDate) return <><Fonts /><OfflineBanner /><ShootingView project={activeProject} dateStr={activeDate}
    onBack={() => { setView("project"); refreshActive(); }}
    onStartSessions={(cids, t) => startSessionsSequentially(activeDate, cids, t)}
    onStartSession={(cid, t) => startSession(activeDate, cid, t)}
    onCancelSession={cid => cancelSession(activeDate, cid)}
    onApplyEvent={(cids, type, t) => applyEventToChildren(activeDate, cids, type, t)}
    onCancelLastEvent={cid => cancelLastEvent(activeDate, cid)}
    onEndSessions={(cids, t) => endSessions(activeDate, cids, t)}
    onReopenSession={cid => reopenSession(activeDate, cid)}
    onToggleChild={cid => toggleChildOnDay(activeDate, cid)}
    onAddGroup={gid => addGroupToDay(activeDate, gid)}
    onRemoveGroup={gid => removeGroupFromDay(activeDate, gid)}
    onEditEventTime={(cid, idx, t) => editEventTime(activeDate, cid, idx, t)}
    onEditStartTime={(cid, t) => editStartTime(activeDate, cid, t)}
    onEditEndTime={(cid, t) => editEndTime(activeDate, cid, t)}
    onExportPDF={() => exportDayToPDF(activeProject, activeDate)} /></>;
  return null;
}

// ─── OfflineBanner (autonome : gère lui-même l'état réseau) ───────────────────
function OfflineBanner() {
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  useEffect(() => {
    const on = () => setIsOnline(true), off = () => setIsOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  if (isOnline) return null;
  return (
    <div className="fixed top-0 left-0 right-0 z-50 bg-amber-900/90 border-b border-amber-700 px-4 py-2 flex items-center justify-center gap-2 text-amber-200 text-xs backdrop-blur">
      <span>📡</span>
      <span>Mode hors-ligne — les modifications reprendront dès le retour du réseau.</span>
    </div>
  );
}

// ─── ShareModal ───────────────────────────────────────────────────────────────
function ShareModal({ project, onClose, onGenerate, onSetPassword, onRevoke }: {
  project: Project;
  onClose: () => void;
  onGenerate: () => Promise<string>;
  onSetPassword: (pwd: string | null) => Promise<void>;
  onRevoke: () => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  // On ne pre-remplit jamais le champ : le mot de passe est hashe en base.
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [accessLog, setAccessLog] = useState<{ result: string; user_agent: string | null; accessed_at: string }[] | null>(null);
  const [showLog, setShowLog] = useState(false);

  const token = project.share_token;
  const baseUrl = typeof window !== "undefined" ? `${window.location.origin}/share/${token}` : "";
  const MIN_PWD = 4;
  const trimmedPwd = password.trim();
  const hasPwd = !!project.share_password_set;
  const pwdValid = trimmedPwd.length >= MIN_PWD;
  // L utilisateur a-t-il deja saisi quelque chose dans le champ ?
  const pwdDirty = trimmedPwd.length > 0;
  // Le lien n'est exploitable que si un mot de passe est sauvegardé
  const linkActive = !!token && hasPwd;

  useEffect(() => {
    if (!token || !showLog) return;
    (async () => {
      const { data } = await supabase.rpc("get_share_access_history", { p_project_id: project.id, p_limit: 20 });
      setAccessLog(data || []);
    })();
  }, [token, showLog, project.id]);

  const resultLabels: Record<string, { label: string; color: string }> = {
    ok: { label: "✓ Accès", color: "text-green-400" },
    wrong_password: { label: "✗ Mauvais mot de passe", color: "text-amber-400" },
    password_required: { label: "🔒 Mot de passe demandé", color: "text-slate-400" },
    not_found: { label: "❓ Lien inconnu", color: "text-slate-500" },
    rate_limited: { label: "🚫 Bloqué (trop d'essais)", color: "text-red-400" },
  };

  function shortUA(ua: string | null): string {
    if (!ua) return "—";
    if (/iPhone|iPad/.test(ua)) return "📱 iOS";
    if (/Android/.test(ua)) return "📱 Android";
    if (/Mac/.test(ua)) return "💻 Mac";
    if (/Windows/.test(ua)) return "💻 Windows";
    if (/Linux/.test(ua)) return "💻 Linux";
    return ua.slice(0, 30);
  }
  function formatAccessTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  async function handleGenerate() {
    // Conditions: doit avoir soit un mot de passe deja enregistre, soit un
    // nouveau valide a la volee
    if (!hasPwd && !pwdValid) return;
    setLoading(true);
    if (pwdValid) { await onSetPassword(trimmedPwd); setPassword(""); }
    await onGenerate();
    setLoading(false);
  }
  async function handleSavePassword() {
    if (!pwdValid) return;
    setLoading(true);
    await onSetPassword(trimmedPwd);
    setPassword(""); // on vide le champ apres enregistrement
    setLoading(false);
  }
  async function handleRevoke() {
    if (!confirm("Désactiver le lien de partage ? Il ne sera plus accessible.")) return;
    setLoading(true); await onRevoke(); onClose();
  }
  function handleCopy() {
    navigator.clipboard.writeText(baseUrl);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm px-4 pb-4" onClick={onClose}>
      <div className="bg-[#0f1a2e] border border-slate-700 rounded-2xl w-full max-w-sm p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>🔗 Lien de partage</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white w-8 h-8 flex items-center justify-center">✕</button>
        </div>
        <p className="text-xs text-slate-400">Partagez ce projet en lecture seule (calendrier + enfants). Le destinataire ne peut rien modifier. Un <b>mot de passe est obligatoire</b> pour protéger les données.</p>

        {/* Étape 1 : mot de passe (toujours visible et obligatoire) */}
        <div className="space-y-2">
          <label className="text-[10px] text-slate-400 uppercase tracking-wider">Mot de passe <span className="text-red-400 normal-case font-normal">(obligatoire, min. {MIN_PWD} caractères)</span></label>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                type={showPwd ? "text" : "password"}
                placeholder={hasPwd ? "Saisir un nouveau mot de passe pour le changer" : "Définir un mot de passe…"}
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full bg-slate-800 border border-slate-600 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 placeholder:text-slate-600 pr-10"
              />
              <button type="button" onClick={() => setShowPwd(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs">
                {showPwd ? "🙈" : "👁"}
              </button>
            </div>
            <button onClick={handleSavePassword} disabled={loading || !pwdValid}
              className="bg-blue-700 hover:bg-blue-600 text-white px-3 rounded-xl text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              {loading ? "…" : "Enregistrer"}
            </button>
          </div>
          {pwdDirty && !pwdValid && <div className="text-[10px] text-red-400">Le mot de passe doit faire au moins {MIN_PWD} caractères.</div>}
          {hasPwd && !pwdDirty && <div className="text-[10px] text-emerald-400">🔒 Mot de passe défini (chiffré en base)</div>}
          {!hasPwd && !pwdDirty && <div className="text-[10px] text-red-400">⚠️ Aucun mot de passe défini — le lien ne fonctionnera pas tant qu&apos;il n&apos;y en a pas un.</div>}
        </div>

        {/* Étape 2 : générer / afficher le lien */}
        {!token ? (
          <button onClick={handleGenerate} disabled={loading || (!hasPwd && !pwdValid)}
            className="w-full bg-blue-700 hover:bg-blue-600 text-white font-semibold py-3 rounded-xl text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            {loading ? "Génération…" : (hasPwd || pwdValid) ? "Générer un lien de partage" : "🔒 Définir d'abord un mot de passe"}
          </button>
        ) : (
          <>
            {/* Avertissement si le projet a un token mais aucun mot de passe enregistré */}
            {!hasPwd && (
              <div className="bg-red-950/40 border border-red-800/60 rounded-xl px-3 py-2.5 text-xs text-red-300">
                ⚠️ <b>Lien actuellement inactif.</b> Définis et enregistre un mot de passe ci-dessus pour l&apos;activer.
              </div>
            )}

            {/* Affichage du lien */}
            <div className={`bg-slate-900/70 border rounded-xl p-3 flex items-center gap-2 ${linkActive ? "border-slate-700" : "border-red-900/60 opacity-60"}`}>
              <span className="text-xs text-slate-300 flex-1 truncate font-mono">{baseUrl}</span>
              <button onClick={handleCopy} disabled={!linkActive}
                className={`text-xs px-2 py-1 rounded-lg font-semibold flex-shrink-0 transition-colors ${copied ? "bg-green-700 text-green-200" : "bg-slate-700 text-slate-300 hover:bg-slate-600"} disabled:opacity-40 disabled:cursor-not-allowed`}>
                {copied ? "✓ Copié" : "Copier"}
              </button>
            </div>

            {/* Regenerate / Revoke */}
            <div className="flex gap-2 pt-1">
              <button onClick={handleGenerate} disabled={loading || !pwdValid}
                className="flex-1 text-xs text-slate-400 border border-slate-700 hover:border-slate-500 py-2 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                🔄 Regénérer
              </button>
              <button onClick={handleRevoke} disabled={loading}
                className="flex-1 text-xs text-red-400 border border-red-900/50 hover:border-red-700 py-2 rounded-xl transition-colors">
                🚫 Désactiver
              </button>
            </div>

            {/* Historique des accès */}
            <div className="border-t border-slate-800 pt-3">
              <button onClick={() => setShowLog(v => !v)} className="text-xs text-slate-400 hover:text-white w-full text-left flex items-center justify-between">
                <span>📜 Historique des accès</span>
                <span className="text-slate-600">{showLog ? "▾" : "▸"}</span>
              </button>
              {showLog && (
                <div className="mt-3 max-h-56 overflow-y-auto space-y-1">
                  {accessLog === null && <div className="text-xs text-slate-500">Chargement…</div>}
                  {accessLog && accessLog.length === 0 && <div className="text-xs text-slate-500">Aucun accès enregistré pour le moment.</div>}
                  {accessLog && accessLog.map((row, i) => {
                    const lbl = resultLabels[row.result] ?? { label: row.result, color: "text-slate-400" };
                    return (
                      <div key={i} className="flex items-center justify-between gap-2 text-[10px] bg-slate-900/40 border border-slate-800 rounded-lg px-2 py-1.5">
                        <span className={`${lbl.color} font-semibold whitespace-nowrap`}>{lbl.label}</span>
                        <span className="text-slate-500 flex-shrink-0">{shortUA(row.user_agent)}</span>
                        <span className="text-slate-600 font-mono flex-shrink-0">{formatAccessTime(row.accessed_at)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="text-[10px] text-slate-600 mt-2">Blocage automatique après 10 tentatives de mot de passe ratées en 15 min.</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function HomeView({ projects, userEmail, onCreate, onOpen, onSignOut }: { projects: Project[]; userEmail: string; onCreate: (n: string) => void; onOpen: (id: string) => void; onSignOut: () => void }) {
  const [name, setName] = useState("");
  const [showRgpd, setShowRgpd] = useState(false);
  return (
    <div className="min-h-screen bg-[#080d16] text-white" style={{ fontFamily: "'DM Mono', monospace" }}>
      <div className="fixed inset-0 opacity-[0.025]" style={{ backgroundImage: "linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)", backgroundSize: "40px 40px" }} />
      {/* Fix #1: safe area padding for iPhone notch */}
      <div className="relative max-w-2xl mx-auto px-4 pt-safe-top py-10">
        <div className="flex items-start justify-between mb-10">
          <div>
            <div className="text-[10px] text-blue-400 tracking-[0.35em] uppercase mb-2">Gestion des mineurs · Audiovisuel</div>
            <h1 className="text-4xl font-extrabold tracking-tight" style={{ fontFamily: "Syne, sans-serif" }}><span className="text-white">KIDS</span><span className="text-blue-500">TIME</span></h1>
          </div>
          <div className="text-right mt-1"><div className="text-xs text-slate-500 mb-1 truncate max-w-[140px]">{userEmail}</div><button onClick={onSignOut} className="text-xs text-slate-500 hover:text-red-400 transition-colors">Déconnexion</button></div>
        </div>
        <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-4 mb-6">
          <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-3">Nouvelle production</div>
          <div className="flex gap-2">
            <input className="flex-1 bg-slate-800 border border-slate-600 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 placeholder:text-slate-600" placeholder="Titre du film ou de la série…" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && name.trim() && (onCreate(name.trim()), setName(""))} />
            <Btn onClick={() => { if (name.trim()) { onCreate(name.trim()); setName(""); } }} className="px-5">Créer</Btn>
          </div>
        </div>
        {projects.length === 0 ? <div className="text-center text-slate-600 py-16 text-sm">Aucun projet — créez votre première production</div> :
          <div className="space-y-3">
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Mes productions</div>
            {projects.map(p => (
              <div key={p.id} className="flex items-center gap-3 bg-slate-900/50 border border-slate-700 rounded-xl px-4 py-4 active:bg-slate-800 transition-colors cursor-pointer" onClick={() => onOpen(p.id)}>
                <div className="flex-1"><div className="font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>{p.name}</div><div className="text-xs text-slate-500">{new Date(p.created_at).toLocaleDateString("fr-FR")}</div></div>
                <span className="text-slate-600 text-sm">→</span>
              </div>
            ))}
          </div>
        }

        {/* Footer : RGPD + mentions légales */}
        <div className="mt-12 pt-6 border-t border-slate-800 flex flex-col items-center gap-3 text-[10px] text-slate-500">
          <div className="flex gap-4">
            <a href="/legal" className="hover:text-slate-300 transition-colors">Mentions légales & Confidentialité</a>
            <span className="text-slate-700">·</span>
            <button onClick={() => setShowRgpd(true)} className="hover:text-red-400 transition-colors">Supprimer toutes mes données</button>
          </div>
          <div className="text-slate-700">KidsTime · ACMA Fiction · Éléonore Aguillon</div>
        </div>
      </div>

      {showRgpd && <RgpdDeleteModal onClose={() => setShowRgpd(false)} userEmail={userEmail} />}
    </div>
  );
}

function RgpdDeleteModal({ onClose, userEmail }: { onClose: () => void; userEmail: string }) {
  type Step = "step1" | "step2" | "sending" | "sent" | "error";
  const [step, setStep] = useState<Step>("step1");
  const [confirm, setConfirm] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [errMsg, setErrMsg] = useState("");

  const canContinueStep1 = confirm === "SUPPRIMER" && understood;

  async function handleSendEmail() {
    setStep("sending");
    try {
      // 1. Genere un token cote serveur
      const { data: token, error: tokErr } = await supabase.rpc("request_data_deletion");
      if (tokErr || !token) throw new Error(tokErr?.message || "Token introuvable");

      // 2. Envoie un magic link Supabase qui redirige vers la page de confirmation avec le token
      const redirectTo = `${window.location.origin}/confirm-deletion?token=${token}`;
      const { error: otpErr } = await supabase.auth.signInWithOtp({
        email: userEmail,
        options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
      });
      if (otpErr) throw otpErr;

      setStep("sent");
    } catch (e: any) {
      setErrMsg(e?.message || "Erreur lors de l'envoi");
      setStep("error");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm px-4 pb-4" onClick={step === "sending" ? undefined : onClose}>
      <div className="bg-[#0f1a2e] border border-red-900/60 rounded-2xl w-full max-w-md p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-red-400" style={{ fontFamily: "Syne, sans-serif" }}>⚠️ Supprimer toutes mes données</h2>
          {step !== "sending" && <button onClick={onClose} className="text-slate-400 hover:text-white w-8 h-8 flex items-center justify-center">✕</button>}
        </div>

        {/* Indicateur d'étape */}
        <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
          <span className={step === "step1" ? "text-red-400 font-bold" : ""}>1. Confirmer</span>
          <span>›</span>
          <span className={step === "step2" || step === "sending" ? "text-red-400 font-bold" : ""}>2. Récapitulatif</span>
          <span>›</span>
          <span className={step === "sent" ? "text-red-400 font-bold" : ""}>3. Email</span>
          <span>›</span>
          <span className="text-slate-600">4. Lien</span>
        </div>

        {step === "step1" && (
          <>
            <p className="text-sm text-slate-300">
              Cette action efface <b>définitivement</b> tous tes projets, enfants, journées de tournage,
              groupes, logs d&apos;accès et abonnements push. Elle est irréversible.
            </p>
            <div className="space-y-2">
              <label className="text-[10px] text-slate-400 uppercase tracking-wider">Tape <span className="text-red-400 font-bold">SUPPRIMER</span> pour activer</label>
              <input
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-red-500 placeholder:text-slate-600"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="SUPPRIMER"
                autoFocus
              />
            </div>
            <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={understood}
                onChange={e => setUnderstood(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-red-500"
              />
              <span>Je comprends que la suppression est irréversible.</span>
            </label>
            <button
              onClick={() => canContinueStep1 && setStep("step2")}
              disabled={!canContinueStep1}
              className={`w-full py-3 rounded-xl text-sm font-bold transition-colors ${canContinueStep1 ? "bg-red-700 hover:bg-red-600 text-white" : "bg-slate-800 text-slate-600 cursor-not-allowed"}`}
            >
              Continuer
            </button>
          </>
        )}

        {step === "step2" && (
          <>
            <div className="bg-red-950/30 border border-red-800/60 rounded-xl p-3 text-xs space-y-2">
              <div className="text-red-300 font-bold">Dernière étape avant l&apos;email</div>
              <div className="text-slate-300">
                Un email avec un lien de confirmation va être envoyé à :
              </div>
              <div className="bg-slate-900/70 border border-slate-700 rounded-lg px-3 py-2 font-mono text-white text-xs break-all">
                {userEmail}
              </div>
              <div className="text-slate-400">
                Le lien sera valide <b>1 heure</b>. La suppression ne sera effective qu&apos;après que tu auras cliqué dessus
                et confirmé une dernière fois.
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setStep("step1")}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 py-3 rounded-xl text-sm font-semibold transition-colors"
              >
                ← Retour
              </button>
              <button
                onClick={handleSendEmail}
                className="flex-1 bg-red-700 hover:bg-red-600 text-white py-3 rounded-xl text-sm font-bold transition-colors"
              >
                M&apos;envoyer le lien
              </button>
            </div>
          </>
        )}

        {step === "sending" && (
          <div className="text-center py-6">
            <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <div className="text-sm text-slate-400">Envoi de l&apos;email…</div>
          </div>
        )}

        {step === "sent" && (
          <>
            <div className="bg-emerald-950/30 border border-emerald-800/60 rounded-xl p-4 text-sm space-y-2">
              <div className="text-emerald-300 font-bold">📩 Email envoyé</div>
              <div className="text-xs text-slate-300">
                Un lien de confirmation a été envoyé à <b className="text-white">{userEmail}</b>. Clique dessus pour finaliser la suppression.
              </div>
              <div className="text-[10px] text-slate-500">
                Pense à vérifier tes spams. Validité : 1 heure.
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 py-3 rounded-xl text-sm font-semibold transition-colors"
            >
              Fermer
            </button>
          </>
        )}

        {step === "error" && (
          <>
            <div className="bg-red-950/40 border border-red-800/60 rounded-xl p-3 text-xs text-red-300">
              Erreur : {errMsg}
            </div>
            <button
              onClick={() => setStep("step2")}
              className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 py-3 rounded-xl text-sm font-semibold transition-colors"
            >
              Réessayer
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ProjectView({ project, onBack, onAddChild, onAddChildren, onUpdateChild, onRemoveChild, onArchiveChild, onAddGroup, onUpdateGroup, onRemoveGroup, onUpdateRules, onOpenDay, onExportProjectPDF, onExportChildDays, onRename, onDelete, onGenerateShareToken, onSetSharePassword, onRevokeShareToken }: {
  project: Project; onBack: () => void;
  onAddChild: (c: any) => void; onAddChildren: (cs: any[]) => Promise<void>;
  onUpdateChild: (id: string, d: any) => void; onRemoveChild: (id: string) => void;
  onArchiveChild: (id: string, archived: boolean) => void;
  onAddGroup: (name: string) => void; onUpdateGroup: (id: string, d: any) => void; onRemoveGroup: (id: string) => void;
  onUpdateRules: (fn: (r: Rules) => Rules) => void; onOpenDay: (date: string) => void;
  onExportProjectPDF: () => void;
  onExportChildDays: (child: Child) => void;
  onRename: (name: string) => Promise<void>;
  onDelete: () => void;
  onGenerateShareToken: () => Promise<string>;
  onSetSharePassword: (pwd: string | null) => Promise<void>;
  onRevokeShareToken: () => Promise<void>;
}) {
  const [tab, setTab] = useState<"calendar" | "children" | "groups" | "settings">("calendar");
  const [childModal, setChildModal] = useState<Child | "new" | null>(null);
  const [groupModal, setGroupModal] = useState<Group | "new" | null>(null);
  const [shareModal, setShareModal] = useState(false);
  const tabs = [{ id: "calendar", label: "📅" }, { id: "children", label: "👦" }, { id: "groups", label: "👥" }, { id: "settings", label: "⚙️" }];
  const tabLabels: Record<string, string> = { calendar: "Calendrier", children: "Enfants", groups: "Groupes", settings: "Paramètres" };
  return (
    <div className="min-h-screen bg-[#080d16] text-white pb-20" style={{ fontFamily: "'DM Mono', monospace" }}>
      {/* Fix #1: sticky header with safe area */}
      <div className="sticky top-0 z-10 bg-[#080d16] border-b border-slate-800 px-4 py-3 flex items-center gap-3">
        <button onClick={onBack} className="text-slate-400 hover:text-white text-sm w-8 h-8 flex items-center justify-center rounded-lg border border-slate-700">←</button>
        <h1 className="text-base font-extrabold truncate flex-1" style={{ fontFamily: "Syne, sans-serif" }}>{project.name}</h1>
        <button onClick={() => setShareModal(true)} className="text-xs text-blue-400 border border-blue-800/60 px-3 py-1.5 rounded-lg hover:bg-blue-900/30 transition-colors flex items-center gap-1">
          🔗 <span className="hidden sm:inline">Partager</span>
        </button>
      </div>
      {shareModal && <ShareModal project={project} onClose={() => setShareModal(false)} onGenerate={onGenerateShareToken} onSetPassword={onSetSharePassword} onRevoke={onRevokeShareToken} />}

      {/* Fix #5/#6: project export button */}
      {tab === "calendar" && (
        <div className="px-4 pt-3">
          <button onClick={onExportProjectPDF} className="w-full text-xs text-blue-400 border border-blue-800/60 px-3 py-2 rounded-lg">📄 Récap. global PDF</button>
        </div>
      )}

      <div className="px-4 py-4">
        {tab === "calendar" && <CalendarTab project={project} onOpenDay={onOpenDay} />}
        {tab === "children" && <ChildrenTab project={project} onAdd={() => setChildModal("new")} onEdit={c => setChildModal(c)} onRemove={onRemoveChild} onImport={onAddChildren} onArchive={onArchiveChild} onExportChildDays={onExportChildDays} />}
        {tab === "groups" && <GroupsTab project={project} onAdd={() => setGroupModal("new")} onRemove={onRemoveGroup} onUpdateGroup={onUpdateGroup} />}
        {tab === "settings" && <SettingsTab rules={project.rules} onUpdateRules={onUpdateRules} projectName={project.name} onRename={onRename} onDelete={onDelete} />}
      </div>

      {/* Fix #1: bottom tab bar for mobile */}
      <div className="fixed bottom-0 left-0 right-0 bg-[#0c1420] border-t border-slate-800 flex pb-safe-bottom">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id as any)} className={`flex-1 py-3 flex flex-col items-center gap-0.5 transition-colors ${tab === t.id ? "text-blue-400" : "text-slate-600"}`}>
            <span className="text-lg">{t.label}</span>
            <span className="text-[9px] uppercase tracking-wider">{tabLabels[t.id]}</span>
          </button>
        ))}
      </div>

      {childModal !== null && (
        <ChildFormModal child={childModal === "new" ? null : childModal}
          onSave={data => { childModal === "new" ? onAddChild(data) : onUpdateChild((childModal as Child).id, data); setChildModal(null); }}
          onClose={() => setChildModal(null)} />
      )}
      {groupModal !== null && (
        <GroupFormModal group={groupModal === "new" ? null : groupModal}
          onSave={name => { groupModal === "new" ? onAddGroup(name) : onUpdateGroup((groupModal as Group).id, { name }); setGroupModal(null); }}
          onClose={() => setGroupModal(null)} />
      )}
    </div>
  );
}

function CalendarTab({ project, onOpenDay }: { project: Project; onOpenDay: (d: string) => void }) {
  const [cur, setCur] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const y = cur.getFullYear(), m = cur.getMonth();
  const firstDay = (new Date(y, m, 1).getDay() + 6) % 7, daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const MN = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
  const DN = ["L","M","M","J","V","S","D"];
  function ds(d: number) { return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <button onClick={() => setCur(new Date(y, m - 1, 1))} className="text-slate-400 w-10 h-10 rounded-lg border border-slate-700 flex items-center justify-center text-lg">‹</button>
        <h2 className="font-bold text-base" style={{ fontFamily: "Syne, sans-serif" }}>{MN[m]} {y}</h2>
        <button onClick={() => setCur(new Date(y, m + 1, 1))} className="text-slate-400 w-10 h-10 rounded-lg border border-slate-700 flex items-center justify-center text-lg">›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 mb-1">{DN.map((d, i) => <div key={i} className="text-center text-[10px] text-slate-500 py-1 uppercase tracking-wider">{d}</div>)}</div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (!d) return <div key={i} />;
          const s = ds(d);
          const dayData = project.shootingDays[s];
          const validChildIds = (dayData?.child_ids || []).filter(id => project.children.find(c => c.id === id));
          const count = validChildIds.length, isShoot = count > 0, isToday = s === todayStr();
          return (
            <button key={i} onClick={() => onOpenDay(s)} className={`rounded-xl py-2.5 text-sm transition-all ${isShoot ? "bg-blue-900/50 border border-blue-600 text-blue-200" : "bg-slate-900/40 border border-slate-800 text-slate-400"} ${isToday ? "ring-2 ring-blue-400" : ""}`}>
              <div className="font-bold text-sm">{d}</div>
              {isShoot && <div className="text-[9px] text-blue-400">{count}👦</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Fix #1 + #3 + #4: ChildrenTab with archive + per-child export
function ChildDeleteConfirmModal({ child, onConfirm, onClose }: { child: Child; onConfirm: () => void; onClose: () => void }) {
  type Step = "step1" | "step2";
  const [step, setStep] = useState<Step>("step1");
  const [understood, setUnderstood] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const fullName = `${child.first_name} ${child.last_name}`.trim();
  const canContinue = understood;
  const canDelete = normalize(confirmName) === normalize(fullName);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm px-4 pb-4" onClick={onClose}>
      <div className="bg-[#0f1a2e] border border-red-900/60 rounded-2xl w-full max-w-md p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-red-400" style={{ fontFamily: "Syne, sans-serif" }}>⚠️ Supprimer un enfant</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white w-8 h-8 flex items-center justify-center">✕</button>
        </div>

        <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
          <span className={step === "step1" ? "text-red-400 font-bold" : ""}>1. Avertissement</span>
          <span>›</span>
          <span className={step === "step2" ? "text-red-400 font-bold" : ""}>2. Confirmer le nom</span>
        </div>

        {step === "step1" && (
          <>
            <div className="bg-red-950/30 border border-red-800/60 rounded-xl p-3 text-xs space-y-2">
              <div className="text-red-300 font-bold">Action irréversible</div>
              <div className="text-slate-300">
                Tu vas supprimer définitivement la fiche de <b className="text-white">{fullName}</b> et toutes les
                données associées (sessions de tournage de cet enfant, présences dans les groupes).
              </div>
              <div className="text-slate-400">
                Pense à <b>archiver</b> plutôt que supprimer si tu souhaites garder l&apos;historique consultable.
              </div>
            </div>
            <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={understood}
                onChange={e => setUnderstood(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-red-500"
              />
              <span>Je comprends que la suppression est irréversible.</span>
            </label>
            <div className="flex gap-2">
              <button onClick={onClose} className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 py-3 rounded-xl text-sm font-semibold transition-colors">
                Annuler
              </button>
              <button
                onClick={() => canContinue && setStep("step2")}
                disabled={!canContinue}
                className={`flex-1 py-3 rounded-xl text-sm font-bold transition-colors ${canContinue ? "bg-red-700 hover:bg-red-600 text-white" : "bg-slate-800 text-slate-600 cursor-not-allowed"}`}
              >
                Continuer
              </button>
            </div>
          </>
        )}

        {step === "step2" && (
          <>
            <p className="text-sm text-slate-300">
              Pour confirmer, tape le nom complet de l&apos;enfant ci-dessous :
            </p>
            <div className="bg-slate-900/70 border border-slate-700 rounded-lg px-3 py-2 font-mono text-white text-xs">
              {fullName}
            </div>
            <input
              autoFocus
              value={confirmName}
              onChange={e => setConfirmName(e.target.value)}
              placeholder="Prénom Nom"
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-red-500 placeholder:text-slate-600"
            />
            <div className="flex gap-2">
              <button onClick={() => setStep("step1")} className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 py-3 rounded-xl text-sm font-semibold transition-colors">
                ← Retour
              </button>
              <button
                onClick={() => { if (canDelete) { onConfirm(); onClose(); } }}
                disabled={!canDelete}
                className={`flex-1 py-3 rounded-xl text-sm font-bold transition-colors ${canDelete ? "bg-red-700 hover:bg-red-600 text-white" : "bg-slate-800 text-slate-600 cursor-not-allowed"}`}
              >
                Supprimer définitivement
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ChildrenTab({ project, onAdd, onEdit, onRemove, onImport, onArchive, onExportChildDays }: {
  project: Project; onAdd: () => void; onEdit: (c: Child) => void; onRemove: (id: string) => void;
  onImport: (cs: any[]) => Promise<void>; onArchive: (id: string, archived: boolean) => void;
  onExportChildDays: (child: Child) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState("");
  const [importPreview, setImportPreview] = useState<any[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [importing, setImporting] = useState(false);
  const [roleTab, setRoleTab] = useState<ChildRole | "all">("all");
  const [showArchived, setShowArchived] = useState(false);
  const [deletingChild, setDeletingChild] = useState<Child | null>(null);

  const activeChildren = project.children.filter(c => !c.archived);
  const archivedChildren = project.children.filter(c => c.archived);
  const rolesPresent = ALL_ROLES.filter(r => activeChildren.some(c => c.role === r));
  const displayChildren = sortByRoleThenAlpha(showArchived ? archivedChildren : (roleTab === "all" ? activeChildren : activeChildren.filter(c => c.role === roleTab)));

  function downloadTemplate() {
    // Une ligne d'exemple bien remplie, une ligne minimale, pour montrer ce qui est optionnel.
    const csv =
      "Prénom;Nom;Date de naissance (JJ/MM/AAAA);Statut (role/silhouette/figurant);Début vacances (JJ/MM/AAAA);Fin vacances (JJ/MM/AAAA);Suivi scolaire (oui/non);Dérogation date (JJ/MM/AAAA);Dérogation heure fin (HH:MM)\n" +
      "Léa;Martin;15/03/2015;role;01/07/2025;31/08/2025;oui;21/04/2025;23:00\n" +
      "Tom;Dupont;08/11/2012;silhouette;;;non;;\n";
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "modele_enfants_kidstime.csv"; a.click(); URL.revokeObjectURL(url);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    setImportMsg("Lecture du fichier…"); setShowPreview(false);
    try {
      let rows: any[] = [];
      if (file.name.endsWith(".csv") || file.name.endsWith(".txt")) {
        const text = await file.text(); const lines = text.split(/\r?\n/).filter(l => l.trim());
        const sep = lines[0].includes(";") ? ";" : ",";
        const headers = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, ""));
        for (let i = 1; i < lines.length; i++) { const vals = lines[i].split(sep).map(v => v.trim().replace(/^"|"$/g, "")); const row: any = {}; headers.forEach((h, idx) => { row[h] = vals[idx] || ""; }); rows.push(row); }
      } else {
        const XLSX = await import("xlsx"); const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" }); const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { raw: true, defval: "" });
      }
      if (rows.length === 0) { setImportMsg("❌ Fichier vide."); return; }
      const headers = Object.keys(rows[0] || {});
      const fullCol = guessColumn(headers, ["nom prenom", "nom prénom", "prenom nom", "prénom nom", "nom et prenom", "full name", "fullname", "nom complet"]);
      const fnCol = guessColumn(headers, ["prenom", "prénom", "firstname", "first name"]);
      const lnCol = guessColumn(headers, ["nom de famille", "lastname", "last name", "surname"]);
      const nomCol = (!fullCol && !fnCol && !lnCol) ? guessColumn(headers, ["nom"]) : null;
      const dobCol = guessColumn(headers, ["naissance", "date de naissance", "dob", "birth", "birthdate", "date naissance"]);
      const vs = guessColumn(headers, ["debut vacances", "début vacances", "vacances debut", "debut vac"]);
      const ve = guessColumn(headers, ["fin vacances", "vacances fin", "end vacances", "fin vac"]);
      const statCol = guessColumn(headers, ["statut", "status", "type de role", "type"]);
      const scolCol = guessColumn(headers, ["suivi scolaire", "scolaire", "school tracking", "school", "suivi"]);
      const derogDateCol = guessColumn(headers, ["derogation date", "dérogation date", "date derogation", "date dérogation", "derog date"]);
      const derogTimeCol = guessColumn(headers, ["derogation heure fin", "dérogation heure fin", "derogation heure", "dérogation heure", "heure derogation", "heure dérogation", "derog heure", "derog heure fin"]);
      const parsed = rows.map(r => {
        // Nom / prenom : on prefere les colonnes separees si presentes
        let firstName = "", lastName = "";
        if (fnCol && lnCol) {
          firstName = String(r[fnCol] || "").trim();
          lastName = String(r[lnCol] || "").trim();
        } else if (fullCol && String(r[fullCol] || "").trim()) {
          ({ firstName, lastName } = splitFullName(String(r[fullCol]).trim()));
        } else if (fnCol) {
          firstName = String(r[fnCol] || "").trim();
        } else if (lnCol) {
          lastName = String(r[lnCol] || "").trim();
        } else if (nomCol) {
          ({ firstName, lastName } = splitFullName(String(r[nomCol] || "").trim()));
        } else {
          const firstVal = Object.values(r).find(v => String(v || "").trim() !== "");
          ({ firstName, lastName } = splitFullName(String(firstVal || "").trim()));
        }

        const role: ChildRole | null = statCol ? detectRole(String(r[statCol] || "")) : null;
        const schoolTracking = scolCol ? /^(oui|yes|true|1|x|o)$/i.test(String(r[scolCol] ?? "").trim()) : false;

        // Derogation : si on a une date ET une heure valides
        const derogations: Derogation[] = [];
        if (derogDateCol && derogTimeCol) {
          const dDate = parseExcelDate(r[derogDateCol]);
          const dTime = String(r[derogTimeCol] ?? "").trim();
          if (dDate && /^\d{1,2}:\d{2}$/.test(dTime)) {
            derogations.push({ date: dDate, end_time: dTime.padStart(5, "0") });
          }
        }

        return {
          firstName, lastName,
          dob: dobCol ? parseExcelDate(r[dobCol]) : "",
          vacationPeriods: (vs && ve && r[vs] && r[ve]) ? [{ start: parseExcelDate(r[vs]), end: parseExcelDate(r[ve]) }] : [],
          role,
          schoolTracking,
          derogations,
        };
      }).filter(c => c.firstName && c.dob);
      if (parsed.length === 0) { setImportMsg("❌ Aucun enfant valide trouvé."); return; }
      setImportPreview(parsed); setShowPreview(true);
      setImportMsg(`✅ ${parsed.length} enfant(s) détecté(s)`);
    } catch (err) { console.error(err); setImportMsg("❌ Erreur de lecture."); }
    e.target.value = "";
  }

  async function confirmImport() {
    setImporting(true);
    try { await onImport(importPreview); setShowPreview(false); setImportPreview([]); setImportMsg(`✅ ${importPreview.length} enfant(s) importé(s) !`); }
    catch { setImportMsg("❌ Erreur lors de l'import."); }
    setImporting(false);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-bold text-base" style={{ fontFamily: "Syne, sans-serif" }}>Enfants ({activeChildren.length})</h2>
        <Btn onClick={onAdd} className="text-xs py-2 px-3">+ Ajouter</Btn>
      </div>

      {/* Import zone */}
      <div className="bg-slate-900/40 border border-slate-700 rounded-xl p-3 mb-4">
        <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-2">Import Excel / CSV</div>
        <div className="flex gap-2 mb-2">
          <button onClick={downloadTemplate} className="flex-1 text-xs text-blue-400 border border-blue-800/60 px-2 py-2 rounded-lg">⬇ Modèle CSV</button>
          <button onClick={() => fileRef.current?.click()} className="flex-1 text-xs text-emerald-400 border border-emerald-800/60 px-2 py-2 rounded-lg">📂 Importer</button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.txt" className="hidden" onChange={handleFile} />
        </div>
        {importMsg && <div className={`text-xs mb-2 ${importMsg.startsWith("✅") ? "text-emerald-400" : "text-red-400"}`}>{importMsg}</div>}
        {showPreview && importPreview.length > 0 && (
          <div className="mt-2 bg-slate-800/60 rounded-xl p-3">
            <div className="space-y-1.5 max-h-56 overflow-y-auto mb-2">
              {importPreview.map((c, i) => (
                <div key={i} className="text-xs flex gap-1.5 items-center flex-wrap">
                  <span className="text-white font-semibold">{c.firstName} {c.lastName}</span>
                  <span className="text-slate-500">{c.dob}</span>
                  {c.role && <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${ROLE_COLORS[c.role as ChildRole]}`}>{ROLE_LABELS[c.role as ChildRole]}</span>}
                  {c.schoolTracking && <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-indigo-700 bg-indigo-900/40 text-indigo-300">📚 Suivi sco.</span>}
                  {c.vacationPeriods?.length > 0 && <span className="text-[10px] text-amber-400">🌴 {c.vacationPeriods.length}</span>}
                  {c.derogations?.length > 0 && <span className="text-[10px] text-purple-400">⏱ {c.derogations.length} dérog.</span>}
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <button onClick={() => { setShowPreview(false); setImportMsg(""); }} className="text-xs text-slate-400">Annuler</button>
              <button onClick={confirmImport} disabled={importing} className="flex-1 text-xs bg-blue-600 text-white py-2 rounded-lg disabled:opacity-50">{importing ? "Import…" : `Confirmer (${importPreview.length})`}</button>
            </div>
          </div>
        )}
      </div>

      {/* Fix #3: archive toggle */}
      {archivedChildren.length > 0 && (
        <button onClick={() => setShowArchived(v => !v)} className="text-xs text-slate-400 border border-slate-700 px-3 py-1.5 rounded-lg mb-3">
          {showArchived ? "← Actifs" : `📦 Archivés (${archivedChildren.length})`}
        </button>
      )}

      {/* Role tabs */}
      {!showArchived && rolesPresent.length > 0 && (
        <div className="flex gap-1 mb-3 border-b border-slate-800 overflow-x-auto">
          <button onClick={() => setRoleTab("all")} className={`px-3 py-2 text-xs whitespace-nowrap transition-colors border-b-2 ${roleTab === "all" ? "border-blue-500 text-white" : "border-transparent text-slate-500"}`}>Tous ({activeChildren.length})</button>
          {rolesPresent.map(r => <button key={r} onClick={() => setRoleTab(r)} className={`px-3 py-2 text-xs whitespace-nowrap transition-colors border-b-2 ${roleTab === r ? "border-blue-500 text-white" : "border-transparent text-slate-500"}`}>{ROLE_LABELS[r]} ({activeChildren.filter(c => c.role === r).length})</button>)}
          {activeChildren.some(c => !c.role) && <button onClick={() => setRoleTab("all")} className="px-3 py-2 text-xs whitespace-nowrap border-b-2 border-transparent text-slate-500">Sans statut ({activeChildren.filter(c => !c.role).length})</button>}
        </div>
      )}

      {displayChildren.length === 0
        ? <div className="text-slate-500 text-center py-10 text-sm">{showArchived ? "Aucun enfant archivé" : "Aucun enfant enregistré"}</div>
        : <div className="space-y-2">{displayChildren.map(c => (
          <div key={c.id} className={`bg-slate-900/50 border rounded-xl px-3 py-3 ${c.archived ? "border-slate-700/40 opacity-60" : "border-slate-700"}`}>
            <div className="flex items-center gap-3">
              {c.role && <div className={`w-1 self-stretch rounded-full flex-shrink-0 ${c.role === "role" ? "bg-purple-500" : c.role === "silhouette" ? "bg-cyan-500" : "bg-orange-500"}`} />}
              <div className="w-9 h-9 rounded-full bg-blue-900/60 flex items-center justify-center text-blue-300 font-bold text-sm flex-shrink-0">{c.first_name?.[0]}{c.last_name?.[0]}</div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-white text-sm truncate">{c.first_name} {c.last_name}</div>
                <div className="text-xs text-slate-400">{getAge(c.dob)} ans · {AGE_BAND_LABELS[getAgeBand(c.dob)]}{!isMinor(c.dob) && <span className="text-amber-400"> · ⚠ majeur·e</span>}</div>
              </div>
              {c.role && <RoleBadge role={c.role} />}
            </div>
            {/* Fix #3 + #4: action buttons */}
            <div className="flex gap-2 mt-2 ml-1">
              <button onClick={() => onEdit(c)} className="text-[10px] text-slate-400 border border-slate-700 px-2 py-1 rounded-lg">✏️ Modifier</button>
              {/* Fix #4: per-child export */}
              <button onClick={() => onExportChildDays(c)} className="text-[10px] text-blue-400 border border-blue-800/60 px-2 py-1 rounded-lg">📄 Journées</button>
              {/* Fix #3: archive */}
              {!c.archived
                ? <button onClick={() => onArchive(c.id, true)} className="text-[10px] text-amber-400 border border-amber-800/60 px-2 py-1 rounded-lg">📦 Archiver</button>
                : <button onClick={() => onArchive(c.id, false)} className="text-[10px] text-emerald-400 border border-emerald-800/60 px-2 py-1 rounded-lg">↩ Désarchiver</button>
              }
              <button onClick={() => setDeletingChild(c)} className="text-[10px] text-red-400 border border-red-800/60 px-2 py-1 rounded-lg ml-auto">🗑</button>
            </div>
          </div>
        ))}</div>
      }
      {deletingChild && (
        <ChildDeleteConfirmModal
          child={deletingChild}
          onConfirm={() => onRemove(deletingChild.id)}
          onClose={() => setDeletingChild(null)}
        />
      )}
    </div>
  );
}

function GroupsTab({ project, onAdd, onRemove, onUpdateGroup }: { project: Project; onAdd: () => void; onRemove: (id: string) => void; onUpdateGroup: (id: string, d: any) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [nameValue, setNameValue] = useState("");
  const childGroupMap: Record<string, string[]> = {};
  for (const g of project.groups) { for (const cid of g.child_ids || []) { if (!childGroupMap[cid]) childGroupMap[cid] = []; childGroupMap[cid].push(g.name); } }
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-bold text-base" style={{ fontFamily: "Syne, sans-serif" }}>Groupes ({project.groups.length})</h2>
        <Btn onClick={onAdd} className="text-xs py-2 px-3">+ Créer</Btn>
      </div>
      {project.groups.length === 0 ? <div className="text-slate-500 text-center py-10 text-sm">Aucun groupe</div> :
        <div className="space-y-3">{project.groups.map(g => {
          const memberCount = (g.child_ids || []).filter(id => project.children.find(c => c.id === id)).length;
          return (
            <div key={g.id} className="bg-slate-900/50 border border-slate-700 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                {editingName === g.id ? (
                  <div className="flex items-center gap-2 flex-1 mr-2">
                    <input value={nameValue} onChange={e => setNameValue(e.target.value)} className="flex-1 bg-slate-800 border border-blue-500 rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
                      onKeyDown={e => { if (e.key === "Enter" && nameValue.trim()) { onUpdateGroup(g.id, { name: nameValue.trim() }); setEditingName(null); } if (e.key === "Escape") setEditingName(null); }} autoFocus />
                    <button onClick={() => { if (nameValue.trim()) { onUpdateGroup(g.id, { name: nameValue.trim() }); setEditingName(null); } }} className="text-emerald-400 w-8 h-8 flex items-center justify-center">✓</button>
                    <button onClick={() => setEditingName(null)} className="text-slate-400 w-8 h-8 flex items-center justify-center">✕</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-white text-sm">{g.name} <span className="text-slate-400 font-normal">({memberCount})</span></h3>
                    <button onClick={() => { setEditingName(g.id); setNameValue(g.name); }} className="text-slate-500 text-xs w-8 h-8 flex items-center justify-center">✏️</button>
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={() => setEditing(editing === g.id ? null : g.id)} className="text-slate-400 text-xs px-2 py-1.5 rounded border border-slate-600">{editing === g.id ? "✓" : "👥"}</button>
                  <button onClick={() => onRemove(g.id)} className="text-slate-500 hover:text-red-400 w-8 h-8 flex items-center justify-center">✕</button>
                </div>
              </div>
              {editing === g.id && (
                <div className="mb-3 bg-slate-800/50 rounded-xl p-3">
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-2">Membres</div>
                  {project.children.filter(c => !c.archived).length === 0 ? <div className="text-xs text-slate-500">Aucun enfant actif</div> :
                    <div className="space-y-1">{project.children.filter(c => !c.archived).map(c => {
                      const isInThisGroup = (g.child_ids || []).includes(c.id);
                      const otherGroups = (childGroupMap[c.id] || []).filter(gn => gn !== g.name);
                      return (
                        <label key={c.id} className="flex items-center gap-3 py-2 cursor-pointer">
                          <input type="checkbox" className="accent-blue-500 w-5 h-5" checked={isInThisGroup}
                            onChange={e => onUpdateGroup(g.id, { child_ids: e.target.checked ? [...(g.child_ids || []), c.id] : (g.child_ids || []).filter((i: string) => i !== c.id) })} />
                          <span className="text-sm text-slate-200 flex-1">{c.first_name} {c.last_name}</span>
                          <div className="flex gap-1">{c.role && <RoleBadge role={c.role} />}{otherGroups.map(gn => <span key={gn} className="text-[9px] px-1 py-0.5 rounded bg-slate-600/60 text-slate-300">👥{gn}</span>)}</div>
                        </label>
                      );
                    })}</div>
                  }
                </div>
              )}
              <div className="flex flex-wrap gap-1">{(g.child_ids || []).map((id: string) => { const c = project.children.find(ch => ch.id === id); return c ? <Badge key={id} color="slate">{c.first_name} {c.last_name}</Badge> : null; })}{!g.child_ids?.length && <span className="text-xs text-slate-500">Aucun membre</span>}</div>
            </div>
          );
        })}</div>
      }
    </div>
  );
}

function SettingsTab({ rules, onUpdateRules, projectName, onRename, onDelete }: { rules: Rules; onUpdateRules: (fn: (r: Rules) => Rules) => void; projectName: string; onRename: (name: string) => Promise<void>; onDelete: () => void }) {
  const [confirmName, setConfirmName] = useState("");
  const [nameDraft, setNameDraft] = useState(projectName);
  const [renameMsg, setRenameMsg] = useState<"" | "saving" | "saved" | "error">("");
  useEffect(() => { setNameDraft(projectName); }, [projectName]);
  function setRule(path: string, value: string) {
    onUpdateRules(r => { const copy = JSON.parse(JSON.stringify(r)); const keys = path.split("."); let obj: any = copy; for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]]; obj[keys[keys.length - 1]] = Number(value); return copy; });
  }
  async function handleRename() {
    const v = nameDraft.trim();
    if (!v || v === projectName) return;
    setRenameMsg("saving");
    try { await onRename(v); setRenameMsg("saved"); setTimeout(() => setRenameMsg(""), 2000); }
    catch { setRenameMsg("error"); }
  }
  const canRename = nameDraft.trim().length > 0 && nameDraft.trim() !== projectName;
  const BL: Record<AgeBand, string> = AGE_BAND_LABELS;
  return (
    <div className="space-y-4">
      {/* Nom du projet */}
      <div className="bg-slate-900/50 border border-slate-700 rounded-2xl p-4">
        <h2 className="font-bold text-sm text-white mb-3" style={{ fontFamily: "Syne, sans-serif" }}>Nom de la production</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleRename(); }}
            className="flex-1 bg-slate-800 border border-slate-600 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 placeholder:text-slate-600"
            placeholder="Nom du projet"
          />
          <button
            onClick={handleRename}
            disabled={!canRename || renameMsg === "saving"}
            className={`px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors ${canRename && renameMsg !== "saving" ? "bg-blue-600 hover:bg-blue-500 text-white" : "bg-slate-800 text-slate-600 cursor-not-allowed"}`}
          >
            {renameMsg === "saving" ? "…" : "Enregistrer"}
          </button>
        </div>
        {renameMsg === "saved" && <div className="text-xs text-emerald-400 mt-2">✓ Nom mis à jour</div>}
        {renameMsg === "error" && <div className="text-xs text-red-400 mt-2">Erreur lors de la mise à jour</div>}
      </div>

      <h2 className="font-bold text-base mb-1" style={{ fontFamily: "Syne, sans-serif" }}>Paramètres DRIEETS</h2>
      <div className="space-y-2">
        {([["Amplitude max", "maxAmplitudeMinutes", 60, 720, 30], ["Pause minimum", "minBreakMinutes", 5, 60, 1]] as const).map(([label, key, min, max, step]) => (
          <div key={key} className="bg-slate-900/50 border border-slate-700 rounded-xl p-3 flex items-center justify-between">
            <div className="text-sm text-white">{label}</div>
            <div className="flex items-center gap-2">
              <input type="number" min={min} max={max} step={step} value={(rules as any)[key]} onChange={e => setRule(key, e.target.value)} className="w-20 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm text-center" />
              <span className="text-xs text-slate-400 w-12">{formatMinutes((rules as any)[key])}</span>
            </div>
          </div>
        ))}
      </div>
      {(["maxWorkMinutes", "mandatoryBreakAfterMinutes"] as const).map(rk => (
        <div key={rk}>
          <h3 className="text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">{rk === "maxWorkMinutes" ? "Temps de travail max" : "Pause obligatoire après"}</h3>
          <div className="space-y-2">{AGE_BANDS.map(band => (
            <div key={band} className="bg-slate-900/50 border border-slate-700 rounded-xl p-3">
              <div className="font-semibold text-white text-xs mb-2">{BL[band]}</div>
              <div className="grid grid-cols-2 gap-3">{(["school", "vacation"] as const).map(p => (
                <div key={p}>
                  <div className="text-[10px] text-slate-400 mb-1">{p === "school" ? "🏫 Scolaire" : "🌴 Vacances"}</div>
                  <div className="bg-slate-800/80 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-400 text-xs font-mono text-center">
                    {formatMinutes(rules[rk][band][p])}
                  </div>
                </div>
              ))}</div>
            </div>
          ))}</div>
        </div>
      ))}

      {/* Zone de danger */}
      <div className="mt-6 border border-red-900/60 rounded-2xl p-4 bg-red-950/20">
        <h2 className="font-bold text-sm text-red-400 mb-1" style={{ fontFamily: "Syne, sans-serif" }}>⚠️ Zone de danger</h2>
        <p className="text-xs text-slate-400 mb-3">Pour supprimer cette production, tapez son nom exact ci-dessous puis confirmez.</p>
        <input
          className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-white text-sm mb-3 focus:outline-none focus:border-red-500 placeholder:text-slate-600"
          placeholder={projectName}
          value={confirmName}
          onChange={e => setConfirmName(e.target.value)}
        />
        <button
          disabled={confirmName !== projectName}
          onClick={() => { if (confirmName === projectName) onDelete(); }}
          className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-colors ${confirmName === projectName ? "bg-red-700 hover:bg-red-600 text-white" : "bg-slate-800 text-slate-600 cursor-not-allowed"}`}
        >
          Supprimer définitivement
        </button>
      </div>
    </div>
  );
}

function ChildFormModal({ child, onSave, onClose }: { child: Child | null; onSave: (d: any) => void; onClose: () => void }) {
  const [firstName, setFirstName] = useState(child?.first_name ?? "");
  const [lastName, setLastName] = useState(child?.last_name ?? "");
  const [dob, setDob] = useState(child?.dob || "");
  const [vacationPeriods, setVacationPeriods] = useState<VacationPeriod[]>(child?.vacation_periods || []);
  const [role, setRole] = useState<ChildRole | null>(child?.role || null);
  const [newVac, setNewVac] = useState({ start: "", end: "" });
  const [derogations, setDerogations] = useState<Derogation[]>(child?.derogations || []);
  const [newDerog, setNewDerog] = useState({ date: "", end_time: "" });
  const [schoolTracking, setSchoolTracking] = useState<boolean>(child?.school_tracking ?? false);
  const [error, setError] = useState("");

  function handleSave() {
    const fn = firstName.trim(), ln = lastName.trim();
    if (!fn || !ln) { setError("Le prénom et le nom sont obligatoires."); return; }
    if (!dob) { setError("La date de naissance est obligatoire."); return; }
    setError("");
    onSave({ firstName: fn, lastName: ln, dob, vacationPeriods, role, derogations, schoolTracking });
  }

  return (
    <Modal title={child ? "Modifier l'enfant" : "Ajouter un enfant"} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <TextInput label="Prénom" required value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Léa" />
          <TextInput label="Nom" required value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Martin" />
        </div>
        <TextInput label="Date de naissance" required type="date" value={dob} onChange={e => setDob(e.target.value)} />
        {dob && (
          <div className={`border rounded-lg px-3 py-2 text-sm ${isMinor(dob) ? "bg-blue-900/30 border-blue-700/60 text-blue-300" : "bg-amber-900/30 border-amber-700/60 text-amber-200"}`}>
            {getAge(dob)} ans · Tranche {AGE_BAND_LABELS[getAgeBand(dob)]}
            {!isMinor(dob) && <div className="text-[10px] text-amber-300/80 mt-1">⚠️ Majeur·e — hors champ DRIEETS. Les règles affichées le sont à titre indicatif.</div>}
          </div>
        )}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-400 uppercase tracking-[0.15em] font-semibold">Statut <span className="text-slate-600 font-normal normal-case">(optionnel)</span></label>
          <div className="flex gap-2 flex-wrap">
            <button type="button" onClick={() => setRole(null)} className={`px-3 py-2 rounded-lg text-xs font-semibold border ${role === null ? "bg-slate-600 border-slate-500 text-white" : "bg-slate-800 border-slate-600 text-slate-400"}`}>Non défini</button>
            {ALL_ROLES.map(r => <button key={r} type="button" onClick={() => setRole(r)} className={`px-3 py-2 rounded-lg text-xs font-semibold border ${role === r ? ROLE_COLORS[r] : "bg-slate-800 border-slate-600 text-slate-400"}`}>{ROLE_LABELS[r]}</button>)}
          </div>
        </div>
        <div>
          <label className="text-[10px] text-slate-400 uppercase tracking-wider block mb-2">Vacances <span className="text-slate-600 font-normal normal-case">(optionnel)</span></label>
          {vacationPeriods.map((p, i) => <div key={i} className="flex items-center gap-2 mb-1 text-sm text-slate-300"><span>{p.start} → {p.end}</span><button onClick={() => setVacationPeriods(v => v.filter((_, j) => j !== i))} className="text-red-400 w-6 h-6 flex items-center justify-center">✕</button></div>)}
          <div className="flex gap-2 items-end mt-2">
            <TextInput label="Début" type="date" value={newVac.start} onChange={e => setNewVac(v => ({ ...v, start: e.target.value }))} />
            <TextInput label="Fin" type="date" value={newVac.end} onChange={e => setNewVac(v => ({ ...v, end: e.target.value }))} />
            <button onClick={() => { if (newVac.start && newVac.end) { setVacationPeriods(v => [...v, newVac]); setNewVac({ start: "", end: "" }); } }} className="bg-slate-700 text-white px-3 rounded-lg h-12 text-sm">+</button>
          </div>
        </div>
        {/* Suivi scolaire */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-400 uppercase tracking-[0.15em] font-semibold">Suivi scolaire <span className="text-slate-600 font-normal normal-case">(optionnel)</span></label>
          <button type="button" onClick={() => setSchoolTracking(v => !v)} className={`px-3 py-2 rounded-lg text-xs font-semibold border w-fit ${schoolTracking ? "bg-indigo-700 border-indigo-500 text-white" : "bg-slate-800 border-slate-600 text-slate-400"}`}>
            {schoolTracking ? "✓ Activé" : "Désactivé"}
          </button>
          <div className="text-[10px] text-slate-500">Active le bouton 📚 Suivi scolaire pour cet enfant pendant le tournage. Inclus dans l&apos;amplitude, hors temps de travail et hors pause.</div>
        </div>
        {/* Dérogations horaires (travail après 20h) */}
        <div>
          <label className="text-[10px] text-slate-400 uppercase tracking-wider block mb-2">
            Dérogations horaires <span className="text-slate-600 font-normal normal-case">(travail après 20h)</span>
          </label>
          {derogations.map((d, i) => (
            <div key={i} className="flex items-center gap-2 mb-1 text-sm">
              <span className="text-orange-300 flex-1">{new Date(d.date + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })} — jusqu&apos;à {d.end_time}</span>
              <button onClick={() => setDerogations(v => v.filter((_, j) => j !== i))} className="text-red-400 w-6 h-6 flex items-center justify-center flex-shrink-0">✕</button>
            </div>
          ))}
          <div className="flex gap-2 items-end mt-2">
            <TextInput label="Date" type="date" value={newDerog.date} onChange={e => setNewDerog(v => ({ ...v, date: e.target.value }))} />
            <TextInput label="Heure limite" type="time" value={newDerog.end_time} onChange={e => setNewDerog(v => ({ ...v, end_time: e.target.value }))} />
            <button
              onClick={() => { if (newDerog.date && newDerog.end_time) { setDerogations(v => [...v, newDerog]); setNewDerog({ date: "", end_time: "" }); } }}
              className="bg-orange-800/60 text-orange-200 border border-orange-700 px-3 rounded-lg h-12 text-sm">+</button>
          </div>
          <div className="text-[10px] text-slate-500 mt-1">Sans dérogation, l&apos;alerte se déclenche à 20h00</div>
        </div>
        {error && <div className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">{error}</div>}
        <div className="text-[10px] text-slate-500">Les champs <span className="text-red-400">*</span> sont obligatoires</div>
        <Btn className="w-full justify-center" onClick={handleSave}>{child ? "Enregistrer" : "Ajouter l'enfant"}</Btn>
      </div>
    </Modal>
  );
}

function GroupFormModal({ group, onSave, onClose }: { group: Group | null; onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(group?.name || "");
  return (
    <Modal title={group ? "Modifier le groupe" : "Créer un groupe"} onClose={onClose}>
      <div className="space-y-3">
        <TextInput label="Nom du groupe" value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Scène 12…" />
        <Btn className="w-full justify-center" onClick={() => name.trim() && onSave(name.trim())}>{group ? "Enregistrer" : "Créer"}</Btn>
      </div>
    </Modal>
  );
}

// Fix #1: ShootingView — mobile-optimised compact cards + Fix #7: selection count
function ManageChildrenList({ project, childIds, onToggleChild, onPendingUncheck }: {
  project: Project;
  childIds: string[];
  onToggleChild: (cid: string) => void;
  onPendingUncheck: (c: Child) => void;
}) {
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<ChildRole | "all">("all");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const active = project.children.filter(c => !c.archived);
  const sorted = sortByRoleThenAlpha(active);
  const q = normalize(search);
  const filtered = sorted.filter(c => {
    if (roleFilter !== "all" && (c.role || null) !== roleFilter) return false;
    if (q) {
      const hay = normalize(`${c.first_name} ${c.last_name}`);
      const hay2 = normalize(`${c.last_name} ${c.first_name}`);
      if (!hay.includes(q) && !hay2.includes(q)) return false;
    }
    return true;
  });

  // Regroupe par statut
  type SectionKey = ChildRole | "none";
  const sections: { key: SectionKey; label: string; children: Child[] }[] = [];
  const buckets: Record<SectionKey, Child[]> = { role: [], silhouette: [], figurant: [], none: [] };
  for (const c of filtered) buckets[(c.role || "none") as SectionKey].push(c);
  const order: SectionKey[] = ["role", "silhouette", "figurant", "none"];
  const labels: Record<SectionKey, string> = { role: "Rôle", silhouette: "Silhouette", figurant: "Figurant·e", none: "Sans statut" };
  for (const k of order) if (buckets[k].length > 0) sections.push({ key: k, label: labels[k], children: buckets[k] });

  const totalSelected = active.filter(c => childIds.includes(c.id)).length;
  const counts = ALL_ROLES.map(r => ({ r, n: active.filter(c => c.role === r).length, sel: active.filter(c => c.role === r && childIds.includes(c.id)).length }));
  const noneN = active.filter(c => !c.role).length;
  const noneSel = active.filter(c => !c.role && childIds.includes(c.id)).length;

  function toggleSection(key: string) { setCollapsed(s => ({ ...s, [key]: !s[key] })); }

  function selectAllInSection(children: Child[]) {
    for (const c of children) if (!childIds.includes(c.id)) onToggleChild(c.id);
  }
  function deselectAllInSection(children: Child[]) {
    for (const c of children) if (childIds.includes(c.id)) onPendingUncheck(c);
  }

  return (
    <div className="space-y-3">
      {/* Header : recherche + compteur global */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="🔍 Rechercher par nom…"
          className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder:text-slate-500"
        />
        <span className="text-[10px] bg-blue-700/40 text-blue-200 px-2 py-1 rounded-lg font-bold whitespace-nowrap">{totalSelected}/{active.length}</span>
      </div>

      {/* Filtres rapides par statut */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        <button onClick={() => setRoleFilter("all")} className={`text-[10px] px-2 py-1 rounded-lg border whitespace-nowrap ${roleFilter === "all" ? "bg-blue-700 border-blue-500 text-white" : "bg-slate-800 border-slate-600 text-slate-400"}`}>
          Tous <span className="opacity-60">({active.length})</span>
        </button>
        {counts.filter(c => c.n > 0).map(({ r, n, sel }) => (
          <button key={r} onClick={() => setRoleFilter(r)} className={`text-[10px] px-2 py-1 rounded-lg border whitespace-nowrap ${roleFilter === r ? "bg-blue-700 border-blue-500 text-white" : "bg-slate-800 border-slate-600 text-slate-400"}`}>
            {ROLE_LABELS[r]} <span className="opacity-60">({sel}/{n})</span>
          </button>
        ))}
        {noneN > 0 && (
          <button onClick={() => setRoleFilter("all")} disabled className="text-[10px] px-2 py-1 rounded-lg border bg-slate-800/40 border-slate-700 text-slate-600 whitespace-nowrap">
            Sans statut <span className="opacity-60">({noneSel}/{noneN})</span>
          </button>
        )}
      </div>

      {/* Sections par statut */}
      {sections.length === 0 && (
        <div className="text-center text-slate-500 text-xs py-4">Aucun enfant{search ? ` ne correspond à "${search}"` : ""}.</div>
      )}
      {sections.map(({ key, label, children }) => {
        const sectionSel = children.filter(c => childIds.includes(c.id)).length;
        const allSel = sectionSel === children.length;
        const isCollapsed = !!collapsed[key];
        return (
          <div key={key} className="bg-slate-900/40 border border-slate-700 rounded-xl overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 bg-slate-800/50">
              <button onClick={() => toggleSection(key)} className="flex-1 text-left text-xs font-semibold text-slate-200 flex items-center gap-2">
                <span className="text-slate-500">{isCollapsed ? "▸" : "▾"}</span>
                <span>{label}</span>
                <span className="text-[10px] text-slate-500 font-normal">{sectionSel}/{children.length}</span>
              </button>
              <button
                onClick={() => allSel ? deselectAllInSection(children) : selectAllInSection(children)}
                className={`text-[10px] px-2 py-1 rounded-lg border whitespace-nowrap ${allSel ? "border-red-800/60 text-red-400" : "border-slate-700 text-slate-400 hover:text-white"}`}
              >
                {allSel ? "Tout décocher" : "Tout cocher"}
              </button>
            </div>
            {!isCollapsed && (
              <div className="divide-y divide-slate-800">
                {children.map(c => {
                  const checked = childIds.includes(c.id);
                  return (
                    <label key={c.id} className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-slate-800/30 transition-colors">
                      <input
                        type="checkbox"
                        className="accent-blue-500 w-5 h-5 flex-shrink-0"
                        checked={checked}
                        onChange={() => {
                          if (checked) onPendingUncheck(c);
                          else onToggleChild(c.id);
                        }}
                      />
                      <span className="text-sm text-slate-200 flex-1 truncate">{c.last_name} {c.first_name}</span>
                      <span className="text-[10px] text-slate-500 whitespace-nowrap">{getAge(c.dob)} ans</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ShootingView({ project, dateStr, onBack, onStartSessions, onStartSession, onCancelSession, onApplyEvent, onCancelLastEvent, onEndSessions, onReopenSession, onToggleChild, onAddGroup, onRemoveGroup, onEditEventTime, onEditStartTime, onEditEndTime, onExportPDF }: {
  project: Project; dateStr: string; onBack: () => void;
  onStartSessions: (cids: string[], t?: string) => void; onStartSession: (cid: string, t?: string) => void;
  onCancelSession: (cid: string) => void; onApplyEvent: (cids: string[], type: "pause_start" | "pause_end" | "dejeuner_start" | "dejeuner_end" | "school_start" | "school_end", t?: string) => void;
  onCancelLastEvent: (cid: string) => void; onEndSessions: (cids: string[], t?: string) => void;
  onReopenSession: (cid: string) => void; onToggleChild: (cid: string) => void;
  onAddGroup: (gid: string) => void; onRemoveGroup: (gid: string) => void;
  onEditEventTime: (cid: string, idx: number, t: string) => void; onEditStartTime: (cid: string, t: string) => void; onEditEndTime: (cid: string, t: string) => void;
  onExportPDF: () => void;
}) {
  const [, setTick] = useState(0);
  const [addingChildren, setAdding] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionModal, setActionModal] = useState<{ type: "start" | "pause" | "dejeuner" | "school" | "resume" | "end" } | null>(null);
  const [search, setSearch] = useState("");
  const [roleTab, setRoleTab] = useState<ChildRole | "all">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null); // Fix #1: collapsed cards
  const [pendingUncheck, setPendingUncheck] = useState<Child | null>(null);

  useEffect(() => { const t = setInterval(() => setTick(n => n + 1), 15000); return () => clearInterval(t); }, []);

  const day = project.shootingDays[dateStr] || { child_ids: [], sessions: {} };
  const childIds = day.child_ids || [];
  const sessions = day.sessions || {};
  const rules = project.rules;
  const dateLabel = new Date(dateStr + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const childrenInDay = sortByRoleThenAlpha(childIds.map(id => project.children.find(c => c.id === id)).filter(Boolean) as Child[]);
  const rolesPresent = ALL_ROLES.filter(r => childrenInDay.some(c => c.role === r));

  // Dérivé de childrenInDay (déjà trié par rôle puis alpha) pour préserver l'ordre d'affichage
  const filteredIds = childrenInDay.filter(c => {
    if (search.trim()) { const q = normalize(search); if (!normalize(`${c.first_name} ${c.last_name}`).includes(q) && !normalize(`${c.last_name} ${c.first_name}`).includes(q)) return false; }
    if (roleTab === "all") return true;
    return c.role === roleTab;
  }).map(c => c.id);

  function toggleSelect(id: string) { setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  const selList = [...selected];
  const childHasSchool = (id: string) => project.children.find(c => c.id === id)?.school_tracking === true;
  const canStart    = selList.some(id => !sessions[id]?.start_time);
  const canPause    = selList.some(id => sessions[id]?.status === "working");
  const canDejeuner = selList.some(id => sessions[id]?.status === "working");
  const canSchool   = selList.some(id => sessions[id]?.status === "working" && childHasSchool(id));
  const canResume   = selList.some(id => sessions[id]?.status === "paused" || sessions[id]?.status === "dejeuner" || sessions[id]?.status === "school");
  const canEnd      = selList.some(id => sessions[id]?.start_time && sessions[id]?.status !== "done");

  return (
    <div className="min-h-screen bg-[#080d16] text-white pb-4" style={{ fontFamily: "'DM Mono', monospace" }}>
      {/* Fix #1: compact sticky header */}
      <div className="sticky top-0 z-10 bg-[#080d16] border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-3 mb-2">
          <button onClick={onBack} className="text-slate-400 w-8 h-8 flex items-center justify-center rounded-lg border border-slate-700 flex-shrink-0">←</button>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-extrabold capitalize truncate" style={{ fontFamily: "Syne, sans-serif" }}>{dateLabel}</h1>
            {/* Fix #7: selection count always visible */}
            <div className="text-xs text-slate-400">{childIds.length} enfant(s) · <span className={selected.size > 0 ? "text-blue-400 font-semibold" : ""}>{selected.size} sélectionné(s)</span></div>
          </div>
          <button onClick={onExportPDF} className="text-xs text-blue-400 border border-blue-800/60 px-2 py-1.5 rounded-lg flex-shrink-0">PDF</button>
        </div>

        {/* Fix #7: action bar with count badge always showing */}
        {childIds.length > 0 && (
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            <div className="flex gap-1 flex-shrink-0">
              <button onClick={() => setSelected(new Set(childIds))} className="text-[10px] text-blue-400 border border-slate-700 px-2 py-1.5 rounded-lg whitespace-nowrap">Tous</button>
              <button onClick={() => setSelected(new Set())} className="text-[10px] text-slate-500 border border-slate-700 px-2 py-1.5 rounded-lg whitespace-nowrap">Aucun</button>
              {project.groups.map(g => <button key={g.id} onClick={() => setSelected(s => { const n = new Set(s); (g.child_ids || []).forEach(id => n.add(id)); return n; })} className="text-[10px] text-slate-400 border border-slate-700 px-2 py-1.5 rounded-lg whitespace-nowrap">{g.name}</button>)}
            </div>
            {/* Fix #7: badge showing count */}
            {selected.size > 0 && (
              <div className="flex gap-1 flex-shrink-0 ml-auto">
                <span className="text-[10px] bg-blue-600 text-white px-2 py-1.5 rounded-lg font-bold">{selected.size} ✓</span>
                {canStart    && <button onClick={() => setActionModal({ type: "start" })}    className="text-[10px] bg-emerald-900/60 text-emerald-300 border border-emerald-800 px-2 py-1.5 rounded-lg whitespace-nowrap">▶ Start</button>}
                {canPause    && <button onClick={() => setActionModal({ type: "pause" })}    className="text-[10px] bg-amber-900/60 text-amber-300 border border-amber-800 px-2 py-1.5 rounded-lg whitespace-nowrap">⏸ Pause</button>}
                {canDejeuner && <button onClick={() => setActionModal({ type: "dejeuner" })} className="text-[10px] bg-orange-900/60 text-orange-300 border border-orange-700 px-2 py-1.5 rounded-lg whitespace-nowrap">🍽 Déjeuner</button>}
                {canSchool   && <button onClick={() => setActionModal({ type: "school" })}   className="text-[10px] bg-indigo-900/60 text-indigo-300 border border-indigo-700 px-2 py-1.5 rounded-lg whitespace-nowrap">📚 Suivi scolaire</button>}
                {canResume   && <button onClick={() => setActionModal({ type: "resume" })}   className="text-[10px] bg-emerald-900/60 text-emerald-300 border border-emerald-800 px-2 py-1.5 rounded-lg whitespace-nowrap">▶ Reprise</button>}
                {canEnd      && <button onClick={() => setActionModal({ type: "end" })}      className="text-[10px] bg-slate-700 text-white border border-slate-600 px-2 py-1.5 rounded-lg whitespace-nowrap">⏹ Fin</button>}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="px-4 py-3">
        {/* Manage children */}
        <div className="mb-3">
          <button onClick={() => setAdding(v => !v)} className="text-xs text-blue-400 border border-blue-800/60 px-3 py-2 rounded-lg w-full">
            {addingChildren ? "✕ Fermer" : "+ Gérer les enfants de la journée"}
          </button>
          {addingChildren && (
            <div className="mt-2 bg-slate-900/60 border border-slate-700 rounded-xl p-4">
              {project.groups.length > 0 && (
                <div className="mb-3">
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-2">Groupes</div>
                  <div className="space-y-1.5">{project.groups.map(g => {
                    const groupInDay = g.child_ids.length > 0 && g.child_ids.every(id => childIds.includes(id));
                    const groupPartial = !groupInDay && g.child_ids.some(id => childIds.includes(id));
                    return (
                      <div key={g.id} className="flex items-center gap-2">
                        <button onClick={() => onAddGroup(g.id)} className={`flex-1 text-sm px-3 py-2 rounded-lg border ${groupInDay ? "bg-blue-900/50 border-blue-600 text-blue-300" : "bg-slate-800 border-slate-600 text-slate-300"}`}>
                          + {g.name} ({g.child_ids?.length || 0}){groupPartial && <span className="text-amber-400 text-xs ml-1">partiel</span>}
                        </button>
                        {(groupInDay || groupPartial) && <button onClick={() => onRemoveGroup(g.id)} className="text-xs text-red-400 border border-red-800/60 px-2 py-2 rounded-lg">− Ret.</button>}
                      </div>
                    );
                  })}</div>
                </div>
              )}
              <ManageChildrenList
                project={project}
                childIds={childIds}
                onToggleChild={onToggleChild}
                onPendingUncheck={setPendingUncheck}
              />
            </div>
          )}
        </div>

        {/* Search */}
        {childIds.length > 0 && (
          <input type="text" placeholder="🔍 Rechercher…" value={search} onChange={e => setSearch(e.target.value)}
            className="w-full bg-slate-800/60 border border-slate-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 placeholder:text-slate-500 mb-3" />
        )}

        {/* Role tabs */}
        {childIds.length > 0 && rolesPresent.length > 0 && (
          <div className="flex gap-1 mb-3 border-b border-slate-800 overflow-x-auto">
            <button onClick={() => setRoleTab("all")} className={`px-3 py-2 text-xs whitespace-nowrap border-b-2 ${roleTab === "all" ? "border-blue-500 text-white" : "border-transparent text-slate-500"}`}>Tous ({childrenInDay.length})</button>
            {rolesPresent.map(r => <button key={r} onClick={() => setRoleTab(r)} className={`px-3 py-2 text-xs whitespace-nowrap border-b-2 ${roleTab === r ? "border-blue-500 text-white" : "border-transparent text-slate-500"}`}>{ROLE_LABELS[r]} ({childrenInDay.filter(c => c.role === r).length})</button>)}
          </div>
        )}

        {/* Fix #1: compact child cards — tap to expand details */}
        {childIds.length === 0
          ? <div className="text-slate-500 text-center py-12 text-sm">Ajoutez des enfants à cette journée</div>
          : filteredIds.length === 0
            ? <div className="text-slate-500 text-center py-6 text-sm">Aucun résultat{search ? ` pour "${search}"` : ""}</div>
            : <div className="space-y-2">{filteredIds.map(id => {
              const child = project.children.find(c => c.id === id); if (!child) return null;
              const session = sessions[id]; const vacation = isVacation(child, dateStr);
              const band = getAgeBand(child.dob); const period: Period = vacation ? "vacation" : "school";
              const maxWork = rules.maxWorkMinutes[band][period]; const breakAfter = rules.mandatoryBreakAfterMinutes[band][period];
              const stats = computeSessionStats(session, rules);
              const isExpanded = expandedId === id;
              return <ChildCard key={id} child={child} session={session} stats={stats} maxWork={maxWork} breakAfter={breakAfter} maxAmplitude={rules.maxAmplitudeMinutes} vacation={vacation}
                isSelected={selected.has(id)} onSelect={() => toggleSelect(id)}
                isExpanded={isExpanded} onToggleExpand={() => setExpandedId(isExpanded ? null : id)}
                onStart={t => onStartSession(id, t)} onCancelSession={() => onCancelSession(id)}
                onCancelLastEvent={() => onCancelLastEvent(id)} onReopenSession={() => onReopenSession(id)}
                onEditEventTime={(idx, t) => onEditEventTime(id, idx, t)} onEditStartTime={t => onEditStartTime(id, t)} onEditEndTime={t => onEditEndTime(id, t)}
                onApplyEvent={(type, t) => onApplyEvent([id], type, t)}
                onEndSession={t => onEndSessions([id], t)}
                dateStr={dateStr} />;
            })}</div>
        }
      </div>

      {pendingUncheck && (
        <Modal title="Retirer l'enfant ?" onClose={() => setPendingUncheck(null)}>
          <div className="space-y-4">
            <div className="text-sm text-slate-300">
              Voulez-vous vraiment retirer <b className="text-white">{pendingUncheck.first_name} {pendingUncheck.last_name}</b> de cette journée ?
              {day.sessions?.[pendingUncheck.id]?.start_time && (
                <div className="mt-2 bg-red-900/30 border border-red-700/50 rounded-lg px-3 py-2 text-xs text-red-300">
                  ⚠ Cet enfant a des données de session enregistrées — elles seront perdues.
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Btn variant="ghost" className="flex-1" onClick={() => setPendingUncheck(null)}>Annuler</Btn>
              <button onClick={() => { onToggleChild(pendingUncheck.id); setPendingUncheck(null); }}
                className="flex-1 bg-red-700 hover:bg-red-600 text-white py-3 rounded-xl font-bold text-sm">
                Retirer
              </button>
            </div>
          </div>
        </Modal>
      )}

      {actionModal && <TimeActionModal type={actionModal.type} childCount={selected.size} dateStr={dateStr}
        onConfirm={timeISO => {
          const ids = [...selected];
          if      (actionModal.type === "start")    onStartSessions(ids, timeISO);
          else if (actionModal.type === "pause")    onApplyEvent(ids, "pause_start", timeISO);
          else if (actionModal.type === "dejeuner") onApplyEvent(ids, "dejeuner_start", timeISO);
          else if (actionModal.type === "school")   onApplyEvent(ids, "school_start", timeISO);
          else if (actionModal.type === "resume")   onApplyEvent(ids, "pause_end", timeISO);
          else if (actionModal.type === "end")      onEndSessions(ids, timeISO);
          setActionModal(null);
        }}
        onClose={() => setActionModal(null)} />}
    </div>
  );
}

function TimeActionModal({ type, childCount, dateStr, onConfirm, onClose }: { type: string; childCount: number; dateStr: string; onConfirm: (t: string) => void; onClose: () => void }) {
  const now = new Date();
  const [timeStr, setTimeStr] = useState(`${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
  const labels: Record<string, string> = { start: "Démarrer", pause: "Mise en pause", dejeuner: "Pause déjeuner", school: "Suivi scolaire", resume: "Reprise", end: "Fin de journée" };
  return (
    <Modal title={`${labels[type]} — ${childCount} enfant(s)`} onClose={onClose}>
      <div className="space-y-4">
        <input type="time" value={timeStr} onChange={e => setTimeStr(e.target.value)} className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-4 text-white text-3xl text-center focus:outline-none focus:border-blue-500" />
        <div className="text-xs text-slate-500 text-center">Modifiez si l&apos;événement a eu lieu avant</div>
        <div className="flex gap-3">
          <Btn variant="ghost" className="flex-1" onClick={onClose}>Annuler</Btn>
          <button onClick={() => onConfirm(timeStrToISO(dateStr, timeStr))} className="flex-1 py-3 rounded-xl font-bold text-sm bg-blue-600 text-white">Confirmer — {timeStr}</button>
        </div>
      </div>
    </Modal>
  );
}

function SingleStartButton({ onStart, dateStr }: { onStart: (t?: string) => void; dateStr: string }) {
  const now = new Date();
  const def = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const [open, setOpen] = useState(false);
  const [timeStr, setTimeStr] = useState(def);
  if (!open) return <button onClick={() => setOpen(true)} className="w-full bg-emerald-700 text-white py-3 rounded-xl font-semibold text-sm">▶ Démarrer la journée</button>;
  return (
    <div className="bg-slate-800/60 border border-slate-600 rounded-xl p-4 space-y-3">
      <input type="time" value={timeStr} onChange={e => setTimeStr(e.target.value)} className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-3 text-white text-xl text-center focus:outline-none focus:border-blue-500" />
      <div className="flex gap-2">
        <Btn variant="ghost" className="flex-1 py-2.5" onClick={() => setOpen(false)}>Annuler</Btn>
        <button onClick={() => onStart(timeStrToISO(dateStr, timeStr))} className="flex-1 bg-emerald-700 text-white py-2.5 rounded-xl font-bold text-sm">Démarrer à {timeStr}</button>
      </div>
    </div>
  );
}

// Fix #1: compact ChildCard with expand/collapse
function ChildCard({ child, session, stats, maxWork, breakAfter, maxAmplitude, vacation, isSelected, onSelect, isExpanded, onToggleExpand, onStart, onCancelSession, onCancelLastEvent, onReopenSession, onEditEventTime, onEditStartTime, onEditEndTime, onApplyEvent, onEndSession, dateStr }: {
  child: Child; session: Session | undefined; stats: SessionStats | null;
  maxWork: number; breakAfter: number; maxAmplitude: number; vacation: boolean;
  isSelected: boolean; onSelect: () => void;
  isExpanded: boolean; onToggleExpand: () => void;
  onStart: (t?: string) => void; onCancelSession: () => void; onCancelLastEvent: () => void; onReopenSession: () => void;
  onEditEventTime: (idx: number, t: string) => void; onEditStartTime: (t: string) => void; onEditEndTime: (t: string) => void;
  onApplyEvent: (type: "pause_start" | "pause_end" | "dejeuner_start" | "dejeuner_end" | "school_start" | "school_end", t?: string) => void;
  onEndSession: (t?: string) => void;
  dateStr: string;
}) {
  const [editingIdx, setEditingIdx] = useState<number | "start" | "end" | null>(null);
  const [indivModal, setIndivModal] = useState<{ type: "pause" | "dejeuner" | "school" | "resume" | "end" } | null>(null);
  const [editTime, setEditTime] = useState("");
  const workPct  = stats ? Math.min(100, (stats.workMin / maxWork) * 100) : 0;
  const ampPct   = stats ? Math.min(100, (stats.amplitudeMin / maxAmplitude) * 100) : 0;
  const workCrit = stats && stats.workMin > maxWork;
  const ampCrit  = stats && stats.amplitudeMin > maxAmplitude;
  const ampWarn  = stats && stats.amplitudeMin === maxAmplitude;
  const breakDue = stats?.timeSinceBreak != null && stats.timeSinceBreak >= breakAfter;

  // Alerte horaire (heure de derogation si definie, sinon defaut par bande d age)
  const derogation = (child.derogations || []).find(d => d.date === dateStr);
  const limitTimeStr = derogation ? derogation.end_time : DEFAULT_NIGHT_LIMIT_BY_BAND[getAgeBand(child.dob)];
  const limitDate = new Date(`${dateStr}T${limitTimeStr}:00`);
  const pastTimeLimit = session?.start_time != null && session.status !== "done" && new Date() >= limitDate;

  function startEdit(key: number | "start" | "end", iso: string | undefined) { setEditingIdx(key); setEditTime(isoToTimeStr(iso)); }
  function confirmEdit() {
    const iso = timeStrToISO(dateStr, editTime);
    if (editingIdx === "start") onEditStartTime(iso); else if (editingIdx === "end") onEditEndTime(iso); else onEditEventTime(editingIdx as number, iso);
    setEditingIdx(null);
  }
  const events = session?.events || [];

  const statusColor = session?.status === "working" ? "border-emerald-700" : session?.status === "paused" ? "border-amber-600" : session?.status === "dejeuner" ? "border-orange-500" : session?.status === "school" ? "border-indigo-600" : session?.status === "done" ? "border-slate-600" : workCrit || ampCrit ? "border-red-700" : ampWarn ? "border-orange-500" : pastTimeLimit ? "border-orange-600" : breakDue ? "border-amber-600" : "border-slate-700";

  return (
    <div className={`rounded-xl border transition-all ${isSelected ? "border-blue-500 bg-blue-950/20" : statusColor + " bg-slate-900/50"}`}>
      {/* Compact header — always visible */}
      <div className="flex items-center gap-2 px-3 py-3">
        <button onClick={onSelect} className={`w-6 h-6 rounded border-2 flex items-center justify-center flex-shrink-0 ${isSelected ? "bg-blue-600 border-blue-500" : "border-slate-600"}`}>
          {isSelected && <span className="text-white text-xs leading-none">✓</span>}
        </button>
        <div className="w-8 h-8 rounded-full bg-blue-900/60 flex items-center justify-center text-blue-300 font-bold text-xs flex-shrink-0">{child.first_name?.[0]}{child.last_name?.[0]}</div>
        <div className="flex-1 min-w-0" onClick={onToggleExpand}>
          <div className="font-bold text-white text-sm truncate">{child.first_name} {child.last_name}</div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {child.role && <RoleBadge role={child.role} />}
            {session?.status === "working" && stats && <span className="text-[10px] text-emerald-400">▶ {formatMinutes(stats.workMin)}</span>}
            {session?.status === "paused" && stats && <span className="text-[10px] text-amber-400">⏸ {formatMinutes(stats.workMin)}</span>}
            {session?.status === "dejeuner" && stats && <span className="text-[10px] text-orange-400">🍽 {formatMinutes(stats.dejeunerMin)}</span>}
            {session?.status === "school" && stats && <span className="text-[10px] text-indigo-400">📚 {formatMinutes(stats.schoolMin)}</span>}
            {session?.status === "done" && <span className="text-[10px] text-slate-400">✓ Terminé</span>}
            {!session?.start_time && <span className="text-[10px] text-slate-500">Non démarré</span>}
            {workCrit && <span className="text-[10px] text-red-400">🚫 Trav.</span>}
            {ampCrit && <span className="text-[10px] text-red-400">🚫 Ampl.</span>}
            {ampWarn && !ampCrit && <span className="text-[10px] text-orange-400">⚠️ Ampl.</span>}
            {breakDue && !workCrit && <span className="text-[10px] text-amber-400">⚠️ Pause</span>}
            {pastTimeLimit && <span className="text-[10px] text-orange-400">🕗 {limitTimeStr} dépassé</span>}
          </div>
        </div>
        {/* Mini progress bars */}
        {stats && (
          <div className="flex flex-col gap-1 w-16 flex-shrink-0" onClick={onToggleExpand}>
            <div className="h-1 bg-slate-800 rounded-full overflow-hidden"><div className={`h-full rounded-full ${workCrit ? "bg-red-500" : workPct > 80 ? "bg-amber-500" : "bg-blue-500"}`} style={{ width: `${workPct}%` }} /></div>
            <div className="h-1 bg-slate-800 rounded-full overflow-hidden"><div className={`h-full rounded-full ${ampCrit ? "bg-red-500" : ampWarn ? "bg-orange-500" : ampPct > 85 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${ampPct}%` }} /></div>
          </div>
        )}
        <button onClick={onToggleExpand} className="text-slate-500 w-8 h-8 flex items-center justify-center">{isExpanded ? "▲" : "▼"}</button>
      </div>

      {/* Expanded details */}
      {isExpanded && (
        <div className="px-3 pb-3 border-t border-slate-700/50 pt-3 space-y-3">
          {!session?.start_time && <SingleStartButton onStart={onStart} dateStr={dateStr} />}
          {session?.status === "done" && <div className="text-center text-emerald-400 text-sm font-semibold">✓ Journée terminée</div>}

          {stats && (
            <>
              <div className="grid grid-cols-3 gap-2">
                {([{ l: "Travail", v: stats.workMin, max: maxWork, crit: workCrit }, { l: "🍽 Déjeuner", v: stats.dejeunerMin }, { l: "Pauses val.", v: stats.validBreakMin, sub: `tot.${formatMinutes(stats.breakMin)}` }, ...(child.school_tracking || stats.schoolMin > 0 ? [{ l: "📚 Suivi sco.", v: stats.schoolMin }] : []), { l: "Amplitude", v: stats.amplitudeMin, max: maxAmplitude, crit: ampCrit, warn: ampWarn }] as any[]).map(({ l, v, max, sub, crit, warn }) => (
                  <div key={l} className={`rounded-lg p-2 text-center border ${crit ? "bg-red-900/30 border-red-800" : warn ? "bg-orange-900/30 border-orange-700" : "bg-slate-800/50 border-slate-700"}`}>
                    <div className={`text-base font-bold ${crit ? "text-red-400" : warn ? "text-orange-400" : "text-white"}`}>{formatMinutes(v)}</div>
                    <div className="text-[9px] text-slate-400">{l}</div>
                    {max && <div className={`text-[9px] ${crit ? "text-red-400" : warn ? "text-orange-400" : "text-slate-500"}`}>/ {formatMinutes(max)}</div>}
                    {sub && <div className="text-[9px] text-slate-500">{sub}</div>}
                  </div>
                ))}
              </div>

              {breakDue && !workCrit && <div className="bg-amber-900/30 border border-amber-700 rounded-lg px-3 py-2 text-xs text-amber-300">⚠️ Pause obligatoire — {formatMinutes(stats.timeSinceBreak)} consécutifs</div>}
              {workCrit && <div className="bg-red-900/30 border border-red-700 rounded-lg px-3 py-2 text-xs text-red-300">🚫 Temps de travail maximum dépassé</div>}
              {ampWarn && !ampCrit && <div className="bg-orange-900/30 border border-orange-600 rounded-lg px-3 py-2 text-xs text-orange-300">⚠️ Amplitude maximale atteinte</div>}
              {ampCrit && <div className="bg-red-900/30 border border-red-700 rounded-lg px-3 py-2 text-xs text-red-300">🚫 Amplitude maximale dépassée</div>}
              {pastTimeLimit && <div className="bg-orange-900/30 border border-orange-600 rounded-lg px-3 py-2 text-xs text-orange-300">🕗 Limite horaire {limitTimeStr} dépassée{derogation ? " (dérogation)" : ""}</div>}

              {/* Boutons d'action individuels */}
              {session?.status !== "done" && (
                <div className="flex gap-2 flex-wrap">
                  {session?.status === "working" && <button onClick={() => setIndivModal({ type: "pause" })} className="flex-1 text-xs bg-amber-900/60 text-amber-300 border border-amber-800 px-3 py-2 rounded-lg whitespace-nowrap">⏸ Pause</button>}
                  {session?.status === "working" && <button onClick={() => setIndivModal({ type: "dejeuner" })} className="flex-1 text-xs bg-orange-900/60 text-orange-300 border border-orange-700 px-3 py-2 rounded-lg whitespace-nowrap">🍽 Déjeuner</button>}
                  {session?.status === "working" && child.school_tracking && <button onClick={() => setIndivModal({ type: "school" })} className="flex-1 text-xs bg-indigo-900/60 text-indigo-300 border border-indigo-700 px-3 py-2 rounded-lg whitespace-nowrap">📚 Suivi sco.</button>}
                  {(session?.status === "paused" || session?.status === "dejeuner" || session?.status === "school") && <button onClick={() => setIndivModal({ type: "resume" })} className="flex-1 text-xs bg-emerald-900/60 text-emerald-300 border border-emerald-800 px-3 py-2 rounded-lg whitespace-nowrap">▶ Reprise</button>}
                  {session?.start_time && <button onClick={() => setIndivModal({ type: "end" })} className="flex-1 text-xs bg-slate-700/60 text-slate-300 border border-slate-600 px-3 py-2 rounded-lg whitespace-nowrap">⏹ Fin</button>}
                </div>
              )}

              <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3">
                <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-2">Chronologie — touchez l&apos;heure pour modifier</div>
                <div className="space-y-2">
                  <TimelineRow label="▶ Début" iso={session?.start_time} isEditing={editingIdx === "start"} editTime={editTime} onEdit={() => startEdit("start", session?.start_time)} onTimeChange={setEditTime} onConfirm={confirmEdit} onCancel={() => setEditingIdx(null)} />
                  {events.map((ev, i) => <TimelineRow key={i}
                    label={ev.type === "pause_start" ? "⏸ Pause" : ev.type === "pause_end" ? "▶ Reprise" : ev.type === "dejeuner_start" ? "🍽 Déjeuner" : ev.type === "dejeuner_end" ? "▶ Reprise déj." : ev.type === "school_start" ? "📚 Suivi scolaire" : "▶ Reprise (sco.)"}
                    iso={ev.time} isEditing={editingIdx === i} editTime={editTime} onEdit={() => startEdit(i, ev.time)} onTimeChange={setEditTime} onConfirm={confirmEdit} onCancel={() => setEditingIdx(null)} />)}
                  {session?.end_time && <TimelineRow label="⏹ Fin" iso={session.end_time} isEditing={editingIdx === "end"} editTime={editTime} onEdit={() => startEdit("end", session.end_time)} onTimeChange={setEditTime} onConfirm={confirmEdit} onCancel={() => setEditingIdx(null)} />}
                </div>
              </div>
            </>
          )}

          <div className="flex gap-2 flex-wrap">
            {session?.status !== "done" && events.length > 0 && <button onClick={onCancelLastEvent} className="text-xs text-amber-400 border border-amber-800/60 px-3 py-2 rounded-lg">↩ Annuler</button>}
            {session?.start_time && session?.status !== "done" && <button onClick={onCancelSession} className="text-xs text-red-400 border border-red-800/60 px-3 py-2 rounded-lg">🗑 Réinitialiser</button>}
            {session?.status === "done" && <button onClick={onReopenSession} className="text-xs text-blue-400 border border-blue-800/60 px-3 py-2 rounded-lg">↩ Rouvrir</button>}
          </div>
        </div>
      )}

      {indivModal && <TimeActionModal type={indivModal.type} childCount={1} dateStr={dateStr}
        onConfirm={timeISO => {
          if      (indivModal.type === "pause")    onApplyEvent("pause_start", timeISO);
          else if (indivModal.type === "dejeuner") onApplyEvent("dejeuner_start", timeISO);
          else if (indivModal.type === "school")   onApplyEvent("school_start", timeISO);
          else if (indivModal.type === "resume")   onApplyEvent("pause_end", timeISO);
          else if (indivModal.type === "end")      onEndSession(timeISO);
          setIndivModal(null);
        }}
        onClose={() => setIndivModal(null)} />}
    </div>
  );
}

function TimelineRow({ label, iso, isEditing, editTime, onEdit, onTimeChange, onConfirm, onCancel }: { label: string; iso: string | undefined; isEditing: boolean; editTime: string; onEdit: () => void; onTimeChange: (t: string) => void; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-slate-400 w-20 flex-shrink-0 text-[10px]">{label}</span>
      {isEditing ? (
        <><input type="time" value={editTime} onChange={e => onTimeChange(e.target.value)} className="bg-slate-700 border border-blue-500 rounded px-2 py-1 text-white text-xs flex-1" />
          <button onClick={onConfirm} className="text-emerald-400 w-7 h-7 flex items-center justify-center">✓</button>
          <button onClick={onCancel} className="text-slate-500 w-7 h-7 flex items-center justify-center">✕</button></>
      ) : (
        <button onClick={onEdit} className="text-blue-300 hover:underline">{formatTime(iso)}</button>
      )}
    </div>
  );
}
