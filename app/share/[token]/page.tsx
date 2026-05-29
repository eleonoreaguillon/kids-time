"use client";

import { useState, useEffect, use } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ─── Types ───────────────────────────────────────────────────────────────────
type AgeBand = "0-2" | "3-5" | "6-11" | "12-16";
type Period = "school" | "vacation";
type ChildRole = "role" | "silhouette" | "figurant";
interface VacationPeriod { start: string; end: string; }
interface Child {
  id: string; project_id: string;
  first_name: string; last_name: string;
  dob: string; vacation_periods: VacationPeriod[];
  role?: ChildRole; child_role?: ChildRole;
  archived?: boolean;
}
interface Session {
  start_time?: string; end_time?: string;
  status?: "working" | "paused" | "dejeuner" | "done";
  events?: { type: string; time: string }[];
}
interface ShootingDay {
  id: string; project_id: string; date: string;
  child_ids: string[]; sessions: Record<string, Session>;
}
interface Rules {
  maxWorkMinutes: Record<AgeBand, Record<Period, number>>;
  mandatoryBreakAfterMinutes: Record<AgeBand, Record<Period, number>>;
  maxAmplitudeMinutes: number; minBreakMinutes: number;
  minRestBetweenDays: number; maxDaysPerWeek: number;
}
interface Project {
  id: string; name: string; rules: Rules; created_at: string;
  children: Child[]; groups: any[]; shooting_days: ShootingDay[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const ROLE_ORDER: Record<string, number> = { role: 0, silhouette: 1, figurant: 2 };
const ROLE_LABELS: Record<ChildRole, string> = { role: "Rôle", silhouette: "Silhouette", figurant: "Figurant·e" };
const ROLE_COLORS: Record<ChildRole, string> = {
  role: "bg-purple-900/40 text-purple-300 border-purple-700",
  silhouette: "bg-cyan-900/40 text-cyan-300 border-cyan-700",
  figurant: "bg-orange-900/40 text-orange-300 border-orange-700",
};

function sortByRoleThenAlpha(cs: Child[]): Child[] {
  return [...cs].sort((a, b) => {
    const ar = a.role ?? a.child_role, br = b.role ?? b.child_role;
    const ra = ROLE_ORDER[ar ?? ""] ?? 3, rb = ROLE_ORDER[br ?? ""] ?? 3;
    if (ra !== rb) return ra - rb;
    return `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, "fr");
  });
}
function formatMinutes(min: number): string {
  const h = Math.floor(Math.abs(min) / 60), m = Math.abs(min) % 60, s = min < 0 ? "-" : "";
  if (h === 0) return `${s}${m}min`; if (m === 0) return `${s}${h}h`;
  return `${s}${h}h${String(m).padStart(2, "0")}`;
}
function computeStats(session: Session | undefined) {
  if (!session?.start_time) return null;
  const now = session.end_time ? new Date(session.end_time) : new Date();
  const start = new Date(session.start_time);
  const amplitudeMin = Math.floor((now.getTime() - start.getTime()) / 60000);
  const events = session.events || [];
  let workMin = 0, breakMin = 0, dejeunerMin = 0, lastRef = start;
  for (const ev of events) {
    const t = new Date(ev.time), dur = Math.floor((t.getTime() - lastRef.getTime()) / 60000);
    if (ev.type === "pause_start" || ev.type === "dejeuner_start") { workMin += dur; lastRef = t; }
    else if (ev.type === "pause_end") { breakMin += dur; lastRef = t; }
    else if (ev.type === "dejeuner_end") { dejeunerMin += dur; lastRef = t; }
  }
  if (session.end_time) workMin += Math.floor((now.getTime() - lastRef.getTime()) / 60000);
  return { amplitudeMin, workMin, breakMin, dejeunerMin,
    start: start.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
    end: session.end_time ? now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : null };
}

// ─── ReadOnlyView ─────────────────────────────────────────────────────────────
function ReadOnlyView({ project }: { project: Project }) {
  const [tab, setTab] = useState<"calendar" | "children">("calendar");
  const days = project.shooting_days;
  const children = sortByRoleThenAlpha(
    project.children.filter(c => !c.archived).map(c => ({ ...c, role: c.role ?? c.child_role }))
  );
  const sortedDays = [...days].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div className="min-h-screen bg-[#080d16] text-white pb-20" style={{ fontFamily: "'DM Mono', monospace" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap" rel="stylesheet" />
      {/* Header */}
      <div className="sticky top-0 z-10 bg-[#0c1420] border-b border-slate-800 px-4 py-3 flex items-center gap-3">
        <div>
          <div className="text-[10px] text-blue-400 tracking-[0.35em] uppercase">Lecture seule</div>
          <h1 className="text-base font-extrabold truncate" style={{ fontFamily: "Syne, sans-serif" }}>{project.name}</h1>
        </div>
        <div className="ml-auto text-xs text-slate-500">{children.length} enfant(s) · {days.length} jour(s)</div>
      </div>
      {/* Tabs */}
      <div className="fixed bottom-0 left-0 right-0 bg-[#0c1420] border-t border-slate-800 flex">
        {[{ id: "calendar", label: "Calendrier", icon: "📅" }, { id: "children", label: "Enfants", icon: "👦" }].map(t => (
          <button key={t.id} onClick={() => setTab(t.id as any)}
            className={`flex-1 py-3 flex flex-col items-center gap-0.5 ${tab === t.id ? "text-blue-400" : "text-slate-600"}`}>
            <span className="text-lg">{t.icon}</span>
            <span className="text-[9px] uppercase tracking-wider">{t.label}</span>
          </button>
        ))}
      </div>
      {/* Content */}
      <div className="px-4 py-4">
        {tab === "calendar" && <CalendarTab days={sortedDays} children={children} />}
        {tab === "children" && <ChildrenTab children={children} days={sortedDays} />}
      </div>
    </div>
  );
}

// ─── CalendarTab ──────────────────────────────────────────────────────────────
function CalendarTab({ days, children }: { days: ShootingDay[]; children: Child[] }) {
  const firstDay = days[0]?.date;
  const initMonth = firstDay ? firstDay.slice(0, 7) : new Date().toISOString().slice(0, 7);
  const [curMonth, setCurMonth] = useState(initMonth);
  const [openDate, setOpenDate] = useState<string | null>(null);

  const [year, month] = curMonth.split("-").map(Number);
  const firstDow = new Date(year, month - 1, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month, 0).getDate();
  const startOffset = (firstDow + 6) % 7; // Monday-first

  const shootingDates = new Set(days.map(d => d.date));
  const monthNames = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
  const dayAbbr = ["L","M","M","J","V","S","D"];

  function prevMonth() {
    const d = new Date(year, month - 2, 1);
    setCurMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  function nextMonth() {
    const d = new Date(year, month, 1);
    setCurMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  const cells: (number | null)[] = [...Array(startOffset).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="space-y-4">
      {/* Month nav */}
      <div className="flex items-center justify-between">
        <button onClick={prevMonth} className="w-9 h-9 flex items-center justify-center rounded-xl border border-slate-700 text-slate-400 hover:text-white">‹</button>
        <span className="font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>{monthNames[month - 1]} {year}</span>
        <button onClick={nextMonth} className="w-9 h-9 flex items-center justify-center rounded-xl border border-slate-700 text-slate-400 hover:text-white">›</button>
      </div>
      {/* Day headers */}
      <div className="grid grid-cols-7 gap-1">
        {dayAbbr.map((d, i) => <div key={i} className="text-center text-[10px] text-slate-500 font-semibold py-1">{d}</div>)}
        {cells.map((day, i) => {
          if (!day) return <div key={i} />;
          const dateStr = `${curMonth}-${String(day).padStart(2, "0")}`;
          const isShooting = shootingDates.has(dateStr);
          const shootingDay = days.find(d => d.date === dateStr);
          const count = shootingDay?.child_ids?.length ?? 0;
          return (
            <button key={i}
              onClick={() => isShooting && setOpenDate(openDate === dateStr ? null : dateStr)}
              className={`aspect-square rounded-xl flex flex-col items-center justify-center text-xs font-semibold transition-colors
                ${isShooting
                  ? openDate === dateStr
                    ? "bg-blue-600 text-white"
                    : "bg-blue-900/50 border border-blue-700/60 text-blue-300 hover:bg-blue-800/60"
                  : "text-slate-600"}`}>
              <span>{day}</span>
              {isShooting && <span className="text-[8px] opacity-70">{count}👦</span>}
            </button>
          );
        })}
      </div>
      {/* Expanded day */}
      {openDate && (() => {
        const sd = days.find(d => d.date === openDate);
        if (!sd) return null;
        const dayChildren = sortByRoleThenAlpha((sd.child_ids || []).map(id => children.find(c => c.id === id)!).filter(Boolean));
        const [, , dayNum] = openDate.split("-");
        const dateLabel = new Date(openDate + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
        return (
          <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-4 space-y-3">
            <div className="font-bold text-white capitalize" style={{ fontFamily: "Syne, sans-serif" }}>{dateLabel}</div>
            <div className="text-xs text-slate-400">{dayChildren.length} enfant(s)</div>
            {dayChildren.length === 0
              ? <div className="text-sm text-slate-500">Aucun enfant ce jour</div>
              : dayChildren.map(child => {
                  const session = sd.sessions?.[child.id];
                  const stats = computeStats(session);
                  const role = child.role ?? child.child_role;
                  return (
                    <div key={child.id} className="bg-slate-800/60 border border-slate-700 rounded-xl p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="font-semibold text-white text-sm">{child.first_name} {child.last_name}</span>
                        {role && <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${ROLE_COLORS[role]}`}>{ROLE_LABELS[role]}</span>}
                      </div>
                      {stats ? (
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                          <div className="text-slate-400">Convocation <span className="text-white font-mono">{stats.start}</span></div>
                          <div className="text-slate-400">Fin <span className="text-white font-mono">{stats.end ?? "—"}</span></div>
                          <div className="text-slate-400">Travail <span className="text-blue-300 font-mono">{formatMinutes(stats.workMin)}</span></div>
                          <div className="text-slate-400">Amplitude <span className="text-orange-300 font-mono">{formatMinutes(stats.amplitudeMin)}</span></div>
                          {stats.breakMin > 0 && <div className="text-slate-400">Pauses <span className="text-green-300 font-mono">{formatMinutes(stats.breakMin)}</span></div>}
                          {stats.dejeunerMin > 0 && <div className="text-slate-400">Déjeuner <span className="text-yellow-300 font-mono">{formatMinutes(stats.dejeunerMin)}</span></div>}
                        </div>
                      ) : (
                        <div className="text-xs text-slate-500">Pas de session enregistrée</div>
                      )}
                    </div>
                  );
                })
            }
          </div>
        );
      })()}
      {/* List of shooting days in other months */}
      <div className="space-y-1">
        {days.filter(d => !d.date.startsWith(curMonth)).slice(0, 3).map(d => (
          <button key={d.date} onClick={() => setCurMonth(d.date.slice(0, 7))}
            className="w-full text-left text-xs text-slate-500 hover:text-blue-400 px-2 py-1">
            → {new Date(d.date + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── ChildrenTab ──────────────────────────────────────────────────────────────
function ChildrenTab({ children, days }: { children: Child[]; days: ShootingDay[] }) {
  const [roleFilter, setRoleFilter] = useState<ChildRole | "all">("all");
  const [openChild, setOpenChild] = useState<string | null>(null);

  const roles: (ChildRole | "all")[] = ["all", "role", "silhouette", "figurant"];
  const roleIcons: Record<string, string> = { all: "Tous", role: "Rôle", silhouette: "Silhouette", figurant: "Figurant·e" };

  const filtered = children.filter(c => {
    const r = c.role ?? c.child_role;
    return roleFilter === "all" || r === roleFilter;
  });

  return (
    <div className="space-y-4">
      {/* Role filter */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {roles.map(r => {
          const count = r === "all" ? children.length : children.filter(c => (c.role ?? c.child_role) === r).length;
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
      {/* Children list */}
      <div className="space-y-2">
        {filtered.map(child => {
          const role = child.role ?? child.child_role;
          const childDays = days.filter(d => (d.child_ids || []).includes(child.id));
          const isOpen = openChild === child.id;
          return (
            <div key={child.id} className="bg-slate-900/50 border border-slate-700 rounded-xl overflow-hidden">
              <button className="w-full flex items-center gap-3 px-4 py-3 text-left"
                onClick={() => setOpenChild(isOpen ? null : child.id)}>
                <div className="flex-1">
                  <div className="font-semibold text-white text-sm">{child.first_name} {child.last_name}</div>
                  <div className="text-xs text-slate-500">{childDays.length} jour(s) de tournage</div>
                </div>
                {role && <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold flex-shrink-0 ${ROLE_COLORS[role]}`}>{ROLE_LABELS[role]}</span>}
                <span className={`text-slate-500 text-xs transition-transform ${isOpen ? "rotate-90" : ""}`}>›</span>
              </button>
              {isOpen && (
                <div className="px-4 pb-3 space-y-2 border-t border-slate-800 pt-3">
                  {childDays.length === 0
                    ? <div className="text-xs text-slate-500">Aucun jour de tournage</div>
                    : childDays.map(sd => {
                        const session = sd.sessions?.[child.id];
                        const stats = computeStats(session);
                        const dateLabel = new Date(sd.date + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
                        return (
                          <div key={sd.id} className="bg-slate-800/50 rounded-xl p-3">
                            <div className="text-xs font-semibold text-white capitalize mb-1">{dateLabel}</div>
                            {stats ? (
                              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
                                <div className="text-slate-400">Convoc. <span className="text-white font-mono">{stats.start}</span></div>
                                <div className="text-slate-400">Fin <span className="text-white font-mono">{stats.end ?? "—"}</span></div>
                                <div className="text-slate-400">Travail <span className="text-blue-300 font-mono">{formatMinutes(stats.workMin)}</span></div>
                                <div className="text-slate-400">Amplitude <span className="text-orange-300 font-mono">{formatMinutes(stats.amplitudeMin)}</span></div>
                                {stats.breakMin > 0 && <div className="text-slate-400">Pauses <span className="text-green-300 font-mono">{formatMinutes(stats.breakMin)}</span></div>}
                              </div>
                            ) : (
                              <div className="text-xs text-slate-500">Pas de session</div>
                            )}
                          </div>
                        );
                      })
                  }
                </div>
              )}
            </div>
          );
        })}
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
    const { data, error } = await supabase.rpc("get_project_by_token", {
      p_token: token,
      p_password: pwd ?? null,
    });
    if (error || !data) { setErrorMsg("Erreur lors du chargement."); setStatus("error"); return; }
    if (data.error === "not_found") { setErrorMsg("Ce lien de partage n'existe pas ou a été désactivé."); setStatus("error"); return; }
    if (data.error === "password_required") { setStatus("password"); return; }
    if (data.error === "wrong_password") { setPwdError("Mot de passe incorrect."); setStatus("password"); return; }
    setProject(data as Project);
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
          <input
            type="password"
            placeholder="Mot de passe"
            value={password}
            onChange={e => { setPassword(e.target.value); setPwdError(""); }}
            onKeyDown={e => e.key === "Enter" && fetchProject(password)}
            className="w-full bg-slate-800 border border-slate-600 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 placeholder:text-slate-600"
            autoFocus
          />
          {pwdError && <div className="text-xs text-red-400">{pwdError}</div>}
          <button
            onClick={() => fetchProject(password)}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl text-sm transition-colors">
            Accéder au projet
          </button>
        </div>
      </div>
    </div>
  );

  return project ? <ReadOnlyView project={project} /> : null;
}
