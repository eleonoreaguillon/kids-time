"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── Supabase ────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ─── Types ────────────────────────────────────────────────────────────────────
type Period = "school" | "vacation";
type AgeBand = "0-2" | "3-5" | "6-11" | "12-16";

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
  if (a < 3) return "0-2";
  if (a < 6) return "3-5";
  if (a < 12) return "6-11";
  return "12-16";
}

function formatMinutes(min: number | null | undefined): string {
  if (min == null || isNaN(min)) return "0min";
  const h = Math.floor(Math.abs(min) / 60), m = Math.abs(min) % 60, s = min < 0 ? "-" : "";
  if (h === 0) return `${s}${m}min`;
  if (m === 0) return `${s}${h}h`;
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

function computeSessionStats(session: Session | undefined, rules: Rules): SessionStats | null {
  if (!session?.start_time) return null;
  const now  = session.end_time ? new Date(session.end_time) : new Date();
  const start = new Date(session.start_time);
  const amplitudeMin = Math.floor((now.getTime() - start.getTime()) / 60000);
  const events = session.events || [];
  let workMin = 0, breakMin = 0, validBreakMin = 0, lastRef = start;

  for (const ev of events) {
    const t = new Date(ev.time), dur = Math.floor((t.getTime() - lastRef.getTime()) / 60000);
    if (ev.type === "pause_start") { workMin += dur; }
    else if (ev.type === "pause_end") {
      if (dur >= rules.minBreakMinutes) validBreakMin += dur; else workMin += dur;
      breakMin += dur;
    }
    lastRef = t;
  }

  const lastDur = Math.floor((now.getTime() - lastRef.getTime()) / 60000);
  if (session.status === "paused") {
    if (lastDur >= rules.minBreakMinutes) validBreakMin += lastDur; else workMin += lastDur;
    breakMin += lastDur;
  } else { workMin += lastDur; }

  let timeSinceBreak: number | null = null;
  if (session.status === "working") {
    const last = [...events].reverse().find(e => e.type === "pause_end");
    timeSinceBreak = Math.floor((now.getTime() - new Date(last ? last.time : session.start_time).getTime()) / 60000);
  }

  return { amplitudeMin, workMin, breakMin, validBreakMin, timeSinceBreak, start, now };
}

// ─── UI Primitives ────────────────────────────────────────────────────────────
type BadgeColor = "green" | "red" | "amber" | "blue" | "slate";

function Badge({ children, color = "slate" }: { children: React.ReactNode; color?: BadgeColor }) {
  const cls: Record<BadgeColor, string> = {
    green: "bg-emerald-900/40 text-emerald-300 border-emerald-700",
    red:   "bg-red-900/40 text-red-300 border-red-700",
    amber: "bg-amber-900/40 text-amber-300 border-amber-700",
    blue:  "bg-blue-900/40 text-blue-300 border-blue-700",
    slate: "bg-slate-700/60 text-slate-300 border-slate-600",
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${cls[color]}`}>{children}</span>;
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

function TextInput({ label, ...props }: { label?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex flex-col gap-1">
      {label && <label className="text-[10px] text-slate-400 uppercase tracking-[0.15em] font-semibold">{label}</label>}
      <input className="bg-slate-800/80 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors placeholder:text-slate-600" {...props} />
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

  if (session === undefined) return (
    <div className="min-h-screen bg-[#080d16] flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
  if (!session) return <AuthPage onAuth={setSession} />;
  return <MainApp session={session} onSignOut={() => supabase.auth.signOut()} />;
}

// ═════════════════════════════════════════════════════════════════════════════
// AUTH PAGE
// ═════════════════════════════════════════════════════════════════════════════
function AuthPage({ onAuth }: { onAuth: (s: any) => void }) {
  const [mode, setMode]     = useState<"login" | "signup">("login");
  const [email, setEmail]   = useState("");
  const [pass, setPass]     = useState("");
  const [error, setError]   = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(""); setLoading(true);
    try {
      if (mode === "login") {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password: pass });
        if (error) throw error;
        onAuth(data.session);
      } else {
        const { error } = await supabase.auth.signUp({ email, password: pass });
        if (error) throw error;
        setError("✅ Compte créé ! Vérifiez votre e-mail puis connectez-vous.");
        setMode("login");
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
        <h1 className="text-6xl font-extrabold tracking-tight" style={{ fontFamily: "Syne, sans-serif" }}>
          KIDS<span className="text-blue-500">TIME</span>
        </h1>
        <div className="mt-6 max-w-sm mx-auto text-slate-400 text-sm leading-relaxed border-t border-slate-800 pt-5">
          Outil développé par Éléonore Aguillon
          <div className="mt-3 text-blue-400 font-semibold text-xs tracking-wider">Bonjour et bienvenue sur cet outil de travail dédié aux coachs et aux responsables enfants qui exercent dans l&apos;audiovisuel.</div>
        </div>
      </div>

      <div className="relative z-10 w-full max-w-sm bg-slate-900/70 border border-slate-700 rounded-2xl p-7 backdrop-blur">
        <div className="flex mb-6 bg-slate-800 rounded-xl p-1">
          {(["login", "signup"] as const).map(m => (
            <button key={m} onClick={() => { setMode(m); setError(""); }}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${mode === m ? "bg-blue-600 text-white" : "text-slate-400 hover:text-white"}`}>
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
  const [view, setView]           = useState<"home" | "project" | "shooting">("home");
  const [projects, setProjects]   = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const [loading, setLoading]     = useState(true);
  const userId = session.user.id;

  const loadProjects = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from("projects").select("*").eq("user_id", userId).order("created_at");
    setProjects((data || []) as Project[]);
    setLoading(false);
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
    setLoading(true);
    const f = await loadFullProject(id);
    setActiveProject(f); setView("project"); setLoading(false);
  }

  async function refreshActive() {
    if (!activeProject) return;
    const f = await loadFullProject(activeProject.id);
    setActiveProject(f);
  }

  async function createProject(name: string) {
    const { data } = await supabase.from("projects").insert({ user_id: userId, name, rules: DEFAULT_RULES }).select().single();
    if (data) { await loadProjects(); openProject(data.id); }
  }

  async function deleteProject(id: string) {
    await supabase.from("projects").delete().eq("id", id);
    loadProjects();
  }

  async function addChild(child: { firstName: string; lastName: string; dob: string; vacationPeriods: VacationPeriod[] }) {
    await supabase.from("children").insert({ project_id: activeProject!.id, first_name: child.firstName, last_name: child.lastName, dob: child.dob, vacation_periods: child.vacationPeriods || [] });
    refreshActive();
  }

  async function updateChild(id: string, data: { firstName: string; lastName: string; dob: string; vacationPeriods: VacationPeriod[] }) {
    await supabase.from("children").update({ first_name: data.firstName, last_name: data.lastName, dob: data.dob, vacation_periods: data.vacationPeriods || [] }).eq("id", id);
    refreshActive();
  }

  async function removeChild(id: string) {
    await supabase.from("children").delete().eq("id", id); refreshActive();
  }

  async function addGroup(name: string) {
    await supabase.from("groups").insert({ project_id: activeProject!.id, name, child_ids: [] }); refreshActive();
  }

  async function updateGroup(id: string, data: Partial<Group>) {
    await supabase.from("groups").update(data).eq("id", id); refreshActive();
  }

  async function removeGroup(id: string) {
    await supabase.from("groups").delete().eq("id", id); refreshActive();
  }

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
    refreshActive();
  }

  async function toggleChildOnDay(dateStr: string, childId: string) {
    const day = await getOrCreateDay(dateStr);
    const ids = day.child_ids || [];
    const newIds = ids.includes(childId) ? ids.filter(i => i !== childId) : [...ids, childId];
    await supabase.from("shooting_days").update({ child_ids: newIds }).eq("id", day.id);
    refreshActive();
  }

  async function addGroupToDay(dateStr: string, groupId: string) {
    const group = activeProject!.groups.find(g => g.id === groupId);
    if (!group) return;
    const day = await getOrCreateDay(dateStr);
    const ids = [...new Set([...(day.child_ids || []), ...group.child_ids])];
    await supabase.from("shooting_days").update({ child_ids: ids }).eq("id", day.id);
    refreshActive();
  }

  async function startSession(dateStr: string, childId: string, timeISO?: string) {
    const day = await getOrCreateDay(dateStr);
    const sessions = { ...(day.sessions || {}) };
    if (sessions[childId]?.start_time) return;
    sessions[childId] = { start_time: timeISO || nowISO(), events: [], status: "working" };
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

  async function editEventTime(dateStr: string, childId: string, eventIndex: number, newTimeISO: string) {
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const sessions = { ...(day.sessions || {}) };
    const s = { ...sessions[childId] };
    const events = [...(s.events || [])];
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

  const Fonts = () => <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap" rel="stylesheet" />;

  if (loading && view === "home") return (
    <div className="min-h-screen bg-[#080d16] flex items-center justify-center">
      <Fonts /><div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (view === "home") return <><Fonts /><HomeView projects={projects} userEmail={session.user.email} onCreate={createProject} onOpen={openProject} onDelete={deleteProject} onSignOut={onSignOut} /></>;
  if (view === "project" && activeProject) return <><Fonts /><ProjectView project={activeProject} onBack={() => { setView("home"); loadProjects(); }} onAddChild={addChild} onUpdateChild={updateChild} onRemoveChild={removeChild} onAddGroup={addGroup} onUpdateGroup={updateGroup} onRemoveGroup={removeGroup} onUpdateRules={updateRules} onOpenDay={date => { setActiveDate(date); setView("shooting"); }} /></>;
  if (view === "shooting" && activeProject && activeDate) return <><Fonts /><ShootingView project={activeProject} dateStr={activeDate} onBack={() => { setView("project"); refreshActive(); }} onStartSession={(cid, t) => startSession(activeDate, cid, t)} onApplyEvent={(cids, type, t) => applyEventToChildren(activeDate, cids, type, t)} onEndSessions={(cids, t) => endSessions(activeDate, cids, t)} onToggleChild={cid => toggleChildOnDay(activeDate, cid)} onAddGroup={gid => addGroupToDay(activeDate, gid)} onEditEventTime={(cid, idx, t) => editEventTime(activeDate, cid, idx, t)} onEditStartTime={(cid, t) => editStartTime(activeDate, cid, t)} /></>;
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
            <h1 className="text-5xl font-extrabold tracking-tight" style={{ fontFamily: "Syne, sans-serif" }}>KIDS<span className="text-blue-500">TIME</span></h1>
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
function ProjectView({ project, onBack, onAddChild, onUpdateChild, onRemoveChild, onAddGroup, onUpdateGroup, onRemoveGroup, onUpdateRules, onOpenDay }: {
  project: Project; onBack: () => void;
  onAddChild: (c: any) => void; onUpdateChild: (id: string, d: any) => void; onRemoveChild: (id: string) => void;
  onAddGroup: (name: string) => void; onUpdateGroup: (id: string, d: any) => void; onRemoveGroup: (id: string) => void;
  onUpdateRules: (fn: (r: Rules) => Rules) => void; onOpenDay: (date: string) => void;
}) {
  const [tab, setTab] = useState<"calendar" | "children" | "groups" | "settings">("calendar");
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
        {tab === "children" && <ChildrenTab project={project} onAdd={() => setChildModal("new")} onEdit={c => setChildModal(c)} onRemove={onRemoveChild} />}
        {tab === "groups"   && <GroupsTab project={project} onAdd={() => setGroupModal("new")} onRemove={onRemoveGroup} onUpdateGroup={onUpdateGroup} />}
        {tab === "settings" && <SettingsTab rules={project.rules} onUpdateRules={onUpdateRules} />}
      </div>
      {childModal !== null && (
        <ChildFormModal
          child={childModal === "new" ? null : childModal}
          onSave={data => { childModal === "new" ? onAddChild(data) : onUpdateChild((childModal as Child).id, data); setChildModal(null); }}
          onClose={() => setChildModal(null)}
        />
      )}
      {groupModal !== null && (
        <GroupFormModal
          group={groupModal === "new" ? null : groupModal}
          onSave={name => { groupModal === "new" ? onAddGroup(name) : onUpdateGroup((groupModal as Group).id, { name }); setGroupModal(null); }}
          onClose={() => setGroupModal(null)}
        />
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
          const s = ds(d), isShoot = !!project.shootingDays[s], isToday = s === todayStr(), count = project.shootingDays[s]?.child_ids?.length || 0;
          return <button key={i} onClick={() => onOpenDay(s)} className={`rounded-xl py-3 text-sm transition-all ${isShoot ? "bg-blue-900/50 border border-blue-600 text-blue-200 hover:bg-blue-800/60" : "bg-slate-900/40 border border-slate-800 text-slate-400 hover:border-slate-600 hover:text-white"} ${isToday ? "ring-2 ring-blue-400" : ""}`}>
            <div className="font-bold">{d}</div>
            {isShoot && <div className="text-[10px] text-blue-400 mt-0.5">{count} 👦</div>}
          </button>;
        })}
      </div>
      <p className="text-[11px] text-slate-600 mt-4 text-center">Cliquez sur une date pour ouvrir la journée de tournage</p>
    </div>
  );
}

function ChildrenTab({ project, onAdd, onEdit, onRemove }: { project: Project; onAdd: () => void; onEdit: (c: Child) => void; onRemove: (id: string) => void }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-bold text-lg" style={{ fontFamily: "Syne, sans-serif" }}>Enfants ({project.children.length})</h2>
        <Btn onClick={onAdd}>+ Ajouter</Btn>
      </div>
      {project.children.length === 0 ? <div className="text-slate-500 text-center py-12 text-sm">Aucun enfant enregistré</div> :
        <div className="space-y-3">{project.children.map(c => (
          <div key={c.id} className="flex items-center gap-4 bg-slate-900/50 border border-slate-700 rounded-xl px-5 py-4">
            <div className="w-10 h-10 rounded-full bg-blue-900/60 flex items-center justify-center text-blue-300 font-bold text-sm">{c.first_name?.[0]}{c.last_name?.[0]}</div>
            <div className="flex-1">
              <div className="font-semibold text-white">{c.first_name} {c.last_name}</div>
              <div className="text-xs text-slate-400">{getAge(c.dob)} ans · tranche {getAgeBand(c.dob)} ans</div>
              {c.vacation_periods?.length > 0 && <div className="text-xs text-amber-400 mt-0.5">{c.vacation_periods.length} période(s) de vacances</div>}
            </div>
            <Badge color="blue">{getAgeBand(c.dob)} ans</Badge>
            <button onClick={() => onEdit(c)} className="text-slate-400 hover:text-white">✏️</button>
            <button onClick={() => onRemove(c.id)} className="text-slate-500 hover:text-red-400">✕</button>
          </div>
        ))}</div>
      }
    </div>
  );
}

