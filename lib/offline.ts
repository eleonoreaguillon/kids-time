// ─────────────────────────────────────────────────────────────────────────────
// Cache local + file d'attente pour le mode hors-ligne (palier 3 complet)
// Tous les writes sont appliques optimistement cote client, caches en
// localStorage, puis pousses vers Supabase. Hors-ligne ou erreur reseau :
// mise en file et rejouee au retour du reseau.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "./supabase";
import type { Project, Rules, Session } from "./types";

const KT_CACHE_V = 1;
export const ktProjectKey = (id: string) => `kt_proj_v${KT_CACHE_V}_${id}`;
const ktProjectListKey = (uid: string) => `kt_projs_v${KT_CACHE_V}_${uid}`;
const KT_QUEUE_KEY = `kt_queue_v${KT_CACHE_V}`;

// ─────────────────────────────────────────────────────────────────────────────
// File d'attente polymorphe
// ─────────────────────────────────────────────────────────────────────────────

export type QueueOp =
  | { kind: "day_upsert";     data: { id: string; project_id: string; date: string; child_ids: string[]; sessions: Record<string, Session> } }
  | { kind: "child_upsert";   data: { id: string; project_id: string; first_name: string; last_name: string; dob: string; vacation_periods: any[]; child_role: string | null; derogations: any[]; school_tracking: boolean; archived: boolean } }
  | { kind: "child_delete";   data: { id: string } }
  | { kind: "group_upsert";   data: { id: string; project_id: string; name: string; child_ids: string[] } }
  | { kind: "group_delete";   data: { id: string } }
  | { kind: "project_upsert"; data: { id: string; user_id: string; name: string; rules: Rules } }
  | { kind: "project_patch";  data: { id: string; patch: Record<string, any> } }
  | { kind: "project_delete"; data: { id: string } };

// Type legacy garde pour compat localStorage (anciens utilisateurs hors-ligne)
type LegacyQueuedDay = {
  id: string;
  project_id: string;
  date: string;
  child_ids: string[];
  sessions: Record<string, Session>;
  queuedAt: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Cache projets
// ─────────────────────────────────────────────────────────────────────────────

export function ktCacheProject(p: Project) {
  try { localStorage.setItem(ktProjectKey(p.id), JSON.stringify(p)); } catch {}
}
export function ktLoadProject(id: string): Project | null {
  try { const raw = localStorage.getItem(ktProjectKey(id)); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function ktCacheProjectList(uid: string, projects: Project[]) {
  try { localStorage.setItem(ktProjectListKey(uid), JSON.stringify(projects)); } catch {}
}
export function ktLoadProjectList(uid: string): Project[] {
  try { const raw = localStorage.getItem(ktProjectListKey(uid)); return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// File d'attente
// ─────────────────────────────────────────────────────────────────────────────

export function ktGetQueue(): QueueOp[] {
  try {
    const raw = localStorage.getItem(KT_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Migration auto depuis l'ancien format (tableau de jours sans champ kind)
    if (parsed.length && parsed[0] && !parsed[0].kind && parsed[0].id && parsed[0].sessions) {
      const migrated: QueueOp[] = parsed.map((d: LegacyQueuedDay) => ({
        kind: "day_upsert",
        data: { id: d.id, project_id: d.project_id, date: d.date, child_ids: d.child_ids, sessions: d.sessions },
      }));
      ktSetQueue(migrated);
      return migrated;
    }
    return parsed as QueueOp[];
  } catch { return []; }
}

function ktSetQueue(items: QueueOp[]) {
  try { localStorage.setItem(KT_QUEUE_KEY, JSON.stringify(items)); } catch {}
}

export function ktEnqueue(op: QueueOp) {
  let queue = ktGetQueue();
  // Collapse les upserts repetes sur le meme id : la derniere version gagne
  if (op.kind === "day_upsert" || op.kind === "child_upsert" || op.kind === "group_upsert" || op.kind === "project_upsert") {
    queue = queue.filter(q => !(q.kind === op.kind && (q.data as any).id === (op.data as any).id));
  }
  // Pour project_patch on fusionne les patches successifs
  if (op.kind === "project_patch") {
    const idx = queue.findIndex(q => q.kind === "project_patch" && q.data.id === op.data.id);
    if (idx >= 0) {
      const existing = queue[idx] as Extract<QueueOp, { kind: "project_patch" }>;
      existing.data.patch = { ...existing.data.patch, ...op.data.patch };
      ktSetQueue(queue);
      return;
    }
  }
  // Pour les deletes : on supprime aussi tout upsert anterieur sur le meme id
  if (op.kind === "child_delete") queue = queue.filter(q => !(q.kind === "child_upsert" && q.data.id === op.data.id));
  if (op.kind === "group_delete") queue = queue.filter(q => !(q.kind === "group_upsert" && q.data.id === op.data.id));
  if (op.kind === "project_delete") queue = queue.filter(q => !((q.kind === "project_upsert" || q.kind === "project_patch") && q.data.id === op.data.id));
  queue.push(op);
  ktSetQueue(queue);
}

export function ktQueueCount(): number {
  return ktGetQueue().length;
}

export async function ktReplayQueue(): Promise<number> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return ktQueueCount();
  const queue = ktGetQueue();
  const remaining: QueueOp[] = [];
  for (const op of queue) {
    try {
      let error: any = null;
      if (op.kind === "day_upsert") {
        ({ error } = await supabase.from("shooting_days").upsert(op.data, { onConflict: "id" }));
      } else if (op.kind === "child_upsert") {
        ({ error } = await supabase.from("children").upsert(op.data, { onConflict: "id" }));
      } else if (op.kind === "child_delete") {
        ({ error } = await supabase.from("children").delete().eq("id", op.data.id));
      } else if (op.kind === "group_upsert") {
        ({ error } = await supabase.from("groups").upsert(op.data, { onConflict: "id" }));
      } else if (op.kind === "group_delete") {
        ({ error } = await supabase.from("groups").delete().eq("id", op.data.id));
      } else if (op.kind === "project_upsert") {
        ({ error } = await supabase.from("projects").upsert(op.data, { onConflict: "id" }));
      } else if (op.kind === "project_patch") {
        ({ error } = await supabase.from("projects").update(op.data.patch).eq("id", op.data.id));
      } else if (op.kind === "project_delete") {
        ({ error } = await supabase.from("projects").delete().eq("id", op.data.id));
      }
      if (error) remaining.push(op);
    } catch { remaining.push(op); }
  }
  ktSetQueue(remaining);
  return remaining.length;
}
