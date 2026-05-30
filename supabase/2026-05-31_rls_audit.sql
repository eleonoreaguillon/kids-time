-- ─────────────────────────────────────────────────────────────────────────────
-- Audit RLS complet pour KidsTime
--
-- Active Row-Level Security sur toutes les tables sensibles et garantit que
-- chaque utilisateur ne peut lire/ecrire QUE ses propres donnees. Idempotent :
-- a rejouer sans risque.
--
-- Tables couvertes :
--   - projects               (proprio direct : user_id = auth.uid())
--   - children               (proprio via projects)
--   - groups                 (proprio via projects)
--   - shooting_days          (proprio via projects)
--   - action_logs            (proprio via projects)        si la table existe
--   - push_subscriptions     (proprio direct : user_id)    si la table existe
--   - share_access_log       (lecture seule pour le proprio)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Affiche l etat actuel de RLS pour info (le NOTICE est visible dans le panel)
DO $audit$
DECLARE r record;
BEGIN
  RAISE NOTICE '--- ETAT RLS ACTUEL ---';
  FOR r IN
    SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
           (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) AS policy_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname IN ('projects','children','groups','shooting_days','action_logs','push_subscriptions','share_access_log')
    ORDER BY c.relname
  LOOP
    RAISE NOTICE '  % | RLS=% | policies=%', r.table_name, r.rls_enabled, r.policy_count;
  END LOOP;
END
$audit$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) projects : RLS + policies
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "projects_select_own" ON public.projects;
CREATE POLICY "projects_select_own" ON public.projects
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "projects_insert_own" ON public.projects;
CREATE POLICY "projects_insert_own" ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "projects_update_own" ON public.projects;
CREATE POLICY "projects_update_own" ON public.projects
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "projects_delete_own" ON public.projects;
CREATE POLICY "projects_delete_own" ON public.projects
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) children : RLS + policies via project_id
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.children ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "children_select_own" ON public.children;
CREATE POLICY "children_select_own" ON public.children
  FOR SELECT TO authenticated
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "children_insert_own" ON public.children;
CREATE POLICY "children_insert_own" ON public.children
  FOR INSERT TO authenticated
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "children_update_own" ON public.children;
CREATE POLICY "children_update_own" ON public.children
  FOR UPDATE TO authenticated
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()))
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "children_delete_own" ON public.children;
CREATE POLICY "children_delete_own" ON public.children
  FOR DELETE TO authenticated
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) groups : RLS + policies via project_id
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "groups_select_own" ON public.groups;
CREATE POLICY "groups_select_own" ON public.groups
  FOR SELECT TO authenticated
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "groups_insert_own" ON public.groups;
CREATE POLICY "groups_insert_own" ON public.groups
  FOR INSERT TO authenticated
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "groups_update_own" ON public.groups;
CREATE POLICY "groups_update_own" ON public.groups
  FOR UPDATE TO authenticated
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()))
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "groups_delete_own" ON public.groups;
CREATE POLICY "groups_delete_own" ON public.groups
  FOR DELETE TO authenticated
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) shooting_days : RLS + policies via project_id
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.shooting_days ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shooting_days_select_own" ON public.shooting_days;
CREATE POLICY "shooting_days_select_own" ON public.shooting_days
  FOR SELECT TO authenticated
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "shooting_days_insert_own" ON public.shooting_days;
CREATE POLICY "shooting_days_insert_own" ON public.shooting_days
  FOR INSERT TO authenticated
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "shooting_days_update_own" ON public.shooting_days;
CREATE POLICY "shooting_days_update_own" ON public.shooting_days
  FOR UPDATE TO authenticated
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()))
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "shooting_days_delete_own" ON public.shooting_days;
CREATE POLICY "shooting_days_delete_own" ON public.shooting_days
  FOR DELETE TO authenticated
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) action_logs (si la table existe) : RLS + policies via project_id
-- ─────────────────────────────────────────────────────────────────────────────
DO $action_logs$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = 'action_logs') THEN
    EXECUTE 'ALTER TABLE public.action_logs ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "action_logs_select_own" ON public.action_logs';
    EXECUTE 'CREATE POLICY "action_logs_select_own" ON public.action_logs
             FOR SELECT TO authenticated
             USING (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()))';

    EXECUTE 'DROP POLICY IF EXISTS "action_logs_insert_own" ON public.action_logs';
    EXECUTE 'CREATE POLICY "action_logs_insert_own" ON public.action_logs
             FOR INSERT TO authenticated
             WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()))';

    -- Les logs ne devraient pas etre modifies ni supprimes par le client.
    -- Pas de policy UPDATE/DELETE -> aucun acces.
  END IF;
END
$action_logs$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) push_subscriptions (si la table existe) : RLS + policies via user_id
-- ─────────────────────────────────────────────────────────────────────────────
DO $push$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = 'push_subscriptions') THEN
    EXECUTE 'ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "push_subscriptions_select_own" ON public.push_subscriptions';
    EXECUTE 'CREATE POLICY "push_subscriptions_select_own" ON public.push_subscriptions
             FOR SELECT TO authenticated USING (user_id = auth.uid())';

    EXECUTE 'DROP POLICY IF EXISTS "push_subscriptions_insert_own" ON public.push_subscriptions';
    EXECUTE 'CREATE POLICY "push_subscriptions_insert_own" ON public.push_subscriptions
             FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid())';

    EXECUTE 'DROP POLICY IF EXISTS "push_subscriptions_update_own" ON public.push_subscriptions';
    EXECUTE 'CREATE POLICY "push_subscriptions_update_own" ON public.push_subscriptions
             FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())';

    EXECUTE 'DROP POLICY IF EXISTS "push_subscriptions_delete_own" ON public.push_subscriptions';
    EXECUTE 'CREATE POLICY "push_subscriptions_delete_own" ON public.push_subscriptions
             FOR DELETE TO authenticated USING (user_id = auth.uid())';
  END IF;
END
$push$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8) share_access_log : RLS + lecture pour proprietaire (deja faite mais idempotent)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.share_access_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owner can read own share access log" ON public.share_access_log;
CREATE POLICY "Owner can read own share access log"
  ON public.share_access_log FOR SELECT TO authenticated
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid()));

-- (Pas de policy INSERT/UPDATE/DELETE : seule la fonction SECURITY DEFINER ecrit)

-- ─────────────────────────────────────────────────────────────────────────────
-- 9) Recapitulatif final
-- ─────────────────────────────────────────────────────────────────────────────
DO $final$
DECLARE r record;
BEGIN
  RAISE NOTICE '--- ETAT RLS APRES AUDIT ---';
  FOR r IN
    SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
           (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid) AS policy_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname IN ('projects','children','groups','shooting_days','action_logs','push_subscriptions','share_access_log')
    ORDER BY c.relname
  LOOP
    RAISE NOTICE '  % | RLS=% | policies=%', r.table_name, r.rls_enabled, r.policy_count;
  END LOOP;
END
$final$;
