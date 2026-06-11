// ─────────────────────────────────────────────────────────────────────────────
// Types et constantes du domaine metier KidsTime
// ─────────────────────────────────────────────────────────────────────────────

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
  /** Affiche le depassement d'amplitude dans les exports (default: true) */
  showAmplitudeOverage?: boolean;
}

export interface VacationPeriod { start: string; end: string; }
export interface Derogation { date: string; end_time: string; }

export interface Child {
  id: string;
  project_id: string;
  first_name: string;
  last_name: string;
  dob: string;
  vacation_periods: VacationPeriod[];
  role?: ChildRole;
  archived?: boolean;
  derogations?: Derogation[];
  school_tracking?: boolean;
}

export interface Group {
  id: string;
  project_id: string;
  name: string;
  child_ids: string[];
}

export interface SessionEvent {
  type: "pause_start" | "pause_end" | "dejeuner_start" | "dejeuner_end" | "school_start" | "school_end";
  time: string;
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Constantes metier (DRIEETS)
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_RULES: Rules = {
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
  showAmplitudeOverage: true,
};

export const AGE_BANDS: AgeBand[] = ["0-2", "3-5", "6-11", "12-16", "16-18"];

export const AGE_BAND_LABELS: Record<AgeBand, string> = {
  "0-2": "< 3 ans", "3-5": "3-5 ans", "6-11": "6-11 ans", "12-16": "12-15 ans", "16-18": "16-17 ans",
};

// Repos quotidien minimum (en minutes) : 14h pour < 16 ans, 12h pour 16-18
export const MIN_DAILY_REST_BY_BAND: Record<AgeBand, number> = {
  "0-2": 14 * 60, "3-5": 14 * 60, "6-11": 14 * 60, "12-16": 14 * 60, "16-18": 12 * 60,
};

// Heure par defaut au-dela de laquelle le travail necessite une derogation
export const DEFAULT_NIGHT_LIMIT_BY_BAND: Record<AgeBand, string> = {
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
