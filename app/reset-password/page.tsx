"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function ResetPasswordPage() {
  const router = useRouter();
  type Phase = "checking" | "needs-link" | "ready" | "saving" | "done" | "error";
  const [phase, setPhase] = useState<Phase>("checking");
  const [errMsg, setErrMsg] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [pwd, setPwd] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPwd, setShowPwd] = useState(false);

  useEffect(() => {
    // Si l'utilisateur arrive depuis le magic link Supabase, la session est
    // creee automatiquement (Supabase consomme le hash dans l URL)
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) { setPhase("needs-link"); return; }
      setUserEmail(data.session.user.email || "");
      setPhase("ready");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) { setUserEmail(session.user.email || ""); setPhase("ready"); }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const MIN = 6;
  const pwdValid = pwd.length >= MIN;
  const matches = pwd === confirm;
  const canSubmit = pwdValid && matches;

  async function handleSubmit() {
    if (!canSubmit) return;
    setPhase("saving"); setErrMsg("");
    const { error } = await supabase.auth.updateUser({ password: pwd });
    if (error) { setErrMsg(error.message); setPhase("error"); return; }
    setPhase("done");
  }

  async function goHome() {
    // On reste connecte avec la nouvelle session, on bascule vers l'accueil
    router.push("/");
  }

  return (
    <div className="min-h-screen bg-[#080d16] text-slate-200 px-5 py-10 flex items-start sm:items-center justify-center" style={{ fontFamily: "'DM Mono', monospace" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap" rel="stylesheet" />

      <div className="w-full max-w-md bg-[#0f1a2e] border border-slate-700 rounded-2xl p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="text-3xl">🔑</div>
          <h1 className="text-lg font-extrabold text-white" style={{ fontFamily: "Syne, sans-serif" }}>
            Nouveau mot de passe
          </h1>
        </div>

        {phase === "checking" && (
          <div className="text-sm text-slate-400">Vérification du lien…</div>
        )}

        {phase === "needs-link" && (
          <>
            <p className="text-sm text-slate-300">
              Ce lien est expiré ou n&apos;est plus valide.
            </p>
            <p className="text-xs text-slate-500">
              Recommence la procédure depuis l&apos;écran de connexion en cliquant sur <b className="text-slate-300">&laquo; Mot de passe oublié ? &raquo;</b>.
            </p>
            <a href="/" className="block text-center bg-blue-700 hover:bg-blue-600 text-white py-3 rounded-xl text-sm font-bold transition-colors">
              Retour à la connexion
            </a>
          </>
        )}

        {(phase === "ready" || phase === "saving" || phase === "error") && (
          <>
            <p className="text-sm text-slate-300">
              Définis un nouveau mot de passe pour <b className="text-white">{userEmail}</b>.
            </p>
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-[10px] text-slate-400 uppercase tracking-wider">Nouveau mot de passe</label>
                <div className="relative">
                  <input
                    type={showPwd ? "text" : "password"}
                    value={pwd}
                    onChange={e => setPwd(e.target.value)}
                    autoComplete="new-password"
                    className="w-full bg-slate-800 border border-slate-600 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 placeholder:text-slate-600 pr-10"
                    placeholder={`Min. ${MIN} caractères`}
                  />
                  <button type="button" onClick={() => setShowPwd(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs">
                    {showPwd ? "🙈" : "👁"}
                  </button>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] text-slate-400 uppercase tracking-wider">Confirmer</label>
                <input
                  type={showPwd ? "text" : "password"}
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  className="w-full bg-slate-800 border border-slate-600 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 placeholder:text-slate-600"
                  placeholder="Re-saisis le mot de passe"
                />
              </div>
              {pwd.length > 0 && !pwdValid && <div className="text-[10px] text-red-400">Le mot de passe doit faire au moins {MIN} caractères.</div>}
              {confirm.length > 0 && !matches && <div className="text-[10px] text-red-400">Les deux mots de passe ne correspondent pas.</div>}
            </div>

            {phase === "error" && (
              <div className="bg-red-950/40 border border-red-800/60 rounded-xl p-3 text-xs text-red-300">
                Erreur : {errMsg}
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={!canSubmit || phase === "saving"}
              className={`w-full py-3 rounded-xl text-sm font-bold transition-colors ${canSubmit && phase !== "saving" ? "bg-blue-700 hover:bg-blue-600 text-white" : "bg-slate-800 text-slate-600 cursor-not-allowed"}`}
            >
              {phase === "saving" ? "Enregistrement…" : "Enregistrer le nouveau mot de passe"}
            </button>
          </>
        )}

        {phase === "done" && (
          <>
            <div className="bg-emerald-950/30 border border-emerald-800/60 rounded-xl p-4 text-sm space-y-1">
              <div className="text-emerald-300 font-bold">✓ Mot de passe mis à jour</div>
              <div className="text-xs text-slate-400">Tu peux maintenant accéder à l&apos;application.</div>
            </div>
            <button onClick={goHome} className="w-full bg-blue-700 hover:bg-blue-600 text-white py-3 rounded-xl text-sm font-bold transition-colors">
              Aller à l&apos;accueil
            </button>
          </>
        )}
      </div>
    </div>
  );
}
