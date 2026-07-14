-- ─────────────────────────────────────────────────────────────────────────────
-- Corrige le lien de partage : crypt()/gen_salt() (pgcrypto) sont introuvables
-- car ces fonctions n'ont que `search_path = public`, alors que sur Supabase
-- pgcrypto est installee dans le schema `extensions`. Consequence : la
-- verification du mot de passe de partage echoue toujours avec une erreur
-- Postgres ("function crypt(text, text) does not exist").
--
-- Correctif : on ajoute `extensions` au search_path des deux fonctions
-- concernees, sans toucher au reste de leur logique.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER FUNCTION public.get_project_by_token(uuid, text, text)
  SET search_path = public, extensions;

ALTER FUNCTION public.set_project_share_password(uuid, text)
  SET search_path = public, extensions;
