import Link from "next/link";

export const metadata = {
  title: "Mentions légales & Confidentialité — KidsTime",
};

export default function LegalPage() {
  return (
    <div className="min-h-screen bg-[#080d16] text-slate-200" style={{ fontFamily: "'DM Mono', monospace" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap" rel="stylesheet" />

      <div className="max-w-3xl mx-auto px-5 py-10 space-y-10">
        <div className="flex items-center justify-between">
          <Link href="/" className="text-xs text-blue-400 hover:text-blue-300">← Retour à l&apos;application</Link>
          <h1 className="text-xl font-extrabold" style={{ fontFamily: "Syne, sans-serif" }}>
            <span className="text-white">KIDS</span><span className="text-blue-500">TIME</span>
          </h1>
        </div>

        {/* ───────────────────── Mentions légales ───────────────────── */}
        <section className="space-y-4">
          <h2 className="text-lg font-bold text-white border-b border-slate-700 pb-2" style={{ fontFamily: "Syne, sans-serif" }}>
            ⚖️ Mentions légales
          </h2>

          <div className="space-y-3 text-sm leading-relaxed">
            <p><b>Éditeur du service</b><br />
              Éléonore Aguillon — ACMA Fiction<br />
              Contact : <a href="mailto:eleonore.aguillon@gmail.com" className="text-blue-400 hover:text-blue-300">eleonore.aguillon@gmail.com</a>
            </p>

            <p><b>Hébergement</b><br />
              Application : Vercel Inc., 340 S Lemon Ave #4133, Walnut, CA 91789, USA.<br />
              Base de données et authentification : Supabase, Inc. (infrastructure AWS, région UE).
            </p>

            <p><b>Propriété intellectuelle</b><br />
              Le code, le design et les contenus de KidsTime sont la propriété d&apos;Éléonore Aguillon, sauf mention contraire.
              Les données saisies dans l&apos;application appartiennent à leur auteur et restent sous sa responsabilité.
            </p>
          </div>
        </section>

        {/* ───────────────────── Politique de confidentialité ───────────────────── */}
        <section className="space-y-4">
          <h2 className="text-lg font-bold text-white border-b border-slate-700 pb-2" style={{ fontFamily: "Syne, sans-serif" }}>
            🔒 Politique de confidentialité (RGPD)
          </h2>

          <div className="space-y-4 text-sm leading-relaxed">
            <p><b>Responsable du traitement</b><br />
              Éléonore Aguillon — ACMA Fiction. Contact : <a href="mailto:eleonore.aguillon@gmail.com" className="text-blue-400 hover:text-blue-300">eleonore.aguillon@gmail.com</a>
            </p>

            <p><b>Finalités du traitement</b><br />
              KidsTime permet aux ADs enfants et aux responsables de production de respecter les obligations légales liées au travail des mineurs sur les tournages audiovisuels (DRIEETS) : suivi du temps de travail, des pauses obligatoires, des amplitudes maximales, du temps scolaire.
            </p>

            <p><b>Base légale</b></p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li><b>Obligation légale</b> (Code du travail, autorisations DRIEETS pour mineurs)</li>
              <li><b>Intérêt légitime</b> de l&apos;éditeur pour faire fonctionner et améliorer le service</li>
            </ul>

            <p><b>Données collectées</b></p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li><b>Compte utilisateur</b> : adresse email (pour l&apos;authentification)</li>
              <li><b>Enfants comédiens</b> : nom, prénom, date de naissance, statut (rôle / silhouette / figurant), périodes de vacances scolaires, dérogations horaires</li>
              <li><b>Activité de tournage</b> : horaires de convocation, pauses, déjeuner, suivi scolaire éventuel, fin de journée</li>
              <li><b>Liens de partage</b> : token, mot de passe (chiffré en bcrypt), historique des accès (résultat, type d&apos;appareil, horodatage)</li>
            </ul>

            <p><b>Destinataires</b></p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>L&apos;auteur du projet (compte authentifié)</li>
              <li>Les personnes à qui l&apos;auteur communique un lien de partage (lecture seule, mot de passe obligatoire)</li>
              <li>Aucune donnée n&apos;est transmise à des tiers à des fins commerciales</li>
            </ul>

            <p><b>Durée de conservation</b><br />
              Les données restent en base tant que le projet existe. L&apos;utilisateur peut à tout moment supprimer un projet (Paramètres → Zone de danger) ou l&apos;intégralité de ses données (Page d&apos;accueil → &laquo; Supprimer toutes mes données &raquo;).
              Les données nécessaires à la justification des obligations légales DRIEETS peuvent être conservées par l&apos;utilisateur jusqu&apos;à 5 ans à des fins probatoires, sous sa propre responsabilité.
            </p>

            <p><b>Sécurité</b></p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>Chiffrement en transit (HTTPS) sur l&apos;ensemble du service</li>
              <li>Chiffrement au repos sur la base de données (AES-256)</li>
              <li>Isolation Row-Level Security : chaque utilisateur ne peut accéder qu&apos;à ses propres projets</li>
              <li>Mots de passe de partage hashés en bcrypt (jamais stockés en clair)</li>
              <li>Rate limit : 10 tentatives de mot de passe / 15 min avant blocage temporaire</li>
              <li>Historique des accès consultable par le propriétaire du projet</li>
            </ul>

            <p><b>Vos droits (RGPD, articles 15 à 22)</b></p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li><b>Droit d&apos;accès</b> : voir et exporter vos données (récap PDF par projet ou enfant)</li>
              <li><b>Droit de rectification</b> : modifier les fiches enfants à tout moment</li>
              <li><b>Droit à l&apos;effacement</b> : bouton &laquo; Supprimer toutes mes données &raquo; en page d&apos;accueil, ou demande par email pour effacer également le compte authentifié</li>
              <li><b>Droit d&apos;opposition / portabilité</b> : nous contacter par email</li>
              <li><b>Droit d&apos;introduire une réclamation</b> auprès de la <a className="text-blue-400 hover:text-blue-300" href="https://www.cnil.fr/" target="_blank" rel="noopener">CNIL</a></li>
            </ul>

            <p><b>Cookies & traceurs</b><br />
              KidsTime ne dépose <b>aucun cookie publicitaire</b> ni traceur tiers. Seul le stockage local du navigateur est utilisé pour conserver votre session d&apos;authentification et permettre le fonctionnement hors-ligne (PWA).
            </p>

            <p><b>Sous-traitants</b></p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li><b>Supabase, Inc.</b> — hébergement base + authentification (région UE)</li>
              <li><b>Vercel, Inc.</b> — hébergement de l&apos;application web</li>
            </ul>
          </div>
        </section>

        <div className="border-t border-slate-700 pt-6 text-[10px] text-slate-500 text-center">
          Dernière mise à jour : {new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}
        </div>
      </div>
    </div>
  );
}
