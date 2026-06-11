"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import {
  AGE_BANDS, AGE_BAND_LABELS, ALL_ROLES, DEFAULT_NIGHT_LIMIT_BY_BAND, DEFAULT_RULES,
  MIN_DAILY_REST_BY_BAND, ROLE_COLORS, ROLE_LABELS,
  type AgeBand, type Child, type ChildRole, type Derogation, type Group, type Period,
  type Project, type Rules, type Session, type SessionEvent, type SessionStats,
  type ShootingDay, type VacationPeriod,
} from "@/lib/types";
import {
  computeSessionStats, detectRole, formatMinutes, formatTime, getAge, getAgeBand,
  guessColumn, isMinor, isVacation, isoToTimeStr, normalize, normalizeRules, nowISO,
  parseExcelDate, sortByRoleThenAlpha, splitFullName, timeStrToISO, todayStr,
} from "@/lib/helpers";
import {
  buildExportRows, exportChildAllDays, exportDayBlankSheet, exportDayToPDF, exportProjectGlobalPDF,
} from "@/lib/exports";
import {
  ktCacheProject, ktCacheProjectList, ktEnqueue, ktLoadProject, ktLoadProjectList,
  ktProjectKey, ktQueueCount, ktReplayQueue, type QueueOp,
} from "@/lib/offline";

// Re-export pour conserver les imports externes (app/share/[token]/page.tsx)
export {
  AGE_BAND_LABELS, ALL_ROLES, ROLE_COLORS, ROLE_LABELS,
  computeSessionStats, formatMinutes, formatTime, getAge, getAgeBand, isMinor,
  isVacation, normalizeRules, sortByRoleThenAlpha,
  buildExportRows, exportChildAllDays, exportDayToPDF, exportProjectGlobalPDF,
};
export type { AgeBand, Child, ChildRole, Derogation, Group, Period, Project, Rules,
  Session, SessionEvent, SessionStats, ShootingDay, VacationPeriod };

// (constantes deplacees dans @/lib/types)

// (helpers deplaces dans @/lib/helpers)

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
    // Si l'utilisateur arrive depuis un magic link de reset de mot de passe,
    // Supabase emet l'evenement PASSWORD_RECOVERY. On le capte AVANT tout pour
    // rediriger vers /reset-password meme si la session est creee au passage.
    if (typeof window !== "undefined" && window.location.pathname !== "/reset-password") {
      const hash = window.location.hash || "";
      if (hash.includes("type=recovery")) {
        window.location.replace("/reset-password" + hash);
        return;
      }
    }
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      // En cas de recuperation de mot de passe, force la navigation vers la
      // page dediee — meme si l'utilisateur est deja sur une autre page.
      if (event === "PASSWORD_RECOVERY" && typeof window !== "undefined" && window.location.pathname !== "/reset-password") {
        window.location.href = "/reset-password";
        return;
      }
      setSession(s);
    });
    return () => subscription.unsubscribe();
  }, []);
  if (session === undefined) return <div className="min-h-screen bg-[#080d16] flex items-center justify-center"><div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;
  if (!session) return <AuthPage onAuth={setSession} />;
  return <MainApp session={session} onSignOut={() => supabase.auth.signOut()} />;
}

