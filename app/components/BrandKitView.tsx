"use client";

import {
  Check,
  Image as ImageIcon,
  LoaderCircle,
  Music2,
  Palette,
  Save,
  Sparkles,
  Trash2,
  Upload,
  Video,
} from "lucide-react";
import { useEffect, useState } from "react";
import { narrators } from "../lib/narrators";
import { SERVICE_URL } from "../lib/service";
import type { BrandAssetKind, BrandKit } from "../lib/types";

const assetCards: Array<{ kind: BrandAssetKind; title: string; detail: string; accept: string; icon: React.ReactNode }> = [
  { kind: "logo", title: "Logo watermark", detail: "PNG, JPG or WebP · up to 20 MB", accept: ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp", icon: <ImageIcon size={18} /> },
  { kind: "intro", title: "Intro visual", detail: "Video · first 5 seconds maximum", accept: "video/mp4,video/quicktime,video/webm,.mkv", icon: <Video size={18} /> },
  { kind: "outro", title: "Outro visual", detail: "Video · final 5 seconds maximum", accept: "video/mp4,video/quicktime,video/webm,.mkv", icon: <Video size={18} /> },
  { kind: "music", title: "Background music", detail: "Audio loops to the video duration", accept: "audio/*,.mp3,.m4a,.wav,.aac,.flac,.ogg", icon: <Music2 size={18} /> },
];

export function BrandKitView({ setToast, onBrandKitChange }: {
  setToast: (value: string) => void;
  onBrandKitChange: (brandKit: BrandKit) => void;
}) {
  const [kit, setKit] = useState<BrandKit | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<BrandAssetKind | null>(null);

  useEffect(() => {
    fetch(`${SERVICE_URL}/brand-kit`)
      .then(async (response) => {
        const result = await response.json() as { brandKit?: BrandKit; error?: string };
        if (!response.ok || !result.brandKit) throw new Error(result.error ?? "Brand Kit could not be loaded.");
        setKit(result.brandKit);
        onBrandKitChange(result.brandKit);
      })
      .catch((error) => setToast(error instanceof Error ? error.message : "Brand Kit could not be loaded."))
      .finally(() => setLoading(false));
  }, [onBrandKitChange, setToast]);

  function update<Key extends keyof BrandKit>(key: Key, value: BrandKit[Key]) {
    setKit((current) => current ? { ...current, [key]: value } : current);
  }

  async function save() {
    if (!kit || saving) return;
    setSaving(true);
    try {
      const response = await fetch(`${SERVICE_URL}/brand-kit`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(brandKitSettings(kit)),
      });
      const result = await response.json() as { brandKit?: BrandKit; error?: string };
      if (!response.ok || !result.brandKit) throw new Error(result.error ?? "Brand Kit could not be saved.");
      setKit(result.brandKit);
      onBrandKitChange(result.brandKit);
      setToast("Brand Kit saved. New jobs will use this version.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Brand Kit could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function upload(kind: BrandAssetKind, file?: File) {
    if (!file || uploading || !kit) return;
    setUploading(kind);
    try {
      const saveResponse = await fetch(`${SERVICE_URL}/brand-kit`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(brandKitSettings(kit)),
      });
      const saved = await saveResponse.json() as { brandKit?: BrandKit; error?: string };
      if (!saveResponse.ok || !saved.brandKit) throw new Error(saved.error ?? "Save the Brand Kit before uploading an asset.");
      const response = await fetch(`${SERVICE_URL}/brand-kit/assets/${kind}`, {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
        },
        body: file,
      });
      const result = await response.json() as { brandKit?: BrandKit; error?: string };
      if (!response.ok || !result.brandKit) throw new Error(result.error ?? "Brand asset could not be uploaded.");
      setKit(result.brandKit);
      onBrandKitChange(result.brandKit);
      setToast(`${assetCards.find((card) => card.kind === kind)?.title ?? "Asset"} is ready.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Brand asset could not be uploaded.");
    } finally {
      setUploading(null);
    }
  }

  async function remove(kind: BrandAssetKind) {
    if (!kit?.assets[kind] || !window.confirm("Remove this asset from the active Brand Kit? Existing queued videos keep their saved version.")) return;
    try {
      const saveResponse = await fetch(`${SERVICE_URL}/brand-kit`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(brandKitSettings(kit)),
      });
      const saved = await saveResponse.json() as { brandKit?: BrandKit; error?: string };
      if (!saveResponse.ok || !saved.brandKit) throw new Error(saved.error ?? "Save the Brand Kit before removing an asset.");
      const response = await fetch(`${SERVICE_URL}/brand-kit/assets/${kind}`, { method: "DELETE" });
      const result = await response.json() as { brandKit?: BrandKit; error?: string };
      if (!response.ok || !result.brandKit) throw new Error(result.error ?? "Brand asset could not be removed.");
      setKit(result.brandKit);
      onBrandKitChange(result.brandKit);
      setToast("Asset removed from the active kit. Its local immutable copy remains available to existing jobs.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Brand asset could not be removed.");
    }
  }

  if (loading) return <div className="content-wrap brand-kit-loading"><LoaderCircle className="spin" size={24} /> Loading Brand Kit…</div>;
  if (!kit) return <div className="content-wrap brand-kit-loading">Start the local renderer to edit your Brand Kit.</div>;

  return (
    <div className="content-wrap brand-kit-page">
      <div className="page-heading brand-kit-heading">
        <div>
          <div className="eyebrow"><span /> BRAND SYSTEM</div>
          <h1>Make every video unmistakably yours.</h1>
          <p>One local preset for visual identity, voice direction, publishing copy, and reusable media.</p>
        </div>
        <button className="primary-small" onClick={save} disabled={saving}>
          {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
          {saving ? "Saving…" : "Save Brand Kit"}
        </button>
      </div>

      <div className="brand-kit-status-card">
        <div className="brand-kit-live-mark" style={{ background: `linear-gradient(145deg, ${kit.primaryColor}, ${kit.accentColor})` }}><Sparkles size={20} /></div>
        <span><strong>{kit.name || "Untitled brand"}</strong><small>{kit.enabled ? "Automatically applied to new Quick and Guided Create jobs" : "Saved, but not applied to new videos"}</small></span>
        <button className={`brand-kit-toggle ${kit.enabled ? "on" : ""}`} onClick={() => update("enabled", !kit.enabled)} aria-pressed={kit.enabled}>
          <i>{kit.enabled && <Check size={11} />}</i>{kit.enabled ? "Active" : "Inactive"}
        </button>
      </div>

      <div className="brand-kit-layout">
        <section className="brand-kit-panel">
          <header><Palette size={18} /><span><strong>Identity and style</strong><small>Used in motion backgrounds, thumbnails, captions, and metadata.</small></span></header>
          <div className="brand-field-grid">
            <BrandField label="Brand name"><input value={kit.name} maxLength={80} onChange={(event) => update("name", event.target.value)} /></BrandField>
            <BrandField label="Default narrator"><select value={kit.defaultNarratorId} onChange={(event) => update("defaultNarratorId", event.target.value as BrandKit["defaultNarratorId"])}>{narrators.map((narrator) => <option key={narrator.id} value={narrator.id}>{narrator.name} · {narrator.role}</option>)}</select></BrandField>
            <BrandField label="Primary color"><div className="brand-color-field"><input type="color" value={kit.primaryColor} onChange={(event) => update("primaryColor", event.target.value)} /><input value={kit.primaryColor} maxLength={7} onChange={(event) => update("primaryColor", event.target.value)} /></div></BrandField>
            <BrandField label="Accent color"><div className="brand-color-field"><input type="color" value={kit.accentColor} onChange={(event) => update("accentColor", event.target.value)} /><input value={kit.accentColor} maxLength={7} onChange={(event) => update("accentColor", event.target.value)} /></div></BrandField>
            <BrandField label="Display font"><select value={kit.fontFamily} onChange={(event) => update("fontFamily", event.target.value)}>{["Arial", "Arial Black", "Helvetica", "Verdana", "Trebuchet MS", "Georgia"].map((font) => <option key={font}>{font}</option>)}</select></BrandField>
            <BrandField label="Caption style"><select value={kit.captionStyle} onChange={(event) => update("captionStyle", event.target.value as BrandKit["captionStyle"])}><option value="bold">Bold highlight</option><option value="classic">Classic</option><option value="minimal">Minimal</option><option value="kinetic">Kinetic word color</option></select></BrandField>
            <BrandField label="Logo position"><select value={kit.logoPosition} onChange={(event) => update("logoPosition", event.target.value as BrandKit["logoPosition"])}><option value="top-right">Top right</option><option value="top-left">Top left</option><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option></select></BrandField>
            <BrandField label={`Logo opacity · ${Math.round(kit.logoOpacity * 100)}%`}><input type="range" min="0.25" max="1" step="0.01" value={kit.logoOpacity} onChange={(event) => update("logoOpacity", Number(event.target.value))} /></BrandField>
          </div>
        </section>

        <section className="brand-kit-panel">
          <header><Sparkles size={18} /><span><strong>Voice and publishing</strong><small>Shapes AI-written drafts and appends your approved publishing identity.</small></span></header>
          <div className="brand-field-stack">
            <BrandField label="Brand voice"><textarea value={kit.brandVoice} maxLength={500} rows={4} onChange={(event) => update("brandVoice", event.target.value)} placeholder="Warm, credible, concise…" /></BrandField>
            <BrandField label="Call to action"><input value={kit.ctaText} maxLength={180} onChange={(event) => update("ctaText", event.target.value)} placeholder="Follow for one clear idea every day." /></BrandField>
            <div className="brand-field-grid">
              <BrandField label="Social handle"><input value={kit.socialHandle} maxLength={80} onChange={(event) => update("socialHandle", event.target.value)} placeholder="@yourbrand" /></BrandField>
              <BrandField label="Website"><input value={kit.website} maxLength={240} onChange={(event) => update("website", event.target.value)} placeholder="https://example.com" /></BrandField>
            </div>
          </div>
        </section>
      </div>

      <section className="brand-assets-section">
        <div className="tools-section-heading"><strong>Reusable media</strong><small>Files stay under your Reelio data directory. Replacing one creates a new immutable version.</small></div>
        <div className="brand-asset-grid">
          {assetCards.map((card) => {
            const asset = kit.assets[card.kind];
            const source = asset ? `${SERVICE_URL}${asset.url}?v=${encodeURIComponent(asset.id)}` : "";
            return <article key={card.kind} className={`brand-asset-card ${asset ? "has-asset" : ""}`}>
              <div className="brand-asset-preview">
                {/* This is a private local-worker URL, so Next image optimization would move local media into the web build pipeline. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {asset?.kind === "logo" && <img src={source} alt={`${kit.name} logo`} />}
                {(asset?.kind === "intro" || asset?.kind === "outro") && <video src={source} controls preload="metadata" />}
                {asset?.kind === "music" && <div className="brand-audio-preview"><Music2 size={26} /><audio src={source} controls preload="metadata" /></div>}
                {!asset && <span>{card.icon}<small>No file yet</small></span>}
              </div>
              <div className="brand-asset-copy"><span>{card.icon}<strong>{card.title}</strong></span><small>{asset ? `${asset.name} · ${formatBytes(asset.bytes)}${asset.durationSeconds ? ` · ${asset.durationSeconds.toFixed(1)}s` : ""}` : card.detail}</small></div>
              <div className="brand-asset-actions">
                <label className={uploading === card.kind ? "busy" : ""}><input type="file" accept={card.accept} disabled={Boolean(uploading)} onChange={(event) => { void upload(card.kind, event.target.files?.[0]); event.currentTarget.value = ""; }} />{uploading === card.kind ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}{asset ? "Replace" : "Upload"}</label>
                {asset && <button onClick={() => void remove(card.kind)} aria-label={`Remove ${card.title}`}><Trash2 size={14} /></button>}
              </div>
            </article>;
          })}
        </div>
      </section>
    </div>
  );
}

function BrandField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="brand-field"><span>{label}</span>{children}</label>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function brandKitSettings(kit: BrandKit) {
  return {
    enabled: kit.enabled,
    name: kit.name,
    primaryColor: kit.primaryColor,
    accentColor: kit.accentColor,
    fontFamily: kit.fontFamily,
    captionStyle: kit.captionStyle,
    logoPosition: kit.logoPosition,
    logoOpacity: kit.logoOpacity,
    brandVoice: kit.brandVoice,
    ctaText: kit.ctaText,
    socialHandle: kit.socialHandle,
    website: kit.website,
    defaultNarratorId: kit.defaultNarratorId,
  };
}