function GroupsTab({ project, onAdd, onRemove, onUpdateGroup }: { project: Project; onAdd: () => void; onRemove: (id: string) => void; onUpdateGroup: (id: string, d: any) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-bold text-lg" style={{ fontFamily: "Syne, sans-serif" }}>Groupes ({project.groups.length})</h2>
        <Btn onClick={onAdd}>+ Créer un groupe</Btn>
      </div>
      {project.groups.length === 0 ? <div className="text-slate-500 text-center py-12 text-sm">Aucun groupe</div> :
        <div className="space-y-4">{project.groups.map(g => (
          <div key={g.id} className="bg-slate-900/50 border border-slate-700 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-white">{g.name}</h3>
              <div className="flex gap-2">
                <button onClick={() => setEditing(editing === g.id ? null : g.id)} className="text-slate-400 hover:text-white">✏️</button>
                <button onClick={() => onRemove(g.id)} className="text-slate-500 hover:text-red-400">✕</button>
              </div>
            </div>
            {editing === g.id && <div className="mb-3 space-y-1">
              {project.children.map(c => (
                <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-slate-800 px-2 py-1.5 rounded-lg">
                  <input type="checkbox" className="accent-blue-500" checked={(g.child_ids || []).includes(c.id)}
                    onChange={e => onUpdateGroup(g.id, { child_ids: e.target.checked ? [...(g.child_ids || []), c.id] : (g.child_ids || []).filter((i: string) => i !== c.id) })} />
                  <span className="text-slate-200">{c.first_name} {c.last_name}</span>
                </label>
              ))}
            </div>}
            <div className="flex flex-wrap gap-2">
              {(g.child_ids || []).map((id: string) => { const c = project.children.find(ch => ch.id === id); return c ? <Badge key={id} color="slate">{c.first_name} {c.last_name}</Badge> : null; })}
              {!g.child_ids?.length && <span className="text-xs text-slate-500">Aucun membre</span>}
            </div>
          </div>
        ))}</div>
      }
    </div>
  );
}

