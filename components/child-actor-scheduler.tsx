"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ─── Types ────────────────────────────────────────────────────────────────────
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

interface Child {
  id: string;
  project_id: string;
  first_name: string;
  last_name: string;
  dob: string;
  vacation_periods: VacationPeriod[];
  role?: ChildRole;
}

interface Group {
  id: string;
  project_id: string;
  name: string;
  child_ids: string[];
}

interface SessionEvent { type: "pause_start" | "pause_end"; time: string; }

interface Session {
  start_time?: string;
  end_time?: string;
  status?: "working" | "paused" | "done";
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
}

interface SessionStats {
  amplitudeMin: number;
  workMin: number;
  breakMin: number;
  validBreakMin: number;
  timeSinceBreak: number | null;
  start: Date;
  now: Date;
  breakSlots: { start: string; end: string; durationMin: number; valid: boolean }[];
}

// ─── Constants ────────────────────────────────────────────────────────────────
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

const ROLE_LABELS: Record<ChildRole, string> = {
  role:       "Rôle",
  silhouette: "Silhouette",
  figurant:   "Figurant·e",
};

const ROLE_COLORS: Record<ChildRole, string> = {
  role:       "bg-purple-900/40 text-purple-300 border-purple-700",
  silhouette: "bg-cyan-900/40 text-cyan-300 border-cyan-700",
  figurant:   "bg-orange-900/40 text-orange-300 border-orange-700",
};

const ALL_ROLES: ChildRole[] = ["role", "silhouette", "figurant"];

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

// Fix #3: fullName stored as-is, split only for DB storage
function splitFullName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

// Fix #5: detect role from string value
function detectRole(val: string): ChildRole | undefined {
  const n = normalize(String(val || ""));
  if (n.includes("role") || n.includes("rôle")) return "role";
  if (n.includes("silhouette")) return "silhouette";
  if (n.includes("figurant") || n.includes("figuration")) return "figurant";
  return undefined;
}

function parseExcelDate(val: any): string {
  if (!val) return "";
  if (typeof val === "number") {
    const d = new Date((val - 25569) * 86400 * 1000);
    return d.toISOString().slice(0, 10);
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) {
      const [d, m, y] = trimmed.split("/"); return `${y}-${m}-${d}`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
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
  const now   = session.end_time ? new Date(session.end_time) : new Date();
  const start = new Date(session.start_time);
  const amplitudeMin = Math.floor((now.getTime() - start.getTime()) / 60000);
  const events = session.events || [];
  let workMin = 0, breakMin = 0, validBreakMin = 0, lastRef = start;
  const breakSlots: SessionStats["breakSlots"] = [];

  for (const ev of events) {
    const t = new Date(ev.time), dur = Math.floor((t.getTime() - lastRef.getTime()) / 60000);
    if (ev.type === "pause_start") { workMin += dur; lastRef = t; }
    else if (ev.type === "pause_end") {
      const valid = dur >= rules.minBreakMinutes;
      breakSlots.push({ start: lastRef.toISOString(), end: t.toISOString(), durationMin: dur, valid });
      if (valid) validBreakMin += dur; else workMin += dur;
      breakMin += dur; lastRef = t;
    }
  }

  const lastDur = Math.floor((now.getTime() - lastRef.getTime()) / 60000);
  if (session.status === "paused") {
    const valid = lastDur >= rules.minBreakMinutes;
    breakSlots.push({ start: lastRef.toISOString(), end: now.toISOString(), durationMin: lastDur, valid });
    if (valid) validBreakMin += lastDur; else workMin += lastDur;
    breakMin += lastDur;
  } else { workMin += lastDur; }

  let timeSinceBreak: number | null = null;
  if (session.status === "working") {
    const last = [...events].reverse().find(e => e.type === "pause_end");
    timeSinceBreak = Math.floor((now.getTime() - new Date(last ? last.time : session.start_time).getTime()) / 60000);
  }
  return { amplitudeMin, workMin, breakMin, validBreakMin, timeSinceBreak, start, now, breakSlots };
}

// ─── Export ───────────────────────────────────────────────────────────────────
function buildExportRows(project: Project, dateStr: string) {
  const day = project.shootingDays[dateStr]; if (!day) return [];
  const rows: any[] = [];
  for (const childId of day.child_ids || []) {
    const child = project.children.find(c => c.id === childId); if (!child) continue;
    const session  = day.sessions?.[childId];
    const vacation = isVacation(child, dateStr);
    const band     = getAgeBand(child.dob);
    const period: Period = vacation ? "vacation" : "school";
    const maxWork  = project.rules.maxWorkMinutes[band][period];
    const maxAmp   = project.rules.maxAmplitudeMinutes;
    const stats    = computeSessionStats(session, project.rules);
    const workOver = stats ? Math.max(0, stats.workMin - maxWork) : 0;
    const ampOver  = stats ? Math.max(0, stats.amplitudeMin - maxAmp) : 0;
    const breakSlotsStr = stats?.breakSlots.map(b => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)}${b.valid ? "" : " ⚠"})`).join(" / ") || "--";
    rows.push({
      "Nom Prénom":                 `${child.first_name} ${child.last_name}`.trim(),
      "Statut":                     child.role ? ROLE_LABELS[child.role] : "--",
      "Date de naissance":          child.dob,
      "Tranche d'âge":              band,
      "Période":                    vacation ? "Vacances" : "Scolaire",
      "Heure de convocation":       session?.start_time ? formatTime(session.start_time) : "--",
      "Heure de fin":               session?.end_time ? formatTime(session.end_time) : "--",
      "Durée totale de travail":    stats ? formatMinutes(stats.workMin) : "--",
      "Temps de travail autorisé":  formatMinutes(maxWork),
      "Dépassement travail":        workOver > 0 ? formatMinutes(workOver) : "0",
      "Durée totale des pauses":    stats ? formatMinutes(stats.breakMin) : "--",
      "Pauses valides":             stats ? formatMinutes(stats.validBreakMin) : "--",
      "Plages horaires des pauses": breakSlotsStr,
      "Amplitude de présence":      stats ? formatMinutes(stats.amplitudeMin) : "--",
      "Amplitude autorisée":        formatMinutes(maxAmp),
      "Dépassement amplitude":      ampOver > 0 ? formatMinutes(ampOver) : "0",
      _child: child, _session: session, _stats: stats, _maxWork: maxWork, _maxAmp: maxAmp, _vacation: vacation, _band: band,
    });
  }
  return rows;
}

function exportDayToXLSX(project: Project, dateStr: string) {
  const day = project.shootingDays[dateStr]; if (!day) return;
  const allRows = buildExportRows(project, dateStr);
  const clean = (rows: any[]) => rows.map(r => {
    const o: any = {};
    for (const k of Object.keys(r)) { if (!k.startsWith("_")) o[k] = r[k]; }
    return o;
  });
  const headers = Object.keys(allRows[0] || {}).filter(k => !k.startsWith("_"));
  const toCsv = (rows: any[]) => [
    headers.join(";"),
    ...rows.map(r => headers.map(h => `"${String(r[h] || "").replace(/"/g, '""')}"`).join(";")),
  ].join("\n");

  if (typeof window !== "undefined" && (window as any).XLSX) {
    const XLSX = (window as any).XLSX;
    const wb   = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(clean(allRows)), "Tous");
    for (const role of ALL_ROLES) {
      const roleRows = allRows.filter(r => r._child?.role === role);
      if (roleRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(clean(roleRows)), ROLE_LABELS[role]);
    }
    const noRoleRows = allRows.filter(r => !r._child?.role);
    if (noRoleRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(clean(noRoleRows)), "Non défini");
    XLSX.writeFile(wb, `KidsTime_${dateStr}_${project.name}.xlsx`);
  } else {
    const blob = new Blob(["\uFEFF" + toCsv(allRows)], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `KidsTime_${dateStr}_${project.name}.csv`; a.click();
    URL.revokeObjectURL(url);
  }
}

