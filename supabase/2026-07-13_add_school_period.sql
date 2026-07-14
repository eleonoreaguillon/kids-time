-- Ajoute la colonne school_period sur children : periode (debut/fin) sur
-- laquelle le suivi scolaire s'applique. Si NULL alors que school_tracking
-- est actif, le suivi s'applique sur toute la duree du projet (retro-compat
-- avec les enfants existants qui n'ont pas de periode definie).

ALTER TABLE children
  ADD COLUMN IF NOT EXISTS school_period JSONB;
