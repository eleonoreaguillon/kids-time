"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type Period = "school" | "vacation";
type AgeBand = "0-2" | "3-5" | "6-11" | "12-16";
type ChildRole = "role" | "silhouette" | "figurant";

interface Rules {
  maxWorkMinutes: Record<AgeBand, Record<Period, number>>;
  mandatoryBreakAfterMinutes: Record<AgeBand, Record<Period, number>>;
  maxAmplitudeMinutes: number;
  minBreakMinutes: number;
  minRestBetweenDays: number;
  maxDaysPerWeek: number;
}

interface VacationPeriod { start: string; end: string; }
interface Derogation { date: string; end_time: string; } // ex: { date: "2025-04-21", end_time: "23:00" }

interface Child {
  id: string;
  project_id: string;
  first_name: string;
  last_name: string;
  dob: string;
  vacation_periods: VacationPeriod[];
  role?: ChildRole;
  archived?: boolean; // fix #3
  derogations?: Derogation[];
}

interface Group {
  id: string;
  project_id: string;
  name: string;
  child_ids: string[];
}

interface SessionEvent { type: "pause_start" | "pause_end" | "dejeuner_start" | "dejeuner_end"; time: string; }

interface Session {
  start_time?: string;
  end_time?: string;
  status?: "working" | "paused" | "dejeuner" | "done";
  events?: SessionEvent[];
}

interface ShootingDay {
  id: string;
  project_id: string;
  date: string;
  child_ids: string[];
  sessions: Record<string, Session>;
}

interface Project {
  id: string;
  user_id: string;
  name: string;
  rules: Rules;
  created_at: string;
  children: Child[];
  groups: Group[];
  shootingDays: Record<string, ShootingDay>;
  share_token?: string;
  share_password?: string;
}

interface SessionStats {
  amplitudeMin: number;
  workMin: number;
  breakMin: number;
  validBreakMin: number;
  dejeunerMin: number;
  timeSinceBreak: number | null;
  start: Date;
  now: Date;
  breakSlots: { start: string; end: string; durationMin: number; valid: boolean; kind: "pause" | "dejeuner" }[];
}

const DEFAULT_RULES: Rules = {
  maxWorkMinutes: {
    "0-2":  { school: 60,  vacation: 60  },
    "3-5":  { school: 120, vacation: 120 },
    "6-11": { school: 180, vacation: 240 },
    "12-16":{ school: 240, vacation: 360 },
  },
  mandatoryBreakAfterMinutes: {
    "0-2":  { school: 30,  vacation: 30  },
    "3-5":  { school: 60,  vacation: 60  },
    "6-11": { school: 90,  vacation: 120 },
    "12-16":{ school: 120, vacation: 180 },
  },
  maxAmplitudeMinutes: 480,
  minBreakMinutes: 15,
  minRestBetweenDays: 840,
  maxDaysPerWeek: 5,
};

const AGE_BANDS: AgeBand[] = ["0-2", "3-5", "6-11", "12-16"];
const ROLE_LABELS: Record<ChildRole, string> = { role: "Rôle", silhouette: "Silhouette", figurant: "Figurant·e" };
const ROLE_COLORS: Record<ChildRole, string> = {
  role:       "bg-purple-900/40 text-purple-300 border-purple-700",
  silhouette: "bg-cyan-900/40 text-cyan-300 border-cyan-700",
  figurant:   "bg-orange-900/40 text-orange-300 border-orange-700",
};
const ALL_ROLES: ChildRole[] = ["role", "silhouette", "figurant"];

