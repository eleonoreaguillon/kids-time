-- ─────────────────────────────────────────────────────────────────────────────
-- share_access_log : trace chaque tentative d'accès à un lien de partage.
-- Permet d'afficher l'historique des consultations au propriétaire du projet
-- et de mettre en place un rate-limit (10 mauvais mots de passe par 15 min
-- bloque les tentatives suivantes).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.share_access_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  share_token   uuid NOT NULL,
  result        text NOT NULL CHECK (result IN ('ok', 'wrong_password', 'password_required', 'not_found', 'rate_limited')),
  user_agent    text,
  accessed_at   timestamptz NOT NULL DEFAULT now()
);

-- Index pour les recherches par token (rate-limit + affichage)
CREATE INDEX IF NOT EXISTS idx_share_access_log_token_time
  ON public.share_access_log (share_token, accessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_share_access_log_project_time
  ON public.share_access_log (project_id, accessed_at DESC);

-- RLS : seul le propriétaire du projet voit ses propres accès
ALTER TABLE public.share_access_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owner can read own share access log" ON public.share_access_log;
CREATE POLICY "Owner can read own share access log"
  ON public.share_access_log
  FOR SELECT
  TO authenticated
  USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

-- Pas de policy INSERT/UPDATE/DELETE : la table est écrite uniquement par la
-- fonction get_project_by_token qui est SECURITY DEFINER (bypass RLS).