function SettingsTab({ rules, onUpdateRules }: { rules: Rules; onUpdateRules: (fn: (r: Rules) => Rules) => void }) {
  function setRule(path: string, value: string) {
    onUpdateRules(r => {
      const copy = JSON.parse(JSON.stringify(r));
      const keys = path.split(".");
      let obj: any = copy;
      for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
      obj[keys[keys.length - 1]] = Number(value);
      return copy;
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

function ChildFormModal({ child, onSave, onClose }: { child: Child | null; onSave: (d: any) => void; onClose: () => void }) {
  const [form, setForm] = useState({ firstName: child?.first_name || "", lastName: child?.last_name || "", dob: child?.dob || "", vacationPeriods: child?.vacation_periods || [] as VacationPeriod[] });
  const [newVac, setNewVac] = useState({ start: "", end: "" });
  return (
    <Modal title={child ? "Modifier l'enfant" : "Ajouter un enfant"} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <TextInput label="Prénom" value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} placeholder="Léa" />
          <TextInput label="Nom" value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} placeholder="Martin" />
        </div>
        <TextInput label="Date de naissance" type="date" value={form.dob} onChange={e => setForm(f => ({ ...f, dob: e.target.value }))} />
        {form.dob && <div className="bg-blue-900/30 border border-blue-700/60 rounded-lg px-4 py-2 text-sm text-blue-300">{getAge(form.dob)} ans · Tranche DRIEETS : {getAgeBand(form.dob)} ans</div>}
        <div>
          <label className="text-[10px] text-slate-400 uppercase tracking-wider block mb-2">Périodes de vacances</label>
          {form.vacationPeriods.map((p, i) => (
            <div key={i} className="flex items-center gap-2 mb-1 text-sm text-slate-300">
              <span>{p.start} → {p.end}</span>
              <button onClick={() => setForm(f => ({ ...f, vacationPeriods: f.vacationPeriods.filter((_, j) => j !== i) }))} className="text-red-400">✕</button>
            </div>
          ))}
          <div className="flex gap-2 items-end mt-2">
            <TextInput label="Début" type="date" value={newVac.start} onChange={e => setNewVac(v => ({ ...v, start: e.target.value }))} />
            <TextInput label="Fin" type="date" value={newVac.end} onChange={e => setNewVac(v => ({ ...v, end: e.target.value }))} />
            <button onClick={() => { if (newVac.start && newVac.end) { setForm(f => ({ ...f, vacationPeriods: [...f.vacationPeriods, newVac] })); setNewVac({ start: "", end: "" }); } }} className="bg-slate-700 hover:bg-slate-600 text-white px-3 rounded-lg h-9 text-sm">+</button>
          </div>
        </div>
        <Btn className="w-full justify-center" onClick={() => { if (!form.firstName || !form.lastName || !form.dob) return; onSave(form); }}>
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
function ShootingView({ project, dateStr, onBack, onStartSession, onApplyEvent, onEndSessions, onToggleChild, onAddGroup, onEditEventTime, onEditStartTime }: {
  project: Project; dateStr: string; onBack: () => void;
  onStartSession: (cid: string, t?: string) => void;
  onApplyEvent: (cids: string[], type: "pause_start" | "pause_end", t?: string) => void;
  onEndSessions: (cids: string[], t?: string) => void;
  onToggleChild: (cid: string) => void;
  onAddGroup: (gid: string) => void;
  onEditEventTime: (cid: string, idx: number, t: string) => void;
  onEditStartTime: (cid: string, t: string) => void;
}) {
  const [, setTick] = useState(0);
  const [addingChildren, setAdding] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionModal, setActionModal] = useState<{ type: "start" | "pause" | "resume" | "end" } | null>(null);

  useEffect(() => { const t = setInterval(() => setTick(n => n + 1), 15000); return () => clearInterval(t); }, []);

  const day = project.shootingDays[dateStr] || { child_ids: [], sessions: {} };
  const childIds = day.child_ids || [];
  const sessions = day.sessions || {};
  const rules = project.rules;
  const dateLabel = new Date(dateStr + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  function toggleSelect(id: string) { setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  const selList = [...selected];
  const canStart  = selList.some(id => !sessions[id]?.start_time);
  const canPause  = selList.some(id => sessions[id]?.status === "working");
  const canResume = selList.some(id => sessions[id]?.status === "paused");
  const canEnd    = selList.some(id => sessions[id]?.start_time && sessions[id]?.status !== "done");

  return (
    <div className="min-h-screen bg-[#080d16] text-white" style={{ fontFamily: "'DM Mono', monospace" }}>
      <div className="border-b border-slate-800 px-6 py-4 flex items-center gap-4">
        <button onClick={onBack} className="text-slate-400 hover:text-white text-sm">← {project.name}</button>
        <div>
          <h1 className="text-lg font-extrabold capitalize" style={{ fontFamily: "Syne, sans-serif" }}>{dateLabel}</h1>
          <div className="text-xs text-slate-400">{childIds.length} enfant(s) · {selected.size} sélectionné(s)</div>
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
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-2">Ajouter un groupe entier</div>
                  <div className="flex flex-wrap gap-2">
                    {project.groups.map(g => <button key={g.id} onClick={() => onAddGroup(g.id)} className="bg-slate-800 hover:bg-blue-900/50 border border-slate-600 hover:border-blue-600 text-sm px-3 py-1.5 rounded-lg transition-colors">👥 {g.name} ({g.child_ids?.length || 0})</button>)}
                  </div>
                </div>
              )}
              <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-2">Individuellement</div>
              {project.children.map(c => (
                <label key={c.id} className="flex items-center gap-3 cursor-pointer hover:bg-slate-800 px-3 py-2 rounded-lg">
                  <input type="checkbox" className="accent-blue-500" checked={childIds.includes(c.id)} onChange={() => onToggleChild(c.id)} />
                  <span className="text-sm text-slate-200">{c.first_name} {c.last_name}</span>
                  <Badge color="blue">{getAgeBand(c.dob)} ans</Badge>
                </label>
              ))}
            </div>
          )}
        </div>

        {childIds.length > 0 && (
          <div className="bg-slate-900/60 border border-slate-700 rounded-xl px-5 py-3 mb-5 flex flex-wrap items-center gap-3">
            <span className="text-xs text-slate-400 font-semibold">Sélection :</span>
            <button onClick={() => setSelected(new Set(childIds))} className="text-xs text-blue-400 hover:text-blue-300">Tous</button>
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
          : <div className="space-y-4">
            {childIds.map(id => {
              const child = project.children.find(c => c.id === id); if (!child) return null;
              const session = sessions[id], vacation = isVacation(child, dateStr), band = getAgeBand(child.dob), period: Period = vacation ? "vacation" : "school";
              const maxWork = rules.maxWorkMinutes[band][period], breakAfter = rules.mandatoryBreakAfterMinutes[band][period];
              const stats = computeSessionStats(session, rules);
              return <ChildCard key={id} child={child} session={session} stats={stats} maxWork={maxWork} breakAfter={breakAfter} maxAmplitude={rules.maxAmplitudeMinutes} vacation={vacation} isSelected={selected.has(id)} onSelect={() => toggleSelect(id)} onStart={t => onStartSession(id, t)} onEditEventTime={(idx, t) => onEditEventTime(id, idx, t)} onEditStartTime={t => onEditStartTime(id, t)} dateStr={dateStr} />;
            })}
          </div>
        }
      </div>

      {actionModal && <TimeActionModal type={actionModal.type} childCount={selected.size} dateStr={dateStr}
        onConfirm={timeISO => {
          const ids = [...selected];
          if (actionModal.type === "start") ids.forEach(id => onStartSession(id, timeISO));
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

function ChildCard({ child, session, stats, maxWork, breakAfter, maxAmplitude, vacation, isSelected, onSelect, onStart, onEditEventTime, onEditStartTime, dateStr }: {
  child: Child; session: Session | undefined; stats: SessionStats | null;
  maxWork: number; breakAfter: number; maxAmplitude: number; vacation: boolean;
  isSelected: boolean; onSelect: () => void;
  onStart: (t?: string) => void;
  onEditEventTime: (idx: number, t: string) => void;
  onEditStartTime: (t: string) => void;
  dateStr: string;
}) {
  const [editingIdx, setEditingIdx] = useState<number | "start" | null>(null);
  const [editTime, setEditTime] = useState("");
  const band = getAgeBand(child.dob);
  const workPct = stats ? Math.min(100, (stats.workMin / maxWork) * 100) : 0;
  const ampPct  = stats ? Math.min(100, (stats.amplitudeMin / maxAmplitude) * 100) : 0;
  const workCrit = stats && stats.workMin >= maxWork, workWarn = stats && stats.workMin >= maxWork * 0.8;
  const ampCrit  = stats && stats.amplitudeMin >= maxAmplitude, ampWarn = stats && stats.amplitudeMin >= maxAmplitude * 0.85;
  const breakDue = stats?.timeSinceBreak != null && stats.timeSinceBreak >= breakAfter;
  function startEdit(key: number | "start", iso: string | undefined) { setEditingIdx(key); setEditTime(isoToTimeStr(iso)); }
  function confirmEdit() { const iso = timeStrToISO(dateStr, editTime); if (editingIdx === "start") onEditStartTime(iso); else onEditEventTime(editingIdx as number, iso); setEditingIdx(null); }
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
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Chronologie — cliquez une heure pour la modifier</div>
            <div className="space-y-1.5">
              <TimelineRow label="▶ Début" iso={session?.start_time} isEditing={editingIdx === "start"} editTime={editTime} onEdit={() => startEdit("start", session?.start_time)} onTimeChange={setEditTime} onConfirm={confirmEdit} onCancel={() => setEditingIdx(null)} />
              {events.map((ev, i) => <TimelineRow key={i} label={ev.type === "pause_start" ? "⏸ Pause" : "▶ Reprise"} iso={ev.time} isEditing={editingIdx === i} editTime={editTime} onEdit={() => startEdit(i, ev.time)} onTimeChange={setEditTime} onConfirm={confirmEdit} onCancel={() => setEditingIdx(null)} />)}
              {session?.end_time && <div className="text-xs text-slate-400 pl-1">⏹ Fin : {formatTime(session.end_time)}</div>}
            </div>
          </div>
        </>
      )}

      {!session?.start_time && <SingleStartButton onStart={onStart} dateStr={dateStr} />}
      {session?.status === "done" && <div className="text-center text-emerald-400 text-sm font-semibold">✓ Journée terminée</div>}
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
          <button onClick={onCancel} className="text-slate-500 hover:text-white">✕</button>
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
  const [open, setOpen] = useState(false), [timeStr, setTimeStr] = useState(def);
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
