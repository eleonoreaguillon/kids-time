-- ─────────────────────────────────────────────────────────────────────────────
-- RGPD - Droit a l effacement
-- Fonction qui supprime toutes les donnees du compte authentifie :
--   - tous les projets (CASCADE supprime children, groups, shooting_days,
--     action_logs, share_access_log...)
--   - les eventuelles push_subscriptions
--
-- NB : le compte auth lui-meme n'est pas supprime par cette fonction
-- (necessite l'admin API Supabase). L'utilisateur est invite a contacter
-- l'editeur par email pour effacer aussi son compte auth.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.delete_all_my_data();

CREATE OR REPLACE FUNCTION public.delete_all_my_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id  uuid := auth.uid();
  v_projects integer := 0;
  v_subs     integer := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Supprime les push subscriptions (si la table existe)
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'push_subscriptions'
  ) THEN
    DELETE FROM push_subscriptions WHERE user_id = v_user_id;
    GET DIAGNOSTICS v_subs = ROW_COUNT;
  END IF;

  -- Supprime les projets (cascade sur enfants, groupes, jours, logs)
  DELETE FROM projects WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_projects = ROW_COUNT;

  RETURN jsonb_build_object(
    'deleted_projects', v_projects,
    'deleted_push_subscriptions', v_subs
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_all_my_data() TO authenticated;