function getAge(dob: string): number {
  const t = new Date(), b = new Date(dob);
  let a = t.getFullYear() - b.getFullYear();
  const m = t.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--;
  return a;
}
function getAgeBand(dob: string): AgeBand {
  const a = getAge(dob);
  if (a < 3) return "0-2"; if (a < 6) return "3-5"; if (a < 12) return "6-11"; return "12-16";
}
function formatMinutes(min: number | null | undefined): string {
  if (min == null || isNaN(min)) return "0min";
  const h = Math.floor(Math.abs(min) / 60), m = Math.abs(min) % 60, s = min < 0 ? "-" : "";
  if (h === 0) return `${s}${m}min`; if (m === 0) return `${s}${h}h`;
  return `${s}${h}h${String(m).padStart(2, "0")}`;
}
function formatTime(v: string | Date | undefined): string {
  if (!v) return "--:--";
  return new Date(v).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
function isVacation(child: Child, dateStr: string): boolean {
  return (child.vacation_periods || []).some(p => dateStr >= p.start && dateStr <= p.end);
}
function todayStr(): string { return new Date().toISOString().slice(0, 10); }
const ROLE_ORDER: Record<string, number> = { role: 0, silhouette: 1, figurant: 2 };
function sortByRoleThenAlpha(cs: Child[]): Child[] {
  return [...cs].sort((a, b) => {
    const ra = ROLE_ORDER[a.role ?? ""] ?? 3, rb = ROLE_ORDER[b.role ?? ""] ?? 3;
    if (ra !== rb) return ra - rb;
    return `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, "fr");
  });
}
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
function computeSessionStats(session: Session | undefined, rules: Rules): SessionStats | null {
  if (!session?.start_time) return null;
  const now = session.end_time ? new Date(session.end_time) : new Date();
  const start = new Date(session.start_time);
  const amplitudeMin = Math.floor((now.getTime() - start.getTime()) / 60000);
  const events = session.events || [];
  let workMin = 0, breakMin = 0, validBreakMin = 0, dejeunerMin = 0, lastRef = start;
  const breakSlots: SessionStats["breakSlots"] = [];
  for (const ev of events) {
    const t = new Date(ev.time), dur = Math.floor((t.getTime() - lastRef.getTime()) / 60000);
    if (ev.type === "pause_start" || ev.type === "dejeuner_start") {
      workMin += dur; lastRef = t;
    } else if (ev.type === "pause_end") {
      const valid = dur >= rules.minBreakMinutes;
      breakSlots.push({ start: lastRef.toISOString(), end: t.toISOString(), durationMin: dur, valid, kind: "pause" });
      if (valid) validBreakMin += dur; else workMin += dur;
      breakMin += dur; lastRef = t;
    } else if (ev.type === "dejeuner_end") {
      breakSlots.push({ start: lastRef.toISOString(), end: t.toISOString(), durationMin: dur, valid: true, kind: "dejeuner" });
      dejeunerMin += dur; lastRef = t;
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
  } else {
    workMin += lastDur;
  }
  let timeSinceBreak: number | null = null;
  if (session.status === "working") {
    const last = [...events].reverse().find(e => e.type === "pause_end" || e.type === "dejeuner_end");
    timeSinceBreak = Math.floor((now.getTime() - new Date(last ? last.time : session.start_time).getTime()) / 60000);
  }
  return { amplitudeMin, workMin, breakMin, validBreakMin, dejeunerMin, timeSinceBreak, start, now, breakSlots };
}

// ─── Export helpers ──────────────────────────────────────────────────────────
function buildExportRows(project: Project, dateStr: string) {
  const day = project.shootingDays[dateStr]; if (!day) return [];
  const rows: any[] = [];
  for (const childId of day.child_ids || []) {
    const child = project.children.find(c => c.id === childId); if (!child) continue;
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

function exportDayToXLSX(project: Project, dateStr: string) {
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
function exportDayToPDF(project: Project, dateStr: string) {
  const day = project.shootingDays[dateStr]; if (!day) return;
  const dateLabel = new Date(dateStr + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const childTable = (row: any) => {
    const { _child: child, _session: session, _stats: stats, _maxWork: maxWork, _maxAmp: maxAmp, _vacation: vacation, _band: band } = row;
    const workOver = stats ? Math.max(0, stats.workMin - maxWork) : 0;
    const ampOver = stats ? Math.max(0, stats.amplitudeMin - maxAmp) : 0;
    const bStr = stats?.breakSlots.filter((b: any) => b.valid && b.kind === "pause").map((b: any) => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join("<br>") || "--";
    const dStr = stats?.breakSlots.filter((b: any) => b.kind === "dejeuner").map((b: any) => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join("<br>") || "--";
    return `<table><tr><th colspan="4">${child.first_name} ${child.last_name}${child.role ? ` — ${ROLE_LABELS[child.role as ChildRole]}` : ""} — ${getAge(child.dob)} ans (${band} ans) — ${vacation ? "Vacances" : "Scolaire"}</th></tr>
      <tr><td><b>Convocation</b><br>${session?.start_time ? formatTime(session.start_time) : "--"}</td><td><b>Fin</b><br>${session?.end_time ? formatTime(session.end_time) : "--"}</td><td><b>Amplitude</b><br>${stats ? formatMinutes(stats.amplitudeMin) : "--"}</td><td><b>Max amplitude</b><br>${formatMinutes(maxAmp)}</td></tr>
      <tr><td><b>Travail total</b><br>${stats ? formatMinutes(stats.workMin) : "--"}</td><td><b>Max travail</b><br>${formatMinutes(maxWork)}</td><td><b>Dépass. travail</b><br><span class="${workOver > 0 ? "over" : "ok"}">${workOver > 0 ? formatMinutes(workOver) : "OK"}</span></td><td><b>Dépass. amplitude</b><br><span class="${ampOver > 0 ? "over" : "ok"}">${ampOver > 0 ? formatMinutes(ampOver) : "OK"}</span></td></tr>
      ${(() => { const derog = (child.derogations || []).find((d: Derogation) => d.date === dateStr); const over20h = !derog && session?.end_time != null && new Date(session.end_time) > new Date(`${dateStr}T20:00:00`); return over20h ? `<tr><td colspan="4" style="color:#dc2626;font-weight:bold;background:#fff5f5">🚫 Dépassement 20h — fin à ${formatTime(session!.end_time)} — aucune dérogation enregistrée</td></tr>` : ""; })()}
      <tr><td><b>🍽 Déjeuner</b><br>${stats ? formatMinutes(stats.dejeunerMin) : "--"}</td><td><b>Plages déjeuner</b><br>${dStr}</td><td><b>Pauses valides</b><br>${stats ? formatMinutes(stats.validBreakMin) : "--"}</td><td><b>Plages de pauses</b><br>${bStr}</td></tr></table>`;
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
function exportChildAllDays(project: Project, child: Child) {
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
    const dateLabel = new Date(dateStr + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
    const derogForDay = (child.derogations || []).find(d => d.date === dateStr);
    const endAfter20h = !derogForDay && session?.end_time != null && new Date(session.end_time) > new Date(`${dateStr}T20:00:00`);
    return `<tr>
      <td>${dateLabel}</td>
      <td>${vacation ? "🌴 Vac." : "🏫 Scol."}</td>
      <td>${session?.start_time ? formatTime(session.start_time) : "--"}</td>
      <td>${session?.end_time ? `<span style="color:${endAfter20h ? "#dc2626" : "inherit"};font-weight:${endAfter20h ? "bold" : "normal"}">${formatTime(session.end_time)}${endAfter20h ? " 🚫" : ""}</span>` : "--"}</td>
      <td><span style="color:${ampOver > 0 ? "#dc2626" : stats && stats.amplitudeMin === maxAmp ? "#ea580c" : "#16a34a"}">${stats ? formatMinutes(stats.amplitudeMin) : "--"} / ${formatMinutes(maxAmp)}</span></td>
      <td><span style="color:${workOver > 0 ? "#dc2626" : "#16a34a"}">${stats ? formatMinutes(stats.workMin) : "--"} / ${formatMinutes(maxWork)}</span></td>
      <td>${stats ? formatMinutes(stats.dejeunerMin) : "--"}</td>
      <td>${stats ? formatMinutes(stats.validBreakMin) : "--"}</td>
      <td style="font-size:8px">${dStr ? dStr + " | " : ""}${bStr}</td>
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
  <h2>${child.role ? ROLE_LABELS[child.role] + " · " : ""}${getAge(child.dob)} ans · Tranche ${getAgeBand(child.dob)} ans · ${project.name}</h2>
  <table><thead><tr>
    <th>Date</th><th>Période</th><th>Début</th><th>Fin</th><th>Amplitude</th><th>Travail / Max</th><th>🍽 Déjeuner</th><th>Pauses valides</th><th>Plages déjeuner / pauses</th>
  </tr></thead><tbody>`;
  for (const [dateStr, day] of days) { html += childTable(dateStr, day); }
  html += `</tbody></table>
  <div class="footer">Généré par KidsTime · Éléonore Aguillon · ACMA Fiction · ${new Date().toLocaleDateString("fr-FR")}</div></body></html>`;
  const w = window.open("", "_blank"); if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 500); }
}

// Fix #5 + #6: export global project recap (one row per child per day + summary tab)
function exportProjectGlobal(project: Project) {
  const sortedDates = Object.keys(project.shootingDays).sort();
  if (sortedDates.length === 0) { alert("Aucune journée de tournage dans ce projet."); return; }

  // Build global summary table: one row per (child, day)
  const allRows: any[] = [];
  for (const dateStr of sortedDates) {
    const day = project.shootingDays[dateStr];
    for (const childId of day.child_ids || []) {
      const child = project.children.find(c => c.id === childId); if (!child) continue;
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
      });
    }
  }

  if (typeof window !== "undefined" && (window as any).XLSX) {
    const XLSX = (window as any).XLSX; const wb = XLSX.utils.book_new();
    // Sheet 1: all rows
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allRows), "Récapitulatif global");
    // Sheet 2: per child summary (total across all days)
    const childSummary: any[] = [];
    for (const child of project.children.filter(c => !c.archived)) {
      const childDays = sortedDates.filter(d => project.shootingDays[d]?.child_ids?.includes(child.id));
      if (childDays.length === 0) continue;
      let totalWork = 0, totalBreak = 0, totalAmp = 0, depassWork = 0, depassAmp = 0;
      for (const dateStr of childDays) {
        const day = project.shootingDays[dateStr];
        const session = day.sessions?.[child.id];
        const vacation = isVacation(child, dateStr);
        const band = getAgeBand(child.dob);
        const period: Period = vacation ? "vacation" : "school";
        const maxWork = project.rules.maxWorkMinutes[band][period];
        const maxAmp = project.rules.maxAmplitudeMinutes;
        const stats = computeSessionStats(session, project.rules);
        if (stats) { totalWork += stats.workMin; totalBreak += stats.validBreakMin; totalAmp += stats.amplitudeMin; depassWork += Math.max(0, stats.workMin - maxWork); depassAmp += Math.max(0, stats.amplitudeMin - maxAmp); }
      }
      childSummary.push({
        "Nom Prénom": `${child.first_name} ${child.last_name}`.trim(),
        "Statut": child.role ? ROLE_LABELS[child.role] : "--",
        "Tranche d'âge": getAgeBand(child.dob),
        "Nb journées": childDays.length,
        "Total travail": formatMinutes(totalWork),
        "Total amplitude": formatMinutes(totalAmp),
        "Total pauses valides": formatMinutes(totalBreak),
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
function exportProjectGlobalPDF(project: Project) {
  const sortedDates = Object.keys(project.shootingDays).sort();
  if (sortedDates.length === 0) { alert("Aucune journée de tournage dans ce projet."); return; }

  const fmtHHMM = (min: number | null | undefined): string => {
    if (!min || min <= 0) return "";
    const h = Math.floor(min / 60), m = min % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };
  const DAY_LETTERS = ["D","L","M","M","J","V","S"];
  const MONTH_NAMES = ["JANVIER","FÉVRIER","MARS","AVRIL","MAI","JUIN","JUILLET","AOÛT","SEPTEMBRE","OCTOBRE","NOVEMBRE","DÉCEMBRE"];

  const TH  = (bg: string) => `style="background:${bg};color:white;border:1px solid #bbb;text-align:center;font-size:7px;padding:3px 2px"`;
  const TDL = `style="text-align:left;padding:3px 6px;border:1px solid #ccc;font-size:8px;background:#f4f6fb;white-space:nowrap"`;
  const TDV = (extra="") => `style="text-align:center;padding:2px 3px;border:1px solid #ccc;font-size:8px;${extra}"`;
  const TDT = (extra="") => `style="text-align:center;padding:2px 4px;border:1px solid #ccc;font-weight:bold;font-size:8px;background:#e8eef8;${extra}"`;

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

  for (const child of project.children.filter(c => !c.archived)) {
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

    // En-têtes calculés uniquement sur les dates de cet enfant
    const childMonthSpans: { month: string; count: number }[] = [];
    for (const d of childDates) {
      const month = MONTH_NAMES[new Date(d + "T12:00:00").getMonth()];
      if (!childMonthSpans.length || childMonthSpans[childMonthSpans.length - 1].month !== month) childMonthSpans.push({ month, count: 1 });
      else childMonthSpans[childMonthSpans.length - 1].count++;
    }
    const headerMonths = childMonthSpans.map(s => `<th colspan="${s.count}" ${TH("#1e3a5f")}>${s.month}</th>`).join("");
    const headerJours  = childDates.map(d => `<th ${TH("#2d4a6f")}>${DAY_LETTERS[new Date(d+"T12:00:00").getDay()]}</th>`).join("");
    const headerDates  = childDates.map(d => `<th ${TH("#3d5a7f")}>${new Date(d+"T12:00:00").getDate()}</th>`).join("");

    let totWork = 0, totDejeuner = 0, totValidPause = 0, totAmp = 0, totWorkOver = 0, totAmpOver = 0;
    for (const d of childDates) {
      const { stats, maxWork, maxAmp } = dd[d];
      if (stats) {
        totWork += stats.workMin; totDejeuner += stats.dejeunerMin;
        totValidPause += stats.validBreakMin;
        totAmp += stats.amplitudeMin;
        totWorkOver += Math.max(0, stats.workMin - maxWork);
        totAmpOver  += Math.max(0, stats.amplitudeMin - maxAmp);
      }
    }

    const cells = (fn: (d: DayData) => string) =>
      childDates.map(ds => {
        const d = dd[ds];
        return `<td ${TDV(d.vacation ? "background:#fffbeb" : "")}>${fn(d)}</td>`;
      }).join("");
    const cellsWithDate = (fn: (d: DayData, ds: string) => string) =>
      childDates.map(ds => {
        const d = dd[ds];
        return `<td ${TDV(d.vacation ? "background:#fffbeb" : "")}>${fn(d, ds)}</td>`;
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
          ${childDates.map(ds => `<td ${TDV(dd[ds].vacation ? "background:#fffbeb;color:#b45309;font-weight:bold" : "")}>${dd[ds].vacation ? "VAC" : ""}</td>`).join("")}
        </tr>
      </thead>
      <tbody>
        <tr><td ${TDL}>Heure de convocation</td><td ${TDT()}></td>${cells(d => d.session?.start_time ? formatTime(d.session.start_time) : "")}</tr>
        <tr><td ${TDL}>Durée de pause déjeuner</td><td ${TDT()}></td>${cells(d => fmtHHMM(d.stats?.dejeunerMin ?? 0))}</tr>
        <tr><td ${TDL}>Durée des autres pauses</td><td ${TDT()}></td>${cells(d => fmtHHMM(d.stats?.validBreakMin ?? 0))}</tr>
        <tr>
          <td ${TDL} style="text-align:left;padding:3px 6px;border:1px solid #ccc;font-size:8px;background:#f4f6fb;font-weight:bold;white-space:nowrap">Durée totale de travail (plateau, HMC, attente)</td>
          <td ${TDT()}></td>
          ${cells(d => `<b>${fmtHHMM(d.stats?.workMin ?? 0)}</b>`)}
        </tr>
        <tr><td ${TDL}>Heure de fin de journée</td><td ${TDT()}></td>${cells(d => d.session?.end_time ? formatTime(d.session.end_time) : "")}</tr>
        <tr>
          <td ${TDL} style="text-align:left;padding:3px 6px;border:1px solid #ccc;font-size:8px;background:#fff5f5;color:#dc2626;white-space:nowrap">Dépassement 20h (sans dérogation)</td>
          <td ${TDT()}></td>
          ${cellsWithDate((d, ds) => { const derog = (child.derogations || []).find(x => x.date === ds); const over = !derog && d.session?.end_time != null && new Date(d.session.end_time) > new Date(`${ds}T20:00:00`); return over ? `<span style="color:#dc2626;font-weight:bold">🚫 ${formatTime(d.session!.end_time)}</span>` : ""; })}
        </tr>
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
  const shareToken = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("share") : null;

  useEffect(() => {
    if (shareToken) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_ev, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, [shareToken]);

  if (shareToken) return <SharedProjectView token={shareToken} />;
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
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const userId = session.user.id;
  const CACHE_KEY = `kidstime_cache_${userId}`;
  const notifiedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

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
        if (stats.workMin >= maxWork * 0.8 && stats.workMin < maxWork) {
          const key = `work-warn-${child.id}-${activeDate}`;
          if (!notifiedRef.current.has(key)) {
            notifiedRef.current.add(key);
            if (Notification.permission === "granted") new Notification("⚠ Temps de travail", { body: `${name} approche du max (${formatMinutes(stats.workMin)} / ${formatMinutes(maxWork)})`, icon: "/favicon.ico" });
          }
        }
        if (stats.workMin >= maxWork) {
          const key = `work-over-${child.id}-${activeDate}`;
          if (!notifiedRef.current.has(key)) {
            notifiedRef.current.add(key);
            if (Notification.permission === "granted") new Notification("🔴 Dépassement travail", { body: `${name} a dépassé le temps max de travail !`, icon: "/favicon.ico" });
          }
        }
        if (stats.amplitudeMin >= maxAmp * 0.9 && stats.amplitudeMin < maxAmp) {
          const key = `amp-warn-${child.id}-${activeDate}`;
          if (!notifiedRef.current.has(key)) {
            notifiedRef.current.add(key);
            if (Notification.permission === "granted") new Notification("⚠ Amplitude", { body: `${name} approche de l'amplitude max (${formatMinutes(stats.amplitudeMin)} / ${formatMinutes(maxAmp)})`, icon: "/favicon.ico" });
          }
        }
        if (stats.amplitudeMin >= maxAmp) {
          const key = `amp-over-${child.id}-${activeDate}`;
          if (!notifiedRef.current.has(key)) {
            notifiedRef.current.add(key);
            if (Notification.permission === "granted") new Notification("🔴 Amplitude dépassée", { body: `${name} a dépassé l'amplitude maximale !`, icon: "/favicon.ico" });
          }
        }
      }
    };
    check();
    const interval = setInterval(check, 60000);
    return () => clearInterval(interval);
  }, [view, activeProject, activeDate]);

  async function logAction(dateStr: string, childId: string, action: string) {
    if (!activeProject) return;
    await supabase.from("action_logs").insert({
      project_id: activeProject.id,
      shooting_day_date: dateStr,
      child_id: childId,
      action,
      performed_by: session.user.email ?? "inconnu",
    });
  }

  const loadProjects = useCallback(async () => {
    setLoading(true);
    if (!navigator.onLine) {
      try { const cached = localStorage.getItem(CACHE_KEY); if (cached) setProjects(JSON.parse(cached)); } catch {}
      setLoading(false); return;
    }
    const { data } = await supabase.from("projects").select("*").eq("user_id", userId).order("created_at");
    const list = (data || []) as Project[];
    setProjects(list);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(list)); } catch {}
    setLoading(false);
  }, [userId, CACHE_KEY]);

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
    const full = { ...proj, children: mappedChildren, groups: groups || [], shootingDays };
    try { localStorage.setItem(`kidstime_project_${id}`, JSON.stringify(full)); } catch {}
    return full;
  }

  async function openProject(id: string) {
    setLoading(true);
    if (!navigator.onLine) {
      try {
        const cached = localStorage.getItem(`kidstime_project_${id}`);
        if (cached) { setActiveProject(JSON.parse(cached)); setView("project"); setLoading(false); return; }
      } catch {}
    }
    const f = await loadFullProject(id); setActiveProject(f); setView("project"); setLoading(false);
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

  async function addChild(child: { fullName: string; dob: string; vacationPeriods: VacationPeriod[]; role: ChildRole | null; derogations?: Derogation[] }) {
    const { firstName, lastName } = splitFullName(child.fullName);
    const { error } = await supabase.from("children").insert({
      project_id: activeProject!.id, first_name: firstName, last_name: lastName,
      dob: child.dob, vacation_periods: child.vacationPeriods || [], child_role: child.role ?? null,
      derogations: child.derogations || [],
    });
    if (error) { console.error("addChild error:", error); return; }
    await refreshActive();
  }

  async function addChildren(children: { firstName: string; lastName: string; dob: string; vacationPeriods: VacationPeriod[]; role: ChildRole | null }[]) {
    if (children.length === 0) return;
    const rows = children.map(c => ({ project_id: activeProject!.id, first_name: c.firstName, last_name: c.lastName, dob: c.dob, vacation_periods: c.vacationPeriods || [], child_role: c.role ?? null }));
    const { error } = await supabase.from("children").insert(rows);
    if (error) { console.error("Import error:", error); throw error; }
    await refreshActive();
  }

  async function updateChild(id: string, data: { fullName: string; dob: string; vacationPeriods: VacationPeriod[]; role: ChildRole | null; derogations?: Derogation[] }) {
    const { firstName, lastName } = splitFullName(data.fullName);
    const { error } = await supabase.from("children").update({ first_name: firstName, last_name: lastName, dob: data.dob, vacation_periods: data.vacationPeriods || [], child_role: data.role ?? null, derogations: data.derogations || [] }).eq("id", id);
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
    const started: string[] = [];
    for (const childId of childIds) { if (!sessions[childId]?.start_time) { sessions[childId] = { start_time: timeISO || nowISO(), events: [], status: "working" }; changed = true; started.push(childId); } }
    if (!changed) return;
    await supabase.from("shooting_days").update({ sessions }).eq("id", day.id); await refreshActive();
    for (const childId of started) { logAction(dateStr, childId, "Convocation"); }
  }
  async function startSession(dateStr: string, childId: string, timeISO?: string) { await startSessionsSequentially(dateStr, [childId], timeISO); }
  async function cancelSession(dateStr: string, childId: string) { const day = activeProject!.shootingDays[dateStr]; if (!day) return; const sessions = { ...(day.sessions || {}) }; delete sessions[childId]; await updateDaySessions(dateStr, sessions); logAction(dateStr, childId, "Annulation de session"); }
  async function applyEventToChildren(dateStr: string, childIds: string[], eventType: "pause_start" | "pause_end" | "dejeuner_start" | "dejeuner_end", timeISO?: string) {
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const sessions = { ...(day.sessions || {}) };
    const applied: { childId: string; actualType: SessionEvent["type"] }[] = [];
    for (const childId of childIds) {
      const s = sessions[childId]; if (!s?.start_time || s.status === "done") continue;
      if (eventType === "pause_start" && s.status !== "working") continue;
      if (eventType === "dejeuner_start" && s.status !== "working") continue;
      // "pause_end" sert aussi à reprendre depuis un déjeuner (smart resume)
      if (eventType === "pause_end" && s.status !== "paused" && s.status !== "dejeuner") continue;
      if (eventType === "dejeuner_end" && s.status !== "dejeuner") continue;
      // Si pause_end mais enfant en déjeuner → enregistrer dejeuner_end
      const actualType: SessionEvent["type"] = (eventType === "pause_end" && s.status === "dejeuner") ? "dejeuner_end" : eventType;
      const newStatus: Session["status"] = actualType === "pause_start" ? "paused" : actualType === "dejeuner_start" ? "dejeuner" : "working";
      sessions[childId] = { ...s, status: newStatus, events: [...(s.events || []), { type: actualType, time: timeISO || nowISO() }] };
      applied.push({ childId, actualType });
    }
    await updateDaySessions(dateStr, sessions);
    for (const { childId, actualType } of applied) {
      if (actualType === "pause_start") logAction(dateStr, childId, "Pause démarrée");
      else if (actualType === "pause_end" || actualType === "dejeuner_end") logAction(dateStr, childId, "Reprise");
      else if (actualType === "dejeuner_start") logAction(dateStr, childId, "Déjeuner démarré");
    }
  }
  async function cancelLastEvent(dateStr: string, childId: string) {
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const sessions = { ...(day.sessions || {}) }; const s = { ...sessions[childId] }; if (!s?.events?.length) return;
    const events = [...s.events]; events.pop(); const lastEv = events[events.length - 1];
    let status: Session["status"] = "working";
    if (lastEv?.type === "pause_start") status = "paused";
    else if (lastEv?.type === "dejeuner_start") status = "dejeuner";
    sessions[childId] = { ...s, events, status, end_time: undefined }; await updateDaySessions(dateStr, sessions);
    logAction(dateStr, childId, "Annulation dernier événement");
  }
  async function endSessions(dateStr: string, childIds: string[], timeISO?: string) {
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const sessions = { ...(day.sessions || {}) };
    const ended: string[] = [];
    for (const childId of childIds) {
      const s = sessions[childId]; if (!s?.start_time || s.status === "done") continue;
      const events = [...(s.events || [])];
      if (s.status === "paused") events.push({ type: "pause_end", time: timeISO || nowISO() });
      else if (s.status === "dejeuner") events.push({ type: "dejeuner_end", time: timeISO || nowISO() });
      sessions[childId] = { ...s, end_time: timeISO || nowISO(), status: "done", events };
      ended.push(childId);
    }
    await updateDaySessions(dateStr, sessions);
    for (const childId of ended) { logAction(dateStr, childId, "Fin de journée"); }
  }
  async function reopenSession(dateStr: string, childId: string) { const day = activeProject!.shootingDays[dateStr]; if (!day) return; const sessions = { ...(day.sessions || {}) }; sessions[childId] = { ...sessions[childId], status: "working", end_time: undefined }; await updateDaySessions(dateStr, sessions); }
  async function editEventTime(dateStr: string, childId: string, eventIndex: number, newTimeISO: string) { const day = activeProject!.shootingDays[dateStr]; if (!day) return; const sessions = { ...(day.sessions || {}) }; const s = { ...sessions[childId] }; const events = [...(s.events || [])]; events[eventIndex] = { ...events[eventIndex], time: newTimeISO }; s.events = events; sessions[childId] = s; await updateDaySessions(dateStr, sessions); }
  async function editStartTime(dateStr: string, childId: string, newTimeISO: string) { const day = activeProject!.shootingDays[dateStr]; if (!day) return; const sessions = { ...(day.sessions || {}) }; sessions[childId] = { ...sessions[childId], start_time: newTimeISO }; await updateDaySessions(dateStr, sessions); }
  async function editEndTime(dateStr: string, childId: string, newTimeISO: string) { const day = activeProject!.shootingDays[dateStr]; if (!day) return; const sessions = { ...(day.sessions || {}) }; sessions[childId] = { ...sessions[childId], end_time: newTimeISO }; await updateDaySessions(dateStr, sessions); }

  async function generateShareToken(projectId: string): Promise<string> {
    const token = crypto.randomUUID();
    await supabase.from("projects").update({ share_token: token }).eq("id", projectId);
    await refreshActive();
    return token;
  }

  const Fonts = () => <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap" rel="stylesheet" />;
  if (loading && view === "home") return <div className="min-h-screen bg-[#080d16] flex items-center justify-center"><Fonts /><div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;

  if (view === "home") return <><Fonts /><HomeView projects={projects} userEmail={session.user.email} onCreate={createProject} onOpen={openProject} onDelete={deleteProject} onSignOut={onSignOut} isOnline={isOnline} /></>;
  if (view === "project" && activeProject) return <><Fonts /><ProjectView project={activeProject}
    onBack={() => { setView("home"); loadProjects(); }}
    onAddChild={addChild} onAddChildren={addChildren} onUpdateChild={updateChild} onRemoveChild={removeChild}
    onArchiveChild={archiveChild}
    onAddGroup={addGroup} onUpdateGroup={updateGroup} onRemoveGroup={removeGroup} onUpdateRules={updateRules}
    onOpenDay={date => { setActiveDate(date); setView("shooting"); }}
    onExportProject={() => exportProjectGlobal(activeProject)}
    onExportProjectPDF={() => exportProjectGlobalPDF(activeProject)}
    onExportChildDays={child => exportChildAllDays(activeProject, child)}
    onDelete={() => { deleteProject(activeProject.id); setView("home"); }}
    onGenerateShareToken={() => generateShareToken(activeProject.id)}
    isOnline={isOnline}
  /></>;
  if (view === "shooting" && activeProject && activeDate) return <><Fonts /><ShootingView project={activeProject} dateStr={activeDate}
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
    onExportXLSX={() => exportDayToXLSX(activeProject, activeDate)}
    onExportPDF={() => exportDayToPDF(activeProject, activeDate)} /></>;
  return null;
}

