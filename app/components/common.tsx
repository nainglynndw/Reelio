"use client";

import { ChevronDown } from "lucide-react";
import type { Platform } from "../lib/types";

export function SelectField({ icon, label, value, options, onChange, disabled = false }: { icon: React.ReactNode; label: string; value: string; options: Array<string | { value: string; label: string }>; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <label className="select-field">
      <span>{icon}{label}</span>
      <div><select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{options.map((option) => typeof option === "string" ? <option key={option} value={option}>{option}</option> : <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown size={15} /></div>
    </label>
  );
}

export function PlatformLogo({ platform }: { platform: Platform }) {
  const icon = platform.id === "youtube" ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 7.7v8.6L16.7 12 9.2 7.7Z" /></svg>
    : platform.id === "tiktok" ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.1 3h3c.4 2.1 1.7 3.5 3.9 3.8v3.1a8 8 0 0 1-3.9-1.2v6.4a5.4 5.4 0 1 1-4.7-5.3V13a2.3 2.3 0 1 0 1.7 2.2V3Z" /></svg>
    : platform.id === "facebook" ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.8 21v-8h2.8l.4-3h-3.2V8.1c0-.9.3-1.5 1.6-1.5h1.7V3.9c-.3 0-1.5-.1-2.8-.1-2.8 0-4.7 1.7-4.7 4.9V10H6.5v3h3.1v8h4.2Z" /></svg>
    : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="4.5" width="15" height="15" rx="4.5" /><circle cx="12" cy="12" r="3.4" /><circle className="instagram-dot" cx="17.2" cy="6.9" r="1" /></svg>;
  return <span className={`platform-logo ${platform.id}`} role="img" aria-label={`${platform.label} icon`}>{icon}</span>;
}
