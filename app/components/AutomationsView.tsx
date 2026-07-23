"use client";

import {
  Bot,
  CalendarClock,
  Check,
  ChevronRight,
  Clock3,
  CloudUpload,
  Globe2,
  Languages,
  Lightbulb,
  Plus,
  RefreshCw,
  ShieldCheck,
  WandSparkles,
} from "lucide-react";
import { useState } from "react";
import { SERVICE_URL } from "../lib/service";

export function AutomationsView({ automationOn, setAutomationOn, setToast }: { automationOn: boolean; setAutomationOn: (value: boolean) => void; setToast: (value: string) => void }) {
  const [automationId, setAutomationId] = useState<string | null>(null);
  async function toggleSchedule() {
    try {
      if (!automationId) {
        const response = await fetch(`${SERVICE_URL}/automations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Daily knowledge drop",
            cron: "30 8 * * 1-5",
            timezone: "Asia/Bangkok",
            enabled: true,
            requireReview: true,
            template: {
              prompt: "Create a surprising, useful knowledge reel about science, psychology, technology, or history.",
              category: "Curious science",
              duration: "60–90 sec",
              language: "English",
              subtitleLanguage: "Thai",
              platforms: ["youtube", "tiktok", "facebook", "instagram"],
            },
          }),
        });
        if (!response.ok) throw new Error("Could not create schedule");
        const { automation } = await response.json() as { automation: { id: string } };
        setAutomationId(automation.id);
        setAutomationOn(true);
        setToast("Weekday 08:30 automation enabled");
      } else {
        const next = !automationOn;
        const response = await fetch(`${SERVICE_URL}/automations/${automationId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }) });
        if (!response.ok) throw new Error("Could not update schedule");
        setAutomationOn(next);
        setToast(next ? "Automation resumed" : "Automation paused");
      }
    } catch {
      setToast("Local automation worker is not available");
    }
  }
  return (
    <div className="content-wrap automation-page">
      <div className="page-heading"><div><div className="eyebrow"><span /> WORKFLOW AUTOMATION</div><h1>Build once. Publish on rhythm.</h1><p>Cron, webhook, and AI-agent triggers use the same durable generation jobs.</p></div><button className="primary-small" onClick={toggleSchedule}><Plus size={17} /> Add schedule</button></div>
      <div className="automation-banner"><div><Bot size={24} /><span><strong>Local automation worker is live</strong><p>Ideas → scripts → clips → languages → approvals → publishing are independent resumable jobs.</p></span></div><em>ACTIVE</em></div>
      <div className="automation-grid">
        {automationId ? <section className="schedule-card">
          <div className="schedule-head"><div className="schedule-icon"><CalendarClock size={20} /></div><div><strong>Daily knowledge drop</strong><span>{automationOn ? "Active schedule" : "Paused schedule"}</span></div><button className={`toggle ${automationOn ? "on" : ""}`} onClick={toggleSchedule}><span /></button></div>
          <div className="flow-line"><FlowNode icon={<Lightbulb size={17} />} title="AI idea" note="Science & psychology" /><ChevronRight size={16} /><FlowNode icon={<WandSparkles size={17} />} title="Generate" note="75-second reel" /><ChevronRight size={16} /><FlowNode icon={<ShieldCheck size={17} />} title="Review" note="Approval required" /><ChevronRight size={16} /><FlowNode icon={<CloudUpload size={17} />} title="Publish" note="4 platforms" /></div>
          <div className="schedule-details"><span><Clock3 size={15} /> Every weekday at 08:30</span><span><Globe2 size={15} /> Asia/Bangkok</span><span><Languages size={15} /> EN + TH subtitles</span></div>
        </section> : <section className="schedule-card schedule-empty"><CalendarClock size={25} /><strong>No schedules configured</strong><span>Use Add schedule when you are ready to automate new videos.</span></section>}
        <aside className="automation-guardrails"><h3>Required before auto-publish</h3>{["Provider credentials connected", "Channel-level content policy", "Monetization preflight passed", "Retry and failure notifications", "Human approval can be enabled"].map((item, index) => <div key={item}><span className={index < 2 ? "ready" : ""}>{index < 2 ? <Check size={13} /> : index + 1}</span>{item}</div>)}</aside>
      </div>
      <div className="jobs-card"><div className="jobs-head"><div><strong>Recent workflow jobs</strong><span>Designed for cron, webhook, or AI-agent triggers</span></div><button><RefreshCw size={15} /> Refresh</button></div><div className="jobs-empty"><strong>No workflow jobs yet</strong><span>New scheduled and agent-triggered jobs will appear here.</span></div></div>
    </div>
  );
}

function FlowNode({ icon, title, note }: { icon: React.ReactNode; title: string; note: string }) {
  return <div className="flow-node"><i>{icon}</i><span><strong>{title}</strong><small>{note}</small></span></div>;
}
