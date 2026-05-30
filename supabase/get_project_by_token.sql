-- ─────────────────────────────────────────────────────────────────────────────
-- get_project_by_token
-- Renvoie en JSON un projet partagé (lecture seule) à partir de son share_token.
-- Gère les cas : not_found / password_required / wrong_password / rate_limited.
--
-- Sécurité :
--  - Chaque tentative est loggée dans share_access_log (token, résultat, UA)
--  - Si > 10 mauvais mots de passe en 15 min sur le même token → rate_limited
--  - Chaque shooting_day garde STRICTEMENT son propre child_ids (DISTINCT ON
--    par date, garde la ligne avec le plus d'enfants en cas de doublon)
--  - share_password n'est jamais renvoyé dans le payload
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop toutes les surcharges existantes
DO $cleanup$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT oid::regprocedure AS sig
    FROM pg_proc
    WHERE proname = 'get_project_by_token'
      AND pronamespace = 'public'::regnamespace
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.sig || ' CASCADE';
  END LOOP;
END
$cleanup$;

CREATE OR REPLACE FUNCTION public.get_project_by_token(
  p_token      uuid,
  p_password   text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project       projects%ROWTYPE;
  v_children      jsonb;
  v_groups        jsonb;
  v_days          jsonb;
  v_recent_fails  integer;
  v_max_fails     integer  := 10;            -- seuil de tentatives échouées
  v_window        interval := '15 minutes';  -- fenêtre du rate-limit
BEGIN
  -- 1) Récupère le projet par token
  SELECT * INTO v_project
  FROM projects
  WHERE share_token = p_token
  LIMIT 1;

  IF NOT FOUND THEN
    INSERT INTO share_access_log (project_id, share_token, result, user_agent)
    VALUES (NULL, p_token, 'not_found', p_user_agent);
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- 2a) Sécurité : un lien partagé DOIT toujours être protégé par un mot de
  --     passe. Si aucun mot de passe n'est défini sur le projet, on bloque
  --     l'accès quelle que soit la valeur passée par l'appelant.
  IF v_project.share_password IS NULL OR v_project.share_password = '' THEN
    INSERT INTO share_access_log (project_id, share_token, result, user_agent)
    VALUES (v_project.id, p_token, 'password_required', p_user_agent);
    RETURN jsonb_build_object('error', 'password_required');
  END IF;

  -- 2b) Rate-limit : combien d'échecs de mot de passe pour ce token sur la
  --     fenêtre récente ? Si >= seuil → bloque temporairement.
  SELECT COUNT(*) INTO v_recent_fails
  FROM share_access_log
  WHERE share_token = p_token
    AND result = 'wrong_password'
    AND accessed_at >= (now() - v_window);

  IF v_recent_fails >= v_max_fails THEN
    INSERT INTO share_access_log (project_id, share_token, result, user_agent)
    VALUES (v_project.id, p_token, 'rate_limited', p_user_agent);
    RETURN jsonb_build_object('error', 'rate_limited');
  END IF;

  IF p_password IS NULL OR p_password = '' THEN
    INSERT INTO share_access_log (project_id, share_token, result, user_agent)
    VALUES (v_project.id, p_token, 'password_required', p_user_agent);
    RETURN jsonb_build_object('error', 'password_required');
  END IF;

  IF p_password <> v_project.share_password THEN
    INSERT INTO share_access_log (project_id, share_token, result, user_agent)
    VALUES (v_project.id, p_token, 'wrong_password', p_user_agent);
    RETURN jsonb_build_object('error', 'wrong_password');
  END IF;

  -- 3) Charge les enfants du projet
  SELECT COALESCE(jsonb_agg(to_jsonb(c.*) ORDER BY c.last_name, c.first_name), '[]'::jsonb)
    INTO v_children
  FROM children c
  WHERE c.project_id = v_project.id;

  -- 4) Charge les groupes du projet
  SELECT COALESCE(jsonb_agg(to_jsonb(g.*) ORDER BY g.name), '[]'::jsonb)
    INTO v_groups
  FROM groups g
  WHERE g.project_id = v_project.id;

  -- 5) Charge les journées de tournage — DISTINCT ON par date (anti-doublons)
  SELECT COALESCE(jsonb_agg(to_jsonb(s.*) ORDER BY s.date), '[]'::jsonb)
    INTO v_days
  FROM (
    SELECT DISTINCT ON (date) *
    FROM shooting_days
    WHERE project_id = v_project.id
    ORDER BY date,
             jsonb_array_length(COALESCE(child_ids, '[]'::jsonb)) DESC,
             id
  ) s;

  -- 6) Log l'accès réussi
  INSERT INTO share_access_log (project_id, share_token, result, user_agent)
  VALUES (v_project.id, p_token, 'ok', p_user_agent);

  -- 7) Renvoie le payload (sans share_password)
  RETURN jsonb_build_object(
    'id',            v_project.id,
    'name',          v_project.name,
    'rules',         v_project.rules,
    'share_token',   v_project.share_token,
    'children',      v_children,
    'groups',        v_groups,
    'shooting_days', v_days
  );
END;
$$;

-- Autorise l'appel anonyme (lien public)
GRANT EXECUTE ON FUNCTION public.get_project_by_token(uuid, text, text) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Fonction d'aide : récupère les N derniers accès pour un projet donné.
-- Utilisée par l'app pour afficher l'historique des consultations.
-- Le projet est authentifié via la session utilisateur (RLS s'applique sur
-- la lecture de la table share_access_log).
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_share_access_history(uuid, integer);

CREATE OR REPLACE FUNCTION public.get_share_access_history(
  p_project_id uuid,
  p_limit      integer DEFAULT 20
)
RETURNS TABLE (
  result      text,
  user_agent  text,
  accessed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT l.result, l.user_agent, l.accessed_at
  FROM share_access_log l
  WHERE l.project_id = p_project_id
  ORDER BY l.accessed_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 100));
$$;

GRANT EXECUTE ON FUNCTION public.get_share_access_history(uuid, integer) TO authenticated;
