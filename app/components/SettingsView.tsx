"use client";

import {
  Check,
  CircleHelp,
  CloudUpload,
  Film,
  Languages,
  Mic2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { platforms } from "../lib/platforms";
import { SERVICE_URL } from "../lib/service";
import type { FacebookStatus, InstagramStatus, ProviderHealth, TextHealth, TikTokStatus, TtsHealth, YouTubeStatus } from "../lib/types";
import { PlatformLogo } from "./common";
import { FacebookSetupGuide, InstagramSetupGuide, TikTokSetupGuide, YouTubeSetupGuide } from "./setup-guides";

export function SettingsView({ setToast }: { setToast: (value: string) => void }) {
  const [showSecret, setShowSecret] = useState(false);
  const [geminiKey, setGeminiKey] = useState("");
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [pexelsKey, setPexelsKey] = useState("");
  const [textModel, setTextModel] = useState("google/gemma-4-31b-it:free");
  const [youtubeClientId, setYoutubeClientId] = useState("");
  const [youtubeClientSecret, setYoutubeClientSecret] = useState("");
  const [youtubeGuide, setYoutubeGuide] = useState(false);
  const [youtubeStatus, setYoutubeStatus] = useState<YouTubeStatus | null>(null);
  const [checkingYoutube, setCheckingYoutube] = useState(false);
  const [connectingYoutube, setConnectingYoutube] = useState(false);
  const [tiktokClientKey, setTiktokClientKey] = useState("");
  const [tiktokClientSecret, setTiktokClientSecret] = useState("");
  const [tiktokGuide, setTiktokGuide] = useState(false);
  const [tiktokStatus, setTiktokStatus] = useState<TikTokStatus | null>(null);
  const [checkingTiktok, setCheckingTiktok] = useState(false);
  const [connectingTiktok, setConnectingTiktok] = useState(false);
  const [facebookGuide, setFacebookGuide] = useState(false);
  const [facebookStatus, setFacebookStatus] = useState<FacebookStatus | null>(null);
  const [checkingFacebook, setCheckingFacebook] = useState(false);
  const [connectingFacebook, setConnectingFacebook] = useState(false);
  const [selectingFacebookPage, setSelectingFacebookPage] = useState(false);
  const [metaAppId, setMetaAppId] = useState("");
  const [metaAppSecret, setMetaAppSecret] = useState("");
  const [instagramGuide, setInstagramGuide] = useState(false);
  const [instagramStatus, setInstagramStatus] = useState<InstagramStatus | null>(null);
  const [checkingInstagram, setCheckingInstagram] = useState(false);
  const [savingInstagram, setSavingInstagram] = useState(false);
  const [publicMediaBaseUrl, setPublicMediaBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [health, setHealth] = useState<ProviderHealth | null>(null);
  const [ttsHealth, setTtsHealth] = useState<TtsHealth | null>(null);
  const [voxHealth, setVoxHealth] = useState<TtsHealth | null>(null);
  const [textHealth, setTextHealth] = useState<TextHealth | null>(null);
  const checkHealth = () => fetch(`${SERVICE_URL}/health`).then((response) => response.json()).then((value: { providers?: ProviderHealth; tts?: TtsHealth; voxcpm2?: TtsHealth; text?: TextHealth }) => { setHealth(value.providers ?? null); setTtsHealth(value.tts ?? null); setVoxHealth(value.voxcpm2 ?? null); setTextHealth(value.text ?? null); setToast("Provider status refreshed"); }).catch(() => { setHealth(null); setTtsHealth(null); setVoxHealth(null); setTextHealth(null); setToast("Local worker is offline"); });
  useEffect(() => {
    fetch(`${SERVICE_URL}/health`).then((response) => response.json()).then((value: { providers?: ProviderHealth; tts?: TtsHealth; voxcpm2?: TtsHealth; text?: TextHealth }) => { setHealth(value.providers ?? null); setTtsHealth(value.tts ?? null); setVoxHealth(value.voxcpm2 ?? null); setTextHealth(value.text ?? null); }).catch(() => { setHealth(null); setTtsHealth(null); setVoxHealth(null); setTextHealth(null); });
    fetch(`${SERVICE_URL}/oauth/youtube/status`).then((response) => response.json()).then((value: YouTubeStatus) => setYoutubeStatus(value)).catch(() => setYoutubeStatus(null));
    fetch(`${SERVICE_URL}/oauth/tiktok/status`).then((response) => response.json()).then((value: TikTokStatus) => setTiktokStatus(value)).catch(() => setTiktokStatus(null));
    fetch(`${SERVICE_URL}/publishing/facebook/status`).then((response) => response.json()).then((value: FacebookStatus) => setFacebookStatus(value)).catch(() => setFacebookStatus(null));
    fetch(`${SERVICE_URL}/publishing/instagram/status`).then((response) => response.json()).then((value: InstagramStatus) => setInstagramStatus(value)).catch(() => setInstagramStatus(null));
    const receiveOAuth = (event: MessageEvent) => {
      if (event.data?.type === "reelio-youtube-oauth") {
        setToast(event.data.message ?? (event.data.ok ? "YouTube connected" : "YouTube connection failed"));
        fetch(`${SERVICE_URL}/oauth/youtube/status`).then((response) => response.json()).then((value: YouTubeStatus) => setYoutubeStatus(value)).catch(() => setYoutubeStatus(null));
      }
      if (event.data?.type === "reelio-tiktok-oauth") {
        setToast(event.data.message ?? (event.data.ok ? "TikTok connected" : "TikTok connection failed"));
        fetch(`${SERVICE_URL}/oauth/tiktok/status`).then((response) => response.json()).then((value: TikTokStatus) => setTiktokStatus(value)).catch(() => setTiktokStatus(null));
      }
      if (event.data?.type === "reelio-facebook-oauth") {
        setToast(event.data.message ?? (event.data.ok ? "Facebook connected" : "Facebook connection failed"));
        fetch(`${SERVICE_URL}/publishing/facebook/status`).then((response) => response.json()).then((value: FacebookStatus) => setFacebookStatus(value)).catch(() => setFacebookStatus(null));
        fetch(`${SERVICE_URL}/publishing/instagram/status`).then((response) => response.json()).then((value: InstagramStatus) => setInstagramStatus(value)).catch(() => setInstagramStatus(null));
      }
    };
    window.addEventListener("message", receiveOAuth);
    return () => window.removeEventListener("message", receiveOAuth);
  }, [setToast]);

  async function checkYouTube(showGuideWhenMissing = true) {
    setCheckingYoutube(true);
    try {
      const response = await fetch(`${SERVICE_URL}/oauth/youtube/status`);
      const result = await response.json() as YouTubeStatus & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "YouTube connection could not be checked");
      setYoutubeStatus(result);
      if (result.connected) setToast(`${result.channelTitle ?? "YouTube"} is connected and ready`);
      else {
        setToast(result.message ?? "YouTube is not connected");
        if (showGuideWhenMissing) setYoutubeGuide(true);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "YouTube connection could not be checked");
      if (showGuideWhenMissing) setYoutubeGuide(true);
    } finally { setCheckingYoutube(false); }
  }

  async function connectYouTube() {
    const popup = window.open("about:blank", "reelio-youtube-oauth", "popup,width=560,height=760");
    setConnectingYoutube(true);
    try {
      if (youtubeClientId.trim() || youtubeClientSecret.trim()) {
        if (!youtubeClientId.trim() || !youtubeClientSecret.trim()) throw new Error("Enter both the Google client ID and client secret.");
        const saved = await fetch(`${SERVICE_URL}/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ googleClientId: youtubeClientId.trim(), googleClientSecret: youtubeClientSecret.trim(), youtubePrivacy: "public" }),
        });
        const savedResult = await saved.json() as { error?: string };
        if (!saved.ok) throw new Error(savedResult.error ?? "YouTube credentials could not be saved");
        setYoutubeClientId(""); setYoutubeClientSecret("");
      } else if (!youtubeStatus?.configured) throw new Error("Enter the Google client ID and client secret.");
      const response = await fetch(`${SERVICE_URL}/oauth/youtube/start`, { method: "POST" });
      const result = await response.json() as { authUrl?: string; error?: string };
      if (!response.ok || !result.authUrl) throw new Error(result.error ?? "YouTube authorization could not start");
      if (!popup) throw new Error("Allow pop-ups for Reelio, then press Connect YouTube again.");
      popup.location.href = result.authUrl;
      setToast("Complete Google authorization in the new window");
    } catch (error) {
      popup?.close();
      setToast(error instanceof Error ? error.message : "YouTube authorization could not start");
    } finally { setConnectingYoutube(false); }
  }

  async function checkTikTok(showGuideWhenMissing = true) {
    setCheckingTiktok(true);
    try {
      const response = await fetch(`${SERVICE_URL}/oauth/tiktok/status`);
      const result = await response.json() as TikTokStatus & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "TikTok connection could not be checked");
      setTiktokStatus(result);
      if (result.connected) setToast(`${result.displayName ?? "TikTok"} is connected for draft uploads`);
      else {
        setToast(result.message ?? "TikTok is not connected");
        if (showGuideWhenMissing) setTiktokGuide(true);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "TikTok connection could not be checked");
      if (showGuideWhenMissing) setTiktokGuide(true);
    } finally { setCheckingTiktok(false); }
  }

  async function connectTikTok() {
    const popup = window.open("about:blank", "reelio-tiktok-oauth", "popup,width=560,height=760");
    setConnectingTiktok(true);
    try {
      if (tiktokClientKey.trim() || tiktokClientSecret.trim()) {
        if (!tiktokClientKey.trim() || !tiktokClientSecret.trim()) throw new Error("Enter both the TikTok client key and client secret.");
        const saved = await fetch(`${SERVICE_URL}/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tiktokClientKey: tiktokClientKey.trim(), tiktokClientSecret: tiktokClientSecret.trim() }),
        });
        const savedResult = await saved.json() as { error?: string };
        if (!saved.ok) throw new Error(savedResult.error ?? "TikTok credentials could not be saved");
        setTiktokClientKey(""); setTiktokClientSecret("");
      } else if (!tiktokStatus?.configured) throw new Error("Enter the TikTok client key and client secret.");
      const response = await fetch(`${SERVICE_URL}/oauth/tiktok/start`, { method: "POST" });
      const result = await response.json() as { authUrl?: string; error?: string };
      if (!response.ok || !result.authUrl) throw new Error(result.error ?? "TikTok authorization could not start");
      if (!popup) throw new Error("Allow pop-ups for Reelio, then press Connect TikTok again.");
      popup.location.href = result.authUrl;
      setToast("Complete TikTok authorization in the new window");
    } catch (error) {
      popup?.close();
      setToast(error instanceof Error ? error.message : "TikTok authorization could not start");
    } finally { setConnectingTiktok(false); }
  }

  async function checkFacebook(showGuideWhenMissing = true) {
    setCheckingFacebook(true);
    try {
      const response = await fetch(`${SERVICE_URL}/publishing/facebook/status`);
      const result = await response.json() as FacebookStatus & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Facebook Page connection could not be checked");
      setFacebookStatus(result);
      if (result.connected) setToast(`${result.pageName ?? "Facebook Page"} is connected and ready for Reels`);
      else {
        setToast(result.message ?? "Facebook Page is not connected");
        if (showGuideWhenMissing) setFacebookGuide(true);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Facebook Page connection could not be checked");
      if (showGuideWhenMissing) setFacebookGuide(true);
    } finally { setCheckingFacebook(false); }
  }

  async function connectFacebook() {
    const popup = window.open("about:blank", "reelio-facebook-oauth", "popup,width=560,height=760");
    setConnectingFacebook(true);
    try {
      if (metaAppId.trim() || metaAppSecret.trim()) {
        if (!metaAppId.trim() || !metaAppSecret.trim()) throw new Error("Enter both the Meta app ID and app secret.");
        const saved = await fetch(`${SERVICE_URL}/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ metaAppId: metaAppId.trim(), metaAppSecret: metaAppSecret.trim() }),
        });
        const savedResult = await saved.json() as { error?: string };
        if (!saved.ok) throw new Error(savedResult.error ?? "Meta app credentials could not be saved");
        setMetaAppId(""); setMetaAppSecret("");
      } else if (!facebookStatus?.configured) throw new Error("Enter the Meta app ID and app secret.");
      const response = await fetch(`${SERVICE_URL}/oauth/facebook/start`, { method: "POST" });
      const result = await response.json() as { authUrl?: string; error?: string };
      if (!response.ok || !result.authUrl) throw new Error(result.error ?? "Facebook authorization could not start");
      if (!popup) throw new Error("Allow pop-ups for Reelio, then press Connect Facebook again.");
      popup.location.href = result.authUrl;
      setToast("Complete Facebook authorization in the new window");
    } catch (error) {
      popup?.close();
      setToast(error instanceof Error ? error.message : "Facebook authorization could not start");
    } finally { setConnectingFacebook(false); }
  }

  async function selectFacebookPage(pageId: string) {
    setSelectingFacebookPage(true);
    try {
      const response = await fetch(`${SERVICE_URL}/oauth/facebook/select-page`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageId }),
      });
      const result = await response.json() as FacebookStatus & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The Facebook Page could not be selected");
      setFacebookStatus(result);
      if (result.connected) setToast(`${result.pageName ?? "Facebook Page"} is connected and ready for Reels`);
      else setToast(result.message ?? "Choose a Facebook Page to finish connecting");
      fetch(`${SERVICE_URL}/publishing/instagram/status`).then((value) => value.json()).then((value: InstagramStatus) => setInstagramStatus(value)).catch(() => {});
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The Facebook Page could not be selected");
    } finally { setSelectingFacebookPage(false); }
  }

  async function checkInstagram(showGuideWhenMissing = true) {
    setCheckingInstagram(true);
    try {
      const response = await fetch(`${SERVICE_URL}/publishing/instagram/status`);
      const result = await response.json() as InstagramStatus & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Instagram connection could not be checked");
      setInstagramStatus(result);
      if (result.connected) setToast(`${result.username ?? "Instagram Professional account"} is connected and ready for Reels`);
      else {
        setToast(result.message ?? "Instagram is not connected");
        if (showGuideWhenMissing) setInstagramGuide(true);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Instagram connection could not be checked");
      if (showGuideWhenMissing) setInstagramGuide(true);
    } finally { setCheckingInstagram(false); }
  }

  async function saveAndCheckInstagram() {
    setSavingInstagram(true);
    try {
      if (!publicMediaBaseUrl.trim()) throw new Error("Enter the public media base URL Meta can download finished Reels from.");
      const response = await fetch(`${SERVICE_URL}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicMediaBaseUrl: publicMediaBaseUrl.trim() }),
      });
      const saved = await response.json() as { error?: string };
      if (!response.ok) throw new Error(saved.error ?? "Instagram credentials could not be saved");
      setPublicMediaBaseUrl("");
      const statusResponse = await fetch(`${SERVICE_URL}/publishing/instagram/status`);
      const status = await statusResponse.json() as InstagramStatus & { error?: string };
      if (!statusResponse.ok) throw new Error(status.error ?? "Instagram connection could not be checked");
      setInstagramStatus(status);
      if (!status.connected) throw new Error(status.message ?? "Meta did not accept the Instagram credentials");
      setToast(`${status.username ?? "Instagram Professional account"} is connected and ready for Reels`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Instagram setup failed");
    } finally { setSavingInstagram(false); }
  }

  async function saveSettings() {
    setSaving(true);
    try {
      const payload: Record<string, string> = {
        reelioTextProvider: "google",
        geminiTextModel: "gemini-3.5-flash",
        geminiTtsModel: "gemini-3.1-flash-tts-preview",
        geminiTtsVoice: "Puck",
        kokoroVoice: "af_heart",
        kokoroSpeed: "1.15",
        openrouterTextModel: textModel,
        openrouterFallbackModel: "google/gemma-4-26b-a4b-it:free",
      };
      if (geminiKey.trim()) payload.geminiApiKey = geminiKey.trim();
      if (openRouterKey.trim()) payload.openrouterApiKey = openRouterKey.trim();
      if (pexelsKey.trim()) payload.pexelsApiKey = pexelsKey.trim();
      if (youtubeClientId.trim()) payload.googleClientId = youtubeClientId.trim();
      if (youtubeClientSecret.trim()) payload.googleClientSecret = youtubeClientSecret.trim();
      if (tiktokClientKey.trim()) payload.tiktokClientKey = tiktokClientKey.trim();
      if (tiktokClientSecret.trim()) payload.tiktokClientSecret = tiktokClientSecret.trim();
      if (metaAppId.trim()) payload.metaAppId = metaAppId.trim();
      if (metaAppSecret.trim()) payload.metaAppSecret = metaAppSecret.trim();
      if (publicMediaBaseUrl.trim()) payload.publicMediaBaseUrl = publicMediaBaseUrl.trim();
      const response = await fetch(`${SERVICE_URL}/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Settings could not be saved");
      setGeminiKey(""); setOpenRouterKey(""); setPexelsKey(""); setYoutubeClientId(""); setYoutubeClientSecret(""); setTiktokClientKey(""); setTiktokClientSecret(""); setMetaAppId(""); setMetaAppSecret(""); setPublicMediaBaseUrl("");
      setToast("Settings saved securely on this Mac");
      window.setTimeout(checkHealth, 100);
    } catch (error) { setToast(error instanceof Error ? error.message : "Settings could not be saved"); }
    finally { setSaving(false); }
  }
  return (
    <div className="content-wrap settings-page">
      <div className="page-heading"><div><div className="eyebrow"><span /> LOCAL SETTINGS</div><h1>Connect your creative stack.</h1><p>Secrets are written to a private local file and never stored in browser storage.</p></div><button className="primary-small" onClick={saveSettings} disabled={saving}><Check size={17} /> {saving ? "Saving…" : "Save settings"}</button></div>
      <div className="settings-grid">
        <section className="settings-card wide-settings">
          <div className="settings-title"><div className="provider-icon openrouter"><Sparkles size={20} /></div><div><strong>Google Gemini — text, translation, and multilingual voice</strong><span>Scripts • translation • selectable Gemini TTS narration</span></div><em className={health?.gemini ? "connected" : ""}><i /> {health?.gemini ? "Connected" : "Key required"}</em></div>
          <label className="secret-field"><span>Gemini API key</span><div><input type={showSecret ? "text" : "password"} placeholder={health?.gemini ? "Connected — enter only to replace" : "Paste Google AI Studio API key"} value={geminiKey} onChange={(event) => setGeminiKey(event.target.value)} autoComplete="off" /><button onClick={() => setShowSecret(!showSecret)}>{showSecret ? "Hide" : "Show"}</button></div><small>Used for scripts, translation, current-news grounding, and optional Gemini TTS. Saved only in .env.local.</small></label>
          <div className="local-model-summary"><span><strong>gemini-3.5-flash</strong><small>Factual master scripts and translation</small></span><span><strong>gemini-3.1-flash-tts-preview</strong><small>Puck voice • multilingual energetic narration</small></span></div>
          <button className="secondary-action" onClick={checkHealth}><RefreshCw size={15} /> Refresh Gemini status</button>
        </section>
        <section className="settings-card wide-settings">
          <div className="settings-title"><div className="provider-icon kokoro"><Mic2 size={20} /></div><div><strong>Kokoro — local English voice</strong><span>Default for English • Gemini remains optional</span></div><em className={health?.kokoro ? "connected" : ""}><i /> {ttsHealth?.ready ? "Ready" : "Setup required"}</em></div>
          <div className="local-model-summary"><span><strong>Kokoro-82M v1.0</strong><small>af_heart voice • 1.15× energetic pacing</small></span><span><strong>Curated music suite</strong><small>Intro sting • ducked bed • ending lift</small></span></div>
          {ttsHealth?.error && <p className="model-error">{ttsHealth.error}</p>}
          <button className="secondary-action" onClick={checkHealth}><RefreshCw size={15} /> Refresh Kokoro status</button>
        </section>
        <section className="settings-card wide-settings">
          <div className="settings-title"><div className="provider-icon kokoro"><Languages size={20} /></div><div><strong>VoxCPM2 — local multilingual voice</strong><span>Default for non-English • Gemini remains optional</span></div><em className={health?.voxcpm2 ? "connected" : ""}><i /> {voxHealth?.ready ? "Ready" : voxHealth?.loading ? "Downloading" : "Setup required"}</em></div>
          <div className="local-model-summary"><span><strong>OpenBMB/VoxCPM2</strong><small>30 languages • local Metal acceleration on Apple Silicon</small></span><span><strong>One-time setup</strong><small>Run npm run voxcpm2:setup</small></span></div>
          {voxHealth?.error && <p className="model-error">{voxHealth.error}</p>}
          <button className="secondary-action" onClick={checkHealth}><RefreshCw size={15} /> Refresh VoxCPM2 status</button>
        </section>
        <section className="settings-card">
          <div className="settings-title"><div className="provider-icon openrouter"><Sparkles size={20} /></div><div><strong>OpenRouter — text fallback</strong><span>Used only when Gemini is unavailable • {textHealth?.provider === "openrouter" ? textHealth.model : "Gemma fallback"}</span></div><em className={health?.openrouter ? "connected" : ""}><i /> {health?.openrouter ? "Connected" : "Not configured"}</em></div>
          <label className="secret-field"><span>API key</span><div><input type={showSecret ? "text" : "password"} placeholder={health?.openrouter ? "Connected — enter only to replace" : "Paste OpenRouter API key"} value={openRouterKey} onChange={(event) => setOpenRouterKey(event.target.value)} autoComplete="off" /><button onClick={() => setShowSecret(!showSecret)}>{showSecret ? "Hide" : "Show"}</button></div><small>Saved to .env.local with owner-only file permissions.</small></label>
          <label className="model-field"><span>Text model</span><select value={textModel} onChange={(event) => setTextModel(event.target.value)}><option>google/gemma-4-31b-it:free</option><option>openrouter/free</option></select></label>
          <button className="secondary-action" onClick={checkHealth}><RefreshCw size={15} /> Refresh status</button>
        </section>
        <section className="settings-card">
          <div className="settings-title"><div className="provider-icon pexels"><Film size={20} /></div><div><strong>Pexels</strong><span>Free licensed stock video</span></div><em className={health?.pexels ? "connected" : ""}><i /> {health?.pexels ? "Connected" : "Motion fallback"}</em></div>
          <label className="secret-field"><span>API key</span><div><input type="password" placeholder={health?.pexels ? "Connected — enter only to replace" : "Paste Pexels API key"} value={pexelsKey} onChange={(event) => setPexelsKey(event.target.value)} autoComplete="off" /></div><small>Clip credits and license metadata will be kept with each project.</small></label>
          <button className="secondary-action" onClick={checkHealth}><RefreshCw size={15} /> Refresh status</button>
        </section>
        <section className="settings-card wide-settings" id="publishing-accounts">
          <div className="settings-title"><div className="provider-icon social"><CloudUpload size={20} /></div><div><strong>Publishing accounts</strong><span>Connect each destination independently</span></div></div>
          <div className="connector-list">{platforms.map((platform) => {
            if (platform.id === "youtube") return <div key={platform.id}><PlatformLogo platform={platform} /><span><strong>{youtubeStatus?.channelTitle ?? platform.label}</strong><small>{youtubeStatus?.connected ? "Verified channel • upload access ready" : youtubeStatus?.message ?? "Google OAuth setup required"}</small></span><div className="connector-actions"><button className="connector-help" onClick={() => setYoutubeGuide(true)} aria-label="Open YouTube setup guide" title="YouTube setup guide"><CircleHelp size={15} /></button><button onClick={() => void checkYouTube(true)} disabled={checkingYoutube}>{checkingYoutube ? "Checking…" : youtubeStatus?.connected ? "Check" : "Set up"}</button></div></div>;
            if (platform.id === "tiktok") return <div key={platform.id}><PlatformLogo platform={platform} /><span><strong>{tiktokStatus?.displayName ?? platform.label}</strong><small>{tiktokStatus?.connected ? "Verified account • draft upload ready" : tiktokStatus?.message ?? "Content Posting API setup required"}</small></span><div className="connector-actions"><button className="connector-help" onClick={() => setTiktokGuide(true)} aria-label="Open TikTok setup guide" title="TikTok setup guide"><CircleHelp size={15} /></button><button onClick={() => void checkTikTok(true)} disabled={checkingTiktok}>{checkingTiktok ? "Checking…" : tiktokStatus?.connected ? "Check" : "Set up"}</button></div></div>;
            if (platform.id === "facebook") return <div key={platform.id}><PlatformLogo platform={platform} /><span><strong>{facebookStatus?.pageName ?? platform.label}</strong><small>{facebookStatus?.connected ? "Verified Page • Reels publishing ready" : facebookStatus?.message ?? "Facebook Page setup required"}</small></span><div className="connector-actions"><button className="connector-help" onClick={() => setFacebookGuide(true)} aria-label="Open Facebook Page setup guide" title="Facebook Page setup guide"><CircleHelp size={15} /></button><button onClick={() => void checkFacebook(true)} disabled={checkingFacebook}>{checkingFacebook ? "Checking…" : facebookStatus?.connected ? "Check" : "Set up"}</button></div></div>;
            return <div key={platform.id}><PlatformLogo platform={platform} /><span><strong>{instagramStatus?.username ?? platform.label}</strong><small>{instagramStatus?.connected ? "Verified Professional account • Reels publishing ready" : instagramStatus?.message ?? "Instagram Professional setup required"}</small></span><div className="connector-actions"><button className="connector-help" onClick={() => setInstagramGuide(true)} aria-label="Open Instagram setup guide" title="Instagram setup guide"><CircleHelp size={15} /></button><button onClick={() => void checkInstagram(true)} disabled={checkingInstagram}>{checkingInstagram ? "Checking…" : instagramStatus?.connected ? "Check" : "Set up"}</button></div></div>;
          })}</div>
        </section>
      </div>
      {youtubeGuide && <YouTubeSetupGuide status={youtubeStatus} clientId={youtubeClientId} clientSecret={youtubeClientSecret} setClientId={setYoutubeClientId} setClientSecret={setYoutubeClientSecret} showSecret={showSecret} setShowSecret={setShowSecret} connecting={connectingYoutube} onConnect={() => void connectYouTube()} onCheck={() => void checkYouTube(false)} onClose={() => setYoutubeGuide(false)} />}
      {tiktokGuide && <TikTokSetupGuide status={tiktokStatus} clientKey={tiktokClientKey} clientSecret={tiktokClientSecret} setClientKey={setTiktokClientKey} setClientSecret={setTiktokClientSecret} showSecret={showSecret} setShowSecret={setShowSecret} connecting={connectingTiktok} onConnect={() => void connectTikTok()} onCheck={() => void checkTikTok(false)} onClose={() => setTiktokGuide(false)} />}
      {facebookGuide && <FacebookSetupGuide status={facebookStatus} appId={metaAppId} appSecret={metaAppSecret} setAppId={setMetaAppId} setAppSecret={setMetaAppSecret} showSecret={showSecret} setShowSecret={setShowSecret} connecting={connectingFacebook} selecting={selectingFacebookPage} onConnect={() => void connectFacebook()} onSelectPage={(pageId) => void selectFacebookPage(pageId)} onCheck={() => void checkFacebook(false)} onClose={() => setFacebookGuide(false)} />}
      {instagramGuide && <InstagramSetupGuide status={instagramStatus} facebookConnected={Boolean(facebookStatus?.connected)} publicMediaBaseUrl={publicMediaBaseUrl} setPublicMediaBaseUrl={setPublicMediaBaseUrl} saving={savingInstagram} onSave={() => void saveAndCheckInstagram()} onCheck={() => void checkInstagram(false)} onClose={() => setInstagramGuide(false)} />}
    </div>
  );
}