// Fix #2: persistent login — supabase handles session persistence by default via localStorage
// We also add autocomplete attributes so the browser/iPhone offers to save the password
function AuthPage({ onAuth }: { onAuth: (s: any) => void }) {
  const [mode, setMode] = useState<"login" | "signup" | "forgot">("login");
  const [email, setEmail] = useState(""); const [pass, setPass] = useState("");
  const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(""); setLoading(true);
    try {
      if (mode === "login") {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password: pass });
        if (error) throw error;
        onAuth(data.session);
      } else if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password: pass });
        if (error) throw error;
        setError("✅ Compte créé ! Vérifiez votre e-mail puis connectez-vous.");
        setMode("login");
      } else if (mode === "forgot") {
        const redirectTo = typeof window !== "undefined" ? `${window.location.origin}/reset-password` : undefined;
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
        setError("✅ Un lien de réinitialisation vient d'être envoyé. Vérifie ta boîte mail (et les spams).");
      }
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
        {mode !== "forgot" && (
          <div className="flex mb-5 bg-slate-800 rounded-xl p-1">
            {(["login", "signup"] as const).map(m => <button key={m} onClick={() => { setMode(m); setError(""); }} className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all ${mode === m ? "bg-blue-600 text-white" : "text-slate-400 hover:text-white"}`}>{m === "login" ? "Connexion" : "Créer un compte"}</button>)}
          </div>
        )}
        {mode === "forgot" && (
          <div className="mb-5 text-center">
            <div className="text-sm font-bold text-white mb-1">Mot de passe oublié</div>
            <div className="text-xs text-slate-400">Indique l&apos;adresse e-mail de ton compte, nous t&apos;enverrons un lien de réinitialisation.</div>
          </div>
        )}
        <form onSubmit={submit} className="space-y-3" autoComplete="on">
          <TextInput label="Adresse e-mail" type="email" autoComplete="email" placeholder="vous@exemple.com" value={email} onChange={e => setEmail(e.target.value)} required />
          {mode !== "forgot" && (
            <TextInput label="Mot de passe" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="••••••••" value={pass} onChange={e => setPass(e.target.value)} required />
          )}
          {error && <div className={`text-xs px-3 py-2 rounded-lg ${error.startsWith("✅") ? "bg-emerald-900/40 text-emerald-300" : "bg-red-900/40 text-red-300"}`}>{error}</div>}
          <button type="submit" disabled={loading} className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-3.5 rounded-xl font-bold text-sm transition-colors">
            {loading ? "Chargement…" : mode === "login" ? "Se connecter" : mode === "signup" ? "Créer mon compte" : "M'envoyer le lien"}
          </button>
        </form>
        {mode === "login" && (
          <button onClick={() => { setMode("forgot"); setError(""); setPass(""); }} className="mt-3 w-full text-center text-xs text-slate-400 hover:text-blue-400 transition-colors">
            Mot de passe oublié ?
          </button>
        )}
        {mode === "forgot" && (
          <button onClick={() => { setMode("login"); setError(""); }} className="mt-3 w-full text-center text-xs text-slate-400 hover:text-white transition-colors">
            ← Retour à la connexion
          </button>
        )}
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
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setProjects(ktLoadProjectList(userId));
      setLoading(false);
      return;
    }
    const { data, error } = await supabase.from("projects").select("*").eq("user_id", userId).order("created_at");
    if (error || !data) {
      setProjects(ktLoadProjectList(userId));
    } else {
      const list = data as Project[];
      setProjects(list);
      ktCacheProjectList(userId, list);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  async function loadFullProject(id: string): Promise<Project> {
    // Hors-ligne : on sert depuis le cache local sans toucher au reseau
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      const cached = ktLoadProject(id);
      if (cached) return cached;
      // Pas de cache : on renvoie un projet minimal et on laisse le composant
      // gerer (cas tres rare : 1er chargement offline)
      throw new Error("offline_no_cache");
    }
    try {
      const [{ data: proj, error: pErr }, { data: children }, { data: groups }, { data: days }] = await Promise.all([
        supabase.from("projects").select("*").eq("id", id).single(),
        supabase.from("children").select("*").eq("project_id", id),
        supabase.from("groups").select("*").eq("project_id", id),
        supabase.from("shooting_days").select("*").eq("project_id", id),
      ]);
      if (pErr || !proj) throw pErr || new Error("no_project");
      const shootingDays: Record<string, ShootingDay> = {};
      (days || []).forEach((d: ShootingDay) => { shootingDays[d.date] = d; });
      const mappedChildren = (children || []).map((c: any) => ({ ...c, role: c.child_role ?? undefined }));
      // Derive un booleen et evite d exposer le hash bcrypt aux composants enfants
      const projAny: any = { ...(proj || {}) };
      const share_password_set = !!projAny.share_password;
      delete projAny.share_password;
      // Retro-compat : ajoute les bandes d age manquantes dans les regles
      if (projAny.rules) projAny.rules = normalizeRules(projAny.rules);
      const full = { ...projAny, share_password_set, children: mappedChildren, groups: groups || [], shootingDays } as Project;
      ktCacheProject(full);
      return full;
    } catch (e) {
      // Repli vers le cache si on a perdu le reseau pendant la requete
      const cached = ktLoadProject(id);
      if (cached) return cached;
      throw e;
    }
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
    if (typeof navigator !== "undefined" && !navigator.onLine) return; // hors-ligne : on garde l etat optimiste
    try {
      const f = await loadFullProject(activeProject.id);
      setActiveProject(f);
    } catch { /* on garde l etat actuel si la requete echoue */ }
  }

  async function createProject(name: string) {
    const id = newId();
    const created_at = new Date().toISOString();
    const newProj: Project = {
      id, user_id: userId, name, rules: DEFAULT_RULES, created_at,
      children: [], groups: [], shootingDays: {},
    } as Project;
    // Cache + state immediats
    ktCacheProject(newProj);
    setProjectsAndCache(list => [...list, newProj]);
    await persistProjectUpsert({ id, user_id: userId, name, rules: DEFAULT_RULES });
    openProject(id);
  }

  async function deleteProject(id: string) {
    setProjectsAndCache(list => list.filter(p => p.id !== id));
    try { localStorage.removeItem(ktProjectKey(id)); } catch {}
    await persistProjectDelete(id);
  }

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
    if (!activeProject) return;
    const c: Child = {
      id: newId(),
      project_id: activeProject.id,
      first_name: child.firstName.trim(),
      last_name: child.lastName.trim(),
      dob: child.dob,
      vacation_periods: child.vacationPeriods || [],
      role: child.role ?? undefined,
      derogations: child.derogations || [],
      school_tracking: child.schoolTracking ?? false,
      archived: false,
    };
    setActiveAndCache(p => ({ ...p, children: [...p.children, c] }));
    await persistChild(c);
  }

  async function addChildren(children: { firstName: string; lastName: string; dob: string; vacationPeriods: VacationPeriod[]; role: ChildRole | null; derogations?: Derogation[]; schoolTracking?: boolean }[]) {
    if (children.length === 0 || !activeProject) return;
    const created: Child[] = children.map(c => ({
      id: newId(),
      project_id: activeProject.id,
      first_name: c.firstName.trim(),
      last_name: c.lastName.trim(),
      dob: c.dob,
      vacation_periods: c.vacationPeriods || [],
      role: c.role ?? undefined,
      derogations: c.derogations || [],
      school_tracking: c.schoolTracking ?? false,
      archived: false,
    }));
    setActiveAndCache(p => ({ ...p, children: [...p.children, ...created] }));
    for (const c of created) await persistChild(c);
  }

  async function updateChild(id: string, data: { firstName: string; lastName: string; dob: string; vacationPeriods: VacationPeriod[]; role: ChildRole | null; derogations?: Derogation[]; schoolTracking?: boolean }) {
    let updated: Child | null = null;
    setActiveAndCache(p => {
      const children = p.children.map(c => {
        if (c.id !== id) return c;
        updated = {
          ...c,
          first_name: data.firstName.trim(),
          last_name: data.lastName.trim(),
          dob: data.dob,
          vacation_periods: data.vacationPeriods || [],
          role: data.role ?? undefined,
          derogations: data.derogations || [],
          school_tracking: data.schoolTracking ?? false,
        };
        return updated;
      });
      return { ...p, children };
    });
    if (updated) await persistChild(updated);
  }

  async function archiveChild(id: string, archived: boolean) {
    let updated: Child | null = null;
    setActiveAndCache(p => {
      const children = p.children.map(c => {
        if (c.id !== id) return c;
        updated = { ...c, archived };
        return updated;
      });
      return { ...p, children };
    });
    if (updated) await persistChild(updated);
  }

  async function removeChild(id: string) {
    setActiveAndCache(p => ({ ...p, children: p.children.filter(c => c.id !== id) }));
    await persistChildDelete(id);
  }

  async function addGroup(name: string) {
    if (!activeProject) return;
    const g: Group = { id: newId(), project_id: activeProject.id, name, child_ids: [] };
    setActiveAndCache(p => ({ ...p, groups: [...p.groups, g] }));
    await persistGroup(g);
  }

  async function updateGroup(id: string, data: Partial<Group>) {
    let updated: Group | null = null;
    setActiveAndCache(p => {
      const groups = p.groups.map(g => {
        if (g.id !== id) return g;
        updated = { ...g, ...data };
        return updated;
      });
      return { ...p, groups };
    });
    if (updated) await persistGroup(updated);
  }

  async function removeGroup(id: string) {
    setActiveAndCache(p => ({ ...p, groups: p.groups.filter(g => g.id !== id) }));
    await persistGroupDelete(id);
  }

  async function updateRules(fn: (r: Rules) => Rules) {
    const r = fn(activeProject!.rules);
    setActiveAndCache(p => ({ ...p, rules: r }));
    await persistProjectPatch(activeProject!.id, { rules: r });
  }

  async function renameProject(name: string) {
    const clean = name.trim();
    if (!clean || !activeProject) return;
    setActiveAndCache(p => ({ ...p, name: clean }));
    setProjectsAndCache(list => list.map(p => p.id === activeProject.id ? { ...p, name: clean } : p));
    await persistProjectPatch(activeProject.id, { name: clean });
  }

  // ─── Helpers offline ────────────────────────────────────────────────────
  function newId(): string {
    return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  }
  // Maj atomique de activeProject + cache localStorage
  function setActiveAndCache(updater: (p: Project) => Project) {
    setActiveProject(p => { if (!p) return p; const next = updater(p); ktCacheProject(next); return next; });
  }
  // Maj atomique de la liste des projets + cache localStorage
  function setProjectsAndCache(updater: (list: Project[]) => Project[]) {
    setProjects(prev => { const next = updater(prev); ktCacheProjectList(userId, next); return next; });
  }

  async function tryPushOrQueue(op: QueueOp, push: () => any) {
    if (typeof navigator !== "undefined" && !navigator.onLine) { ktEnqueue(op); return; }
    try {
      const res = await push();
      if (res && res.error) throw res.error;
    } catch { ktEnqueue(op); }
  }

  function childToPayload(c: Child) {
    return {
      id: c.id,
      project_id: c.project_id,
      first_name: (c.first_name || "").trim(),
      last_name: (c.last_name || "").trim(),
      dob: c.dob,
      vacation_periods: c.vacation_periods || [],
      child_role: (c.role ?? null) as string | null,
      derogations: c.derogations || [],
      school_tracking: !!c.school_tracking,
      archived: !!c.archived,
    };
  }
  async function persistChild(c: Child) {
    const data = childToPayload(c);
    await tryPushOrQueue({ kind: "child_upsert", data }, () => supabase.from("children").upsert(data, { onConflict: "id" }));
  }
  async function persistChildDelete(id: string) {
    await tryPushOrQueue({ kind: "child_delete", data: { id } }, () => supabase.from("children").delete().eq("id", id));
  }
  async function persistGroup(g: Group) {
    const data = { id: g.id, project_id: g.project_id, name: g.name, child_ids: g.child_ids || [] };
    await tryPushOrQueue({ kind: "group_upsert", data }, () => supabase.from("groups").upsert(data, { onConflict: "id" }));
  }
  async function persistGroupDelete(id: string) {
    await tryPushOrQueue({ kind: "group_delete", data: { id } }, () => supabase.from("groups").delete().eq("id", id));
  }
  async function persistProjectPatch(id: string, patch: Record<string, any>) {
    await tryPushOrQueue({ kind: "project_patch", data: { id, patch } }, () => supabase.from("projects").update(patch).eq("id", id));
  }
  async function persistProjectUpsert(p: { id: string; user_id: string; name: string; rules: Rules }) {
    await tryPushOrQueue({ kind: "project_upsert", data: p }, () => supabase.from("projects").upsert(p, { onConflict: "id" }));
  }
  async function persistProjectDelete(id: string) {
    await tryPushOrQueue({ kind: "project_delete", data: { id } }, () => supabase.from("projects").delete().eq("id", id));
  }

  // Cree localement un jour si necessaire (UUID cote client pour autoriser le
  // mode hors-ligne)
  function ensureLocalDay(dateStr: string): ShootingDay {
    const existing = activeProject!.shootingDays[dateStr];
    if (existing) return existing;
    return {
      id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      project_id: activeProject!.id,
      date: dateStr,
      child_ids: [],
      sessions: {},
    };
  }
  // Applique le nouvel etat d un jour : MAJ activeProject + cache local + push
  // Supabase (ou mise en file si offline / erreur reseau)
  async function persistDay(updated: ShootingDay) {
    // 1) MAJ optimiste de l'etat React + cache localStorage
    setActiveProject(p => {
      if (!p) return p;
      const next = { ...p, shootingDays: { ...p.shootingDays, [updated.date]: updated } };
      ktCacheProject(next);
      return next;
    });
    // 2) Tentative de push reseau
    const data = { id: updated.id, project_id: updated.project_id, date: updated.date, child_ids: updated.child_ids, sessions: updated.sessions };
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      ktEnqueue({ kind: "day_upsert", data });
      return;
    }
    try {
      const { error } = await supabase.from("shooting_days").upsert(data, { onConflict: "id" });
      if (error) throw error;
    } catch {
      ktEnqueue({ kind: "day_upsert", data });
    }
  }

  async function getOrCreateDay(dateStr: string): Promise<ShootingDay> {
    return ensureLocalDay(dateStr);
  }
  async function updateDaySessions(dateStr: string, sessions: Record<string, Session>) {
    const day = ensureLocalDay(dateStr);
    await persistDay({ ...day, sessions });
  }
  async function toggleChildOnDay(dateStr: string, childId: string) {
    const day = ensureLocalDay(dateStr);
    const ids = day.child_ids || [];
    const newIds = ids.includes(childId) ? ids.filter(i => i !== childId) : [...ids, childId];
    await persistDay({ ...day, child_ids: newIds });
  }
  async function addGroupToDay(dateStr: string, groupId: string) {
    const group = activeProject!.groups.find(g => g.id === groupId); if (!group) return;
    const day = ensureLocalDay(dateStr);
    const ids = [...new Set([...(day.child_ids || []), ...group.child_ids])];
    await persistDay({ ...day, child_ids: ids });
  }
  async function removeGroupFromDay(dateStr: string, groupId: string) {
    const group = activeProject!.groups.find(g => g.id === groupId); if (!group) return;
    const day = activeProject!.shootingDays[dateStr]; if (!day) return;
    const ids = (day.child_ids || []).filter(id => !group.child_ids.includes(id));
    await persistDay({ ...day, child_ids: ids });
  }
  async function startSessionsSequentially(dateStr: string, childIds: string[], timeISO?: string) {
    const day = ensureLocalDay(dateStr);
    const sessions = { ...(day.sessions || {}) };
    let changed = false;
    for (const childId of childIds) { if (!sessions[childId]?.start_time) { sessions[childId] = { start_time: timeISO || nowISO(), events: [], status: "working" }; changed = true; } }
    if (!changed) return;
    await persistDay({ ...day, sessions });
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
    onExportProjectPDF={(ids?: string[]) => exportProjectGlobalPDF(activeProject, ids)}
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
    onExportPDF={() => exportDayToPDF(activeProject, activeDate)}
    onPrintBlank={() => exportDayBlankSheet(activeProject, activeDate)} /></>;
  return null;
}

// ─── OfflineBanner (autonome : gère lui-même l'état réseau + file d'attente) ─
function OfflineBanner() {
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [justSynced, setJustSynced] = useState(false);

  useEffect(() => {
    setPending(ktQueueCount());
    const on = async () => {
      setIsOnline(true);
      if (ktQueueCount() === 0) return;
      setSyncing(true);
      const remaining = await ktReplayQueue();
      setPending(remaining);
      setSyncing(false);
      if (remaining === 0) {
        setJustSynced(true);
        setTimeout(() => setJustSynced(false), 3500);
      }
    };
    const off = () => setIsOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    // Rafraichit le compteur toutes les 5 sec au cas ou une mutation l aurait
    // change ailleurs dans l app
    const tick = setInterval(() => setPending(ktQueueCount()), 5000);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      clearInterval(tick);
    };
  }, []);

  // Bandeau hors-ligne
  if (!isOnline) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 bg-amber-900/90 border-b border-amber-700 px-4 py-2 flex items-center justify-center gap-2 text-amber-200 text-xs backdrop-blur">
        <span>📡</span>
        <span>Mode hors-ligne {pending > 0 && <span className="font-bold">— {pending} action(s) en attente de synchronisation</span>}</span>
      </div>
    );
  }
  // Bandeau de synchro en cours
  if (syncing) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 bg-blue-900/90 border-b border-blue-700 px-4 py-2 flex items-center justify-center gap-2 text-blue-200 text-xs backdrop-blur">
        <span className="animate-spin">↻</span>
        <span>Synchronisation en cours…</span>
      </div>
    );
  }
  // Petit toast de confirmation
  if (justSynced) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 bg-emerald-900/90 border-b border-emerald-700 px-4 py-2 flex items-center justify-center gap-2 text-emerald-200 text-xs backdrop-blur">
        <span>✓</span>
        <span>Modifications synchronisées</span>
      </div>
    );
  }
  return null;
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
  const [showAccount, setShowAccount] = useState(false);
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
          <div className="text-right mt-1 flex flex-col items-end gap-1">
            <div className="text-xs text-slate-500 truncate max-w-[140px]">{userEmail}</div>
            <button onClick={() => setShowAccount(true)} className="text-xs text-slate-500 hover:text-blue-400 transition-colors">⚙ Mon compte</button>
            <button onClick={onSignOut} className="text-xs text-slate-500 hover:text-red-400 transition-colors">Déconnexion</button>
          </div>
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
      {showAccount && <AccountModal onClose={() => setShowAccount(false)} userEmail={userEmail} />}
    </div>
  );
}

function AccountModal({ onClose, userEmail }: { onClose: () => void; userEmail: string }) {
  const [currentPwd, setCurrentPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [errMsg, setErrMsg] = useState("");

  const MIN = 6;
  const newValid = newPwd.length >= MIN;
  const matches = newPwd === confirmPwd;
  const distinct = newPwd !== currentPwd;
  const canSubmit = currentPwd.length > 0 && newValid && matches && distinct;

  async function handleSubmit() {
    if (!canSubmit) return;
    setStatus("saving"); setErrMsg("");
    // 1) Verifie le mot de passe actuel en signant a nouveau
    const { error: signErr } = await supabase.auth.signInWithPassword({ email: userEmail, password: currentPwd });
    if (signErr) { setStatus("error"); setErrMsg("Mot de passe actuel incorrect."); return; }
    // 2) Met a jour avec le nouveau
    const { error: updErr } = await supabase.auth.updateUser({ password: newPwd });
    if (updErr) { setStatus("error"); setErrMsg(updErr.message); return; }
    setStatus("done");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm px-4 pb-4" onClick={status === "saving" ? undefined : onClose}>
      <div className="bg-[#0f1a2e] border border-slate-700 rounded-2xl w-full max-w-md p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-white" style={{ fontFamily: "Syne, sans-serif" }}>⚙ Mon compte</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white w-8 h-8 flex items-center justify-center">✕</button>
        </div>

        <div className="bg-slate-900/70 border border-slate-700 rounded-xl p-3 text-xs space-y-1">
          <div className="text-slate-500 uppercase tracking-wider">Adresse e-mail</div>
          <div className="text-white font-mono break-all">{userEmail}</div>
        </div>

        {status === "done" ? (
          <>
            <div className="bg-emerald-950/30 border border-emerald-800/60 rounded-xl p-4 text-sm space-y-1">
              <div className="text-emerald-300 font-bold">✓ Mot de passe mis à jour</div>
              <div className="text-xs text-slate-400">La modification est immédiate sur ce compte.</div>
            </div>
            <button onClick={onClose} className="w-full bg-blue-700 hover:bg-blue-600 text-white py-3 rounded-xl text-sm font-bold transition-colors">
              Fermer
            </button>
          </>
        ) : (
          <>
            <div>
              <h3 className="text-xs font-semibold text-slate-300 mb-3 uppercase tracking-wider">Changer le mot de passe</h3>
              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-400 uppercase tracking-wider">Mot de passe actuel</label>
                  <div className="relative">
                    <input
                      type={showPwd ? "text" : "password"}
                      value={currentPwd}
                      onChange={e => setCurrentPwd(e.target.value)}
                      autoComplete="current-password"
                      className="w-full bg-slate-800 border border-slate-600 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 placeholder:text-slate-600 pr-10"
                      placeholder="••••••••"
                    />
                    <button type="button" onClick={() => setShowPwd(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs">
                      {showPwd ? "🙈" : "👁"}
                    </button>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-400 uppercase tracking-wider">Nouveau mot de passe</label>
                  <input
                    type={showPwd ? "text" : "password"}
                    value={newPwd}
                    onChange={e => setNewPwd(e.target.value)}
                    autoComplete="new-password"
                    className="w-full bg-slate-800 border border-slate-600 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 placeholder:text-slate-600"
                    placeholder={`Min. ${MIN} caractères`}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-400 uppercase tracking-wider">Confirmer</label>
                  <input
                    type={showPwd ? "text" : "password"}
                    value={confirmPwd}
                    onChange={e => setConfirmPwd(e.target.value)}
                    autoComplete="new-password"
                    className="w-full bg-slate-800 border border-slate-600 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 placeholder:text-slate-600"
                    placeholder="Re-saisis le nouveau mot de passe"
                  />
                </div>
                {newPwd.length > 0 && !newValid && <div className="text-[10px] text-red-400">Le nouveau mot de passe doit faire au moins {MIN} caractères.</div>}
                {confirmPwd.length > 0 && !matches && <div className="text-[10px] text-red-400">Les deux mots de passe ne correspondent pas.</div>}
                {newValid && !distinct && <div className="text-[10px] text-amber-400">Le nouveau mot de passe doit être différent de l&apos;ancien.</div>}
              </div>
            </div>

            {status === "error" && (
              <div className="bg-red-950/40 border border-red-800/60 rounded-xl p-3 text-xs text-red-300">
                {errMsg}
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={!canSubmit || status === "saving"}
              className={`w-full py-3 rounded-xl text-sm font-bold transition-colors ${canSubmit && status !== "saving" ? "bg-blue-700 hover:bg-blue-600 text-white" : "bg-slate-800 text-slate-600 cursor-not-allowed"}`}
            >
              {status === "saving" ? "Enregistrement…" : "Changer le mot de passe"}
            </button>
          </>
        )}
      </div>
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
  onExportProjectPDF: (selectedIds?: string[]) => void;
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
  const [exportModal, setExportModal] = useState(false);
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
          <button onClick={() => setExportModal(true)} className="w-full text-xs text-blue-400 border border-blue-800/60 px-3 py-2 rounded-lg">📄 Récap. global PDF</button>
        </div>
      )}
      {exportModal && <SelectChildrenForExportModal project={project} onClose={() => setExportModal(false)} onConfirm={ids => onExportProjectPDF(ids)} />}

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
export function SelectChildrenForExportModal({ project, onConfirm, onClose }: {
  project: Project;
  onConfirm: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(project.children.filter(c => !c.archived).map(c => c.id)));
  const [search, setSearch] = useState("");
  const active = project.children.filter(c => !c.archived);
  const sorted = sortByRoleThenAlpha(active);
  const q = normalize(search);
  const filtered = sorted.filter(c => {
    if (!q) return true;
    const hay = normalize(`${c.first_name} ${c.last_name}`);
    const hay2 = normalize(`${c.last_name} ${c.first_name}`);
    return hay.includes(q) || hay2.includes(q);
  });
  type SectionKey = ChildRole | "none";
  const buckets: Record<SectionKey, Child[]> = { role: [], silhouette: [], figurant: [], none: [] };
  for (const c of filtered) buckets[(c.role || "none") as SectionKey].push(c);
  const order: SectionKey[] = ["role", "silhouette", "figurant", "none"];
  const labels: Record<SectionKey, string> = { role: "Rôle", silhouette: "Silhouette", figurant: "Figurant·e", none: "Sans statut" };
  const sections = order.filter(k => buckets[k].length > 0).map(k => ({ key: k, label: labels[k], children: buckets[k] }));

  function toggle(id: string) { setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function selectAll() { setSelected(new Set(active.map(c => c.id))); }
  function selectNone() { setSelected(new Set()); }
  function selectSection(children: Child[], add: boolean) {
    setSelected(s => { const n = new Set(s); for (const c of children) add ? n.add(c.id) : n.delete(c.id); return n; });
  }

  return (
    <Modal title="Export PDF global — sélection" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-slate-400">Sélectionne les enfants à inclure dans le récapitulatif.</p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="🔍 Rechercher…"
            className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder:text-slate-500"
          />
          <span className="text-[10px] bg-blue-700/40 text-blue-200 px-2 py-1 rounded-lg font-bold whitespace-nowrap">{selected.size}/{active.length}</span>
        </div>
        <div className="flex gap-2">
          <button onClick={selectAll} className="text-[10px] text-slate-300 border border-slate-600 px-2 py-1 rounded-lg">Tout cocher</button>
          <button onClick={selectNone} className="text-[10px] text-slate-400 border border-slate-700 px-2 py-1 rounded-lg">Tout décocher</button>
        </div>
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {sections.length === 0 && <div className="text-xs text-slate-500 text-center py-4">Aucun résultat.</div>}
          {sections.map(({ key, label, children }) => {
            const sel = children.filter(c => selected.has(c.id)).length;
            const allSel = sel === children.length;
            return (
              <div key={key} className="bg-slate-900/40 border border-slate-700 rounded-lg overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 bg-slate-800/50">
                  <span className="text-xs font-semibold text-slate-200 flex-1">{label} <span className="text-[10px] text-slate-500 font-normal">{sel}/{children.length}</span></span>
                  <button onClick={() => selectSection(children, !allSel)} className="text-[10px] border border-slate-700 text-slate-400 px-2 py-1 rounded-lg">
                    {allSel ? "Tout décocher" : "Tout cocher"}
                  </button>
                </div>
                <div className="divide-y divide-slate-800">
                  {children.map(c => (
                    <label key={c.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-slate-800/30">
                      <input type="checkbox" className="accent-blue-500 w-4 h-4 flex-shrink-0" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                      <span className="text-sm text-slate-200 flex-1 truncate">{c.last_name} {c.first_name}</span>
                      <span className="text-[10px] text-slate-500">{getAge(c.dob)} ans</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 py-2.5 rounded-xl text-sm font-semibold">Annuler</button>
          <button
            onClick={() => { if (selected.size > 0) { onConfirm([...selected]); onClose(); } }}
            disabled={selected.size === 0}
            className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-colors ${selected.size > 0 ? "bg-blue-700 hover:bg-blue-600 text-white" : "bg-slate-800 text-slate-600 cursor-not-allowed"}`}
          >
            📄 Exporter ({selected.size})
          </button>
        </div>
      </div>
    </Modal>
  );
}

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
      "Prénom;Nom;Date de naissance (JJ/MM/AAAA);Statut (role/silhouette/figurant);Début vacances (JJ/MM/AAAA);Fin vacances (JJ/MM/AAAA);Suivi scolaire (oui/non)\n" +
      "Léa;Martin;15/03/2015;role;01/07/2025;31/08/2025;oui\n" +
      "Tom;Dupont;08/11/2012;silhouette;;;non\n";
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

      {/* Options d'export */}
      <div className="mt-2">
        <h3 className="text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">Options des exports</h3>
        <label className="flex items-start gap-3 bg-slate-900/50 border border-slate-700 rounded-xl p-3 cursor-pointer">
          <input
            type="checkbox"
            className="accent-blue-500 w-5 h-5 mt-0.5 flex-shrink-0"
            checked={rules.showAmplitudeOverage !== false}
            onChange={e => onUpdateRules(r => ({ ...r, showAmplitudeOverage: e.target.checked }))}
          />
          <div className="flex-1">
            <div className="text-sm text-white">Afficher les informations d&apos;amplitude max</div>
            <div className="text-[10px] text-slate-400 mt-0.5">Si décoché, les colonnes &laquo;&nbsp;amplitude autorisée&nbsp;&raquo; et &laquo;&nbsp;dépassement d&apos;amplitude&nbsp;&raquo; n&apos;apparaissent dans aucun PDF (jour, par enfant, récap global). Seule l&apos;amplitude de présence reste affichée.</div>
          </div>
        </label>
      </div>

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

function ShootingView({ project, dateStr, onBack, onStartSessions, onStartSession, onCancelSession, onApplyEvent, onCancelLastEvent, onEndSessions, onReopenSession, onToggleChild, onAddGroup, onRemoveGroup, onEditEventTime, onEditStartTime, onEditEndTime, onExportPDF, onPrintBlank }: {
  project: Project; dateStr: string; onBack: () => void;
  onStartSessions: (cids: string[], t?: string) => void; onStartSession: (cid: string, t?: string) => void;
  onCancelSession: (cid: string) => void; onApplyEvent: (cids: string[], type: "pause_start" | "pause_end" | "dejeuner_start" | "dejeuner_end" | "school_start" | "school_end", t?: string) => void;
  onCancelLastEvent: (cid: string) => void; onEndSessions: (cids: string[], t?: string) => void;
  onReopenSession: (cid: string) => void; onToggleChild: (cid: string) => void;
  onAddGroup: (gid: string) => void; onRemoveGroup: (gid: string) => void;
  onEditEventTime: (cid: string, idx: number, t: string) => void; onEditStartTime: (cid: string, t: string) => void; onEditEndTime: (cid: string, t: string) => void;
  onExportPDF: () => void;
  onPrintBlank: () => void;
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
          <button onClick={onPrintBlank} className="text-xs text-slate-300 border border-slate-600 px-2 py-1.5 rounded-lg flex-shrink-0" title="Fiche papier vierge à remplir au stylo">🖨</button>
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