function HomeView({ projects, userEmail, onCreate, onOpen, onDelete, onSignOut, isOnline }: { projects: Project[]; userEmail: string; onCreate: (n: string) => void; onOpen: (id: string) => void; onDelete: (id: string) => void; onSignOut: () => void; isOnline: boolean }) {
  const [name, setName] = useState("");
  return (
    <div className="min-h-screen bg-[#080d16] text-white" style={{ fontFamily: "'DM Mono', monospace" }}>
      {!isOnline && <OfflineBanner />}
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
                <span className="text-slate-600 text-xs">→</span>
              </div>
            ))}
          </div>
        }
      </div>
    </div>
  );
}

function ProjectView({ project, onBack, onAddChild, onAddChildren, onUpdateChild, onRemoveChild, onArchiveChild, onAddGroup, onUpdateGroup, onRemoveGroup, onUpdateRules, onOpenDay, onExportProject, onExportProjectPDF, onExportChildDays, onDelete, onGenerateShareToken, isOnline }: {
  project: Project; onBack: () => void;
  onAddChild: (c: any) => void; onAddChildren: (cs: any[]) => Promise<void>;
  onUpdateChild: (id: string, d: any) => void; onRemoveChild: (id: string) => void;
  onArchiveChild: (id: string, archived: boolean) => void;
  onAddGroup: (name: string) => void; onUpdateGroup: (id: string, d: any) => void; onRemoveGroup: (id: string) => void;
  onUpdateRules: (fn: (r: Rules) => Rules) => void; onOpenDay: (date: string) => void;
  onExportProject: () => void; onExportProjectPDF: () => void;
  onExportChildDays: (child: Child) => void;
  onDelete: () => void;
  onGenerateShareToken: () => Promise<string>;
  isOnline: boolean;
}) {
  const [tab, setTab] = useState<"calendar" | "children" | "groups" | "settings">("calendar");
  const [childModal, setChildModal] = useState<Child | "new" | null>(null);
  const [groupModal, setGroupModal] = useState<Group | "new" | null>(null);
  const [shareModal, setShareModal] = useState(false);
  const tabs = [{ id: "calendar", label: "📅" }, { id: "children", label: "👦" }, { id: "groups", label: "👥" }, { id: "settings", label: "⚙️" }];
  const tabLabels: Record<string, string> = { calendar: "Calendrier", children: "Enfants", groups: "Groupes", settings: "Paramètres" };
  return (
    <div className="min-h-screen bg-[#080d16] text-white pb-20" style={{ fontFamily: "'DM Mono', monospace" }}>
      {!isOnline && <OfflineBanner />}
      {/* Fix #1: sticky header with safe area */}
      <div className="sticky top-0 z-10 bg-[#080d16] border-b border-slate-800 px-4 py-3 flex items-center gap-3">
        <button onClick={onBack} className="text-slate-400 hover:text-white text-sm w-8 h-8 flex items-center justify-center rounded-lg border border-slate-700">←</button>
        <h1 className="text-base font-extrabold truncate flex-1" style={{ fontFamily: "Syne, sans-serif" }}>{project.name}</h1>
        <button onClick={() => setShareModal(true)} className="text-slate-400 hover:text-blue-400 text-xs border border-slate-700 px-3 py-1.5 rounded-lg">🔗 Partager</button>
      </div>
      {shareModal && <ShareModal project={project} onGenerateToken={onGenerateShareToken} onClose={() => setShareModal(false)} />}

      {/* Fix #5/#6: project export buttons */}
      {tab === "calendar" && (
        <div className="px-4 pt-3 flex gap-2">
          <button onClick={onExportProjectPDF} className="flex-1 text-xs text-blue-400 border border-blue-800/60 px-3 py-2 rounded-lg">📄 Récap. global PDF</button>
          <button onClick={onExportProject} className="flex-1 text-xs text-emerald-400 border border-emerald-800/60 px-3 py-2 rounded-lg">📊 Récap. global Excel</button>
        </div>
      )}

      <div className="px-4 py-4">
        {tab === "calendar" && <CalendarTab project={project} onOpenDay={onOpenDay} />}
        {tab === "children" && <ChildrenTab project={project} onAdd={() => setChildModal("new")} onEdit={c => setChildModal(c)} onRemove={onRemoveChild} onImport={onAddChildren} onArchive={onArchiveChild} onExportChildDays={onExportChildDays} />}
        {tab === "groups" && <GroupsTab project={project} onAdd={() => setGroupModal("new")} onRemove={onRemoveGroup} onUpdateGroup={onUpdateGroup} />}
        {tab === "settings" && <SettingsTab rules={project.rules} onUpdateRules={onUpdateRules} projectName={project.name} onDelete={onDelete} projectId={project.id} />}
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
          shootingDays={project.shootingDays}
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
  const [duplicates, setDuplicates] = useState<any[]>([]);
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);
  const [roleTab, setRoleTab] = useState<ChildRole | "all">("all");
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const activeChildren = project.children.filter(c => !c.archived);
  const archivedChildren = project.children.filter(c => c.archived);
  const rolesPresent = ALL_ROLES.filter(r => activeChildren.some(c => c.role === r));
  const baseChildren = sortByRoleThenAlpha(showArchived ? archivedChildren : (roleTab === "all" ? activeChildren : activeChildren.filter(c => c.role === roleTab)));
  const displayChildren = search.trim()
    ? baseChildren.filter(c => normalize(`${c.first_name} ${c.last_name}`).includes(normalize(search)) || normalize(`${c.last_name} ${c.first_name}`).includes(normalize(search)))
    : baseChildren;

  function downloadTemplate() {
    const csv = "Nom Prénom;Statut (role/silhouette/figurant);Date de naissance (JJ/MM/AAAA);Début vacances (JJ/MM/AAAA);Fin vacances (JJ/MM/AAAA)\nMartin Léa;role;15/03/2015;01/07/2025;31/08/2025\n";
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
      const parsed = rows.map(r => {
        let fullName = "";
        if (fullCol && String(r[fullCol] || "").trim()) fullName = String(r[fullCol]).trim();
        else if (fnCol && lnCol) { const fn = String(r[fnCol] || "").trim(); const ln = String(r[lnCol] || "").trim(); fullName = [fn, ln].filter(Boolean).join(" "); }
        else if (fnCol) fullName = String(r[fnCol] || "").trim();
        else if (lnCol) fullName = String(r[lnCol] || "").trim();
        else if (nomCol) fullName = String(r[nomCol] || "").trim();
        else { const firstVal = Object.values(r).find(v => String(v || "").trim() !== ""); fullName = String(firstVal || "").trim(); }
        const { firstName, lastName } = splitFullName(fullName);
        const role: ChildRole | null = statCol ? detectRole(String(r[statCol] || "")) : null;
        return { firstName, lastName, dob: dobCol ? parseExcelDate(r[dobCol]) : "", vacationPeriods: (vs && ve && r[vs] && r[ve]) ? [{ start: parseExcelDate(r[vs]), end: parseExcelDate(r[ve]) }] : [], role };
      }).filter(c => c.firstName && c.dob);
      if (parsed.length === 0) { setImportMsg("❌ Aucun enfant valide trouvé."); return; }
      setImportPreview(parsed); setShowPreview(true);
      setImportMsg(`✅ ${parsed.length} enfant(s) détecté(s)`);
    } catch (err) { console.error(err); setImportMsg("❌ Erreur de lecture."); }
    e.target.value = "";
  }

  function detectDuplicates(preview: any[]): any[] {
    return preview.filter(c =>
      project.children.some(existing =>
        normalize(existing.first_name) === normalize(c.firstName) &&
        normalize(existing.last_name) === normalize(c.lastName) &&
        existing.dob === c.dob
      )
    );
  }

  function handleConfirmImportClick() {
    const dupes = detectDuplicates(importPreview);
    if (dupes.length > 0) {
      setDuplicates(dupes);
      setShowDuplicateWarning(true);
    } else {
      doImport(importPreview);
    }
  }

  async function doImport(children: any[]) {
    setShowDuplicateWarning(false);
    setDuplicates([]);
    setImporting(true);
    try { await onImport(children); setShowPreview(false); setImportPreview([]); setImportMsg(`✅ ${children.length} enfant(s) importé(s) !`); }
    catch { setImportMsg("❌ Erreur lors de l'import."); }
    setImporting(false);
  }

  async function confirmImport() {
    handleConfirmImportClick();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-bold text-base" style={{ fontFamily: "Syne, sans-serif" }}>Enfants ({activeChildren.length})</h2>
        <Btn onClick={onAdd} className="text-xs py-2 px-3">+ Ajouter</Btn>
      </div>

      {/* Recherche */}
      <div className="relative mb-3">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">🔍</span>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Rechercher un enfant…"
          className="w-full bg-slate-800/80 border border-slate-600 rounded-xl pl-8 pr-8 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
        />
        {search && <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white text-sm">✕</button>}
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
            <div className="space-y-1 max-h-40 overflow-y-auto mb-2">
              {importPreview.map((c, i) => <div key={i} className="text-xs flex gap-2 items-center flex-wrap"><span className="text-white font-semibold">{c.firstName} {c.lastName}</span><span className="text-slate-500">{c.dob}</span>{c.role && <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${ROLE_COLORS[c.role as ChildRole]}`}>{ROLE_LABELS[c.role as ChildRole]}</span>}</div>)}
            </div>
            {showDuplicateWarning && duplicates.length > 0 && (
              <div className="mb-3 bg-amber-900/30 border border-amber-600/60 rounded-xl p-3">
                <div className="text-xs font-semibold text-amber-300 mb-1">⚠ {duplicates.length} doublon(s) détecté(s) :</div>
                <div className="space-y-0.5 max-h-24 overflow-y-auto mb-3">
                  {duplicates.map((c, i) => <div key={i} className="text-xs text-amber-200">{c.firstName} {c.lastName} · {c.dob}</div>)}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => { setShowDuplicateWarning(false); setDuplicates([]); }} className="flex-1 text-xs text-slate-300 border border-slate-600 py-2 rounded-lg">Annuler</button>
                  <button onClick={() => doImport(importPreview)} disabled={importing} className="flex-1 text-xs bg-amber-700 text-white py-2 rounded-lg disabled:opacity-50">{importing ? "Import…" : "Importer quand même"}</button>
                </div>
              </div>
            )}
            {!showDuplicateWarning && (
              <div className="flex gap-2">
                <button onClick={() => { setShowPreview(false); setImportMsg(""); }} className="text-xs text-slate-400">Annuler</button>
                <button onClick={confirmImport} disabled={importing} className="flex-1 text-xs bg-blue-600 text-white py-2 rounded-lg disabled:opacity-50">{importing ? "Import…" : `Confirmer (${importPreview.length})`}</button>
              </div>
            )}
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
        ? <div className="text-slate-500 text-center py-10 text-sm">{search.trim() ? `Aucun résultat pour « ${search} »` : showArchived ? "Aucun enfant archivé" : "Aucun enfant enregistré"}</div>
        : <div className="space-y-2">{displayChildren.map(c => (
          <div key={c.id} className={`bg-slate-900/50 border rounded-xl px-3 py-3 ${c.archived ? "border-slate-700/40 opacity-60" : "border-slate-700"}`}>
            <div className="flex items-center gap-3">
              {c.role && <div className={`w-1 self-stretch rounded-full flex-shrink-0 ${c.role === "role" ? "bg-purple-500" : c.role === "silhouette" ? "bg-cyan-500" : "bg-orange-500"}`} />}
              <div className="w-9 h-9 rounded-full bg-blue-900/60 flex items-center justify-center text-blue-300 font-bold text-sm flex-shrink-0">{c.first_name?.[0]}{c.last_name?.[0]}</div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-white text-sm truncate">{c.first_name} {c.last_name}</div>
                <div className="text-xs text-slate-400">{getAge(c.dob)} ans · {getAgeBand(c.dob)} ans</div>
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
              {confirmRemoveId === c.id ? (
                <div className="flex items-center gap-1 ml-auto">
                  <span className="text-[10px] text-red-300">Supprimer ?</span>
                  <button onClick={() => { onRemove(c.id); setConfirmRemoveId(null); }} className="text-[10px] text-white bg-red-700 hover:bg-red-600 px-2 py-1 rounded-lg">Oui</button>
                  <button onClick={() => setConfirmRemoveId(null)} className="text-[10px] text-slate-400 border border-slate-700 px-2 py-1 rounded-lg">Non</button>
                </div>
              ) : (
                <button onClick={() => setConfirmRemoveId(c.id)} className="text-[10px] text-red-400 border border-red-800/60 px-2 py-1 rounded-lg ml-auto">🗑</button>
              )}
            </div>
          </div>
        ))}</div>
      }
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

function SettingsTab({ rules, onUpdateRules, projectName, onDelete, projectId }: { rules: Rules; onUpdateRules: (fn: (r: Rules) => Rules) => void; projectName: string; onDelete: () => void; projectId: string }) {
  const [showDeleteZone, setShowDeleteZone] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [logs, setLogs] = useState<any[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsPage, setLogsPage] = useState(0);
  const PAGE_SIZE = 20;

  useEffect(() => {
    setLogsLoading(true);
    supabase.from("action_logs")
      .select("*, children(first_name, last_name)")
      .eq("project_id", projectId)
      .order("performed_at", { ascending: false })
      .range(logsPage * PAGE_SIZE, (logsPage + 1) * PAGE_SIZE - 1)
      .then(({ data }) => { setLogs(data || []); setLogsLoading(false); });
  }, [projectId, logsPage]);

  const BL: Record<AgeBand, string> = { "0-2": "< 3 ans", "3-5": "3–5 ans", "6-11": "6–11 ans", "12-16": "12–16 ans" };

  function setRule(key: string, value: string) {
    onUpdateRules(r => ({ ...r, [key]: Number(value) }));
  }

  return (
    <div className="space-y-4">
      <h2 className="font-bold text-base mb-1" style={{ fontFamily: "Syne, sans-serif" }}>Paramètres</h2>

      {/* Paramètres ajustables */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Paramètres ajustables</h3>
        {([["Amplitude max", "maxAmplitudeMinutes", 60, 720, 30], ["Pause minimum", "minBreakMinutes", 5, 60, 1]] as const).map(([label, key, min, max, step]) => (
          <div key={key} className="bg-slate-900/50 border border-slate-700 rounded-xl p-3 flex items-center justify-between">
            <div className="text-sm text-white">{label}</div>
            <div className="flex items-center gap-2">
              <input type="number" min={min} max={max} step={step} value={(rules as any)[key]}
                onChange={e => setRule(key, e.target.value)}
                className="w-20 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-white text-sm text-center focus:outline-none focus:border-blue-500" />
              <span className="text-xs text-slate-400 w-12">{formatMinutes((rules as any)[key])}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Paramètres verrouillés DRIEETS */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Définis par la réglementation DRIEETS</h3>
        <div className="bg-slate-900/50 border border-slate-700 rounded-xl p-3 flex items-center justify-between">
          <div className="text-sm text-white">Repos entre journées</div>
          <div className="bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-1.5 text-slate-400 text-sm font-mono">{formatMinutes(rules.minRestBetweenDays)}</div>
        </div>
      </div>
      {(["maxWorkMinutes", "mandatoryBreakAfterMinutes"] as const).map(rk => (
        <div key={rk}>
          <h3 className="text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">{rk === "maxWorkMinutes" ? "Temps de travail max" : "Pause obligatoire après"}</h3>
          <div className="space-y-2">{AGE_BANDS.map(band => (
            <div key={band} className="bg-slate-900/50 border border-slate-700 rounded-xl p-3">
              <div className="font-semibold text-white text-xs mb-2">{BL[band]}</div>
              <div className="grid grid-cols-2 gap-3">{(["school", "vacation"] as const).map(p => (
                <div key={p}>
                  <div className="text-[10px] text-slate-400 block mb-1">{p === "school" ? "🏫 Scolaire" : "🌴 Vacances"}</div>
                  <div className="bg-slate-800/80 border border-slate-600 rounded-lg px-2 py-1.5 text-slate-300 text-xs font-mono text-center">
                    {formatMinutes(rules[rk][band][p])}
                  </div>
                </div>
              ))}</div>
            </div>
          ))}</div>
        </div>
      ))}

      {/* Zone de suppression */}
      <div className="mt-6 border border-red-900/50 rounded-xl p-4 bg-red-950/20">
        <div className="text-xs font-semibold text-red-400 uppercase tracking-wider mb-2">Zone de danger</div>
        {!showDeleteZone ? (
          <button onClick={() => setShowDeleteZone(true)} className="text-xs text-red-400 border border-red-800/60 px-3 py-2 rounded-lg">🗑 Supprimer cette production…</button>
        ) : (
          <div className="space-y-3">
            <div className="text-xs text-red-300">Cette action est <b>irréversible</b>. Tapez le nom exact de la production pour confirmer :</div>
            <div className="text-xs text-slate-400 font-mono bg-slate-800/60 rounded px-3 py-2 select-all">{projectName}</div>
            <input
              type="text"
              value={deleteConfirm}
              onChange={e => setDeleteConfirm(e.target.value)}
              placeholder="Tapez le nom ici…"
              className="w-full bg-slate-800 border border-red-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-red-500"
            />
            <div className="flex gap-2">
              <button onClick={() => { setShowDeleteZone(false); setDeleteConfirm(""); }} className="flex-1 text-xs text-slate-400 border border-slate-700 px-3 py-2 rounded-lg">Annuler</button>
              <button
                disabled={deleteConfirm !== projectName}
                onClick={onDelete}
                className="flex-1 text-xs bg-red-800 disabled:opacity-30 disabled:cursor-not-allowed text-white px-3 py-2 rounded-lg font-semibold"
              >Supprimer définitivement</button>
            </div>
          </div>
        )}
      </div>

      {/* Historique des actions */}
      <div className="mt-6 border border-slate-700/60 rounded-xl p-4 bg-slate-900/30">
        <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3">📋 Historique des actions</div>
        {logsLoading ? (
          <div className="text-xs text-slate-500 py-4 text-center">Chargement…</div>
        ) : logs.length === 0 ? (
          <div className="text-xs text-slate-500 py-4 text-center">Aucune action enregistrée</div>
        ) : (
          <div className="space-y-1 max-h-80 overflow-y-auto">
            {logs.map((log, i) => {
              const d = new Date(log.performed_at);
              const dateLabel = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
              const childName = log.children ? `${log.children.first_name} ${log.children.last_name}` : log.child_id;
              return (
                <div key={i} className="flex items-center gap-2 text-[10px] text-slate-400 py-1 border-b border-slate-800/60 last:border-0">
                  <span className="text-slate-500 flex-shrink-0 w-20">{dateLabel}</span>
                  <span className="text-slate-300 flex-1 truncate font-semibold">{childName}</span>
                  <span className="flex-shrink-0">{log.action}</span>
                  <span className="text-slate-600 flex-shrink-0 truncate max-w-[80px]">{log.performed_by}</span>
                </div>
              );
            })}
          </div>
        )}
        {(logsPage > 0 || logs.length === PAGE_SIZE) && (
          <div className="flex gap-2 mt-3">
            {logsPage > 0 && <button onClick={() => setLogsPage(p => p - 1)} className="text-xs text-slate-400 border border-slate-700 px-3 py-1.5 rounded-lg">← Page précédente</button>}
            {logs.length === PAGE_SIZE && <button onClick={() => setLogsPage(p => p + 1)} className="text-xs text-slate-400 border border-slate-700 px-3 py-1.5 rounded-lg ml-auto">Page suivante →</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function ChildFormModal({ child, shootingDays, onSave, onClose }: { child: Child | null; shootingDays: Record<string, ShootingDay>; onSave: (d: any) => void; onClose: () => void }) {
  const [fullName, setFullName] = useState(child ? `${child.first_name} ${child.last_name}`.trim() : "");
  const [dob, setDob] = useState(child?.dob || "");
  const [vacationPeriods, setVacationPeriods] = useState<VacationPeriod[]>(child?.vacation_periods || []);
  const [role, setRole] = useState<ChildRole | null>(child?.role || null);
  const [newVac, setNewVac] = useState({ start: "", end: "" });
  const [vacWarnings, setVacWarnings] = useState<Record<number, string[]>>({});
  const [derogations, setDerogations] = useState<Derogation[]>(child?.derogations || []);
  const [newDerog, setNewDerog] = useState({ date: "", end_time: "" });
  const [error, setError] = useState("");

  function handleSave() {
    if (!fullName.trim()) { setError("Le prénom et nom sont obligatoires."); return; }
    if (!dob) { setError("La date de naissance est obligatoire."); return; }
    setError(""); onSave({ fullName: fullName.trim(), dob, vacationPeriods, role, derogations });
  }

  return (
    <Modal title={child ? "Modifier l'enfant" : "Ajouter un enfant"} onClose={onClose}>
      <div className="space-y-3">
        <TextInput label="Prénom Nom" required value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Ex: Léa Martin" />
        <TextInput label="Date de naissance" required type="date" value={dob} onChange={e => setDob(e.target.value)} />
        {dob && <div className="bg-blue-900/30 border border-blue-700/60 rounded-lg px-3 py-2 text-sm text-blue-300">{getAge(dob)} ans · Tranche {getAgeBand(dob)} ans</div>}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-400 uppercase tracking-[0.15em] font-semibold">Statut <span className="text-slate-600 font-normal normal-case">(optionnel)</span></label>
          <div className="flex gap-2 flex-wrap">
            <button type="button" onClick={() => setRole(null)} className={`px-3 py-2 rounded-lg text-xs font-semibold border ${role === null ? "bg-slate-600 border-slate-500 text-white" : "bg-slate-800 border-slate-600 text-slate-400"}`}>Non défini</button>
            {ALL_ROLES.map(r => <button key={r} type="button" onClick={() => setRole(r)} className={`px-3 py-2 rounded-lg text-xs font-semibold border ${role === r ? ROLE_COLORS[r] : "bg-slate-800 border-slate-600 text-slate-400"}`}>{ROLE_LABELS[r]}</button>)}
          </div>
        </div>
        <div>
          <label className="text-[10px] text-slate-400 uppercase tracking-wider block mb-2">Vacances <span className="text-slate-600 font-normal normal-case">(optionnel)</span></label>
          {vacationPeriods.map((p, i) => (
            <div key={i} className="mb-2">
              <div className="flex items-center gap-2 text-sm text-slate-300">
                <span>{p.start} → {p.end}</span>
                <button onClick={() => {
                  setVacationPeriods(v => v.filter((_, j) => j !== i));
                  setVacWarnings(w => { const copy = { ...w }; delete copy[i]; return copy; });
                }} className="text-red-400 w-6 h-6 flex items-center justify-center">✕</button>
              </div>
              {vacWarnings[i] && vacWarnings[i].length > 0 && (
                <div className="mt-1 bg-amber-900/25 border border-amber-700/50 rounded-lg px-2 py-1.5 text-[10px] text-amber-300">
                  ⚠ {vacWarnings[i].length} jour(s) de tournage tombent dans cette période de vacances : {vacWarnings[i].join(", ")}
                </div>
              )}
            </div>
          ))}
          <div className="flex gap-2 items-end mt-2">
            <TextInput label="Début" type="date" value={newVac.start} onChange={e => setNewVac(v => ({ ...v, start: e.target.value }))} />
            <TextInput label="Fin" type="date" value={newVac.end} onChange={e => setNewVac(v => ({ ...v, end: e.target.value }))} />
            <button onClick={() => {
              if (newVac.start && newVac.end) {
                const idx = vacationPeriods.length;
                const conflictDates = Object.entries(shootingDays)
                  .filter(([date, day]) => {
                    if (date < newVac.start || date > newVac.end) return false;
                    if (child && !day.child_ids.includes(child.id)) return false;
                    return true;
                  })
                  .map(([date]) => new Date(date + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short" }));
                setVacationPeriods(v => [...v, newVac]);
                if (conflictDates.length > 0) {
                  setVacWarnings(w => ({ ...w, [idx]: conflictDates }));
                }
                setNewVac({ start: "", end: "" });
              }
            }} className="bg-slate-700 text-white px-3 rounded-lg h-12 text-sm">+</button>
          </div>
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
function ShootingView({ project, dateStr, onBack, onStartSessions, onStartSession, onCancelSession, onApplyEvent, onCancelLastEvent, onEndSessions, onReopenSession, onToggleChild, onAddGroup, onRemoveGroup, onEditEventTime, onEditStartTime, onEditEndTime, onExportXLSX, onExportPDF }: {
  project: Project; dateStr: string; onBack: () => void;
  onStartSessions: (cids: string[], t?: string) => void; onStartSession: (cid: string, t?: string) => void;
  onCancelSession: (cid: string) => void; onApplyEvent: (cids: string[], type: "pause_start" | "pause_end" | "dejeuner_start" | "dejeuner_end", t?: string) => void;
  onCancelLastEvent: (cid: string) => void; onEndSessions: (cids: string[], t?: string) => void;
  onReopenSession: (cid: string) => void; onToggleChild: (cid: string) => void;
  onAddGroup: (gid: string) => void; onRemoveGroup: (gid: string) => void;
  onEditEventTime: (cid: string, idx: number, t: string) => void; onEditStartTime: (cid: string, t: string) => void; onEditEndTime: (cid: string, t: string) => void;
  onExportXLSX: () => void; onExportPDF: () => void;
}) {
  const [, setTick] = useState(0);
  const [addingChildren, setAdding] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<Child | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionModal, setActionModal] = useState<{ type: "start" | "pause" | "dejeuner" | "resume" | "end" } | null>(null);
  const [search, setSearch] = useState("");
  const [roleTab, setRoleTab] = useState<ChildRole | "all">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null); // Fix #1: collapsed cards

  useEffect(() => { const t = setInterval(() => setTick(n => n + 1), 15000); return () => clearInterval(t); }, []);

  const day = project.shootingDays[dateStr] || { child_ids: [], sessions: {} };
  const childIds = day.child_ids || [];
  const sessions = day.sessions || {};
  const rules = project.rules;
  const dateLabel = new Date(dateStr + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const childrenInDay = sortByRoleThenAlpha(childIds.map(id => project.children.find(c => c.id === id)).filter(Boolean) as Child[]);
  const rolesPresent = ALL_ROLES.filter(r => childrenInDay.some(c => c.role === r));

  const filteredIds = childrenInDay.filter(c => {
    if (search.trim()) { const q = normalize(search); if (!normalize(`${c.first_name} ${c.last_name}`).includes(q) && !normalize(`${c.last_name} ${c.first_name}`).includes(q)) return false; }
    if (roleTab !== "all" && c.role !== roleTab) return false;
    return true;
  }).map(c => c.id);

  function toggleSelect(id: string) { setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  const selList = [...selected];
  const canStart    = selList.some(id => !sessions[id]?.start_time);
  const canPause    = selList.some(id => sessions[id]?.status === "working");
  const canDejeuner = selList.some(id => sessions[id]?.status === "working");
  const canResume   = selList.some(id => sessions[id]?.status === "paused" || sessions[id]?.status === "dejeuner");
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
          <button onClick={onExportXLSX} className="text-xs text-emerald-400 border border-emerald-800/60 px-2 py-1.5 rounded-lg flex-shrink-0">XLS</button>
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
              <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-2">Individuellement</div>
              <div className="space-y-0.5">{project.children.filter(c => !c.archived).map(c => {
                const isInDay = childIds.includes(c.id);
                const hasSession = isInDay && !!sessions[c.id]?.start_time;
                return (
                  <label key={c.id} className="flex items-center gap-3 py-2.5 cursor-pointer">
                    <input type="checkbox" className="accent-blue-500 w-5 h-5" checked={isInDay}
                      onChange={() => {
                        if (isInDay) { setPendingRemove(c); }
                        else { onToggleChild(c.id); }
                      }} />
                    <span className="text-sm text-slate-200 flex-1">{c.first_name} {c.last_name}</span>
                    {c.role && <RoleBadge role={c.role} />}
                    {hasSession && <span className="text-[10px] text-amber-400">● données</span>}
                  </label>
                );
              })}</div>
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

      {actionModal && <TimeActionModal type={actionModal.type} childCount={selected.size} dateStr={dateStr}
        onConfirm={timeISO => {
          const ids = [...selected];
          if      (actionModal.type === "start")    onStartSessions(ids, timeISO);
          else if (actionModal.type === "pause")    onApplyEvent(ids, "pause_start", timeISO);
          else if (actionModal.type === "dejeuner") onApplyEvent(ids, "dejeuner_start", timeISO);
          else if (actionModal.type === "resume")   onApplyEvent(ids, "pause_end", timeISO);
          else if (actionModal.type === "end")      onEndSessions(ids, timeISO);
          setActionModal(null);
        }}
        onClose={() => setActionModal(null)} />}

      {pendingRemove && (
        <Modal title="Retirer de la journée ?" onClose={() => setPendingRemove(null)}>
          <div className="space-y-4">
            {sessions[pendingRemove.id]?.start_time ? (
              <div className="bg-red-900/30 border border-red-700 rounded-lg px-4 py-3 text-sm text-red-300">
                🚫 <b>{pendingRemove.first_name} {pendingRemove.last_name}</b> a des données enregistrées pour cette journée.<br />
                <span className="text-xs mt-1 block text-red-400">Les heures de travail, pauses et événements seront définitivement perdus.</span>
              </div>
            ) : (
              <div className="bg-slate-800/60 border border-slate-600 rounded-lg px-4 py-3 text-sm text-slate-300">
                Retirer <b>{pendingRemove.first_name} {pendingRemove.last_name}</b> de cette journée de tournage ?
              </div>
            )}
            <div className="flex gap-3">
              <Btn variant="ghost" className="flex-1" onClick={() => setPendingRemove(null)}>Annuler</Btn>
              <button onClick={() => { onToggleChild(pendingRemove.id); setPendingRemove(null); }}
                className={`flex-1 py-3 rounded-xl font-bold text-sm ${sessions[pendingRemove.id]?.start_time ? "bg-red-700" : "bg-slate-600"} text-white`}>
                Retirer
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function TimeActionModal({ type, childCount, dateStr, onConfirm, onClose }: { type: string; childCount: number; dateStr: string; onConfirm: (t: string) => void; onClose: () => void }) {
  const now = new Date();
  const [timeStr, setTimeStr] = useState(`${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
  const labels: Record<string, string> = { start: "Démarrer", pause: "Mise en pause", dejeuner: "Pause déjeuner", resume: "Reprise", end: "Fin de journée" };
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
  onApplyEvent: (type: "pause_start" | "pause_end" | "dejeuner_start" | "dejeuner_end", t?: string) => void;
  onEndSession: (t?: string) => void;
  dateStr: string;
}) {
  const [editingIdx, setEditingIdx] = useState<number | "start" | "end" | null>(null);
  const [indivModal, setIndivModal] = useState<{ type: "pause" | "dejeuner" | "resume" | "end" } | null>(null);
  const [editTime, setEditTime] = useState("");
  const workPct  = stats ? Math.min(100, (stats.workMin / maxWork) * 100) : 0;
  const ampPct   = stats ? Math.min(100, (stats.amplitudeMin / maxAmplitude) * 100) : 0;
  const workCrit = stats && stats.workMin > maxWork;
  const ampCrit  = stats && stats.amplitudeMin > maxAmplitude;
  const ampWarn  = stats && stats.amplitudeMin === maxAmplitude;
  const breakDue = stats?.timeSinceBreak != null && stats.timeSinceBreak >= breakAfter;

  // Alerte 20h (ou heure de dérogation si définie pour cette date)
  const derogation = (child.derogations || []).find(d => d.date === dateStr);
  const limitTimeStr = derogation ? derogation.end_time : "20:00";
  const limitDate = new Date(`${dateStr}T${limitTimeStr}:00`);
  const limit20h = new Date(`${dateStr}T20:00:00`);
  const pastTimeLimit = session?.start_time != null && session.status !== "done" && new Date() >= limitDate;
  // Dépassement 20h sans dérogation (session en cours OU terminée après 20h)
  const past20hNoDerog = !derogation && session?.start_time != null && (
    (session.status !== "done" && new Date() >= limit20h) ||
    (session.status === "done" && session.end_time != null && new Date(session.end_time) > limit20h)
  );

  function startEdit(key: number | "start" | "end", iso: string | undefined) { setEditingIdx(key); setEditTime(isoToTimeStr(iso)); }
  function confirmEdit() {
    const iso = timeStrToISO(dateStr, editTime);
    if (editingIdx === "start") onEditStartTime(iso); else if (editingIdx === "end") onEditEndTime(iso); else onEditEventTime(editingIdx as number, iso);
    setEditingIdx(null);
  }
  const events = session?.events || [];

  const statusColor = session?.status === "working" ? "border-emerald-700" : session?.status === "paused" ? "border-amber-600" : session?.status === "dejeuner" ? "border-orange-500" : session?.status === "done" ? "border-slate-600" : workCrit || ampCrit ? "border-red-700" : ampWarn ? "border-orange-500" : pastTimeLimit ? "border-orange-600" : breakDue ? "border-amber-600" : "border-slate-700";

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
            {session?.status === "done" && <span className="text-[10px] text-slate-400">✓ Terminé</span>}
            {!session?.start_time && <span className="text-[10px] text-slate-500">Non démarré</span>}
            {workCrit && <span className="text-[10px] text-red-400">🚫 Trav.</span>}
            {ampCrit && <span className="text-[10px] text-red-400">🚫 Ampl.</span>}
            {ampWarn && !ampCrit && <span className="text-[10px] text-orange-400">⚠️ Ampl.</span>}
            {breakDue && !workCrit && <span className="text-[10px] text-amber-400">⚠️ Pause</span>}
            {past20hNoDerog && <span className="text-[10px] text-red-400">🚫 20h</span>}
            {pastTimeLimit && !past20hNoDerog && <span className="text-[10px] text-orange-400">🕗 {limitTimeStr} dépassé</span>}
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
                {([{ l: "Travail", v: stats.workMin, max: maxWork, crit: workCrit }, { l: "🍽 Déjeuner", v: stats.dejeunerMin }, { l: "Pauses val.", v: stats.validBreakMin, sub: `tot.${formatMinutes(stats.breakMin)}` }, { l: "Amplitude", v: stats.amplitudeMin, max: maxAmplitude, crit: ampCrit, warn: ampWarn }] as any[]).map(({ l, v, max, sub, crit, warn }) => (
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
              {past20hNoDerog && <div className="bg-red-900/30 border border-red-700 rounded-lg px-3 py-2 text-xs text-red-300">🚫 Dépassement 20h — aucune dérogation enregistrée</div>}
              {pastTimeLimit && !past20hNoDerog && <div className="bg-orange-900/30 border border-orange-600 rounded-lg px-3 py-2 text-xs text-orange-300">🕗 Limite horaire {limitTimeStr} dépassée (dérogation)</div>}

              {/* Boutons d'action individuels */}
              {session?.status !== "done" && (
                <div className="flex gap-2 flex-wrap">
                  {session?.status === "working" && <button onClick={() => setIndivModal({ type: "pause" })} className="flex-1 text-xs bg-amber-900/60 text-amber-300 border border-amber-800 px-3 py-2 rounded-lg whitespace-nowrap">⏸ Pause</button>}
                  {session?.status === "working" && <button onClick={() => setIndivModal({ type: "dejeuner" })} className="flex-1 text-xs bg-orange-900/60 text-orange-300 border border-orange-700 px-3 py-2 rounded-lg whitespace-nowrap">🍽 Déjeuner</button>}
                  {(session?.status === "paused" || session?.status === "dejeuner") && <button onClick={() => setIndivModal({ type: "resume" })} className="flex-1 text-xs bg-emerald-900/60 text-emerald-300 border border-emerald-800 px-3 py-2 rounded-lg whitespace-nowrap">▶ Reprise</button>}
                  {session?.start_time && <button onClick={() => setIndivModal({ type: "end" })} className="flex-1 text-xs bg-slate-700/60 text-slate-300 border border-slate-600 px-3 py-2 rounded-lg whitespace-nowrap">⏹ Fin</button>}
                </div>
              )}

              <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3">
                <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-2">Chronologie — touchez l&apos;heure pour modifier</div>
                <div className="space-y-2">
                  <TimelineRow label="▶ Début" iso={session?.start_time} isEditing={editingIdx === "start"} editTime={editTime} onEdit={() => startEdit("start", session?.start_time)} onTimeChange={setEditTime} onConfirm={confirmEdit} onCancel={() => setEditingIdx(null)} />
                  {events.map((ev, i) => <TimelineRow key={i}
                    label={ev.type === "pause_start" ? "⏸ Pause" : ev.type === "pause_end" ? "▶ Reprise" : ev.type === "dejeuner_start" ? "🍽 Déjeuner" : "▶ Reprise déj."}
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

// ─── Offline banner ────────────────────────────────────────────────────────────
function OfflineBanner() {
  return (
    <div className="bg-amber-900/80 border-b border-amber-700 px-4 py-2 flex items-center gap-2 text-amber-200 text-xs">
      <span>📡</span>
      <span>Mode hors-ligne — données en lecture seule. Les modifications reprendront dès le retour du réseau.</span>
    </div>
  );
}

// ─── Share modal ───────────────────────────────────────────────────────────────
function ShareModal({ project, onGenerateToken, onClose }: { project: Project; onGenerateToken: () => Promise<string>; onClose: () => void }) {
  const [token, setToken] = useState(project.share_token || "");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [password, setPassword] = useState(project.share_password || "");
  const [pwSaved, setPwSaved] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);
  const shareUrl = token ? `${window.location.origin}?share=${token}` : "";

  async function generate() {
    setLoading(true);
    const t = await onGenerateToken();
    setToken(t);
    setLoading(false);
  }

  function copyLink() {
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function savePassword() {
    setPwSaving(true);
    await supabase.from("projects").update({ share_password: password || null }).eq("id", project.id);
    setPwSaving(false);
    setPwSaved(true);
    setTimeout(() => setPwSaved(false), 2000);
  }

  return (
    <Modal title="Partager en lecture seule" onClose={onClose}>
      <div className="space-y-4">
        <div className="text-xs text-slate-400">
          Générez un lien pour partager ce projet en <b className="text-white">lecture seule</b> avec un réalisateur ou directeur de production. Aucun compte requis.
        </div>
        {!token ? (
          <button onClick={generate} disabled={loading} className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-3 rounded-xl font-bold text-sm">
            {loading ? "Génération…" : "🔗 Générer le lien de partage"}
          </button>
        ) : (
          <div className="space-y-3">
            <div className="bg-slate-800/80 border border-slate-600 rounded-lg px-3 py-2 text-xs text-blue-300 break-all font-mono">{shareUrl}</div>
            <div className="flex gap-2">
              <button onClick={copyLink} className={`flex-1 py-3 rounded-xl font-bold text-sm transition-colors ${copied ? "bg-emerald-700 text-white" : "bg-slate-700 hover:bg-slate-600 text-white"}`}>
                {copied ? "✓ Lien copié !" : "📋 Copier le lien"}
              </button>
              <button onClick={generate} disabled={loading} className="py-3 px-3 rounded-xl text-xs text-slate-400 hover:text-white border border-slate-700 hover:border-slate-500 transition-colors" title="Regénérer un nouveau lien">
                {loading ? "…" : "🔄"}
              </button>
            </div>
            <div className="border-t border-slate-700 pt-3">
              <div className="text-xs text-slate-300 font-semibold mb-1.5">🔒 Mot de passe (optionnel)</div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Laisser vide = sans mot de passe"
                  className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
                />
                <button onClick={savePassword} disabled={pwSaving} className={`px-3 py-2 rounded-lg text-xs font-bold transition-colors ${pwSaved ? "bg-emerald-700 text-white" : "bg-slate-700 hover:bg-slate-600 text-white"}`}>
                  {pwSaved ? "✓" : pwSaving ? "…" : "Sauver"}
                </button>
              </div>
              <div className="text-[10px] text-slate-500 mt-1">Si défini, les visiteurs devront saisir ce mot de passe pour accéder au projet.</div>
            </div>
          </div>
        )}
        <Btn variant="ghost" className="w-full" onClick={onClose}>Fermer</Btn>
      </div>
    </Modal>
  );
}

// ─── Shared project view (read-only, no auth required) ────────────────────────
function SharedProjectView({ token }: { token: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwChecking, setPwChecking] = useState(false);

  async function loadProject(password?: string) {
    const params: any = { p_token: token };
    if (password) params.p_password = password;
    const { data, error: e } = await supabase.rpc("get_project_by_token", params);
    if (e || !data) { setError("Lien invalide ou expiré."); setLoading(false); setPwChecking(false); return; }
    if (data.error === "password_required") {
      setNeedsPassword(true); setLoading(false); setPwChecking(false);
      if (password) setPwError("Mot de passe incorrect.");
      return;
    }
    const shootingDays: Record<string, ShootingDay> = {};
    Object.entries(data.shootingDays || {}).forEach(([date, d]: [string, any]) => { shootingDays[date] = d; });
    const mappedChildren = (data.children || []).map((c: any) => ({ ...c, role: c.child_role ?? undefined }));
    setProject({ ...data.project, children: mappedChildren, groups: data.groups || [], shootingDays });
    setNeedsPassword(false); setLoading(false); setPwChecking(false);
  }

  useEffect(() => { loadProject(); }, [token]);

  function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!pwInput.trim()) return;
    setPwError(""); setPwChecking(true);
    loadProject(pwInput.trim());
  }

  if (loading) return <div className="min-h-screen bg-[#080d16] flex items-center justify-center"><div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;

  if (needsPassword) return (
    <div className="min-h-screen bg-[#080d16] flex items-center justify-center px-4" style={{ fontFamily: "'DM Mono', monospace" }}>
      <div className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-6">
        <h1 className="text-xl font-extrabold mb-1 text-center" style={{ fontFamily: "Syne, sans-serif" }}><span className="text-white">KIDS</span><span className="text-blue-500">TIME</span></h1>
        <div className="text-center text-sm text-slate-400 mb-5">Ce projet est protégé par un mot de passe.</div>
        <form onSubmit={submitPassword} className="space-y-3">
          <input
            type="password"
            value={pwInput}
            onChange={e => { setPwInput(e.target.value); setPwError(""); }}
            placeholder="Mot de passe"
            autoFocus
            className="w-full bg-slate-800 border border-slate-600 rounded-xl px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
          />
          {pwError && <div className="text-xs text-red-400">{pwError}</div>}
          <button type="submit" disabled={pwChecking || !pwInput.trim()} className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-3 rounded-xl font-bold text-sm">
            {pwChecking ? "Vérification…" : "Accéder au projet"}
          </button>
        </form>
      </div>
    </div>
  );

  if (error || !project) return (
    <div className="min-h-screen bg-[#080d16] flex items-center justify-center px-4" style={{ fontFamily: "'DM Mono', monospace" }}>
      <div className="text-center"><div className="text-red-400 text-4xl mb-4">⚠️</div><div className="text-white font-bold mb-2">{error || "Erreur"}</div><div className="text-slate-400 text-sm">Ce lien de partage est invalide ou a expiré.</div></div>
    </div>
  );
  return <ReadOnlyView project={project} />;
}

// ─── Read-only view ───────────────────────────────────────────────────────────
function ReadOnlyView({ project }: { project: Project }) {
  const sortedDates = Object.keys(project.shootingDays).sort();
  const [tab, setTab] = useState<"calendar" | "children">("calendar");
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [openChild, setOpenChild] = useState<string | null>(null);
  const [calCur, setCalCur] = useState(() => {
    if (sortedDates.length > 0) { const d = new Date(sortedDates[0] + "T12:00:00"); return new Date(d.getFullYear(), d.getMonth(), 1); }
    const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [roleTab, setRoleTab] = useState<ChildRole | "all">("all");
  const MN = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
  const DN = ["L","M","M","J","V","S","D"];
  const activeChildren = project.children.filter(c => !c.archived);
  const rolesPresent = ALL_ROLES.filter(r => activeChildren.some(c => c.role === r));
  const displayChildren = sortByRoleThenAlpha(roleTab === "all" ? activeChildren : activeChildren.filter(c => c.role === roleTab));

  return (
    <div className="min-h-screen bg-[#080d16] text-white pb-10" style={{ fontFamily: "'DM Mono', monospace" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap" rel="stylesheet" />
      <div className="bg-blue-900/30 border-b border-blue-800 px-4 py-2 flex items-center gap-2 text-blue-300 text-xs">
        <span>👁</span><span>Mode consultation — lecture seule · KidsTime · ACMA Fiction</span>
      </div>
      <div className="max-w-2xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-extrabold mb-1" style={{ fontFamily: "Syne, sans-serif" }}><span className="text-white">KIDS</span><span className="text-blue-500">TIME</span></h1>
        <h2 className="text-lg font-bold text-white mb-1">{project.name}</h2>
        <div className="text-xs text-slate-400 mb-4">{project.children.length} enfant(s) · {sortedDates.length} jour(s) de tournage</div>

        {/* Tabs */}
        <div className="flex gap-1 mb-5 bg-slate-900/60 p-1 rounded-xl border border-slate-800">
          {([["calendar", "📅 Calendrier"], ["children", "👦 Enfants"]] as const).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors ${tab === key ? "bg-blue-600 text-white" : "text-slate-400 hover:text-white"}`}>{label}</button>
          ))}
        </div>

        {tab === "calendar" && (() => {
          const y = calCur.getFullYear(), m = calCur.getMonth();
          const firstDay = (new Date(y, m, 1).getDay() + 6) % 7, daysInMonth = new Date(y, m + 1, 0).getDate();
          const cells = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
          function ds(d: number) { return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
          return (
            <div>
              <div className="flex items-center justify-between mb-4">
                <button onClick={() => setCalCur(new Date(y, m - 1, 1))} className="text-slate-400 w-10 h-10 rounded-lg border border-slate-700 flex items-center justify-center text-lg">‹</button>
                <h2 className="font-bold text-base" style={{ fontFamily: "Syne, sans-serif" }}>{MN[m]} {y}</h2>
                <button onClick={() => setCalCur(new Date(y, m + 1, 1))} className="text-slate-400 w-10 h-10 rounded-lg border border-slate-700 flex items-center justify-center text-lg">›</button>
              </div>
              <div className="grid grid-cols-7 gap-1 mb-1">{DN.map((d, i) => <div key={i} className="text-center text-[10px] text-slate-500 py-1 uppercase tracking-wider">{d}</div>)}</div>
              <div className="grid grid-cols-7 gap-1 mb-4">
                {cells.map((d, i) => {
                  if (!d) return <div key={i} />;
                  const s = ds(d);
                  const dayData = project.shootingDays[s];
                  const count = (dayData?.child_ids || []).filter(id => project.children.find(c => c.id === id)).length;
                  const isShoot = count > 0, isToday = s === todayStr(), isOpen = openDate === s;
                  const hasAlert = isShoot && (dayData.child_ids || []).some(id => {
                    const child = project.children.find(c => c.id === id); if (!child) return false;
                    const session = dayData.sessions?.[id];
                    const vacation = isVacation(child, s);
                    const band = getAgeBand(child.dob);
                    const period: Period = vacation ? "vacation" : "school";
                    const stats = computeSessionStats(session, project.rules);
                    return stats && (stats.workMin > project.rules.maxWorkMinutes[band][period] || stats.amplitudeMin > project.rules.maxAmplitudeMinutes);
                  });
                  return (
                    <button key={i} onClick={() => isShoot ? setOpenDate(isOpen ? null : s) : undefined}
                      className={`rounded-xl py-2.5 text-sm transition-all ${isShoot ? `cursor-pointer ${isOpen ? "bg-blue-700/60 border-blue-400" : "bg-blue-900/50 border-blue-600"} border text-blue-200` : "bg-slate-900/40 border border-slate-800 text-slate-600 cursor-default"} ${isToday ? "ring-2 ring-blue-400" : ""}`}>
                      <div className="font-bold text-sm">{d}</div>
                      {isShoot && <div className="text-[9px] text-blue-400">{count}👦</div>}
                      {hasAlert && <div className="text-[9px] text-red-400">⚠</div>}
                    </button>
                  );
                })}
              </div>
              {openDate && project.shootingDays[openDate] && (() => {
                const day = project.shootingDays[openDate];
                const dateLabel = new Date(openDate + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
                const childrenInDay = sortByRoleThenAlpha((day.child_ids || []).map(id => project.children.find(c => c.id === id)).filter(Boolean) as Child[]);
                return (
                  <div className="border border-blue-700/50 rounded-xl overflow-hidden">
                    <div className="px-4 py-3 bg-blue-900/30 border-b border-blue-700/30">
                      <div className="font-bold text-white text-sm capitalize">{dateLabel}</div>
                      <div className="text-[10px] text-blue-300">{childrenInDay.length} enfant(s) · cliquez sur un jour pour fermer</div>
                    </div>
                    <div className="p-3 space-y-3">
                      {childrenInDay.map(child => {
                        const session = day.sessions?.[child.id];
                        const vacation = isVacation(child, openDate);
                        const band = getAgeBand(child.dob);
                        const period: Period = vacation ? "vacation" : "school";
                        const maxWork = project.rules.maxWorkMinutes[band][period];
                        const maxAmp = project.rules.maxAmplitudeMinutes;
                        const stats = computeSessionStats(session, project.rules);
                        const workOver = stats ? stats.workMin > maxWork : false;
                        const ampOver = stats ? stats.amplitudeMin > maxAmp : false;
                        const ampWarn = stats ? stats.amplitudeMin === maxAmp : false;
                        const pauseSlots = stats?.breakSlots.filter(b => b.valid && b.kind === "pause") || [];
                        const dejSlots = stats?.breakSlots.filter(b => b.kind === "dejeuner") || [];
                        return (
                          <div key={child.id} className="bg-slate-800/50 rounded-xl p-3 space-y-2">
                            <div className="flex items-center gap-2">
                              <div className="w-7 h-7 rounded-full bg-blue-900/60 flex items-center justify-center text-blue-300 font-bold text-[10px] flex-shrink-0">{child.first_name?.[0]}{child.last_name?.[0]}</div>
                              <div className="flex-1">
                                <div className="text-sm font-semibold text-white">{child.first_name} {child.last_name}</div>
                                <div className="flex items-center gap-2"><div className="text-[10px] text-slate-400">{getAge(child.dob)} ans{vacation ? " · 🌴 Vacances" : ""}</div>{child.role && <RoleBadge role={child.role} />}</div>
                              </div>
                            </div>
                            {session?.start_time ? (
                              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] pt-1 border-t border-slate-700">
                                <div className="text-slate-400">Convocation</div><div className="text-white font-medium">{formatTime(session.start_time)}</div>
                                <div className="text-slate-400">Fin</div><div className="text-white font-medium">{session.end_time ? formatTime(session.end_time) : <span className="text-blue-400">en cours</span>}</div>
                                <div className="text-slate-400">Travail</div>
                                <div className={`font-semibold ${workOver ? "text-red-400" : "text-emerald-400"}`}>{stats ? formatMinutes(stats.workMin) : "--"} <span className="text-slate-500 font-normal">/ {formatMinutes(maxWork)}</span>{workOver && <span className="text-red-400 ml-1">⚠ +{formatMinutes(stats!.workMin - maxWork)}</span>}</div>
                                <div className="text-slate-400">Amplitude</div>
                                <div className={`font-semibold ${ampOver ? "text-red-400" : ampWarn ? "text-orange-400" : "text-slate-300"}`}>{stats ? formatMinutes(stats.amplitudeMin) : "--"} <span className="text-slate-500 font-normal">/ {formatMinutes(maxAmp)}</span>{ampOver && <span className="text-red-400 ml-1">⚠ +{formatMinutes(stats!.amplitudeMin - maxAmp)}</span>}</div>
                                {stats && stats.dejeunerMin > 0 && <><div className="text-slate-400">🍽 Déjeuner</div><div className="text-slate-300">{formatMinutes(stats.dejeunerMin)}{dejSlots.length > 0 && <span className="text-slate-500 ml-1">({dejSlots.map(s => `${formatTime(s.start)}→${formatTime(s.end)}`).join(", ")})</span>}</div></>}
                                {stats && stats.validBreakMin > 0 && <><div className="text-slate-400">Pauses</div><div className="text-slate-300">{formatMinutes(stats.validBreakMin)}{pauseSlots.length > 0 && <span className="text-slate-500 ml-1">({pauseSlots.map(s => `${formatTime(s.start)}→${formatTime(s.end)}`).join(", ")})</span>}</div></>}
                              </div>
                            ) : <div className="text-[10px] text-slate-500 pt-1 border-t border-slate-700">Non démarré</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {tab === "children" && (
          <div>
            {rolesPresent.length > 0 && (
              <div className="flex gap-0 border-b border-slate-800 mb-3 overflow-x-auto">
                <button onClick={() => setRoleTab("all")} className={`px-3 py-2 text-xs whitespace-nowrap transition-colors border-b-2 ${roleTab === "all" ? "border-blue-500 text-white" : "border-transparent text-slate-500"}`}>Tous ({activeChildren.length})</button>
                {rolesPresent.map(r => <button key={r} onClick={() => setRoleTab(r)} className={`px-3 py-2 text-xs whitespace-nowrap transition-colors border-b-2 ${roleTab === r ? "border-blue-500 text-white" : "border-transparent text-slate-500"}`}>{ROLE_LABELS[r]} ({activeChildren.filter(c => c.role === r).length})</button>)}
              </div>
            )}
            <div className="space-y-2">
              {displayChildren.map(child => {
                const band = getAgeBand(child.dob);
                const daysPresent = sortedDates.filter(d => (project.shootingDays[d].child_ids || []).includes(child.id));
                const isOpen = openChild === child.id;
                const hasAlert = daysPresent.some(dateStr => {
                  const session = project.shootingDays[dateStr].sessions?.[child.id];
                  const vacation = isVacation(child, dateStr);
                  const period: Period = vacation ? "vacation" : "school";
                  const stats = computeSessionStats(session, project.rules);
                  return stats && (stats.workMin > project.rules.maxWorkMinutes[band][period] || stats.amplitudeMin > project.rules.maxAmplitudeMinutes);
                });
                return (
                  <div key={child.id} className="border border-slate-700 rounded-xl overflow-hidden">
                    <button onClick={() => setOpenChild(isOpen ? null : child.id)} className="w-full flex items-center gap-3 px-4 py-3 bg-slate-900/50 hover:bg-slate-800/60 transition-colors text-left">
                      <div className="w-9 h-9 rounded-full bg-blue-900/60 flex items-center justify-center text-blue-300 font-bold text-sm flex-shrink-0">{child.first_name?.[0]}{child.last_name?.[0]}</div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-white">{child.first_name} {child.last_name}</div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-slate-400">{getAge(child.dob)} ans · {band} ans · {daysPresent.length} jour(s)</span>
                          {child.role && <RoleBadge role={child.role} />}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {hasAlert && <span className="text-red-400 text-xs">⚠</span>}
                        <span className="text-slate-500 text-xs">{isOpen ? "▲" : "▼"}</span>
                      </div>
                    </button>
                    {isOpen && daysPresent.length > 0 && (
                      <div className="p-3 space-y-2 bg-slate-900/20">
                        {daysPresent.map(dateStr => {
                          const day = project.shootingDays[dateStr];
                          const session = day.sessions?.[child.id];
                          const vacation = isVacation(child, dateStr);
                          const period: Period = vacation ? "vacation" : "school";
                          const maxWork = project.rules.maxWorkMinutes[band][period];
                          const maxAmp = project.rules.maxAmplitudeMinutes;
                          const stats = computeSessionStats(session, project.rules);
                          const workOver = stats ? stats.workMin > maxWork : false;
                          const ampOver = stats ? stats.amplitudeMin > maxAmp : false;
                          const ampWarn = stats ? stats.amplitudeMin === maxAmp : false;
                          const pauseSlots = stats?.breakSlots.filter(b => b.valid && b.kind === "pause") || [];
                          const dejSlots = stats?.breakSlots.filter(b => b.kind === "dejeuner") || [];
                          const dateLabel = new Date(dateStr + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
                          return (
                            <div key={dateStr} className="bg-slate-800/50 rounded-xl p-3 space-y-2">
                              <div className="text-xs font-semibold text-blue-300 capitalize">{dateLabel}{vacation ? " · 🌴 Vacances" : ""}</div>
                              {session?.start_time ? (
                                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
                                  <div className="text-slate-400">Convocation</div><div className="text-white font-medium">{formatTime(session.start_time)}</div>
                                  <div className="text-slate-400">Fin</div><div className="text-white font-medium">{session.end_time ? formatTime(session.end_time) : <span className="text-blue-400">en cours</span>}</div>
                                  <div className="text-slate-400">Travail</div>
                                  <div className={`font-semibold ${workOver ? "text-red-400" : "text-emerald-400"}`}>{stats ? formatMinutes(stats.workMin) : "--"} <span className="text-slate-500 font-normal">/ {formatMinutes(maxWork)}</span>{workOver && <span className="text-red-400 ml-1">⚠ +{formatMinutes(stats!.workMin - maxWork)}</span>}</div>
                                  <div className="text-slate-400">Amplitude</div>
                                  <div className={`font-semibold ${ampOver ? "text-red-400" : ampWarn ? "text-orange-400" : "text-slate-300"}`}>{stats ? formatMinutes(stats.amplitudeMin) : "--"} <span className="text-slate-500 font-normal">/ {formatMinutes(maxAmp)}</span>{ampOver && <span className="text-red-400 ml-1">⚠ +{formatMinutes(stats!.amplitudeMin - maxAmp)}</span>}</div>
                                  {stats && stats.dejeunerMin > 0 && <><div className="text-slate-400">🍽 Déjeuner</div><div className="text-slate-300">{formatMinutes(stats.dejeunerMin)}{dejSlots.length > 0 && <span className="text-slate-500 ml-1">({dejSlots.map(s => `${formatTime(s.start)}→${formatTime(s.end)}`).join(", ")})</span>}</div></>}
                                  {stats && stats.validBreakMin > 0 && <><div className="text-slate-400">Pauses</div><div className="text-slate-300">{formatMinutes(stats.validBreakMin)}{pauseSlots.length > 0 && <span className="text-slate-500 ml-1">({pauseSlots.map(s => `${formatTime(s.start)}→${formatTime(s.end)}`).join(", ")})</span>}</div></>}
                                </div>
                              ) : <div className="text-[10px] text-slate-500">Non démarré</div>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-8 text-center text-[10px] text-slate-600">KidsTime · Éléonore Aguillon · ACMA Fiction</div>
      </div>
    </div>
  );
}