function exportDayToPDF(project: Project, dateStr: string) {
  const day = project.shootingDays[dateStr]; if (!day) return;
  const dateLabel = new Date(dateStr + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const childTable = (row: any) => {
    const { _child: child, _session: session, _stats: stats, _maxWork: maxWork, _maxAmp: maxAmp, _vacation: vacation, _band: band } = row;
    const workOver = stats ? Math.max(0, stats.workMin - maxWork) : 0;
    const ampOver  = stats ? Math.max(0, stats.amplitudeMin - maxAmp) : 0;
    const breakSlotsStr = stats?.breakSlots.map((b: any) => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)}${b.valid ? "" : " ⚠"})`).join("<br>") || "--";
    return `<table>
      <tr><th colspan="4">${child.first_name} ${child.last_name}${child.role ? ` — ${ROLE_LABELS[child.role as ChildRole]}` : ""} — ${getAge(child.dob)} ans (${band} ans) — ${vacation ? "Vacances" : "Scolaire"}</th></tr>
      <tr>
        <td><b>Heure de convocation</b><br>${session?.start_time ? formatTime(session.start_time) : "--"}</td>
        <td><b>Heure de fin</b><br>${session?.end_time ? formatTime(session.end_time) : "--"}</td>
        <td><b>Amplitude de présence</b><br>${stats ? formatMinutes(stats.amplitudeMin) : "--"}</td>
        <td><b>Amplitude autorisée</b><br>${formatMinutes(maxAmp)}</td>
      </tr>
      <tr>
        <td><b>Durée totale de travail</b><br>${stats ? formatMinutes(stats.workMin) : "--"}</td>
        <td><b>Temps autorisé</b><br>${formatMinutes(maxWork)}</td>
        <td><b>Dépassement travail</b><br><span class="${workOver > 0 ? "over" : "ok"}">${workOver > 0 ? formatMinutes(workOver) : "OK"}</span></td>
        <td><b>Dépassement amplitude</b><br><span class="${ampOver > 0 ? "over" : "ok"}">${ampOver > 0 ? formatMinutes(ampOver) : "OK"}</span></td>
      </tr>
      <tr>
        <td><b>Durée totale des pauses</b><br>${stats ? formatMinutes(stats.breakMin) : "--"}</td>
        <td><b>Pauses valides</b><br>${stats ? formatMinutes(stats.validBreakMin) : "--"}</td>
        <td colspan="2"><b>Plages horaires des pauses</b><br>${breakSlotsStr}</td>
      </tr>
    </table>`;
  };
  const allRows = buildExportRows(project, dateStr);
  let html = `<html><head><meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; font-size: 11px; color: #111; padding: 20px; }
    h1 { font-size: 18px; margin-bottom: 4px; } h2 { font-size: 13px; color: #444; margin-bottom: 16px; font-weight: normal; }
    h3 { font-size: 12px; color: #1e3a5f; border-bottom: 2px solid #1e3a5f; padding-bottom: 4px; margin: 20px 0 10px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th { background: #1e3a5f; color: white; padding: 7px 8px; text-align: left; font-size: 10px; }
    td { padding: 6px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
    tr:nth-child(even) td { background: #f8fafc; }
    .over { color: #dc2626; font-weight: bold; } .ok { color: #16a34a; }
    .footer { margin-top: 30px; font-size: 9px; color: #999; text-align: center; }
  </style></head><body>
  <h1>KidsTime — Récapitulatif journée</h1>
  <h2>${dateLabel} &nbsp;·&nbsp; ${project.name}</h2>`;
  for (const role of ALL_ROLES) {
    const roleRows = allRows.filter(r => r._child?.role === role);
    if (roleRows.length > 0) { html += `<h3>${ROLE_LABELS[role]} (${roleRows.length})</h3>`; html += roleRows.map(childTable).join(""); }
  }
  const noRoleRows = allRows.filter(r => !r._child?.role);
  if (noRoleRows.length > 0) { html += `<h3>Statut non défini (${noRoleRows.length})</h3>`; html += noRoleRows.map(childTable).join(""); }
  html += `<div class="footer">Généré par KidsTime · Éléonore Aguillon · ACMA Fiction · ${new Date().toLocaleDateString("fr-FR")}</div></body></html>`;
  const w = window.open("", "_blank");
  if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 500); }
}

// ─── UI Primitives ────────────────────────────────────────────────────────────
type BadgeColor = "green" | "red" | "amber" | "blue" | "slate" | "purple" | "cyan" | "orange";

function Badge({ children, color = "slate" }: { children: React.ReactNode; color?: BadgeColor }) {
  const cls: Record<BadgeColor, string> = {
    green:  "bg-emerald-900/40 text-emerald-300 border-emerald-700",
    red:    "bg-red-900/40 text-red-300 border-red-700",
    amber:  "bg-amber-900/40 text-amber-300 border-amber-700",
    blue:   "bg-blue-900/40 text-blue-300 border-blue-700",
    slate:  "bg-slate-700/60 text-slate-300 border-slate-600",
    purple: "bg-purple-900/40 text-purple-300 border-purple-700",
    cyan:   "bg-cyan-900/40 text-cyan-300 border-cyan-700",
    orange: "bg-orange-900/40 text-orange-300 border-orange-700",
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${cls[color]}`}>{children}</span>;
}

function RoleBadge({ role }: { role?: ChildRole }) {
  if (!role) return null;
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${ROLE_COLORS[role]}`}>{ROLE_LABELS[role]}</span>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-[#0c1420] border border-slate-700 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-slate-700/60">
          <h2 className="text-base font-bold text-white">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl leading-none">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function TextInput({ label, required: req, ...props }: { label?: string; required?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label className="text-[10px] text-slate-400 uppercase tracking-[0.15em] font-semibold flex items-center gap-1">
          {label}
          {/* Fix #4: show required indicator */}
          {req && <span className="text-red-400">*</span>}
        </label>
      )}
      <input required={req} className="bg-slate-800/80 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors placeholder:text-slate-600" {...props} />
    </div>
  );
}

type BtnVariant = "primary" | "secondary" | "danger" | "ghost";

function Btn({ children, variant = "primary", className = "", ...props }: { children: React.ReactNode; variant?: BtnVariant; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const v: Record<BtnVariant, string> = {
    primary:   "bg-blue-600 hover:bg-blue-500 text-white",
    secondary: "bg-slate-700 hover:bg-slate-600 text-white",
    danger:    "bg-red-800 hover:bg-red-700 text-white",
    ghost:     "text-slate-400 hover:text-white border border-slate-700 hover:border-slate-500",
  };
  return <button className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${v[variant]} ${className}`} {...props}>{children}</button>;
}

// ═════════════════════════════════════════════════════════════════════════════
// ROOT
// ═════════════════════════════════════════════════════════════════════════════
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

// ═════════════════════════════════════════════════════════════════════════════
// AUTH
// ═════════════════════════════════════════════════════════════════════════════
function AuthPage({ onAuth }: { onAuth: (s: any) => void }) {
  const [mode, setMode]       = useState<"login" | "signup">("login");
  const [email, setEmail]     = useState("");
  const [pass, setPass]       = useState("");
  const [error, setError]     = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(""); setLoading(true);
    try {
      if (mode === "login") {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password: pass });
        if (error) throw error; onAuth(data.session);
      } else {
        const { error } = await supabase.auth.signUp({ email, password: pass });
        if (error) throw error;
        setError("✅ Compte créé ! Vérifiez votre e-mail puis connectez-vous."); setMode("login");
      }
    } catch (err: any) { setError(err.message); }
    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-[#080d16] flex flex-col items-center justify-center px-4" style={{ fontFamily: "'DM Mono', monospace" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap" rel="stylesheet" />
      <div className="fixed inset-0 opacity-[0.025]" style={{ backgroundImage: "linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)", backgroundSize: "40px 40px" }} />
      <div className="relative z-10 mb-10 text-center">
        <div className="text-[10px] text-blue-400 tracking-[0.4em] uppercase mb-2">Audiovisuel · Mineurs</div>
        <h1 className="text-6xl font-extrabold tracking-tight" style={{ fontFamily: "Syne, sans-serif" }}><span className="text-white">KIDS</span><span className="text-blue-500">TIME</span></h1>
        <div className="mt-6 max-w-sm mx-auto text-slate-400 text-sm leading-relaxed border-t border-slate-800 pt-5">
          Bonjour et bienvenue sur cet outil de travail dédié aux coachs et aux responsables enfants qui exercent dans l&apos;audiovisuel.
          <div className="mt-3 text-blue-400 font-semibold text-xs tracking-wider">Éléonore Aguillon · ACMA Fiction</div>
        </div>
      </div>
      <div className="relative z-10 w-full max-w-sm bg-slate-900/70 border border-slate-700 rounded-2xl p-7 backdrop-blur">
        <div className="flex mb-6 bg-slate-800 rounded-xl p-1">
          {(["login", "signup"] as const).map(m => (
            <button key={m} onClick={() => { setMode(m); setError(""); }} className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${mode === m ? "bg-blue-600 text-white" : "text-slate-400 hover:text-white"}`}>
              {m === "login" ? "Connexion" : "Créer un compte"}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="space-y-4">
          <TextInput label="Adresse e-mail" type="email" placeholder="vous@exemple.com" value={email} onChange={e => setEmail(e.target.value)} required />
          <TextInput label="Mot de passe" type="password" placeholder="••••••••" value={pass} onChange={e => setPass(e.target.value)} required />
          {error && <div className={`text-xs px-3 py-2 rounded-lg ${error.startsWith("✅") ? "bg-emerald-900/40 text-emerald-300" : "bg-red-900/40 text-red-300"}`}>{error}</div>}
          <button type="submit" disabled={loading} className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-3 rounded-xl font-bold text-sm transition-colors">
            {loading ? "Chargement…" : mode === "login" ? "Se connecter" : "Créer mon compte"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═════════════════════════════════════════════════════════════════════════════
function MainApp({ session, onSignOut }: { session: any; onSignOut: () => void }) {
  const [view, setView]             = useState<"home" | "project" | "shooting">("home");
  const [projects, setProjects]     = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);
  const userId = session.user.id;

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
    return { ...proj, children: children || [], groups: groups || [], shootingDays };
  }

  async function openProject(id: string) {
    setLoading(true); const f = await loadFullProject(id);
    setActiveProject(f); setView("project"); setLoading(false);
  }

  // Fix #2: use setActiveProject directly after insert to ensure UI refresh
  async function refreshActive(projectId?: string) {
    const id = projectId || activeProject?.id;
    if (!id) return;
    const f = await loadFullProject(id);
    setActiveProject(f);
  }

  async function createProject(name: string) {
    const { data } = await supabase.from("projects").insert({ user_id: userId, name, rules: DEFAULT_RULES }).select().single();
    if (data) { await loadProjects(); openProject(data.id); }
  }

  async function deleteProject(id: string) { await supabase.from("projects").delete().eq("id", id); loadProjects(); }

  async function addChild(child: { fullName: string; dob: string; vacationPeriods: VacationPeriod[]; role?: ChildRole }) {
    const { firstName, lastName } = splitFullName(child.fullName);
    const { error } = await supabase.from("children").insert({
      project_id: activeProject!.id, first_name: firstName, last_name: lastName,
      dob: child.dob, vacation_periods: child.vacationPeriods || [], role: child.role || null,
    });
    if (!error) await refreshActive();
  }

  // Fix #2: ensure refreshActive is awaited and state is updated before displaying
  async function addChildren(children: { firstName: string; lastName: string; dob: string; vacationPeriods: VacationPeriod[]; role?: ChildRole }[]) {
    if (children.length === 0) return;
    const rows = children.map(c => ({
      project_id: activeProject!.id,
      first_name: c.firstName,
      last_name:  c.lastName,
      dob:        c.dob,
      vacation_periods: c.vacationPeriods || [],
      role: c.role || null,
    }));
    const { error } = await supabase.from("children").insert(rows);
    if (error) { console.error("Import error:", error); throw error; }
    // Fix #2: force full reload of project to get all newly inserted children
    await refreshActive();
  }

  async function updateChild(id: string, data: { fullName: string; dob: string; vacationPeriods: VacationPeriod[]; role?: ChildRole }) {
    const { firstName, lastName } = splitFullName(data.fullName);
    await supabase.from("children").update({
      first_name: firstName, last_name: lastName, dob: data.dob,
      vacation_periods: data.vacationPeriods || [], role: data.role || null,
    }).eq("id", id);
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
    if (!day) {
      const { data } = await supabase.from("shooting_days").insert({ project_id: activeProject!.id, date: dateStr, child_ids: [], sessions: {} }).select().single();
      day = data as ShootingDay;
    }
    return day;
  }

  async function updateDaySessions(dateStr: string, sessions: Record<string, Session>) {
    const day = await getOrCreateDay(dateStr);
    await supabase.from("shooting_days").update({ sessions }).eq("id", day.id);
    await refreshActive();
  }

  async function toggleChildOnDay(dateStr: string, childId: string) {
    const day = await getOrCreateDay(dateStr);
    const ids = day.child_ids || [];
    const newIds = ids.includes(childId) ? ids.filter(i => i !== childId) : [...ids, childId];
    await supabase.from("shooting_days").update({ child_ids: newIds }).eq("id", day.id);
    await refreshActive();
  }

  async function addGroupToDay(dateStr: string, groupId: string) {
    const group = activeProject!.groups.find(g => g.id === groupId); if (!group) return;
    const day = await getOrCreateDay(dateStr);
    const ids = [...new Set([...(day.child_ids || []), ...group.child_ids])];
    await supabase.from("shooting_days").update({ child_ids: ids }).eq("id", day.id);
    await refreshActive();
  }

  async function removeGroupFromDay(dateStr: string, groupId: string) {
    const group = activeProject!.groups.find(g => g.id === groupId); if (!group) return;
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const ids = (day.child_ids || []).filter(id => !group.child_ids.includes(id));
    await supabase.from("shooting_days").update({ child_ids: ids }).eq("id", day.id);
    await refreshActive();
  }

  async function startSessionsSequentially(dateStr: string, childIds: string[], timeISO?: string) {
    const day = await getOrCreateDay(dateStr);
    const sessions = { ...(day.sessions || {}) };
    let changed = false;
    for (const childId of childIds) {
      if (!sessions[childId]?.start_time) {
        sessions[childId] = { start_time: timeISO || nowISO(), events: [], status: "working" };
        changed = true;
      }
    }
    if (!changed) return;
    await supabase.from("shooting_days").update({ sessions }).eq("id", day.id);
    await refreshActive();
  }

  async function startSession(dateStr: string, childId: string, timeISO?: string) {
    await startSessionsSequentially(dateStr, [childId], timeISO);
  }

  async function cancelSession(dateStr: string, childId: string) {
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const sessions = { ...(day.sessions || {}) }; delete sessions[childId];
    await updateDaySessions(dateStr, sessions);
  }

  async function applyEventToChildren(dateStr: string, childIds: string[], eventType: "pause_start" | "pause_end", timeISO?: string) {
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const sessions = { ...(day.sessions || {}) };
    for (const childId of childIds) {
      const s = sessions[childId];
      if (!s?.start_time || s.status === "done") continue;
      if (eventType === "pause_start" && s.status !== "working") continue;
      if (eventType === "pause_end"   && s.status !== "paused")  continue;
      sessions[childId] = { ...s, status: eventType === "pause_start" ? "paused" : "working", events: [...(s.events || []), { type: eventType, time: timeISO || nowISO() }] };
    }
    await updateDaySessions(dateStr, sessions);
  }

  async function cancelLastEvent(dateStr: string, childId: string) {
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const sessions = { ...(day.sessions || {}) };
    const s = { ...sessions[childId] }; if (!s?.events?.length) return;
    const events = [...s.events]; events.pop();
    const lastEv = events[events.length - 1];
    let status: Session["status"] = "working";
    if (lastEv?.type === "pause_start") status = "paused";
    sessions[childId] = { ...s, events, status, end_time: undefined };
    await updateDaySessions(dateStr, sessions);
  }

  async function endSessions(dateStr: string, childIds: string[], timeISO?: string) {
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const sessions = { ...(day.sessions || {}) };
    for (const childId of childIds) {
      const s = sessions[childId]; if (!s?.start_time || s.status === "done") continue;
      const events = [...(s.events || [])];
      if (s.status === "paused") events.push({ type: "pause_end", time: timeISO || nowISO() });
      sessions[childId] = { ...s, end_time: timeISO || nowISO(), status: "done", events };
    }
    await updateDaySessions(dateStr, sessions);
  }

  async function reopenSession(dateStr: string, childId: string) {
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const sessions = { ...(day.sessions || {}) };
    sessions[childId] = { ...sessions[childId], status: "working", end_time: undefined };
    await updateDaySessions(dateStr, sessions);
  }

  async function editEventTime(dateStr: string, childId: string, eventIndex: number, newTimeISO: string) {
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const sessions = { ...(day.sessions || {}) };
    const s = { ...sessions[childId] }; const events = [...(s.events || [])];
    events[eventIndex] = { ...events[eventIndex], time: newTimeISO };
    s.events = events; sessions[childId] = s;
    await updateDaySessions(dateStr, sessions);
  }

  async function editStartTime(dateStr: string, childId: string, newTimeISO: string) {
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const sessions = { ...(day.sessions || {}) };
    sessions[childId] = { ...sessions[childId], start_time: newTimeISO };
    await updateDaySessions(dateStr, sessions);
  }

  async function editEndTime(dateStr: string, childId: string, newTimeISO: string) {
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const sessions = { ...(day.sessions || {}) };
    sessions[childId] = { ...sessions[childId], end_time: newTimeISO };
    await updateDaySessions(dateStr, sessions);
  }

  const Fonts = () => <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap" rel="stylesheet" />;

  if (loading && view === "home") return <div className="min-h-screen bg-[#080d16] flex items-center justify-center"><Fonts /><div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;

  if (view === "home") return <><Fonts /><HomeView projects={projects} userEmail={session.user.email} onCreate={createProject} onOpen={openProject} onDelete={deleteProject} onSignOut={onSignOut} /></>;
  if (view === "project" && activeProject) return <><Fonts /><ProjectView project={activeProject} onBack={() => { setView("home"); loadProjects(); }} onAddChild={addChild} onAddChildren={addChildren} onUpdateChild={updateChild} onRemoveChild={removeChild} onAddGroup={addGroup} onUpdateGroup={updateGroup} onRemoveGroup={removeGroup} onUpdateRules={updateRules} onOpenDay={date => { setActiveDate(date); setView("shooting"); }} /></>;
  if (view === "shooting" && activeProject && activeDate) return <><Fonts /><ShootingView
    project={activeProject} dateStr={activeDate}
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

// ═════════════════════════════════════════════════════════════════════════════
// HOME VIEW
// ═════════════════════════════════════════════════════════════════════════════
function HomeView({ projects, userEmail, onCreate, onOpen, onDelete, onSignOut }: { projects: Project[]; userEmail: string; onCreate: (n: string) => void; onOpen: (id: string) => void; onDelete: (id: string) => void; onSignOut: () => void }) {
  const [name, setName] = useState("");
  return (
    <div className="min-h-screen bg-[#080d16] text-white" style={{ fontFamily: "'DM Mono', monospace" }}>
      <div className="fixed inset-0 opacity-[0.025]" style={{ backgroundImage: "linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)", backgroundSize: "40px 40px" }} />
      <div className="relative max-w-2xl mx-auto px-6 py-14">
        <div className="flex items-start justify-between mb-12">
          <div>
            <div className="text-[10px] text-blue-400 tracking-[0.35em] uppercase mb-2">Gestion des mineurs · Audiovisuel</div>
            <h1 className="text-5xl font-extrabold tracking-tight" style={{ fontFamily: "Syne, sans-serif" }}><span className="text-white">KIDS</span><span className="text-blue-500">TIME</span></h1>
          </div>
          <div className="text-right mt-2">
            <div className="text-xs text-slate-500 mb-1">{userEmail}</div>
            <button onClick={onSignOut} className="text-xs text-slate-500 hover:text-red-400 transition-colors">Déconnexion</button>
          </div>
        </div>
        <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-6 mb-8">
          <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-3">Nouvelle production</div>
          <div className="flex gap-3">
            <input className="flex-1 bg-slate-800 border border-slate-600 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 placeholder:text-slate-600"
              placeholder="Titre du film ou de la série…" value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && name.trim() && (onCreate(name.trim()), setName(""))} />
            <Btn onClick={() => { if (name.trim()) { onCreate(name.trim()); setName(""); } }} className="px-6">Créer</Btn>
          </div>
        </div>
        {projects.length === 0
          ? <div className="text-center text-slate-600 py-16 text-sm">Aucun projet — créez votre première production</div>
          : <div className="space-y-3">
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Mes productions</div>
            {projects.map(p => (
              <div key={p.id} className="flex items-center gap-3 bg-slate-900/50 border border-slate-700 rounded-xl px-5 py-4 hover:border-blue-700/60 transition-colors group cursor-pointer" onClick={() => onOpen(p.id)}>
                <div className="flex-1">
                  <div className="font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>{p.name}</div>
                  <div className="text-xs text-slate-500">{new Date(p.created_at).toLocaleDateString("fr-FR")}</div>
                </div>
                <button onClick={e => { e.stopPropagation(); onDelete(p.id); }} className="text-slate-600 hover:text-red-400 text-lg transition-colors opacity-0 group-hover:opacity-100">✕</button>
              </div>
            ))}
          </div>
        }
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PROJECT VIEW
// ═════════════════════════════════════════════════════════════════════════════
function ProjectView({ project, onBack, onAddChild, onAddChildren, onUpdateChild, onRemoveChild, onAddGroup, onUpdateGroup, onRemoveGroup, onUpdateRules, onOpenDay }: {
  project: Project; onBack: () => void;
  onAddChild: (c: any) => void; onAddChildren: (cs: any[]) => Promise<void>;
  onUpdateChild: (id: string, d: any) => void; onRemoveChild: (id: string) => void;
  onAddGroup: (name: string) => void; onUpdateGroup: (id: string, d: any) => void; onRemoveGroup: (id: string) => void;
  onUpdateRules: (fn: (r: Rules) => Rules) => void; onOpenDay: (date: string) => void;
}) {
  const [tab, setTab]           = useState<"calendar" | "children" | "groups" | "settings">("calendar");
  const [childModal, setChildModal] = useState<Child | "new" | null>(null);
  const [groupModal, setGroupModal] = useState<Group | "new" | null>(null);
  const tabs = [{ id: "calendar", label: "📅 Calendrier" }, { id: "children", label: "👦 Enfants" }, { id: "groups", label: "👥 Groupes" }, { id: "settings", label: "⚙️ Paramètres" }];
  return (
    <div className="min-h-screen bg-[#080d16] text-white" style={{ fontFamily: "'DM Mono', monospace" }}>
      <div className="border-b border-slate-800 px-6 py-4 flex items-center gap-4">
        <button onClick={onBack} className="text-slate-400 hover:text-white text-sm">← Productions</button>
        <h1 className="text-xl font-extrabold" style={{ fontFamily: "Syne, sans-serif" }}>{project.name}</h1>
        <div className="ml-auto text-xs text-slate-500">{project.children.length} enfant(s) · {Object.keys(project.shootingDays).length} jour(s)</div>
      </div>
      <div className="border-b border-slate-800 px-6">
        <div className="flex gap-1 -mb-px">
          {tabs.map(t => <button key={t.id} onClick={() => setTab(t.id as any)} className={`px-4 py-3 text-sm transition-colors border-b-2 ${tab === t.id ? "border-blue-500 text-white" : "border-transparent text-slate-500 hover:text-slate-300"}`}>{t.label}</button>)}
        </div>
      </div>
      <div className="max-w-4xl mx-auto px-6 py-8">
        {tab === "calendar" && <CalendarTab project={project} onOpenDay={onOpenDay} />}
        {tab === "children" && <ChildrenTab project={project} onAdd={() => setChildModal("new")} onEdit={c => setChildModal(c)} onRemove={onRemoveChild} onImport={onAddChildren} />}
        {tab === "groups"   && <GroupsTab project={project} onAdd={() => setGroupModal("new")} onRemove={onRemoveGroup} onUpdateGroup={onUpdateGroup} />}
        {tab === "settings" && <SettingsTab rules={project.rules} onUpdateRules={onUpdateRules} />}
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

// ─── Calendar Tab ─────────────────────────────────────────────────────────────
function CalendarTab({ project, onOpenDay }: { project: Project; onOpenDay: (d: string) => void }) {
  const [cur, setCur] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const y = cur.getFullYear(), m = cur.getMonth();
  const firstDay = (new Date(y, m, 1).getDay() + 6) % 7, daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const MN = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
  const DN = ["Lun","Mar","Mer","Jeu","Ven","Sam","Dim"];
  function ds(d: number) { return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <button onClick={() => setCur(new Date(y, m - 1, 1))} className="text-slate-400 hover:text-white w-9 h-9 rounded-lg border border-slate-700 hover:border-slate-500 flex items-center justify-center">‹</button>
        <h2 className="font-bold text-lg" style={{ fontFamily: "Syne, sans-serif" }}>{MN[m]} {y}</h2>
        <button onClick={() => setCur(new Date(y, m + 1, 1))} className="text-slate-400 hover:text-white w-9 h-9 rounded-lg border border-slate-700 hover:border-slate-500 flex items-center justify-center">›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 mb-1">{DN.map(d => <div key={d} className="text-center text-[10px] text-slate-500 py-1 uppercase tracking-wider">{d}</div>)}</div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (!d) return <div key={i} />;
          const s = ds(d);
          const dayData = project.shootingDays[s];
          const validChildIds = (dayData?.child_ids || []).filter(id => project.children.find(c => c.id === id));
          const count = validChildIds.length, isShoot = count > 0, isToday = s === todayStr();
          return (
            <button key={i} onClick={() => onOpenDay(s)} className={`rounded-xl py-3 text-sm transition-all ${isShoot ? "bg-blue-900/50 border border-blue-600 text-blue-200 hover:bg-blue-800/60" : "bg-slate-900/40 border border-slate-800 text-slate-400 hover:border-slate-600 hover:text-white"} ${isToday ? "ring-2 ring-blue-400" : ""}`}>
              <div className="font-bold">{d}</div>
              {isShoot && <div className="text-[10px] text-blue-400 mt-0.5">{count} 👦</div>}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-slate-600 mt-4 text-center">Cliquez sur une date pour ouvrir la journée de tournage</p>
    </div>
  );
}

// ─── Children Tab — Fix #1 (role tabs) + Fix #2 (display after import) + Fix #3 (name import) + Fix #5 (role detection)
function ChildrenTab({ project, onAdd, onEdit, onRemove, onImport }: { project: Project; onAdd: () => void; onEdit: (c: Child) => void; onRemove: (id: string) => void; onImport: (cs: any[]) => Promise<void> }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg]         = useState("");
  const [importPreview, setImportPreview] = useState<any[]>([]);
  const [showPreview, setShowPreview]     = useState(false);
  const [importing, setImporting]         = useState(false);

  // Fix #1: role tabs in children list
  const [roleTab, setRoleTab] = useState<ChildRole | "all">("all");
  const rolesPresent = ALL_ROLES.filter(r => project.children.some(c => c.role === r));
  const filteredChildren = roleTab === "all" ? project.children : project.children.filter(c => c.role === roleTab);

  function downloadTemplate() {
    // Fix #3 + #5: template with Nom Prénom + Statut columns
    const csv = "Nom Prénom;Statut (role/silhouette/figurant);Date de naissance (JJ/MM/AAAA);Début vacances (JJ/MM/AAAA);Fin vacances (JJ/MM/AAAA)\nMartin Léa;role;15/03/2015;01/07/2025;31/08/2025\n";
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a"); a.href = url; a.download = "modele_enfants_kidstime.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    setImportMsg("Lecture du fichier…"); setShowPreview(false);
    try {
      let rows: any[] = [];
      if (file.name.endsWith(".csv") || file.name.endsWith(".txt")) {
        const text  = await file.text();
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        const sep   = lines[0].includes(";") ? ";" : ",";
        const headers = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, ""));
        for (let i = 1; i < lines.length; i++) {
          const vals = lines[i].split(sep).map(v => v.trim().replace(/^"|"$/g, ""));
          const row: any = {};
          headers.forEach((h, idx) => { row[h] = vals[idx] || ""; });
          rows.push(row);
        }
      } else {
        const XLSX = await import("xlsx");
        const buf  = await file.arrayBuffer();
        const wb   = XLSX.read(buf, { type: "array" });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { raw: true, defval: "" });
      }

      if (rows.length === 0) { setImportMsg("❌ Fichier vide."); return; }

      const headers = Object.keys(rows[0] || {});

      // Fix #3: detect name columns
      const fullCol = guessColumn(headers, ["nom prenom", "nom prénom", "prenom nom", "prénom nom", "nom et prenom", "full name", "fullname", "nom complet", "name"]);
      const fnCol   = guessColumn(headers, ["prenom", "prénom", "firstname", "first name", "first"]);
      const lnCol   = guessColumn(headers, ["nom", "lastname", "last name", "last"]);
      const dobCol  = guessColumn(headers, ["naissance", "date de naissance", "dob", "birth", "birthdate", "date naissance"]);
      const vs      = guessColumn(headers, ["debut vacances", "début vacances", "vacances debut", "start vacances", "debut vac"]);
      const ve      = guessColumn(headers, ["fin vacances", "vacances fin", "end vacances", "fin vac"]);
      // Fix #5: detect statut column
      const statCol = guessColumn(headers, ["statut", "status", "role", "rôle", "type"]);

      const parsed = rows.map(r => {
        // Fix #3: name handling
        let fullName = "";

        if (fullCol && String(r[fullCol] || "").trim()) {
          // Single column — keep entire value as fullName
          fullName = String(r[fullCol]).trim();
        } else if (fnCol && lnCol) {
          // Two separate columns — join with space
          const fn = String(r[fnCol] || "").trim();
          const ln = String(r[lnCol] || "").trim();
          fullName = [fn, ln].filter(Boolean).join(" ");
        } else if (fnCol) {
          fullName = String(r[fnCol] || "").trim();
        } else if (lnCol) {
          fullName = String(r[lnCol] || "").trim();
        } else {
          // Fallback: first non-empty column value
          const firstVal = Object.values(r).find(v => String(v || "").trim() !== "");
          fullName = String(firstVal || "").trim();
        }

        // Fix #3: split into firstName/lastName for DB
        const { firstName, lastName } = splitFullName(fullName);

        // Fix #5: detect role from statut column
        const role = statCol ? detectRole(String(r[statCol] || "")) : undefined;

        return {
          firstName,
          lastName,
          fullName, // for preview display
          dob: dobCol ? parseExcelDate(r[dobCol]) : "",
          vacationPeriods: (vs && ve && r[vs] && r[ve]) ? [{ start: parseExcelDate(r[vs]), end: parseExcelDate(r[ve]) }] : [],
          role,
        };
      }).filter(c => c.firstName && c.dob);

      if (parsed.length === 0) { setImportMsg("❌ Aucun enfant valide trouvé. Vérifiez que les colonnes Nom Prénom et Date de naissance sont remplies."); return; }
      setImportPreview(parsed);
      setShowPreview(true);
      setImportMsg(`✅ ${parsed.length} enfant(s) détecté(s) — vérifiez l'aperçu ci-dessous`);
    } catch (err) {
      console.error(err);
      setImportMsg("❌ Erreur de lecture. Vérifiez le format du fichier.");
    }
    e.target.value = "";
  }

  // Fix #2: await import and show error if it fails
  async function confirmImport() {
    setImporting(true);
    try {
      await onImport(importPreview);
      setShowPreview(false); setImportPreview([]);
      setImportMsg(`✅ ${importPreview.length} enfant(s) importé(s) avec succès !`);
    } catch {
      setImportMsg("❌ Erreur lors de l'import. Réessayez.");
    }
    setImporting(false);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-bold text-lg" style={{ fontFamily: "Syne, sans-serif" }}>Enfants ({project.children.length})</h2>
        <Btn onClick={onAdd}>+ Ajouter</Btn>
      </div>

      {/* Import zone */}
      <div className="bg-slate-900/40 border border-slate-700 rounded-xl p-4 mb-5">
        <div className="text-xs text-slate-400 uppercase tracking-wider mb-1">Import depuis un fichier Excel / CSV</div>
        <div className="text-[10px] text-slate-500 mb-3">
          Colonnes : <span className="text-slate-300">Nom Prénom</span> (ou Prénom + Nom séparés) · <span className="text-slate-300">Date de naissance</span> · <span className="text-slate-300">Statut</span> (optionnel)
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          <button onClick={downloadTemplate} className="text-xs text-blue-400 hover:text-blue-300 border border-blue-800/60 hover:border-blue-600 px-3 py-1.5 rounded-lg transition-colors">⬇ Télécharger le modèle CSV</button>
          <button onClick={() => fileRef.current?.click()} className="text-xs text-emerald-400 hover:text-emerald-300 border border-emerald-800/60 hover:border-emerald-600 px-3 py-1.5 rounded-lg transition-colors">📂 Importer un fichier (.xlsx / .csv)</button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.txt" className="hidden" onChange={handleFile} />
        </div>
        {importMsg && <div className={`text-xs mb-2 ${importMsg.startsWith("✅") ? "text-emerald-400" : "text-red-400"}`}>{importMsg}</div>}
        {showPreview && importPreview.length > 0 && (
          <div className="mt-3 bg-slate-800/60 rounded-xl p-3">
            <div className="text-xs text-slate-400 mb-2">Aperçu — vérifiez avant d&apos;importer :</div>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {importPreview.map((c, i) => (
                <div key={i} className="text-xs flex gap-3 items-center flex-wrap">
                  {/* Fix #3: show full name as imported */}
                  <span className="text-white font-semibold">{c.firstName} {c.lastName}</span>
                  <span className="text-slate-500">{c.dob}</span>
                  {/* Fix #5: show detected role */}
                  {c.role && <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${ROLE_COLORS[c.role as ChildRole]}`}>{ROLE_LABELS[c.role as ChildRole]}</span>}
                  {c.vacationPeriods.length > 0 && <span className="text-amber-400">🌴 {c.vacationPeriods[0].start} → {c.vacationPeriods[0].end}</span>}
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <button onClick={() => { setShowPreview(false); setImportMsg(""); }} className="text-xs text-slate-400 hover:text-white">Annuler</button>
              <button onClick={confirmImport} disabled={importing} className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg">
                {importing ? "Import en cours…" : `Confirmer l'import (${importPreview.length})`}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Fix #1: Role tabs in children list */}
      {project.children.length > 0 && rolesPresent.length > 0 && (
        <div className="flex gap-1 mb-4 border-b border-slate-800">
          <button onClick={() => setRoleTab("all")}
            className={`px-4 py-2 text-sm transition-colors border-b-2 ${roleTab === "all" ? "border-blue-500 text-white" : "border-transparent text-slate-500 hover:text-slate-300"}`}>
            Tous ({project.children.length})
          </button>
          {rolesPresent.map(r => (
            <button key={r} onClick={() => setRoleTab(r)}
              className={`px-4 py-2 text-sm transition-colors border-b-2 ${roleTab === r ? "border-blue-500 text-white" : "border-transparent text-slate-500 hover:text-slate-300"}`}>
              {ROLE_LABELS[r]} ({project.children.filter(c => c.role === r).length})
            </button>
          ))}
          {project.children.some(c => !c.role) && (
            <button onClick={() => setRoleTab("all")}
              className={`px-4 py-2 text-sm transition-colors border-b-2 border-transparent text-slate-500 hover:text-slate-300`}>
              Sans statut ({project.children.filter(c => !c.role).length})
            </button>
          )}
        </div>
      )}

      {project.children.length === 0
        ? <div className="text-slate-500 text-center py-12 text-sm">Aucun enfant enregistré</div>
        : filteredChildren.length === 0
          ? <div className="text-slate-500 text-center py-8 text-sm">Aucun enfant dans cette catégorie</div>
          : <div className="space-y-3">{filteredChildren.map(c => (
            <div key={c.id} className="flex items-center gap-4 bg-slate-900/50 border border-slate-700 rounded-xl px-5 py-4">
              {/* Fix #1: visual role indicator on left border */}
              {c.role && <div className={`w-1 self-stretch rounded-full flex-shrink-0 ${c.role === "role" ? "bg-purple-500" : c.role === "silhouette" ? "bg-cyan-500" : "bg-orange-500"}`} />}
              <div className="w-10 h-10 rounded-full bg-blue-900/60 flex items-center justify-center text-blue-300 font-bold text-sm flex-shrink-0">{c.first_name?.[0]}{c.last_name?.[0]}</div>
              <div className="flex-1">
                <div className="font-semibold text-white">{c.first_name} {c.last_name}</div>
                <div className="text-xs text-slate-400">{getAge(c.dob)} ans · tranche {getAgeBand(c.dob)} ans</div>
                {c.vacation_periods?.length > 0 && <div className="text-xs text-amber-400 mt-0.5">{c.vacation_periods.length} période(s) de vacances</div>}
              </div>
              {/* Fix #1: role badge always visible */}
              <div className="flex gap-1.5 flex-wrap justify-end">
                <Badge color="blue">{getAgeBand(c.dob)} ans</Badge>
                {c.role ? <RoleBadge role={c.role} /> : <span className="text-[10px] text-slate-500">—</span>}
              </div>
              <button onClick={() => onEdit(c)} className="text-slate-400 hover:text-white">✏️</button>
              <button onClick={() => onRemove(c.id)} className="text-slate-500 hover:text-red-400">✕</button>
            </div>
          ))}</div>
      }
    </div>
  );
}

// ─── Groups Tab ───────────────────────────────────────────────────────────────
function GroupsTab({ project, onAdd, onRemove, onUpdateGroup }: { project: Project; onAdd: () => void; onRemove: (id: string) => void; onUpdateGroup: (id: string, d: any) => void }) {
  const [editing, setEditing]         = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [nameValue, setNameValue]     = useState("");

  const childGroupMap: Record<string, string[]> = {};
  for (const g of project.groups) {
    for (const cid of g.child_ids || []) {
      if (!childGroupMap[cid]) childGroupMap[cid] = [];
      childGroupMap[cid].push(g.name);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-bold text-lg" style={{ fontFamily: "Syne, sans-serif" }}>Groupes ({project.groups.length})</h2>
        <Btn onClick={onAdd}>+ Créer un groupe</Btn>
      </div>
      {project.groups.length === 0 ? <div className="text-slate-500 text-center py-12 text-sm">Aucun groupe</div> :
        <div className="space-y-4">{project.groups.map(g => {
          const memberCount = (g.child_ids || []).filter(id => project.children.find(c => c.id === id)).length;
          return (
            <div key={g.id} className="bg-slate-900/50 border border-slate-700 rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                {editingName === g.id ? (
                  <div className="flex items-center gap-2 flex-1 mr-3">
                    <input value={nameValue} onChange={e => setNameValue(e.target.value)}
                      className="flex-1 bg-slate-800 border border-blue-500 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none"
                      onKeyDown={e => { if (e.key === "Enter" && nameValue.trim()) { onUpdateGroup(g.id, { name: nameValue.trim() }); setEditingName(null); } if (e.key === "Escape") setEditingName(null); }}
                      autoFocus />
                    <button onClick={() => { if (nameValue.trim()) { onUpdateGroup(g.id, { name: nameValue.trim() }); setEditingName(null); } }} className="text-emerald-400 hover:text-emerald-300 text-sm">✓</button>
                    <button onClick={() => setEditingName(null)} className="text-slate-400 hover:text-white text-sm">✕</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-white">{g.name} <span className="text-slate-400 font-normal text-sm">({memberCount})</span></h3>
                    <button onClick={() => { setEditingName(g.id); setNameValue(g.name); }} className="text-slate-500 hover:text-slate-300 text-xs" title="Renommer">✏️</button>
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={() => setEditing(editing === g.id ? null : g.id)} className="text-slate-400 hover:text-white text-sm px-2 py-1 rounded border border-slate-600 hover:border-slate-400">
                    {editing === g.id ? "✓ Fermer" : "👥 Membres"}
                  </button>
                  <button onClick={() => onRemove(g.id)} className="text-slate-500 hover:text-red-400">✕</button>
                </div>
              </div>
              {editing === g.id && (
                <div className="mb-4 bg-slate-800/50 rounded-xl p-3">
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-2">Sélectionner les enfants du groupe</div>
                  {project.children.length === 0
                    ? <div className="text-xs text-slate-500">Aucun enfant dans le projet</div>
                    : <div className="space-y-1">
                      {project.children.map(c => {
                        const isInThisGroup = (g.child_ids || []).includes(c.id);
                        const otherGroups = (childGroupMap[c.id] || []).filter(gn => gn !== g.name);
                        return (
                          <label key={c.id} className="flex items-center gap-3 cursor-pointer hover:bg-slate-700/50 px-2 py-1.5 rounded-lg">
                            <input type="checkbox" className="accent-blue-500 w-4 h-4" checked={isInThisGroup}
                              onChange={e => onUpdateGroup(g.id, { child_ids: e.target.checked ? [...(g.child_ids || []), c.id] : (g.child_ids || []).filter((i: string) => i !== c.id) })} />
                            <span className="text-sm text-slate-200 flex-1">{c.first_name} {c.last_name}</span>
                            <div className="flex gap-1 flex-wrap">
                              <Badge color="blue">{getAgeBand(c.dob)} ans</Badge>
                              {c.role && <RoleBadge role={c.role} />}
                              {otherGroups.map(gn => (
                                <span key={gn} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-600/60 text-slate-300 border border-slate-500">👥 {gn}</span>
                              ))}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  }
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {(g.child_ids || []).map((id: string) => { const c = project.children.find(ch => ch.id === id); return c ? <Badge key={id} color="slate">{c.first_name} {c.last_name}</Badge> : null; })}
                {!g.child_ids?.length && <span className="text-xs text-slate-500">Aucun membre</span>}
              </div>
            </div>
          );
        })}</div>
      }
    </div>
  );
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────
function SettingsTab({ rules, onUpdateRules }: { rules: Rules; onUpdateRules: (fn: (r: Rules) => Rules) => void }) {
  function setRule(path: string, value: string) {
    onUpdateRules(r => {
      const copy = JSON.parse(JSON.stringify(r)); const keys = path.split(".");
      let obj: any = copy; for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
      obj[keys[keys.length - 1]] = Number(value); return copy;
    });
  }
  const BL: Record<AgeBand, string> = { "0-2": "Moins de 3 ans", "3-5": "3 à 5 ans", "6-11": "6 à 11 ans", "12-16": "12 à 16 ans" };
  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-bold text-lg mb-1" style={{ fontFamily: "Syne, sans-serif" }}>Paramètres DRIEETS</h2>
        <p className="text-xs text-slate-500 mb-6">Modifiables par production selon accord ou dérogation</p>
        <div className="space-y-3 mb-8">
          {([["Amplitude horaire max", "maxAmplitudeMinutes", 60, 720, 30], ["Pause minimum (en-dessous = travail)", "minBreakMinutes", 5, 60, 1], ["Repos entre deux journées", "minRestBetweenDays", 480, 1440, 30]] as const).map(([label, key, min, max, step]) => (
            <div key={key} className="bg-slate-900/50 border border-slate-700 rounded-xl p-4 flex items-center justify-between">
              <div className="text-sm text-white">{label}</div>
              <div className="flex items-center gap-2">
                <input type="number" min={min} max={max} step={step} value={(rules as any)[key]} onChange={e => setRule(key, e.target.value)} className="w-20 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-white text-sm text-center" />
                <span className="text-xs text-slate-400">min ({formatMinutes((rules as any)[key])})</span>
              </div>
            </div>
          ))}
        </div>
        {(["maxWorkMinutes", "mandatoryBreakAfterMinutes"] as const).map(rk => (
          <div key={rk} className="mb-6">
            <h3 className="text-xs font-semibold text-slate-300 mb-3 uppercase tracking-wider">{rk === "maxWorkMinutes" ? "Temps de travail max" : "Pause obligatoire après"}</h3>
            <div className="space-y-2">
              {AGE_BANDS.map(band => (
                <div key={band} className="bg-slate-900/50 border border-slate-700 rounded-xl p-4">
                  <div className="font-semibold text-white text-sm mb-3">{BL[band]}</div>
                  <div className="grid grid-cols-2 gap-4">
                    {(["school", "vacation"] as const).map(p => (
                      <div key={p}>
                        <label className="text-xs text-slate-400 block mb-1">{p === "school" ? "🏫 Scolaire" : "🌴 Vacances"}</label>
                        <div className="flex items-center gap-2">
                          <input type="number" min="15" max="720" step="15" value={rules[rk][band][p]} onChange={e => setRule(`${rk}.${band}.${p}`, e.target.value)} className="w-20 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-white text-sm text-center" />
                          <span className="text-xs text-slate-500">{formatMinutes(rules[rk][band][p])}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Child Form Modal — Fix #4 (required fields) ──────────────────────────────
function ChildFormModal({ child, onSave, onClose }: { child: Child | null; onSave: (d: any) => void; onClose: () => void }) {
  const [form, setForm] = useState({
    fullName: child ? `${child.first_name} ${child.last_name}`.trim() : "",
    dob:      child?.dob || "",
    vacationPeriods: child?.vacation_periods || [] as VacationPeriod[],
    role: (child?.role || "") as ChildRole | "",
  });
  const [newVac, setNewVac] = useState({ start: "", end: "" });
  const [error, setError]   = useState("");

  function handleSave() {
    // Fix #4: validate required fields
    if (!form.fullName.trim()) { setError("Le prénom et nom sont obligatoires."); return; }
    if (!form.dob) { setError("La date de naissance est obligatoire."); return; }
    setError("");
    onSave({ ...form, role: form.role || undefined });
  }

  return (
    <Modal title={child ? "Modifier l'enfant" : "Ajouter un enfant"} onClose={onClose}>
      <div className="space-y-4">
        {/* Fix #4: required indicator */}
        <TextInput label="Prénom Nom" required value={form.fullName} onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))} placeholder="Ex: Léa Martin" />
        <TextInput label="Date de naissance" required type="date" value={form.dob} onChange={e => setForm(f => ({ ...f, dob: e.target.value }))} />
        {form.dob && <div className="bg-blue-900/30 border border-blue-700/60 rounded-lg px-4 py-2 text-sm text-blue-300">{getAge(form.dob)} ans · Tranche DRIEETS : {getAgeBand(form.dob)} ans</div>}

        {/* Fix #4: statut is optional */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-400 uppercase tracking-[0.15em] font-semibold">
            Statut <span className="text-slate-600 normal-case font-normal">(optionnel)</span>
          </label>
          <div className="flex gap-2 flex-wrap">
            {(["", "role", "silhouette", "figurant"] as const).map(r => (
              <button key={r} type="button"
                onClick={() => setForm(f => ({ ...f, role: r as ChildRole | "" }))}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${form.role === r
                  ? r === "" ? "bg-slate-600 border-slate-500 text-white" : ROLE_COLORS[r as ChildRole]
                  : "bg-slate-800 border-slate-600 text-slate-400 hover:text-white"}`}>
                {r === "" ? "Non défini" : ROLE_LABELS[r as ChildRole]}
              </button>
            ))}
          </div>
        </div>

        {/* Fix #4: vacances is optional */}
        <div>
          <label className="text-[10px] text-slate-400 uppercase tracking-wider block mb-2">
            Périodes de vacances <span className="text-slate-600 normal-case font-normal">(optionnel)</span>
          </label>
          {form.vacationPeriods.map((p, i) => (
            <div key={i} className="flex items-center gap-2 mb-1 text-sm text-slate-300">
              <span>{p.start} → {p.end}</span>
              <button onClick={() => setForm(f => ({ ...f, vacationPeriods: f.vacationPeriods.filter((_, j) => j !== i) }))} className="text-red-400">✕</button>
            </div>
          ))}
          <div className="flex gap-2 items-end mt-2">
            <TextInput label="Début" type="date" value={newVac.start} onChange={e => setNewVac(v => ({ ...v, start: e.target.value }))} />
            <TextInput label="Fin"   type="date" value={newVac.end}   onChange={e => setNewVac(v => ({ ...v, end: e.target.value }))} />
            <button onClick={() => { if (newVac.start && newVac.end) { setForm(f => ({ ...f, vacationPeriods: [...f.vacationPeriods, newVac] })); setNewVac({ start: "", end: "" }); } }} className="bg-slate-700 hover:bg-slate-600 text-white px-3 rounded-lg h-9 text-sm">+</button>
          </div>
        </div>

        {error && <div className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">{error}</div>}

        <div className="text-[10px] text-slate-500">Les champs marqués <span className="text-red-400">*</span> sont obligatoires</div>

        <Btn className="w-full justify-center" onClick={handleSave}>
          {child ? "Enregistrer" : "Ajouter l'enfant"}
        </Btn>
      </div>
    </Modal>
  );
}

function GroupFormModal({ group, onSave, onClose }: { group: Group | null; onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(group?.name || "");
  return (
    <Modal title={group ? "Modifier le groupe" : "Créer un groupe"} onClose={onClose}>
      <div className="space-y-4">
        <TextInput label="Nom du groupe" value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Scène 12, Les petits…" />
        <Btn className="w-full justify-center" onClick={() => name.trim() && onSave(name.trim())}>{group ? "Enregistrer" : "Créer"}</Btn>
      </div>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SHOOTING VIEW
// ═════════════════════════════════════════════════════════════════════════════
function ShootingView({ project, dateStr, onBack, onStartSessions, onStartSession, onCancelSession, onApplyEvent, onCancelLastEvent, onEndSessions, onReopenSession, onToggleChild, onAddGroup, onRemoveGroup, onEditEventTime, onEditStartTime, onEditEndTime, onExportXLSX, onExportPDF }: {
  project: Project; dateStr: string; onBack: () => void;
  onStartSessions: (cids: string[], t?: string) => void;
  onStartSession: (cid: string, t?: string) => void;
  onCancelSession: (cid: string) => void;
  onApplyEvent: (cids: string[], type: "pause_start" | "pause_end", t?: string) => void;
  onCancelLastEvent: (cid: string) => void;
  onEndSessions: (cids: string[], t?: string) => void;
  onReopenSession: (cid: string) => void;
  onToggleChild: (cid: string) => void;
  onAddGroup: (gid: string) => void;
  onRemoveGroup: (gid: string) => void;
  onEditEventTime: (cid: string, idx: number, t: string) => void;
  onEditStartTime: (cid: string, t: string) => void;
  onEditEndTime: (cid: string, t: string) => void;
  onExportXLSX: () => void;
  onExportPDF: () => void;
}) {
  const [, setTick]             = useState(0);
  const [addingChildren, setAdding] = useState(false);
  const [selected, setSelected]     = useState<Set<string>>(new Set());
  const [actionModal, setActionModal] = useState<{ type: "start" | "pause" | "resume" | "end" } | null>(null);
  const [search, setSearch]         = useState("");
  const [roleTab, setRoleTab]       = useState<ChildRole | "all">("all");

  useEffect(() => { const t = setInterval(() => setTick(n => n + 1), 15000); return () => clearInterval(t); }, []);

  const day      = project.shootingDays[dateStr] || { child_ids: [], sessions: {} };
  const childIds = day.child_ids || [];
  const sessions = day.sessions || {};
  const rules    = project.rules;
  const dateLabel = new Date(dateStr + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  const childrenInDay = childIds.map(id => project.children.find(c => c.id === id)).filter(Boolean) as Child[];
  const rolesPresent  = ALL_ROLES.filter(r => childrenInDay.some(c => c.role === r));

  const filteredIds = childIds.filter(id => {
    const c = project.children.find(ch => ch.id === id); if (!c) return false;
    if (search.trim()) {
      const q = normalize(search);
      if (!normalize(`${c.first_name} ${c.last_name}`).includes(q) && !normalize(`${c.last_name} ${c.first_name}`).includes(q)) return false;
    }
    if (roleTab === "all") return true;
    return c.role === roleTab;
  });

  function toggleSelect(id: string) { setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  const selList   = [...selected];
  const canStart  = selList.some(id => !sessions[id]?.start_time);
  const canPause  = selList.some(id => sessions[id]?.status === "working");
  const canResume = selList.some(id => sessions[id]?.status === "paused");
  const canEnd    = selList.some(id => sessions[id]?.start_time && sessions[id]?.status !== "done");

  return (
    <div className="min-h-screen bg-[#080d16] text-white" style={{ fontFamily: "'DM Mono', monospace" }}>
      <div className="border-b border-slate-800 px-6 py-4 flex items-center gap-4">
        <button onClick={onBack} className="text-slate-400 hover:text-white text-sm">← {project.name}</button>
        <div className="flex-1">
          <h1 className="text-lg font-extrabold capitalize" style={{ fontFamily: "Syne, sans-serif" }}>{dateLabel}</h1>
          <div className="text-xs text-slate-400">{childIds.length} enfant(s) · {selected.size} sélectionné(s)</div>
        </div>
        <div className="flex gap-2">
          <button onClick={onExportXLSX} className="text-xs text-emerald-400 hover:text-emerald-300 border border-emerald-800/60 hover:border-emerald-600 px-3 py-1.5 rounded-lg transition-colors">⬇ Excel</button>
          <button onClick={onExportPDF}  className="text-xs text-blue-400 hover:text-blue-300 border border-blue-800/60 hover:border-blue-600 px-3 py-1.5 rounded-lg transition-colors">⬇ PDF</button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="mb-5">
          <button onClick={() => setAdding(v => !v)} className="text-sm text-blue-400 hover:text-blue-300 border border-blue-800/60 hover:border-blue-600 px-4 py-2 rounded-lg transition-colors">
            {addingChildren ? "✕ Fermer" : "+ Gérer les enfants de la journée"}
          </button>
          {addingChildren && (
            <div className="mt-3 bg-slate-900/60 border border-slate-700 rounded-xl p-5">
              {project.groups.length > 0 && (
                <div className="mb-4">
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-2">Groupes — ajouter ou retirer en entier</div>
                  <div className="space-y-2">
                    {project.groups.map(g => {
                      const groupInDay = g.child_ids.length > 0 && g.child_ids.every(id => childIds.includes(id));
                      const groupPartial = !groupInDay && g.child_ids.some(id => childIds.includes(id));
                      return (
                        <div key={g.id} className="flex items-center gap-2">
                          <button onClick={() => onAddGroup(g.id)}
                            className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${groupInDay ? "bg-blue-900/50 border-blue-600 text-blue-300" : "bg-slate-800 border-slate-600 text-slate-300 hover:border-blue-600 hover:text-blue-300"}`}>
                            + {g.name} ({g.child_ids?.length || 0})
                            {groupPartial && <span className="text-amber-400 text-xs ml-1">partiel</span>}
                          </button>
                          {(groupInDay || groupPartial) && (
                            <button onClick={() => onRemoveGroup(g.id)} className="text-xs text-red-400 hover:text-red-300 border border-red-800/60 hover:border-red-600 px-2 py-1.5 rounded-lg transition-colors">− Retirer</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-2">Individuellement</div>
              {project.children.map(c => (
                <label key={c.id} className="flex items-center gap-3 cursor-pointer hover:bg-slate-800 px-3 py-2 rounded-lg">
                  <input type="checkbox" className="accent-blue-500" checked={childIds.includes(c.id)} onChange={() => onToggleChild(c.id)} />
                  <span className="text-sm text-slate-200">{c.first_name} {c.last_name}</span>
                  <Badge color="blue">{getAgeBand(c.dob)} ans</Badge>
                  {c.role && <RoleBadge role={c.role} />}
                </label>
              ))}
            </div>
          )}
        </div>

        {childIds.length > 0 && (
          <div className="mb-4">
            <input type="text" placeholder="🔍 Rechercher un enfant…" value={search} onChange={e => setSearch(e.target.value)}
              className="w-full bg-slate-800/60 border border-slate-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 placeholder:text-slate-500 transition-colors" />
          </div>
        )}

        {childIds.length > 0 && rolesPresent.length > 0 && (
          <div className="flex gap-1 mb-5 border-b border-slate-800">
            <button onClick={() => setRoleTab("all")} className={`px-4 py-2 text-sm transition-colors border-b-2 ${roleTab === "all" ? "border-blue-500 text-white" : "border-transparent text-slate-500 hover:text-slate-300"}`}>
              Tous ({childrenInDay.length})
            </button>
            {rolesPresent.map(r => (
              <button key={r} onClick={() => setRoleTab(r)} className={`px-4 py-2 text-sm transition-colors border-b-2 ${roleTab === r ? "border-blue-500 text-white" : "border-transparent text-slate-500 hover:text-slate-300"}`}>
                {ROLE_LABELS[r]} ({childrenInDay.filter(c => c.role === r).length})
              </button>
            ))}
          </div>
        )}

        {childIds.length > 0 && (
          <div className="bg-slate-900/60 border border-slate-700 rounded-xl px-5 py-3 mb-5 flex flex-wrap items-center gap-3">
            <span className="text-xs text-slate-400 font-semibold">Sélection :</span>
            <button onClick={() => setSelected(new Set(childIds))} className="text-xs text-blue-400 hover:text-blue-300">Tous</button>
            <button onClick={() => setSelected(new Set(filteredIds))} className="text-xs text-slate-400 hover:text-white">Vue actuelle</button>
            <button onClick={() => setSelected(new Set())} className="text-xs text-slate-500 hover:text-white">Aucun</button>
            {project.groups.map(g => (
              <button key={g.id} onClick={() => setSelected(s => { const n = new Set(s); (g.child_ids || []).forEach(id => n.add(id)); return n; })} className="text-xs text-slate-400 hover:text-white border border-slate-700 hover:border-slate-500 px-2 py-0.5 rounded">
                {g.name}
              </button>
            ))}
            <div className="flex-1" />
            {selected.size > 0 && <>
              {canStart  && <Btn variant="secondary" className="text-xs py-1.5 !bg-emerald-900/50 !text-emerald-300 border border-emerald-800" onClick={() => setActionModal({ type: "start" })}>▶ Démarrer</Btn>}
              {canPause  && <Btn variant="secondary" className="text-xs py-1.5 !bg-amber-900/50 !text-amber-300 border border-amber-800" onClick={() => setActionModal({ type: "pause" })}>⏸ Pause</Btn>}
              {canResume && <Btn variant="secondary" className="text-xs py-1.5 !bg-emerald-900/50 !text-emerald-300 border border-emerald-800" onClick={() => setActionModal({ type: "resume" })}>▶ Reprendre</Btn>}
              {canEnd    && <Btn variant="secondary" className="text-xs py-1.5" onClick={() => setActionModal({ type: "end" })}>⏹ Terminer</Btn>}
            </>}
          </div>
        )}

        {childIds.length === 0
          ? <div className="text-slate-500 text-center py-16 text-sm">Ajoutez des enfants à cette journée</div>
          : filteredIds.length === 0
            ? <div className="text-slate-500 text-center py-8 text-sm">Aucun résultat{search ? ` pour "${search}"` : ""}</div>
            : <div className="space-y-4">
              {filteredIds.map(id => {
                const child = project.children.find(c => c.id === id); if (!child) return null;
                const session    = sessions[id];
                const vacation   = isVacation(child, dateStr);
                const band       = getAgeBand(child.dob);
                const period: Period = vacation ? "vacation" : "school";
                const maxWork    = rules.maxWorkMinutes[band][period];
                const breakAfter = rules.mandatoryBreakAfterMinutes[band][period];
                const stats      = computeSessionStats(session, rules);
                return <ChildCard key={id} child={child} session={session} stats={stats} maxWork={maxWork} breakAfter={breakAfter} maxAmplitude={rules.maxAmplitudeMinutes} vacation={vacation}
                  isSelected={selected.has(id)} onSelect={() => toggleSelect(id)}
                  onStart={t => onStartSession(id, t)}
                  onCancelSession={() => onCancelSession(id)}
                  onCancelLastEvent={() => onCancelLastEvent(id)}
                  onReopenSession={() => onReopenSession(id)}
                  onEditEventTime={(idx, t) => onEditEventTime(id, idx, t)}
                  onEditStartTime={t => onEditStartTime(id, t)}
                  onEditEndTime={t => onEditEndTime(id, t)}
                  dateStr={dateStr} />;
              })}
            </div>
        }
      </div>

      {actionModal && <TimeActionModal type={actionModal.type} childCount={selected.size} dateStr={dateStr}
        onConfirm={timeISO => {
          const ids = [...selected];
          if      (actionModal.type === "start")  onStartSessions(ids, timeISO);
          else if (actionModal.type === "pause")  onApplyEvent(ids, "pause_start", timeISO);
          else if (actionModal.type === "resume") onApplyEvent(ids, "pause_end", timeISO);
          else if (actionModal.type === "end")    onEndSessions(ids, timeISO);
          setActionModal(null);
        }}
        onClose={() => setActionModal(null)} />}
    </div>
  );
}

function TimeActionModal({ type, childCount, dateStr, onConfirm, onClose }: { type: string; childCount: number; dateStr: string; onConfirm: (t: string) => void; onClose: () => void }) {
  const now = new Date();
  const [timeStr, setTimeStr] = useState(`${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
  const labels: Record<string, string> = { start: "Démarrer la journée", pause: "Mise en pause", resume: "Reprise du travail", end: "Fin de journée" };
  return (
    <Modal title={labels[type]} onClose={onClose}>
      <div className="space-y-5">
        <div className="bg-slate-800/60 rounded-xl px-4 py-3 text-sm text-slate-300">
          Action appliquée à <span className="text-white font-bold">{childCount} enfant(s)</span> sélectionné(s)
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-slate-400 uppercase tracking-wider">Heure de l&apos;événement</label>
          <input type="time" value={timeStr} onChange={e => setTimeStr(e.target.value)} className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-3 text-white text-2xl text-center focus:outline-none focus:border-blue-500" />
          <div className="text-xs text-slate-500 mt-1">Modifiez si l&apos;événement a eu lieu avant que vous ne le renseigniez</div>
        </div>
        <div className="flex gap-3">
          <Btn variant="ghost" className="flex-1" onClick={onClose}>Annuler</Btn>
          <button onClick={() => onConfirm(timeStrToISO(dateStr, timeStr))} className="flex-1 py-2.5 rounded-xl font-bold text-sm bg-blue-600 hover:bg-blue-500 text-white transition-colors">
            Confirmer — {timeStr}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ChildCard({ child, session, stats, maxWork, breakAfter, maxAmplitude, vacation, isSelected, onSelect, onStart, onCancelSession, onCancelLastEvent, onReopenSession, onEditEventTime, onEditStartTime, onEditEndTime, dateStr }: {
  child: Child; session: Session | undefined; stats: SessionStats | null;
  maxWork: number; breakAfter: number; maxAmplitude: number; vacation: boolean;
  isSelected: boolean; onSelect: () => void;
  onStart: (t?: string) => void; onCancelSession: () => void; onCancelLastEvent: () => void; onReopenSession: () => void;
  onEditEventTime: (idx: number, t: string) => void; onEditStartTime: (t: string) => void; onEditEndTime: (t: string) => void;
  dateStr: string;
}) {
  const [editingIdx, setEditingIdx] = useState<number | "start" | "end" | null>(null);
  const [editTime, setEditTime]     = useState("");
  const band     = getAgeBand(child.dob);
  const workPct  = stats ? Math.min(100, (stats.workMin / maxWork) * 100) : 0;
  const ampPct   = stats ? Math.min(100, (stats.amplitudeMin / maxAmplitude) * 100) : 0;
  const workCrit = stats && stats.workMin >= maxWork, workWarn = stats && stats.workMin >= maxWork * 0.8;
  const ampCrit  = stats && stats.amplitudeMin >= maxAmplitude, ampWarn = stats && stats.amplitudeMin >= maxAmplitude * 0.85;
  const breakDue = stats?.timeSinceBreak != null && stats.timeSinceBreak >= breakAfter;

  function startEdit(key: number | "start" | "end", iso: string | undefined) { setEditingIdx(key); setEditTime(isoToTimeStr(iso)); }
  function confirmEdit() {
    const iso = timeStrToISO(dateStr, editTime);
    if (editingIdx === "start") onEditStartTime(iso);
    else if (editingIdx === "end") onEditEndTime(iso);
    else onEditEventTime(editingIdx as number, iso);
    setEditingIdx(null);
  }
  const events = session?.events || [];

  return (
    <div className={`rounded-2xl p-5 border transition-all ${isSelected ? "border-blue-500 bg-blue-950/30" : workCrit || ampCrit ? "border-red-700 bg-slate-900/60" : breakDue ? "border-amber-600 bg-slate-900/60" : "border-slate-700 bg-slate-900/50"}`}>
      <div className="flex items-start gap-3 mb-4">
        <button onClick={onSelect} className={`mt-1 w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${isSelected ? "bg-blue-600 border-blue-500" : "border-slate-600"}`}>
          {isSelected && <span className="text-white text-xs leading-none">✓</span>}
        </button>
        <div className="w-10 h-10 rounded-full bg-blue-900/60 flex items-center justify-center text-blue-300 font-bold text-sm flex-shrink-0">
          {child.first_name?.[0]}{child.last_name?.[0]}
        </div>
        <div className="flex-1">
          <div className="font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>{child.first_name} {child.last_name}</div>
          <div className="flex flex-wrap gap-1.5 mt-1">
            <Badge color="blue">{getAge(child.dob)} ans · {band} ans</Badge>
            <Badge color={vacation ? "amber" : "slate"}>{vacation ? "🌴 Vacances" : "🏫 Scolaire"}</Badge>
            {child.role && <RoleBadge role={child.role} />}
            {session?.status === "working" && <Badge color="green">● Travail</Badge>}
            {session?.status === "paused"  && <Badge color="amber">⏸ Pause</Badge>}
            {session?.status === "done"    && <Badge color="slate">✓ Terminé</Badge>}
          </div>
        </div>
        <div className="text-right text-[10px] text-slate-500">
          <div>Max : {formatMinutes(maxWork)}</div>
          <div>Pause / {formatMinutes(breakAfter)}</div>
          <div>Ampl. {formatMinutes(maxAmplitude)}</div>
        </div>
      </div>

      {stats && (
        <>
          <div className="grid grid-cols-3 gap-2 mb-4">
            {([{ l: "Travail", v: stats.workMin, max: maxWork, crit: workCrit, warn: workWarn }, { l: "Pauses valides", v: stats.validBreakMin, sub: `tot. ${formatMinutes(stats.breakMin)}` }, { l: "Amplitude", v: stats.amplitudeMin, max: maxAmplitude, crit: ampCrit, warn: ampWarn }] as any[]).map(({ l, v, max, sub, crit, warn }) => (
              <div key={l} className={`rounded-xl p-3 text-center border ${crit ? "bg-red-900/30 border-red-800" : warn ? "bg-amber-900/20 border-amber-800" : "bg-slate-800/50 border-slate-700"}`}>
                <div className={`text-xl font-bold ${crit ? "text-red-400" : warn ? "text-amber-400" : "text-white"}`}>{formatMinutes(v)}</div>
                <div className="text-[10px] text-slate-400">{l}</div>
                {max && <div className={`text-[10px] mt-0.5 ${crit ? "text-red-400" : "text-slate-500"}`}>/ {formatMinutes(max)}</div>}
                {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
              </div>
            ))}
          </div>
          <div className="space-y-1.5 mb-4">
            {([{ l: "Travail", p: workPct, crit: workCrit, warn: workWarn }, { l: "Amplitude", p: ampPct, crit: ampCrit, warn: ampWarn }] as any[]).map(({ l, p, crit, warn }) => (
              <div key={l}>
                <div className="flex justify-between text-[10px] text-slate-500 mb-0.5"><span>{l}</span><span>{Math.round(p)}%</span></div>
                <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden"><div className={`h-full rounded-full transition-all duration-700 ${crit ? "bg-red-500" : warn ? "bg-amber-500" : "bg-blue-500"}`} style={{ width: `${p}%` }} /></div>
              </div>
            ))}
          </div>
          {breakDue && !workCrit && <div className="bg-amber-900/30 border border-amber-700 rounded-lg px-3 py-2 text-xs text-amber-300 mb-3">⚠️ Pause obligatoire — {formatMinutes(stats.timeSinceBreak)} consécutifs (seuil : {formatMinutes(breakAfter)})</div>}
          {workCrit && <div className="bg-red-900/30 border border-red-700 rounded-lg px-3 py-2 text-xs text-red-300 mb-3">🚫 Temps de travail maximum atteint</div>}
          {ampCrit  && <div className="bg-red-900/30 border border-red-700 rounded-lg px-3 py-2 text-xs text-red-300 mb-3">🚫 Amplitude maximale atteinte</div>}
          <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-3 mb-3">
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Chronologie — cliquez une heure pour modifier</div>
            <div className="space-y-1.5">
              <TimelineRow label="▶ Début" iso={session?.start_time} isEditing={editingIdx === "start"} editTime={editTime} onEdit={() => startEdit("start", session?.start_time)} onTimeChange={setEditTime} onConfirm={confirmEdit} onCancel={() => setEditingIdx(null)} />
              {events.map((ev, i) => (
                <TimelineRow key={i} label={ev.type === "pause_start" ? "⏸ Pause" : "▶ Reprise"} iso={ev.time} isEditing={editingIdx === i} editTime={editTime} onEdit={() => startEdit(i, ev.time)} onTimeChange={setEditTime} onConfirm={confirmEdit} onCancel={() => setEditingIdx(null)} />
              ))}
              {session?.end_time && (
                <TimelineRow label="⏹ Fin" iso={session.end_time} isEditing={editingIdx === "end"} editTime={editTime} onEdit={() => startEdit("end", session.end_time)} onTimeChange={setEditTime} onConfirm={confirmEdit} onCancel={() => setEditingIdx(null)} />
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {session?.status !== "done" && events.length > 0 && (
              <button onClick={onCancelLastEvent} className="text-xs text-amber-400 hover:text-amber-300 border border-amber-800/60 hover:border-amber-600 px-3 py-1.5 rounded-lg transition-colors">↩ Annuler dernière action</button>
            )}
            {session?.start_time && session?.status !== "done" && (
              <button onClick={onCancelSession} className="text-xs text-red-400 hover:text-red-300 border border-red-800/60 hover:border-red-600 px-3 py-1.5 rounded-lg transition-colors">🗑 Réinitialiser</button>
            )}
            {session?.status === "done" && (
              <button onClick={onReopenSession} className="text-xs text-blue-400 hover:text-blue-300 border border-blue-800/60 hover:border-blue-600 px-3 py-1.5 rounded-lg transition-colors">↩ Rouvrir la journée</button>
            )}
          </div>
        </>
      )}
      {!session?.start_time && <SingleStartButton onStart={onStart} dateStr={dateStr} />}
      {session?.status === "done" && <div className="text-center text-emerald-400 text-sm font-semibold mt-3">✓ Journée terminée</div>}
    </div>
  );
}
function TimelineRow({ label, iso, isEditing, editTime, onEdit, onTimeChange, onConfirm, onCancel }: { label: string; iso: string | undefined; isEditing: boolean; editTime: string; onEdit: () => void; onTimeChange: (t: string) => void; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-slate-400 w-20 flex-shrink-0">{label}</span>
      {isEditing ? (
        <>
          <input type="time" value={editTime} onChange={e => onTimeChange(e.target.value)} className="bg-slate-700 border border-blue-500 rounded px-2 py-0.5 text-white text-xs w-24" />
          <button onClick={onConfirm} className="text-emerald-400 hover:text-emerald-300">✓</button>
          <button onClick={onCancel}  className="text-slate-500 hover:text-white">✕</button>
        </>
      ) : (
        <button onClick={onEdit} className="text-blue-300 hover:text-blue-200 hover:underline underline-offset-2">{formatTime(iso)}</button>
      )}
    </div>
  );
}

function SingleStartButton({ onStart, dateStr }: { onStart: (t?: string) => void; dateStr: string }) {
  const now = new Date();
  const def = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const [open, setOpen]       = useState(false);
  const [timeStr, setTimeStr] = useState(def);
  if (!open) return <button onClick={() => setOpen(true)} className="w-full bg-emerald-700 hover:bg-emerald-600 text-white py-2.5 rounded-xl font-semibold text-sm transition-colors">▶ Démarrer la journée</button>;
  return (
    <div className="bg-slate-800/60 border border-slate-600 rounded-xl p-4 space-y-3">
      <div className="text-xs text-slate-400">Heure de début :</div>
      <input type="time" value={timeStr} onChange={e => setTimeStr(e.target.value)} className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2.5 text-white text-xl text-center focus:outline-none focus:border-blue-500" />
      <div className="flex gap-2">
        <Btn variant="ghost" className="flex-1" onClick={() => setOpen(false)}>Annuler</Btn>
        <button onClick={() => onStart(timeStrToISO(dateStr, timeStr))} className="flex-1 bg-emerald-700 hover:bg-emerald-600 text-white py-2 rounded-xl font-bold text-sm transition-colors">Démarrer à {timeStr}</button>
      </div>
    </div>
  );
}
