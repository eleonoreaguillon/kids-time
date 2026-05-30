-- ─────────────────────────────────────────────────────────────────────────────
-- Hache les mots de passe de partage avec bcrypt (pgcrypto).
-- Apres cette migration :
--   - les mots de passe existants en clair sont hashes en bcrypt
--   - la verification se fait via crypt() dans get_project_by_token
--   - le client ne lit plus jamais la valeur ; il utilise une RPC pour la mettre
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Hash les valeurs existantes (uniquement celles qui ne sont pas deja hashees)
UPDATE projects
SET share_password = crypt(share_password, gen_salt('bf', 10))
WHERE share_password IS NOT NULL
  AND share_password <> ''
  AND share_password NOT LIKE '$2%';

-- RPC pour definir/effacer le mot de passe (avec hashing cote serveur)
DROP FUNCTION IF EXISTS public.set_project_share_password(uuid, text);

CREATE OR REPLACE FUNCTION public.set_project_share_password(
  p_project_id uuid,
  p_password   text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  SELECT user_id INTO v_owner FROM projects WHERE id = p_project_id;
  IF v_owner IS NULL OR v_owner <> auth.uid() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  IF p_password IS NULL OR p_password = '' THEN
    UPDATE projects SET share_password = NULL WHERE id = p_project_id;
  ELSE
    UPDATE projects
    SET share_password = crypt(p_password, gen_salt('bf', 10))
    WHERE id = p_project_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_project_share_password(uuid, text) TO authenticated;
