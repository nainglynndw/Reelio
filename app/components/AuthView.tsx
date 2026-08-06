"use client";

import { ArrowRight, Database, LockKeyhole, ShieldCheck, Sparkles, X } from "lucide-react";
import { FormEvent, useState } from "react";
import { serviceFetch, SERVICE_URL } from "../lib/service";

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  subscription: {
    planCode: "free" | "creator" | "studio";
    status: "trialing" | "active" | "past_due" | "canceled";
    includedRenders: number;
    rendersUsed: number;
    currentPeriodStart: string;
    currentPeriodEnd: string | null;
  };
  entitlements: string[];
  createdAt: string;
};

type AuthResult = {
  authenticated?: boolean;
  setupRequired?: boolean;
  user?: AuthUser | null;
  error?: string;
};

export function AuthView({ setupRequired, serviceOnline, onAuthenticated, onClose }: {
  setupRequired: boolean;
  serviceOnline: boolean;
  onAuthenticated: (user: AuthUser) => void;
  onClose?: () => void;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await serviceFetch(`${SERVICE_URL}/auth/${setupRequired ? "register" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, displayName }),
      });
      const result = await response.json() as AuthResult;
      if (!response.ok || !result.user) throw new Error(result.error ?? "Authentication failed.");
      onAuthenticated(result.user);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Authentication failed.");
    } finally {
      setSubmitting(false);
    }
  }

  const content = <>
      <section className="auth-story">
        <div className="auth-brand"><span className="brand-mark" /><strong>Reelio</strong></div>
        <div>
          <span className="auth-kicker"><Sparkles size={14} /> AI PRODUCTION STUDIO</span>
          <h1>Your channel production system, secured locally.</h1>
          <p>Create, localize, package, and publish videos from one protected workspace.</p>
        </div>
        <ul>
          <li><Database size={17} /><span><strong>Local SQLite database</strong><small>Stored under your configured REELIO_DATA_DIR.</small></span></li>
          <li><LockKeyhole size={17} /><span><strong>Private credentials</strong><small>Passwords are salted and hashed; raw passwords are never stored.</small></span></li>
          <li><ShieldCheck size={17} /><span><strong>Protected media library</strong><small>Jobs, tools, settings, and media require an active session.</small></span></li>
        </ul>
      </section>

      <section className="auth-form-panel">
        <form onSubmit={submit}>
          <header>
            <span>{setupRequired ? "LOCAL WORKSPACE SETUP" : "WELCOME BACK"}</span>
            <h2>{setupRequired ? "Create your Reelio account" : "Sign in to Reelio"}</h2>
            <p>{setupRequired ? "This local installation starts with the Studio plan so every production feature is available." : "Use the email and password for your Reelio account."}</p>
          </header>

          {setupRequired && <label><span>Your name</span><input autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Channel owner" required minLength={2} maxLength={80} /></label>}
          <label><span>Email address</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required /></label>
          <label><span>Password</span><input type="password" autoComplete={setupRequired ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 10 characters" required minLength={10} maxLength={128} /></label>

          {error && <div className="auth-error" role="alert">{error}</div>}
          {!serviceOnline && <div className="auth-error" role="alert">The local service is offline. Start Reelio with npm run dev.</div>}

          <button type="submit" disabled={submitting || !serviceOnline}>
            {submitting ? "Please wait…" : setupRequired ? "Create account and continue" : "Sign in"}
            {!submitting && <ArrowRight size={16} />}
          </button>
          <small className="auth-storage-note">Local-first now. The database schema can migrate to hosted infrastructure later.</small>
        </form>
      </section>
  </>;

  if (onClose) {
    return <div className="auth-gate-overlay" role="presentation">
      <div className="auth-gate-dialog" role="dialog" aria-modal="true" aria-label={setupRequired ? "Create your Reelio account" : "Sign in to Reelio"}>
        <button className="auth-gate-close" onClick={onClose} aria-label="Continue exploring without signing in"><X size={18} /></button>
        {content}
      </div>
    </div>;
  }

  return <main className="auth-shell">{content}</main>;
}
