-- ─────────────────────────────────────────────────────────────────────────────
-- get_project_by_token
-- Renvoie en JSON un projet partagé (lecture seule) à partir de son share_token.
-- Gère les cas : not_found / password_required / wrong_password.
-- Chaque shooting_day renvoyé garde STRICTEMENT son propre child_ids (pas
-- d'agrégation entre journées). Le share_password n'est jamais renvoyé.
-- ─────────────────────────────────────────────────────────────────────────────

-- L'ancienne version peut avoir un type de retour différent (json, record, ...)
-- → on supprime d'abord pour pouvoir recréer proprement.
DROP FUNCTION IF EXISTS public.get_project_by_token(uuid, text);

CREATE OR REPLACE FUNCTION public.get_project_by_token(
  p_token   uuid,
  p_password text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project   projects%ROWTYPE;
  v_children  jsonb;
  v_groups    jsonb;
  v_days      jsonb;
BEGIN
  -- 1) Récupère le projet par token
  SELECT * INTO v_project
  FROM projects
  WHERE share_token = p_token
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- 2) Vérifie le mot de passe si défini
  IF v_project.share_password IS NOT NULL AND v_project.share_password <> '' THEN
    IF p_password IS NULL OR p_password = '' THEN
      RETURN jsonb_build_object('error', 'password_required');
    END IF;
    IF p_password <> v_project.share_password THEN
      RETURN jsonb_build_object('error', 'wrong_password');
    END IF;
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

  -- 5) Charge les journées de tournage — chaque ligne garde son child_ids
  --    propre, aucun cross-join, aucune agrégation entre dates.
  SELECT COALESCE(jsonb_agg(to_jsonb(s.*) ORDER BY s.date), '[]'::jsonb)
    INTO v_days
  FROM shooting_days s
  WHERE s.project_id = v_project.id;

  -- 6) Renvoie le payload final (sans share_password)
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
GRANT EXECUTE ON FUNCTION public.get_project_by_token(uuid, text) TO anon, authenticated;
