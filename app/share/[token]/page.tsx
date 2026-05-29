"use client";

import { useState, useEffect, use } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  ROLE_LABELS, ROLE_COLORS, ALL_ROLES,
  getAge, getAgeBand, formatMinutes, formatTime, isVacation,
  computeSessionStats, buildExportRows,
  exportDayToXLSX, exportDayToPDF, exportChildAllDays,
  exportProjectGlobal, exportProjectGlobalPDF,
  type Project, type Child, type ShootingDay, type ChildRole,
} from "@/components/child-actor-scheduler";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ─── Helpers ──────────────────────────────────────────────────────────────────
const ROLE_ORDER: Record<string, number> = { role: 0, silhouette: 1, figurant: 2 };
function sortByRoleThenAlpha(cs: Child[]): Child[] {
  return [...cs].sort((a, b) => {
    const ra = ROLE_ORDER[a.role ?? ""] ?? 3, rb = ROLE_ORDER[b.role ?? ""] ?? 3;
    if (ra !== rb) return ra - rb;
    return `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, "fr");
  });
}

// Normalize the RPC payload into the exact host `Project` shape so that the
// shared export functions and stats computations behave identically.
function normalizeProject(data: any): Project {
  const shootingDays: Record<string, ShootingDay> = {};
  (data.shooting_days || []).forEach((d: any) => { shootingDays[d.date] = d; });
  const children = (data.children || []).map((c: any) => ({ ...c, role: c.role ?? c.child_role ?? undefined }));
  return { ...data, children, groups: data.groups || [], shootingDays } as Project;
}

// ─── Per-child detail card (mirrors the host ChildCard info) ──────────────────
function ChildDetailRow({ row, dateStr }: { row: any; dateStr: string }) {
  const { _child: child, _session: session, _stats: stats, _maxWork: maxWork, _maxAmp: maxAmp, _vacation: vacation, _band: band } = row;
  const role = child.role as ChildRole | undefined;
  const workOver = stats ? Math.max(0, stats.workMin - maxWork) : 0;
  const ampOver = stats ? Math.max(0, stats.amplitudeMin - maxAmp) : 0;
  const pauseSlots = stats?.breakSlots.filter((b: any) => b.kind === "pause") || [];
  const dejeunerSlots = stats?.breakSlots.filter((b: any) => b.kind === "dejeuner") || [];

  return (
    <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-3">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="font-semibold text-white text-sm">{child.first_name} {child.last_name}</span>
        {role && <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${ROLE_COLORS[role]}`}>{ROLE_LABELS[role]}</span>}
        <span className="text-[10px] text-slate-500">{getAge(child.dob)} ans · {band} · {vacation ? "🌴 Vacances" : "🏫 Scolaire"}</span>
      </div>
      {!stats ? (
        <div className="text-xs text-slate-500">Pas de session enregistrée</div>
      ) : (
        <div className="space-y-1.5 text-xs">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <div className="text-slate-400">Convocation <span className="text-white font-mono">{session?.start_time ? formatTime(session.start_time) : "--"}</span></div>
            <div className="text-slate-400">Fin <span className="text-white font-mono">{session?.end_time ? formatTime(session.end_time) : "--"}</span></div>
            <div className="text-slate-400">Travail <span className={`font-mono ${workOver > 0 ? "text-red-400 font-bold" : "text-blue-300"}`}>{formatMinutes(stats.workMin)}</span> <span className="text-slate-600">/ {formatMinutes(maxWork)}</span></div>
            <div className="text-slate-400">Amplitude <span className={`font-mono ${ampOver > 0 ? "text-red-400 font-bold" : stats.amplitudeMin === maxAmp ? "text-orange-400" : "text-orange-300"}`}>{formatMinutes(stats.amplitudeMin)}</span> <span className="text-slate-600">/ {formatMinutes(maxAmp)}</span></div>
            <div className="text-slate-400">🍽 Déjeuner <span className="text-yellow-300 font-mono">{formatMinutes(stats.dejeunerMin)}</span></div>
            <div className="text-slate-400">Pauses valides <span className="text-green-300 font-mono">{formatMinutes(stats.validBreakMin)}</span></div>
          </div>
          {(workOver > 0 || ampOver > 0) && (
            <div className="flex gap-2 flex-wrap pt-1">
              {workOver > 0 && <span className="text-[10px] bg-red-900/40 border border-red-700 text-red-300 px-2 py-0.5 rounded-full">🚫 Dépass. travail {formatMinutes(workOver)}</span>}
              {ampOver > 0 && <span className="text-[10px] bg-red-900/40 border border-red-700 text-red-300 px-2 py-0.5 rounded-full">🚫 Dépass. amplitude {formatMinutes(ampOver)}</span>}
            </div>
          )}
          {dejeunerSlots.length > 0 && (
            <div className="text-[10px] text-slate-500">Plages déjeuner : {dejeunerSlots.map((b: any) => `${formatTime(b.start)}-${formatTime(b.end)}`).join(", ")}</div>
          )}
          {pauseSlots.length > 0 && (
            <div className="text-[10px] text-slate-500">Plages pauses : {pauseSlots.map((b: any) => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)}${b.valid ? "" : " ✗"})`).join(", ")}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── CalendarTab ──────────────────────────────────────────────────────────────
function CalendarTab({ project }: { project: Project }) {
  const days = Object.values(project.shootingDays).sort((a, b) => a.date.localeCompare(b.date));
  const firstDay = days[0]?.date;
  const initMonth = firstDay ? firstDay.slice(0, 7) : new Date().toISOString().slice(0, 7);
  const [curMonth, setCurMonth] = useState(initMonth);
  const [openDate, setOpenDate] = useState<string | null>(null);

  const [year, month] = curMonth.split("-").map(Number);
  const firstDow = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const startOffset = (firstDow + 6) % 7;
  const shootingDates = new Set(days.map(d => d.date));
  const monthNames = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
  const dayAbbr = ["L","M","M","J","V","S","D"];

  function shift(delta: number) {
    const d = new Date(year, month - 1 + delta, 1);
    setCurMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  const cells: (number | null)[] = [...Array(startOffset).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={() => shift(-1)} className="w-9 h-9 flex items-center justify-center rounded-xl border border-slate-700 text-slate-400 hover:text-white">‹</button>
        <span className="font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>{monthNames[month - 1]} {year}</span>
        <button onClick={() => shift(1)} className="w-9 h-9 flex items-center justify-center rounded-xl border border-slate-700 text-slate-400 hover:text-white">›</button>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {dayAbbr.map((d, i) => <div key={i} className="text-center text-[10px] text-slate-500 font-semibold py-1">{d}</div>)}
        {cells.map((day, i) => {
          if (!day) return <div key={i} />;
          const dateStr = `${curMonth}-${String(day).padStart(2, "0")}`;
          const isShooting = shootingDates.has(dateStr);
          const count = project.shootingDays[dateStr]?.child_ids?.length ?? 0;
          return (
            <button key={i}
              onClick={() => isShooting && setOpenDate(openDate === dateStr ? null : dateStr)}
              className={`aspect-square rounded-xl flex flex-col items-center justify-center text-xs font-semibold transition-colors
                ${isShooting
                  ? openDate === dateStr ? "bg-blue-600 text-white" : "bg-blue-900/50 border border-blue-700/60 text-blue-300 hover:bg-blue-800/60"
                  : "text-slate-600"}`}>
              <span>{day}</span>
              {isShooting && <span className="text-[8px] opacity-70">{count}👦</span>}
            </button>
          );
        })}
      </div>
      {openDate && (() => {
        const rows = sortByRoleThenAlpha(buildExportRows(project, openDate).map((r: any) => r._child))
          .map(child => buildExportRows(project, openDate).find((r: any) => r._child.id === child.id));
        const dateLabel = new Date(openDate + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
        return (
          <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="font-bold text-white capitalize" style={{ fontFamily: "Syne, sans-serif" }}>{dateLabel}</div>
              <div className="flex gap-2">
                <button onClick={() => exportDayToPDF(project, openDate)} className="text-xs text-blue-400 border border-blue-800/60 px-2 py-1 rounded-lg">📄 PDF</button>
                <button onClick={() => exportDayToXLSX(project, openDate)} className="text-xs text-emerald-400 border border-emerald-800/60 px-2 py-1 rounded-lg">📊 Excel</button>
              </div>
            </div>
            <div className="text-xs text-slate-400">{rows.length} enfant(s)</div>
            {rows.length === 0
              ? <div className="text-sm text-slate-500">Aucun enfant ce jour</div>
              : rows.map((r: any) => <ChildDetailRow key={r._child.id} row={r} dateStr={openDate} />)}
          </div>
        );
      })()}
    </div>
  );
}

// ─── ChildrenTab ──────────────────────────────────────────────────────────────
function ChildrenTab({ project }: { project: Project }) {
  const [roleFilter, setRoleFilter] = useState<ChildRole | "all">("all");
  const [openChild, setOpenChild] = useState<string | null>(null);

  const children = sortByRoleThenAlpha(project.children.filter(c => !c.archived));
  const days = Object.values(project.shootingDays).sort((a, b) => a.date.localeCompare(b.date));
  const roles: (ChildRole | "all")[] = ["all", ...ALL_ROLES];
  const roleIcons: Record<string, string> = { all: "Tous", role: "Rôle", silhouette: "Silhouette", figurant: "Figurant·e" };

  const filtered = children.filter(c => roleFilter === "all" || c.role === roleFilter);

  return (
    <div className="space-y-4">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {roles.map(r => {
          const count = r === "all" ? children.length : children.filter(c => c.role === r).length;
          if (r !== "all" && count === 0) return null;
          return (
            <button key={r} onClick={() => setRoleFilter(r)}
              className={`flex-shrink-0 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors
                ${roleFilter === r ? "bg-blue-700 border-blue-600 text-white" : "bg-slate-800 border-slate-700 text-slate-400"}`}>
              {roleIcons[r]} <span className="opacity-60">({count})</span>
            </button>
          );
        })}
      </div>
      <div className="space-y-2">
        {filtered.map(child => {
          const childDays = days.filter(d => (d.child_ids || []).includes(child.id));
          const isOpen = openChild === child.id;
          return (
            <div key={child.id} className="bg-slate-900/50 border border-slate-700 rounded-xl overflow-hidden">
              <button className="w-full flex items-center gap-3 px-4 py-3 text-left" onClick={() => setOpenChild(isOpen ? null : child.id)}>
                <div className="flex-1">
                  <div className="font-semibold text-white text-sm">{child.first_name} {child.last_name}</div>
                  <div className="text-xs text-slate-500">{getAge(child.dob)} ans · {childDays.length} jour(s) de tournage</div>
                </div>
                {child.role && <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold flex-shrink-0 ${ROLE_COLORS[child.role]}`}>{ROLE_LABELS[child.role]}</span>}
                <span className={`text-slate-500 text-xs transition-transform ${isOpen ? "rotate-90" : ""}`}>›</span>
              </button>
              {isOpen && (
                <div className="px-4 pb-3 space-y-2 border-t border-slate-800 pt-3">
                  {childDays.length > 0 && (
                    <button onClick={() => exportChildAllDays(project, child)} className="text-xs text-blue-400 border border-blue-800/60 px-3 py-1.5 rounded-lg w-full mb-1">
                      📄 Exporter toutes les journées (PDF)
                    </button>
                  )}
                  {childDays.length === 0
                    ? <div className="text-xs text-slate-500">Aucun jour de tournage</div>
                    : childDays.map(sd => {
                        const row = buildExportRows(project, sd.date).find((r: any) => r._child.id === child.id);
                        const dateLabel = new Date(sd.date + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
                        return (
                          <div key={sd.id}>
                            <div className="text-xs font-semibold text-slate-300 capitalize mb-1 mt-2">{dateLabel}</div>
                            {row ? <ChildDetailRow row={row} dateStr={sd.date} /> : <div className="text-xs text-slate-500">Pas de données</div>}
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
  );
}

// ─── ReadOnlyView ─────────────────────────────────────────────────────────────
function ReadOnlyView({ project }: { project: Project }) {
  const [tab, setTab] = useState<"calendar" | "children">("calendar");
  const children = project.children.filter(c => !c.archived);
  const dayCount = Object.keys(project.shootingDays).length;

  return (
    <div className="min-h-screen bg-[#080d16] text-white pb-24" style={{ fontFamily: "'DM Mono', monospace" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap" rel="stylesheet" />
      <div className="sticky top-0 z-10 bg-[#0c1420] border-b border-slate-800 px-4 py-3 flex items-center gap-3">
        <div className="min-w-0">
          <div className="text-[10px] text-blue-400 tracking-[0.35em] uppercase">Lecture seule</div>
          <h1 className="text-base font-extrabold truncate" style={{ fontFamily: "Syne, sans-serif" }}>{project.name}</h1>
        </div>
        <div className="ml-auto text-xs text-slate-500 text-right">{children.length} enfant(s)<br />{dayCount} jour(s)</div>
      </div>

      {/* Global export buttons */}
      <div className="px-4 pt-3 flex gap-2">
        <button onClick={() => exportProjectGlobalPDF(project)} className="flex-1 text-xs text-blue-400 border border-blue-800/60 px-3 py-2 rounded-lg">📄 Récap. global PDF</button>
        <button onClick={() => exportProjectGlobal(project)} className="flex-1 text-xs text-emerald-400 border border-emerald-800/60 px-3 py-2 rounded-lg">📊 Récap. global Excel</button>
      </div>

      <div className="px-4 py-4">
        {tab === "calendar" && <CalendarTab project={project} />}
        {tab === "children" && <ChildrenTab project={project} />}
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-[#0c1420] border-t border-slate-800 flex">
        {[{ id: "calendar", label: "Calendrier", icon: "📅" }, { id: "children", label: "Enfants", icon: "👦" }].map(t => (
          <button key={t.id} onClick={() => setTab(t.id as any)}
            className={`flex-1 py-3 flex flex-col items-center gap-0.5 ${tab === t.id ? "text-blue-400" : "text-slate-600"}`}>
            <span className="text-lg">{t.icon}</span>
            <span className="text-[9px] uppercase tracking-wider">{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [status, setStatus] = useState<"loading" | "password" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [password, setPassword] = useState("");
  const [pwdError, setPwdError] = useState("");
  const [project, setProject] = useState<Project | null>(null);

  async function fetchProject(pwd?: string) {
    setStatus("loading");
    const { data, error } = await supabase.rpc("get_project_by_token", { p_token: token, p_password: pwd ?? null });
    if (error || !data) { setErrorMsg("Erreur lors du chargement."); setStatus("error"); return; }
    if (data.error === "not_found") { setErrorMsg("Ce lien de partage n'existe pas ou a été désactivé."); setStatus("error"); return; }
    if (data.error === "password_required") { setStatus("password"); return; }
    if (data.error === "wrong_password") { setPwdError("Mot de passe incorrect."); setStatus("password"); return; }
    setProject(normalizeProject(data));
    setStatus("ready");
  }

  useEffect(() => { fetchProject(); }, [token]);

  if (status === "loading") return (
    <div className="min-h-screen bg-[#080d16] flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (status === "error") return (
    <div className="min-h-screen bg-[#080d16] flex items-center justify-center px-6">
      <div className="text-center space-y-3">
        <div className="text-4xl">🔗</div>
        <div className="text-white font-bold" style={{ fontFamily: "Syne, sans-serif" }}>Lien invalide</div>
        <div className="text-slate-400 text-sm">{errorMsg}</div>
      </div>
    </div>
  );

  if (status === "password") return (
    <div className="min-h-screen bg-[#080d16] flex items-center justify-center px-6">
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap" rel="stylesheet" />
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <div className="text-4xl">🔒</div>
          <h1 className="text-2xl font-extrabold text-white" style={{ fontFamily: "Syne, sans-serif" }}>Accès protégé</h1>
          <p className="text-slate-400 text-sm">Ce projet est protégé par un mot de passe.</p>
        </div>
        <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-5 space-y-4">
          <input type="password" placeholder="Mot de passe" value={password} autoFocus
            onChange={e => { setPassword(e.target.value); setPwdError(""); }}
            onKeyDown={e => e.key === "Enter" && fetchProject(password)}
            className="w-full bg-slate-800 border border-slate-600 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 placeholder:text-slate-600" />
          {pwdError && <div className="text-xs text-red-400">{pwdError}</div>}
          <button onClick={() => fetchProject(password)}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl text-sm transition-colors">
            Accéder au projet
          </button>
        </div>
      </div>
    </div>
  );

  return project ? <ReadOnlyView project={project} /> : null;
}
