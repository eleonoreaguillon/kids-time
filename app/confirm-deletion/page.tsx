"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function ConfirmDeletionInner() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") || "";

  type Phase = "checking-session" | "needs-login" | "ready" | "deleting" | "done" | "error";
  const [phase, setPhase] = useState<Phase>("checking-session");
  const [errMsg, setErrMsg] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [result, setResult] = useState<{ deleted_projects?: number; deleted_push_subscriptions?: number } | null>(null);
  const [userEmail, setUserEmail] = useState("");

  useEffect(() => {
    if (!token) { setPhase("error"); setErrMsg("Lien invalide : token manquant."); return; }

    // Vérifie qu'une session existe (l'utilisateur a cliqué le magic link)
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) { setPhase("needs-login"); return; }
      setUserEmail(data.session.user.email || "");
      setPhase("ready");
    });

    // Si Supabase fournit la session via le hash après le magic link, on capte le SIGNED_IN
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) { setUserEmail(session.user.email || ""); setPhase("ready"); }
    });
    return () => sub.subscription.unsubscribe();
  }, [token]);

  async function handleConfirm() {
    setPhase("deleting");
    const { data, error } = await supabase.rpc("confirm_data_deletion", { p_token: token });
    if (error) {
      setPhase("error");
      const m = error.message || "";
      if (m.includes("expired")) setErrMsg("Ce lien a expiré (validité 1h). Recommence la procédure depuis l'app.");
      else if (m.includes("used")) setErrMsg("Ce lien a déjà été utilisé.");
      else if (m.includes("mismatch")) setErrMsg("Ce lien ne correspond pas au compte connecté.");
      else if (m.includes("invalid")) setErrMsg("Token invalide.");
      else setErrMsg(m);
      return;
    }
    setResult(data || {});
    setPhase("done");
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/");
  }

  return (
    <div className="min-h-screen bg-[#080d16] text-slate-200 px-5 py-10 flex items-start sm:items-center justify-center" style={{ fontFamily: "'DM Mono', monospace" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap" rel="stylesheet" />

      <div className="w-full max-w-md bg-[#0f1a2e] border border-red-900/60 rounded-2xl p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="text-3xl">⚠️</div>
          <h1 className="text-lg font-extrabold text-red-300" style={{ fontFamily: "Syne, sans-serif" }}>
            Confirmer la suppression
          </h1>
        </div>

        {phase === "checking-session" && (
          <div className="text-sm text-slate-400">Vérification de la session…</div>
        )}

        {phase === "needs-login" && (
          <>
            <p className="text-sm text-slate-300">
              Tu dois être connecté(e) pour valider la suppression. Le lien magique reçu par email te connectera automatiquement.
            </p>
            <p className="text-xs text-slate-500">
              Si tu viens d&apos;ouvrir ce lien depuis un autre appareil que celui où tu as fait la demande,
              ré-ouvre ce lien directement depuis l&apos;email.
            </p>
            <a href="/" className="block text-center text-xs text-blue-400 hover:text-blue-300">← Retour à l&apos;accueil</a>
          </>
        )}

        {phase === "ready" && (
          <>
            <div className="bg-red-950/30 border border-red-800/60 rounded-xl p-3 text-xs space-y-1">
              <div className="text-red-300 font-bold">Action irréversible</div>
              <div className="text-slate-300">
                Tu vas supprimer définitivement toutes les données associées à <b className="text-white">{userEmail}</b> :
                projets, enfants, journées de tournage, groupes, logs d&apos;accès et abonnements push.
              </div>
            </div>

            <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={understood}
                onChange={e => setUnderstood(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-red-500"
              />
              <span>Je comprends que cette action est irréversible et que toutes mes données seront effacées.</span>
            </label>

            <button
              onClick={handleConfirm}
              disabled={!understood}
              className={`w-full py-3 rounded-xl text-sm font-bold transition-colors ${
                understood ? "bg-red-700 hover:bg-red-600 text-white" : "bg-slate-800 text-slate-600 cursor-not-allowed"
              }`}
            >
              Supprimer définitivement toutes mes données
            </button>

            <a href="/" className="block text-center text-xs text-slate-500 hover:text-slate-300">Annuler — retourner à l&apos;accueil</a>
          </>
        )}

        {phase === "deleting" && (
          <div className="text-center py-4">
            <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <div className="text-sm text-slate-400">Suppression en cours…</div>
          </div>
        )}

        {phase === "done" && (
          <>
            <div className="bg-emerald-950/30 border border-emerald-800/60 rounded-xl p-4 text-sm space-y-1">
              <div className="text-emerald-300 font-bold">✓ Suppression effectuée</div>
              <div className="text-xs text-slate-400">
                {result?.deleted_projects ?? 0} projet(s) supprimé(s)
                {result?.deleted_push_subscriptions ? `, ${result.deleted_push_subscriptions} abonnement(s) push supprimé(s)` : ""}.
              </div>
            </div>
            <p className="text-xs text-slate-500">
              Ton compte d&apos;authentification reste actif. Pour le supprimer aussi, écris à
              {" "}<a href="mailto:eleonore.aguillon@gmail.com" className="text-blue-400 hover:text-blue-300">eleonore.aguillon@gmail.com</a>.
            </p>
            <button
              onClick={handleSignOut}
              className="w-full bg-blue-700 hover:bg-blue-600 text-white py-3 rounded-xl text-sm font-bold transition-colors"
            >
              Se déconnecter
            </button>
          </>
        )}

        {phase === "error" && (
          <>
            <div className="bg-red-950/40 border border-red-800/60 rounded-xl p-3 text-xs text-red-300">
              {errMsg}
            </div>
            <a href="/" className="block text-center text-xs text-blue-400 hover:text-blue-300">← Retour à l&apos;accueil</a>
          </>
        )}
      </div>
    </div>
  );
}

export default function ConfirmDeletionPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#080d16]" />}>
      <ConfirmDeletionInner />
    </Suspense>
  );
}
