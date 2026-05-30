-- ─────────────────────────────────────────────────────────────────────────────
-- RGPD - Confirmation par email avant suppression definitive
--
-- Architecture :
--   1. L utilisateur fait sa double-confirmation dans l UI
--   2. On appelle request_data_deletion() qui cree un token (1h de validite)
--   3. On envoie un magic link Supabase Auth avec emailRedirectTo contenant le token
--   4. L utilisateur clique le lien, atterrit sur /confirm-deletion?token=...,
--      authentifie via OTP, et confirme manuellement
--   5. On appelle confirm_data_deletion(token) qui supprime tout
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pending_deletions (
  token       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '1 hour'),
  used_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_pending_deletions_user_id ON public.pending_deletions (user_id);
CREATE INDEX IF NOT EXISTS idx_pending_deletions_expires ON public.pending_deletions (expires_at);

ALTER TABLE public.pending_deletions ENABLE ROW LEVEL SECURITY;
-- Pas de policies : seules les fonctions SECURITY DEFINER interagissent
-- (donc le client ne peut JAMAIS lire/ecrire directement les tokens)

-- ─────────────────────────────────────────────────────────────────────────────
-- request_data_deletion : cree un token de confirmation
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.request_data_deletion();

CREATE OR REPLACE FUNCTION public.request_data_deletion()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_token   uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Invalide les eventuels tokens precedents encore valides
  UPDATE pending_deletions
  SET used_at = now()
  WHERE user_id = v_user_id AND used_at IS NULL AND expires_at > now();

  -- Cree un nouveau token
  INSERT INTO pending_deletions (user_id) VALUES (v_user_id)
  RETURNING token INTO v_token;

  RETURN v_token;
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_data_deletion() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- confirm_data_deletion : valide le token + supprime toutes les donnees
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.confirm_data_deletion(uuid);

CREATE OR REPLACE FUNCTION public.confirm_data_deletion(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   uuid := auth.uid();
  v_pending   pending_deletions%ROWTYPE;
  v_projects  integer := 0;
  v_subs      integer := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT * INTO v_pending FROM pending_deletions WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid token';
  END IF;

  IF v_pending.user_id <> v_user_id THEN
    RAISE EXCEPTION 'token mismatch';
  END IF;

  IF v_pending.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'token already used';
  END IF;

  IF v_pending.expires_at < now() THEN
    RAISE EXCEPTION 'token expired';
  END IF;

  -- Marque le token comme utilise (avant la suppression, au cas ou)
  UPDATE pending_deletions SET used_at = now() WHERE token = p_token;

  -- Supprime les push subscriptions
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'push_subscriptions'
  ) THEN
    DELETE FROM push_subscriptions WHERE user_id = v_user_id;
    GET DIAGNOSTICS v_subs = ROW_COUNT;
  END IF;

  -- Supprime les projets (CASCADE sur le reste)
  DELETE FROM projects WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_projects = ROW_COUNT;

  RETURN jsonb_build_object(
    'deleted_projects', v_projects,
    'deleted_push_subscriptions', v_subs
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_data_deletion(uuid) TO authenticated;
