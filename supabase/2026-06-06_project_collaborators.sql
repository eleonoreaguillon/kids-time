-- ─────────────────────────────────────────────────────────────────────────────
-- Collaboration : permet a plusieurs comptes de travailler sur un meme projet
--
-- Modele : projects.user_id reste le proprietaire (owner). Une nouvelle table
-- project_collaborators relie d'autres comptes en tant que collaborateurs.
--
-- Roles :
--   - Owner : tous droits + peut gerer collaborateurs, generer/revoquer le
--             lien de partage, supprimer le projet
--   - Collaborateur : tous droits d'edition/suppression sur enfants, groupes,
--             journees. Ne peut PAS : supprimer le projet, gerer les
--             collaborateurs, gerer le lien de partage.
--
-- Toutes les mutations passent par des RPC SECURITY DEFINER pour verifier le
-- role (owner requis pour invite/revoke). Les RLS des tables children /
-- groups / shooting_days sont etendues via la fonction can_access_project.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.project_collaborators (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  invited_by  uuid NOT NULL,
  invited_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_collab_user    ON public.project_collaborators (user_id);
CREATE INDEX IF NOT EXISTS idx_project_collab_project ON public.project_collaborators (project_id);

ALTER TABLE public.project_collaborators ENABLE ROW LEVEL SECURITY;

-- Lecture : le collaborateur voit sa propre ligne, le proprietaire voit
-- toutes les lignes de ses projets.
DROP POLICY IF EXISTS "collab_read" ON public.project_collaborators;
CREATE POLICY "collab_read" ON public.project_collaborators FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );
-- Pas de policies INSERT/UPDATE/DELETE : uniquement via les RPC ci-dessous.

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper : est-ce que l'utilisateur peut acceder au projet ? (owner ou collab)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.can_access_project(pid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM projects p WHERE p.id = pid AND p.user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM project_collaborators pc WHERE pc.project_id = pid AND pc.user_id = auth.uid());
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Mise a jour des RLS : projects, children, groups, shooting_days
-- ─────────────────────────────────────────────────────────────────────────────

-- projects : lecture + update = owner OU collab. Delete = owner uniquement.
DROP POLICY IF EXISTS "projects_select_own" ON public.projects;
CREATE POLICY "projects_select_own" ON public.projects FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR id IN (SELECT project_id FROM public.project_collaborators WHERE user_id = auth.uid())
  );
DROP POLICY IF EXISTS "projects_update_own" ON public.projects;
CREATE POLICY "projects_update_own" ON public.projects FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    OR id IN (SELECT project_id FROM public.project_collaborators WHERE user_id = auth.uid())
  )
  WITH CHECK (
    user_id = auth.uid()
    OR id IN (SELECT project_id FROM public.project_collaborators WHERE user_id = auth.uid())
  );
-- DELETE : owner uniquement (policy existante conservee)

-- children : full access si peut acceder au projet
DROP POLICY IF EXISTS "children_select_own" ON public.children;
DROP POLICY IF EXISTS "children_insert_own" ON public.children;
DROP POLICY IF EXISTS "children_update_own" ON public.children;
DROP POLICY IF EXISTS "children_delete_own" ON public.children;
DROP POLICY IF EXISTS "children_access"     ON public.children;
CREATE POLICY "children_access" ON public.children FOR ALL TO authenticated
  USING (public.can_access_project(project_id))
  WITH CHECK (public.can_access_project(project_id));

-- groups
DROP POLICY IF EXISTS "groups_select_own" ON public.groups;
DROP POLICY IF EXISTS "groups_insert_own" ON public.groups;
DROP POLICY IF EXISTS "groups_update_own" ON public.groups;
DROP POLICY IF EXISTS "groups_delete_own" ON public.groups;
DROP POLICY IF EXISTS "groups_access"     ON public.groups;
CREATE POLICY "groups_access" ON public.groups FOR ALL TO authenticated
  USING (public.can_access_project(project_id))
  WITH CHECK (public.can_access_project(project_id));

-- shooting_days
DROP POLICY IF EXISTS "shooting_days_select_own" ON public.shooting_days;
DROP POLICY IF EXISTS "shooting_days_insert_own" ON public.shooting_days;
DROP POLICY IF EXISTS "shooting_days_update_own" ON public.shooting_days;
DROP POLICY IF EXISTS "shooting_days_delete_own" ON public.shooting_days;
DROP POLICY IF EXISTS "shooting_days_access"     ON public.shooting_days;
CREATE POLICY "shooting_days_access" ON public.shooting_days FOR ALL TO authenticated
  USING (public.can_access_project(project_id))
  WITH CHECK (public.can_access_project(project_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- RPCs : invite / revoke / list
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.invite_collaborator(uuid, text);
CREATE OR REPLACE FUNCTION public.invite_collaborator(p_project_id uuid, p_email text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner  uuid;
  v_target uuid;
  v_email  text := lower(trim(p_email));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  SELECT user_id INTO v_owner FROM projects WHERE id = p_project_id;
  IF v_owner IS NULL OR v_owner <> auth.uid() THEN
    RETURN jsonb_build_object('error', 'not_owner');
  END IF;
  IF v_email IS NULL OR v_email = '' THEN
    RETURN jsonb_build_object('error', 'invalid_email');
  END IF;
  SELECT id INTO v_target FROM auth.users WHERE lower(email) = v_email LIMIT 1;
  IF v_target IS NULL THEN
    RETURN jsonb_build_object('error', 'no_account');
  END IF;
  IF v_target = auth.uid() THEN
    RETURN jsonb_build_object('error', 'self');
  END IF;
  INSERT INTO project_collaborators (project_id, user_id, invited_by)
  VALUES (p_project_id, v_target, auth.uid())
  ON CONFLICT (project_id, user_id) DO NOTHING;
  RETURN jsonb_build_object('ok', true, 'user_id', v_target);
END;
$$;
GRANT EXECUTE ON FUNCTION public.invite_collaborator(uuid, text) TO authenticated;

DROP FUNCTION IF EXISTS public.revoke_collaborator(uuid, uuid);
CREATE OR REPLACE FUNCTION public.revoke_collaborator(p_project_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  SELECT user_id INTO v_owner FROM projects WHERE id = p_project_id;
  IF v_owner IS NULL OR v_owner <> auth.uid() THEN
    RETURN jsonb_build_object('error', 'not_owner');
  END IF;
  DELETE FROM project_collaborators WHERE project_id = p_project_id AND user_id = p_user_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.revoke_collaborator(uuid, uuid) TO authenticated;

DROP FUNCTION IF EXISTS public.list_collaborators(uuid);
CREATE OR REPLACE FUNCTION public.list_collaborators(p_project_id uuid)
RETURNS TABLE (user_id uuid, email text, invited_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  SELECT p.user_id INTO v_owner FROM projects p WHERE p.id = p_project_id;
  -- Owner OU collab peut lister
  IF v_owner IS NULL
     OR (v_owner <> auth.uid()
         AND NOT EXISTS (SELECT 1 FROM project_collaborators WHERE project_id = p_project_id AND user_id = auth.uid())) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT pc.user_id, u.email::text, pc.invited_at
    FROM project_collaborators pc
    JOIN auth.users u ON u.id = pc.user_id
    WHERE pc.project_id = p_project_id
    ORDER BY pc.invited_at;
END;
$$;
GRANT EXECUTE ON FUNCTION public.list_collaborators(uuid) TO authenticated;
