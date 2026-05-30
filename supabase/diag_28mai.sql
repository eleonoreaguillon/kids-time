-- 1) Combien de lignes shooting_days existent pour le 28 mai, tous projets confondus ?
SELECT id, project_id, date, array_length(child_ids, 1) AS nb_child_ids, child_ids
FROM shooting_days
WHERE date = '2026-05-28'
ORDER BY project_id;

-- 2) Pour CHAQUE projet qui a une journée le 28 mai, montre le nom + le compte
SELECT p.id AS project_id, p.name, sd.id AS day_id,
       array_length(sd.child_ids, 1) AS nb_child_ids,
       sd.child_ids
FROM shooting_days sd
JOIN projects p ON p.id = sd.project_id
WHERE sd.date = '2026-05-28';

-- 3) Pour chaque child_id présent le 28 mai, vérifier que l'enfant existe et
--    appartient bien au même projet (détecte les IDs "fantômes" ou cross-project)
SELECT sd.project_id, sd.date, cid AS child_id,
       c.first_name, c.last_name, c.project_id AS child_project_id,
       (c.project_id = sd.project_id) AS same_project,
       c.archived
FROM shooting_days sd,
     unnest(sd.child_ids) AS cid
LEFT JOIN children c ON c.id = cid
WHERE sd.date = '2026-05-28';
