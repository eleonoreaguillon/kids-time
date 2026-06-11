// ─────────────────────────────────────────────────────────────────────────────
// Fonctions d'export : recap par jour, par enfant, recap global PDF
// (les exports Excel/CSV historiques sont conserves pour compat mais ne sont
// plus cables a l'UI)
// ─────────────────────────────────────────────────────────────────────────────

import {
  AGE_BAND_LABELS,
  ALL_ROLES,
  ROLE_LABELS,
  type Child,
  type ChildRole,
  type Period,
  type Project,
  type Session,
  type SessionStats,
  type ShootingDay,
} from "./types";
import {
  computeSessionStats,
  formatMinutes,
  formatTime,
  getAge,
  getAgeBand,
  isVacation,
  sortByRoleThenAlpha,
} from "./helpers";

export function buildExportRows(project: Project, dateStr: string) {
  const day = project.shootingDays[dateStr]; if (!day) return [];
  const showAmpOver = project.rules.showAmplitudeOverage !== false;
  const rows: any[] = [];
  // Tri statut → nom de famille (alpha) pour des exports coherents avec l'ecran
  const orderedChildren = sortByRoleThenAlpha((day.child_ids || []).map(id => project.children.find(c => c.id === id)).filter(Boolean) as Child[]);
  for (const child of orderedChildren) {
    const childId = child.id;
    const session = day.sessions?.[childId];
    const vacation = isVacation(child, dateStr);
    const band = getAgeBand(child.dob);
    const period: Period = vacation ? "vacation" : "school";
    const maxWork = project.rules.maxWorkMinutes[band][period];
    const maxAmp = project.rules.maxAmplitudeMinutes;
    const stats = computeSessionStats(session, project.rules);
    const workOver = stats ? Math.max(0, stats.workMin - maxWork) : 0;
    const ampOver = stats ? Math.max(0, stats.amplitudeMin - maxAmp) : 0;
    const breakSlotsStr = stats?.breakSlots.filter(b => b.valid && b.kind === "pause").map(b => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join(" / ") || "--";
    const dejeunerSlotsStr = stats?.breakSlots.filter(b => b.kind === "dejeuner").map(b => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join(" / ") || "--";
    const schoolSlotsStr = stats?.breakSlots.filter(b => b.kind === "school").map(b => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join(" / ") || "--";
    rows.push({
      "Nom Prénom": `${child.first_name} ${child.last_name}`.trim(),
      "Statut": child.role ? ROLE_LABELS[child.role] : "--",
      "Date de naissance": child.dob, "Tranche d'âge": band,
      "Période": vacation ? "Vacances" : "Scolaire",
      "Heure de convocation": session?.start_time ? formatTime(session.start_time) : "--",
      "Heure de fin": session?.end_time ? formatTime(session.end_time) : "--",
      "Durée totale de travail": stats ? formatMinutes(stats.workMin) : "--",
      "Temps de travail autorisé": formatMinutes(maxWork),
      "Dépassement travail": workOver > 0 ? formatMinutes(workOver) : "0",
      "Pause déjeuner": stats ? formatMinutes(stats.dejeunerMin) : "--",
      "Plages déjeuner": dejeunerSlotsStr,
      "Suivi scolaire": stats ? formatMinutes(stats.schoolMin) : "--",
      "Plages suivi scolaire": schoolSlotsStr,
      "Durée totale des pauses": stats ? formatMinutes(stats.breakMin) : "--",
      "Pauses valides": stats ? formatMinutes(stats.validBreakMin) : "--",
      "Plages horaires des pauses": breakSlotsStr,
      "Amplitude de présence": stats ? formatMinutes(stats.amplitudeMin) : "--",
      ...(showAmpOver ? {
        "Amplitude autorisée": formatMinutes(maxAmp),
        "Dépassement amplitude": ampOver > 0 ? formatMinutes(ampOver) : "0",
      } : {}),
      _child: child, _session: session, _stats: stats, _maxWork: maxWork, _maxAmp: maxAmp, _vacation: vacation, _band: band, _date: dateStr, _showAmpOver: showAmpOver,
    });
  }
  return rows;
}

// PDF d'une journee (un tableau par enfant, regroupes par statut)
export function exportDayToPDF(project: Project, dateStr: string) {
  const day = project.shootingDays[dateStr]; if (!day) return;
  const dateLabel = new Date(dateStr + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const showAmpOver = project.rules.showAmplitudeOverage !== false;
  const childTable = (row: any) => {
    const { _child: child, _session: session, _stats: stats, _maxWork: maxWork, _maxAmp: maxAmp, _vacation: vacation, _band: band } = row;
    const workOver = stats ? Math.max(0, stats.workMin - maxWork) : 0;
    const ampOver = stats ? Math.max(0, stats.amplitudeMin - maxAmp) : 0;
    const bStr = stats?.breakSlots.filter((b: any) => b.valid && b.kind === "pause").map((b: any) => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join("<br>") || "--";
    const dStr = stats?.breakSlots.filter((b: any) => b.kind === "dejeuner").map((b: any) => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join("<br>") || "--";
    const sStr = stats?.breakSlots.filter((b: any) => b.kind === "school").map((b: any) => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join("<br>") || "--";
    const showSchool = child.school_tracking || (stats && stats.schoolMin > 0);
    return `<table><tr><th colspan="4">${child.first_name} ${child.last_name}${child.role ? ` — ${ROLE_LABELS[child.role as ChildRole]}` : ""} — ${getAge(child.dob)} ans (${band} ans) — ${vacation ? "Vacances" : "Scolaire"}</th></tr>
      <tr><td><b>Convocation</b><br>${session?.start_time ? formatTime(session.start_time) : "--"}</td><td><b>Fin</b><br>${session?.end_time ? formatTime(session.end_time) : "--"}</td><td><b>Amplitude</b><br>${stats ? formatMinutes(stats.amplitudeMin) : "--"}</td>${showAmpOver ? `<td><b>Max amplitude</b><br>${formatMinutes(maxAmp)}</td>` : `<td></td>`}</tr>
      <tr><td><b>Travail total</b><br>${stats ? formatMinutes(stats.workMin) : "--"}</td><td><b>Max travail</b><br>${formatMinutes(maxWork)}</td><td><b>Dépass. travail</b><br><span class="${workOver > 0 ? "over" : "ok"}">${workOver > 0 ? formatMinutes(workOver) : "OK"}</span></td>${showAmpOver ? `<td><b>Dépass. amplitude</b><br><span class="${ampOver > 0 ? "over" : "ok"}">${ampOver > 0 ? formatMinutes(ampOver) : "OK"}</span></td>` : `<td></td>`}</tr>
      <tr><td><b>🍽 Déjeuner</b><br>${stats ? formatMinutes(stats.dejeunerMin) : "--"}</td><td><b>Plages déjeuner</b><br>${dStr}</td><td><b>Pauses valides</b><br>${stats ? formatMinutes(stats.validBreakMin) : "--"}</td><td><b>Plages de pauses</b><br>${bStr}</td></tr>
      ${showSchool ? `<tr><td><b>📚 Suivi scolaire</b><br>${stats ? formatMinutes(stats.schoolMin) : "--"}</td><td colspan="3"><b>Plages suivi scolaire</b><br>${sStr}</td></tr>` : ""}</table>`;
  };
  const allRows = buildExportRows(project, dateStr);
  let html = `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:Arial,sans-serif;font-size:11px;color:#111;padding:16px}
    .back-btn{display:inline-block;margin-bottom:16px;padding:8px 16px;background:#1e3a5f;color:white;border:none;border-radius:8px;font-size:13px;cursor:pointer;text-decoration:none}
    h1{font-size:16px;margin-bottom:4px}h2{font-size:12px;color:#444;margin-bottom:12px;font-weight:normal}
    h3{font-size:11px;color:#1e3a5f;border-bottom:2px solid #1e3a5f;padding-bottom:3px;margin:16px 0 8px}
    table{width:100%;border-collapse:collapse;margin-bottom:12px}
    th{background:#1e3a5f;color:white;padding:5px 6px;text-align:left;font-size:9px}
    td{padding:4px 6px;border-bottom:1px solid #e5e7eb;vertical-align:top;font-size:9px}
    tr:nth-child(even) td{background:#f8fafc}.over{color:#dc2626;font-weight:bold}.ok{color:#16a34a}
    .footer{margin-top:20px;font-size:8px;color:#999;text-align:center}
    @media print{.back-btn{display:none}}
  </style></head><body>
  <button class="back-btn" onclick="window.close()">← Retour</button>
  <h1>KidsTime — Récapitulatif par enfant</h1><h2>${dateLabel} · ${project.name}</h2>`;
  for (const role of ALL_ROLES) { const rr = allRows.filter(r => r._child?.role === role); if (rr.length > 0) { html += `<h3>${ROLE_LABELS[role]} (${rr.length})</h3>`; html += rr.map(childTable).join(""); } }
  const nr = allRows.filter(r => !r._child?.role); if (nr.length > 0) { html += `<h3>Statut non défini (${nr.length})</h3>`; html += nr.map(childTable).join(""); }
  html += `<div class="footer">Généré par KidsTime · Éléonore Aguillon · ACMA Fiction · ${new Date().toLocaleDateString("fr-FR")}</div></body></html>`;
  const w = window.open("", "_blank"); if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 500); }
}

// Fiche papier vierge a remplir au stylo sur le plateau (backup hors-ligne).
// Optimisee A4 portrait, noir & blanc, lisible et avec assez d'espace pour
// noter les horaires a la main.
export function exportDayBlankSheet(project: Project, dateStr: string) {
  const day = project.shootingDays[dateStr]; if (!day) return;
  const dateLabel = new Date(dateStr + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const orderedChildren = sortByRoleThenAlpha((day.child_ids || []).map(id => project.children.find(c => c.id === id)).filter(Boolean) as Child[]);
  if (orderedChildren.length === 0) { alert("Aucun enfant prévu pour cette journée."); return; }

  const childRow = (child: Child, i: number) => {
    const band = getAgeBand(child.dob);
    const vacation = isVacation(child, dateStr);
    const period: Period = vacation ? "vacation" : "school";
    const maxWork = project.rules.maxWorkMinutes[band][period];
    const maxAmp = project.rules.maxAmplitudeMinutes;
    return `<tr>
      <td class="num">${i + 1}</td>
      <td class="name"><b>${child.last_name.toUpperCase()}</b> ${child.first_name}<br><span class="meta">${getAge(child.dob)} ans · ${AGE_BAND_LABELS[band]} · ${child.role ? ROLE_LABELS[child.role] : "—"} · ${vacation ? "Vacances" : "Scolaire"}</span></td>
      <td class="t cap">Max travail<br><b>${formatMinutes(maxWork)}</b><br>Max ampl.<br><b>${formatMinutes(maxAmp)}</b></td>
      <td class="t"></td>
      <td class="t"></td>
      <td class="t"></td>
      <td class="t"></td>
      <td class="t"></td>
      <td class="t"></td>
    </tr>`;
  };

  const html = `<html><head><meta charset="utf-8"><title>Fiche papier — ${dateLabel}</title>
  <style>
    @page { size: A4 portrait; margin: 10mm 10mm 12mm 10mm; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 10px; color: #000; margin: 0; }
    .back-btn { display: inline-block; margin: 8px; padding: 8px 16px; background: #1e3a5f; color: white; border: none; border-radius: 8px; font-size: 13px; cursor: pointer; }
    .sheet { padding: 4mm 6mm; }
    h1 { font-size: 16px; margin: 0 0 2px 0; }
    .sub { font-size: 11px; margin: 0 0 6px 0; }
    .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #000; padding-bottom: 4px; margin-bottom: 6px; }
    .header .right { text-align: right; font-size: 9px; line-height: 1.4; }
    .header .right .field { display: inline-block; min-width: 100px; border-bottom: 1px solid #000; padding: 0 4px 1px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th { background: #000; color: white; font-size: 9px; padding: 4px 3px; text-align: center; font-weight: 600; border: 0.5px solid #000; }
    td { border: 0.5px solid #555; padding: 4px 3px; vertical-align: top; height: 38px; }
    td.num { width: 4%; text-align: center; font-weight: 700; font-size: 11px; }
    td.name { width: 19%; font-size: 10px; }
    td.name .meta { font-size: 7.5px; color: #444; }
    td.t { width: 9%; }
    td.cap { width: 11%; font-size: 8px; text-align: center; color: #444; background: #f4f4f4; }
    .legend { font-size: 8px; color: #444; margin-top: 6px; }
    .remarks { margin-top: 6mm; border: 1px solid #000; padding: 4px 6px; min-height: 28mm; }
    .remarks-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 2px; }
    .footer { font-size: 7.5px; color: #666; margin-top: 4mm; text-align: center; border-top: 0.5px solid #ccc; padding-top: 2px; }
    @media print { .back-btn { display: none; } }
  </style></head><body>
  <button class="back-btn" onclick="window.close()">← Retour</button>
  <div class="sheet">
    <div class="header">
      <div>
        <h1>KIDSTIME — Fiche de tournage (papier)</h1>
        <div class="sub"><b>${project.name}</b> — ${dateLabel}</div>
      </div>
      <div class="right">
        AD enfants : <span class="field">&nbsp;</span><br>
        Production : <span class="field">&nbsp;</span><br>
        Lieu : <span class="field">&nbsp;</span>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>#</th>
          <th style="text-align:left;padding-left:6px">Nom Prénom</th>
          <th>Limites<br>DRIEETS</th>
          <th>Convoc.</th>
          <th>Pause<br>début</th>
          <th>Pause<br>fin</th>
          <th>Déjeuner<br>début</th>
          <th>Déjeuner<br>fin</th>
          <th>Fin de<br>journée</th>
        </tr>
      </thead>
      <tbody>
        ${orderedChildren.map(childRow).join("")}
      </tbody>
    </table>

    <div class="legend">
      Remplir au stylo. Reporter ensuite dans l'app KidsTime pour archivage et exports DRIEETS. Toutes les colonnes horaires sont au format HH:MM.
    </div>

    <div class="remarks">
      <div class="remarks-title">Remarques / Événements de la journée</div>
    </div>

    <div class="footer">
      Généré par KidsTime · ${new Date().toLocaleDateString("fr-FR")} · Backup papier à conserver
    </div>
  </div>
  </body></html>`;

  const w = window.open("", "_blank");
  if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 500); }
}

// PDF "toutes les journees d'un enfant" — une ligne par jour
export function exportChildAllDays(project: Project, child: Child) {
  const days = Object.entries(project.shootingDays)
    .filter(([, day]) => day.child_ids?.includes(child.id))
    .sort(([a], [b]) => a.localeCompare(b));
  if (days.length === 0) { alert("Cet enfant n'a aucune journée enregistrée."); return; }

  const showAmpOver = project.rules.showAmplitudeOverage !== false;
  const childTable = (dateStr: string, day: ShootingDay) => {
    const session = day.sessions?.[child.id];
    const vacation = isVacation(child, dateStr);
    const band = getAgeBand(child.dob);
    const period: Period = vacation ? "vacation" : "school";
    const maxWork = project.rules.maxWorkMinutes[band][period];
    const maxAmp = project.rules.maxAmplitudeMinutes;
    const stats = computeSessionStats(session, project.rules);
    const workOver = stats ? Math.max(0, stats.workMin - maxWork) : 0;
    const ampOver = stats ? Math.max(0, stats.amplitudeMin - maxAmp) : 0;
    const bStr = stats?.breakSlots.filter(b => b.valid && b.kind === "pause").map((b) => `${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join(", ") || "--";
    const dStr = stats?.breakSlots.filter(b => b.kind === "dejeuner").map((b) => `🍽 ${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join(", ") || "--";
    const sStr = stats?.breakSlots.filter(b => b.kind === "school").map((b) => `📚 ${formatTime(b.start)}-${formatTime(b.end)} (${formatMinutes(b.durationMin)})`).join(", ") || "--";
    const dateLabel = new Date(dateStr + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
    return `<tr>
      <td>${dateLabel}</td>
      <td>${vacation ? "🌴 Vac." : "🏫 Scol."}</td>
      <td>${session?.start_time ? formatTime(session.start_time) : "--"}</td>
      <td>${session?.end_time ? formatTime(session.end_time) : "--"}</td>
      <td><span style="color:${!showAmpOver ? "inherit" : ampOver > 0 ? "#dc2626" : stats && stats.amplitudeMin === maxAmp ? "#ea580c" : "#16a34a"}">${stats ? formatMinutes(stats.amplitudeMin) : "--"}${showAmpOver ? ` / ${formatMinutes(maxAmp)}` : ""}</span></td>
      <td><span style="color:${workOver > 0 ? "#dc2626" : "#16a34a"}">${stats ? formatMinutes(stats.workMin) : "--"} / ${formatMinutes(maxWork)}</span></td>
      <td>${stats ? formatMinutes(stats.dejeunerMin) : "--"}</td>
      ${child.school_tracking ? `<td>${stats ? formatMinutes(stats.schoolMin) : "--"}</td>` : ""}
      <td>${stats ? formatMinutes(stats.validBreakMin) : "--"}</td>
      <td style="font-size:8px">${dStr ? dStr + " | " : ""}${bStr}${child.school_tracking && stats && stats.schoolMin > 0 ? " | " + sStr : ""}</td>
    </tr>`;
  };

  let html = `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:Arial,sans-serif;font-size:10px;padding:16px}
  .back-btn{display:inline-block;margin-bottom:16px;padding:8px 16px;background:#1e3a5f;color:white;border:none;border-radius:8px;font-size:13px;cursor:pointer}
  h1{font-size:16px}h2{font-size:12px;color:#444;font-weight:normal;margin-bottom:12px}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th{background:#1e3a5f;color:white;padding:5px 6px;text-align:left;font-size:9px}
  td{padding:4px 6px;border-bottom:1px solid #e5e7eb;vertical-align:top}
  tr:nth-child(even) td{background:#f8fafc}
  .footer{margin-top:20px;font-size:8px;color:#999;text-align:center}
  @media print{.back-btn{display:none}}</style></head><body>
  <button class="back-btn" onclick="window.close()">← Retour</button>
  <h1>KidsTime — Journées de ${child.first_name} ${child.last_name}</h1>
  <h2>${child.role ? ROLE_LABELS[child.role] + " · " : ""}${getAge(child.dob)} ans · Tranche ${AGE_BAND_LABELS[getAgeBand(child.dob)]} · ${project.name}</h2>
  <table><thead><tr>
    <th>Date</th><th>Période</th><th>Début</th><th>Fin</th><th>Amplitude</th><th>Travail / Max</th><th>🍽 Déjeuner</th>${child.school_tracking ? "<th>📚 Suivi sco.</th>" : ""}<th>Pauses valides</th><th>Plages déjeuner / pauses${child.school_tracking ? " / sco." : ""}</th>
  </tr></thead><tbody>`;
  for (const [dateStr, day] of days) { html += childTable(dateStr, day); }
  html += `</tbody></table>
  <div class="footer">Généré par KidsTime · Éléonore Aguillon · ACMA Fiction · ${new Date().toLocaleDateString("fr-FR")}</div></body></html>`;
  const w = window.open("", "_blank"); if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 500); }
}

// PDF global du projet (un bloc par enfant, dates en colonnes, format DRIEETS)
// selectedIds : si fourni, restreint aux enfants choisis.
export function exportProjectGlobalPDF(project: Project, selectedIds?: string[]) {
  const sortedDates = Object.keys(project.shootingDays).sort();
  if (sortedDates.length === 0) { alert("Aucune journée de tournage dans ce projet."); return; }
  const filterSet = selectedIds && selectedIds.length > 0 ? new Set(selectedIds) : null;
  const showAmpOver = project.rules.showAmplitudeOverage !== false;

  const fmtHHMM = (min: number | null | undefined): string => {
    if (!min || min <= 0) return "";
    const h = Math.floor(min / 60), m = min % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };
  const DAY_LETTERS = ["D","L","M","M","J","V","S"];
  const MONTH_NAMES = ["JANVIER","FÉVRIER","MARS","AVRIL","MAI","JUIN","JUILLET","AOÛT","SEPTEMBRE","OCTOBRE","NOVEMBRE","DÉCEMBRE"];

  const monthSpans: { month: string; count: number }[] = [];
  for (const d of sortedDates) {
    const month = MONTH_NAMES[new Date(d + "T12:00:00").getMonth()];
    if (!monthSpans.length || monthSpans[monthSpans.length - 1].month !== month) monthSpans.push({ month, count: 1 });
    else monthSpans[monthSpans.length - 1].count++;
  }

  const TH  = (bg: string) => `style="background:${bg};color:white;border:1px solid #bbb;text-align:center;font-size:7px;padding:3px 2px"`;
  const TDL = `style="text-align:left;padding:3px 6px;border:1px solid #ccc;font-size:8px;background:#f4f6fb;white-space:nowrap"`;
  const TDV = (extra="") => `style="text-align:center;padding:2px 3px;border:1px solid #ccc;font-size:8px;${extra}"`;
  const TDT = (extra="") => `style="text-align:center;padding:2px 4px;border:1px solid #ccc;font-weight:bold;font-size:8px;background:#e8eef8;${extra}"`;

  const headerMonths = monthSpans.map(s => `<th colspan="${s.count}" ${TH("#1e3a5f")}>${s.month}</th>`).join("");
  const headerJours  = sortedDates.map(d => `<th ${TH("#2d4a6f")}>${DAY_LETTERS[new Date(d+"T12:00:00").getDay()]}</th>`).join("");
  const headerDates  = sortedDates.map(d => `<th ${TH("#3d5a7f")}>${new Date(d+"T12:00:00").getDate()}</th>`).join("");

  let html = `<html><head><meta charset="utf-8">
  <style>
    body{font-family:Arial,sans-serif;font-size:8px;padding:12px;color:#111}
    .back-btn{display:inline-block;margin-bottom:12px;padding:8px 16px;background:#1e3a5f;color:white;border:none;border-radius:8px;font-size:13px;cursor:pointer}
    h1{font-size:14px;margin-bottom:2px}h2{font-size:10px;color:#444;font-weight:normal;margin-bottom:10px}
    .child-block{margin-bottom:24px;page-break-inside:avoid}
    table{border-collapse:collapse}
    .over{color:#dc2626;font-weight:bold}
    .footer{margin-top:16px;font-size:7px;color:#999;text-align:center}
    @media print{.back-btn{display:none}}
  </style></head><body>
  <button class="back-btn" onclick="window.close()">← Retour</button>
  <h1>KidsTime — Récapitulatif global</h1>
  <h2>${project.name} · Généré le ${new Date().toLocaleDateString("fr-FR")}</h2>`;

  for (const child of sortByRoleThenAlpha(project.children.filter(c => !c.archived && (!filterSet || filterSet.has(c.id))))) {
    type DayData = { inDay: boolean; session?: Session; vacation: boolean; maxWork: number; maxAmp: number; stats: SessionStats | null };
    const dd: Record<string, DayData> = {};
    for (const dateStr of sortedDates) {
      const day = project.shootingDays[dateStr];
      const inDay = (day.child_ids || []).includes(child.id);
      const vacation = isVacation(child, dateStr);
      const band = getAgeBand(child.dob);
      const period: Period = vacation ? "vacation" : "school";
      dd[dateStr] = {
        inDay, vacation,
        session: inDay ? day.sessions?.[child.id] : undefined,
        maxWork: project.rules.maxWorkMinutes[band][period],
        maxAmp: project.rules.maxAmplitudeMinutes,
        stats: inDay ? computeSessionStats(day.sessions?.[child.id], project.rules) : null,
      };
    }
    const childDates = sortedDates.filter(d => dd[d].inDay);
    if (childDates.length === 0) continue;

    let totWork = 0, totDejeuner = 0, totValidPause = 0, totSchool = 0, totAmp = 0, totWorkOver = 0, totAmpOver = 0;
    for (const d of childDates) {
      const { stats, maxWork, maxAmp } = dd[d];
      if (stats) {
        totWork += stats.workMin; totDejeuner += stats.dejeunerMin;
        totValidPause += stats.validBreakMin;
        totSchool += stats.schoolMin;
        totAmp += stats.amplitudeMin;
        totWorkOver += Math.max(0, stats.workMin - maxWork);
        totAmpOver  += Math.max(0, stats.amplitudeMin - maxAmp);
      }
    }

    const cells = (fn: (d: DayData) => string) =>
      sortedDates.map(ds => {
        const d = dd[ds];
        if (!d.inDay) return `<td ${TDV(d.vacation ? "background:#fffbeb" : "")}></td>`;
        return `<td ${TDV(d.vacation ? "background:#fffbeb" : "")}>${fn(d)}</td>`;
      }).join("");

    html += `<div class="child-block"><table>
      <thead>
        <tr>
          <td ${TDL} style="text-align:left;padding:3px 6px;border:1px solid #ccc;font-size:8px;background:#1e3a5f;color:white;font-weight:bold;white-space:nowrap">
            ${child.first_name} ${child.last_name}${child.role ? ` — ${ROLE_LABELS[child.role]}` : ""}&nbsp;(${childDates.length} jour${childDates.length > 1 ? "s" : ""})
          </td>
          <th ${TH("#374151")}>TOTAL</th>${headerMonths}
        </tr>
        <tr>
          <td ${TDL} style="text-align:left;padding:2px 6px;border:1px solid #ccc;font-size:7px;color:#666;background:#f4f6fb">JOUR</td>
          <td ${TDV()}></td>${headerJours}
        </tr>
        <tr>
          <td ${TDL} style="text-align:left;padding:2px 6px;border:1px solid #ccc;font-size:7px;color:#666;background:#f4f6fb">DATE</td>
          <td ${TDV()}></td>${headerDates}
        </tr>
        <tr>
          <td ${TDL} style="text-align:left;padding:2px 6px;border:1px solid #ccc;font-size:7px;color:#b45309;background:#fffbeb">VACANCES</td>
          <td ${TDV()}></td>
          ${sortedDates.map(ds => `<td ${TDV(dd[ds].inDay && dd[ds].vacation ? "background:#fffbeb;color:#b45309;font-weight:bold" : "")}>${dd[ds].inDay && dd[ds].vacation ? "VAC" : ""}</td>`).join("")}
        </tr>
      </thead>
      <tbody>
        <tr><td ${TDL}>Heure de convocation</td><td ${TDT()}></td>${cells(d => d.session?.start_time ? formatTime(d.session.start_time) : "")}</tr>
        <tr><td ${TDL}>Durée de pause déjeuner</td><td ${TDT()}></td>${cells(d => fmtHHMM(d.stats?.dejeunerMin ?? 0))}</tr>
        <tr><td ${TDL}>Durée des autres pauses</td><td ${TDT()}></td>${cells(d => fmtHHMM(d.stats?.validBreakMin ?? 0))}</tr>
        ${child.school_tracking || totSchool > 0 ? `<tr><td ${TDL}>📚 Suivi scolaire</td><td ${TDT()}>${fmtHHMM(totSchool)}</td>${cells(d => fmtHHMM(d.stats?.schoolMin ?? 0))}</tr>` : ""}
        <tr>
          <td ${TDL} style="text-align:left;padding:3px 6px;border:1px solid #ccc;font-size:8px;background:#f4f6fb;font-weight:bold;white-space:nowrap">Durée totale de travail (plateau, HMC, attente)</td>
          <td ${TDT()}></td>
          ${cells(d => `<b>${fmtHHMM(d.stats?.workMin ?? 0)}</b>`)}
        </tr>
        <tr><td ${TDL}>Heure de fin de journée</td><td ${TDT()}></td>${cells(d => d.session?.end_time ? formatTime(d.session.end_time) : "")}</tr>
        <tr><td ${TDL}>Temps de travail autorisé</td><td ${TDT()}></td>${cells(d => fmtHHMM(d.maxWork))}</tr>
        <tr>
          <td ${TDL} style="text-align:left;padding:3px 6px;border:1px solid #ccc;font-size:8px;background:#fff5f5;color:#dc2626;white-space:nowrap">Dépassement temps de travail</td>
          <td ${TDT(totWorkOver > 0 ? "color:#dc2626" : "")}>${fmtHHMM(totWorkOver)}</td>
          ${cells(d => { const ov = Math.max(0,(d.stats?.workMin??0)-d.maxWork); return ov>0?`<span class="over">${fmtHHMM(ov)}</span>`:""; })}
        </tr>
        <tr>
          <td ${TDL} style="text-align:left;padding:3px 6px;border:1px solid #ccc;font-size:8px;background:#f4f6fb;font-weight:bold;white-space:nowrap">Amplitude de présence</td>
          <td ${TDT()}></td>
          ${cells(d => { const amp = d.stats?.amplitudeMin ?? 0; const over = showAmpOver && amp > d.maxAmp; const warn = showAmpOver && amp === d.maxAmp && amp > 0; return `<b style="color:${over ? "#dc2626" : warn ? "#ea580c" : "inherit"}">${fmtHHMM(amp)}</b>`; })}
        </tr>
        ${showAmpOver ? `<tr><td ${TDL}>Amplitude autorisée</td><td ${TDT()}></td>${cells(d => fmtHHMM(d.maxAmp))}</tr>` : ""}
        ${showAmpOver ? `<tr>
          <td ${TDL} style="text-align:left;padding:3px 6px;border:1px solid #ccc;font-size:8px;background:#fff5f5;color:#dc2626;white-space:nowrap">Dépassement amplitude</td>
          <td ${TDT(totAmpOver > 0 ? "color:#dc2626" : "")}>${fmtHHMM(totAmpOver)}</td>
          ${cells(d => { const ov = Math.max(0,(d.stats?.amplitudeMin??0)-d.maxAmp); return ov>0?`<span class="over">${fmtHHMM(ov)}</span>`:""; })}
        </tr>` : ""}
      </tbody>
    </table></div>`;
  }

  html += `<div class="footer">Généré par KidsTime · Éléonore Aguillon · ACMA Fiction · ${new Date().toLocaleDateString("fr-FR")}</div></body></html>`;
  const w = window.open("", "_blank"); if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 500); }
}
