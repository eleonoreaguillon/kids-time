-- Ajoute la colonne school_tracking sur children (flag par enfant pour activer
-- le bouton "📚 Suivi scolaire" sur la vue tournage).
-- Le temps de suivi scolaire est inclus dans l'amplitude mais ne compte ni dans
-- le temps de travail ni dans les pauses valides.

ALTER TABLE children
  ADD COLUMN IF NOT EXISTS school_tracking BOOLEAN NOT NULL DEFAULT false;
