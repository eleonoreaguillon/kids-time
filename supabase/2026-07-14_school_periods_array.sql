-- Remplace school_period (periode unique) par school_periods (plusieurs
-- periodes possibles), pour les projets longs ou le suivi scolaire ne
-- s'applique que sur certaines fenetres de temps distinctes.

ALTER TABLE children ADD COLUMN IF NOT EXISTS school_periods JSONB NOT NULL DEFAULT '[]';

-- Reprend la valeur de l'ancienne colonne (periode unique) si elle existe
-- encore, puis la supprime.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'children' AND column_name = 'school_period'
  ) THEN
    UPDATE children
    SET school_periods = jsonb_build_array(school_period)
    WHERE school_period IS NOT NULL
      AND (school_periods IS NULL OR school_periods = '[]'::jsonb);
    ALTER TABLE children DROP COLUMN school_period;
  END IF;
END $$;
