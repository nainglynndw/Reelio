"use client";

import {
  Bot, CalendarClock, Check, ChevronLeft, ChevronRight, CircleAlert, Clock3, CloudUpload,
  Edit3, ExternalLink, Globe2, Lightbulb, LoaderCircle, Newspaper, Play, Plus,
  RotateCcw, ShieldCheck, Sparkles, Trash2, WandSparkles, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { defaultTtsEngine, speechLanguages, ttsEngineOptions } from "../lib/languages";
import { narrators } from "../lib/narrators";
import { platforms } from "../lib/platforms";
import { scriptStyles } from "../lib/script-styles";
import { SERVICE_URL } from "../lib/service";
import type {
  Automation, CalendarEntry, LocalJob, NarratorId, PublishingReadiness, ScriptStyle, TtsEngine,
} from "../lib/types";

type ViewMode = "calendar" | "quick";
type ScheduleKind = "daily" | "weekdays" | "weekly" | "custom";
type PipelineDraft = {
  mode: ViewMode;
  name: string;
  color: string;
  briefSource: "suggested" | "news";
  category: string;
  topicFocus: string;
  timezone: string;
  startDate: string;
  endDate: string;
  weekdays: number[];
  times: string[];
  scheduleKind: ScheduleKind;
  quickTime: string;
  quickWeekday: string;
  cron: string;
  duration: string;
  language: string;
  ttsEngine: TtsEngine;
  subtitleLanguage: string;
  scriptStyle: ScriptStyle;
  narratorId: NarratorId;
  platforms: string[];
  publishMode: "review" | "auto";
  enabled: boolean;
};

const pipelineColors = ["#6f4bf3", "#18a7b8", "#e49a38", "#df5f9c", "#49b881", "#4b8cff", "#a65ac7", "#e0674f"];
const durations = ["30 sec", "60 sec", "60–90 sec", "90 sec", "2 min", "3 min"];
const week = [["0", "Sun"], ["1", "Mon"], ["2", "Tue"], ["3", "Wed"], ["4", "Thu"], ["5", "Fri"], ["6", "Sat"]];

export function AutomationsView({ setToast, onOpenJob, onOpenSettings }: {
  setToast: (value: string) => void;
  onOpenJob: (job: LocalJob) => void;
  onOpenSettings: () => void;
}) {
  const [mode, setMode] = useState<ViewMode>("calendar");
  const [pipelines, setPipelines] = useState<Automation[]>([]);
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [jobs, setJobs] = useState<LocalJob[]>([]);
  const [readiness, setReadiness] = useState<PublishingReadiness | null>(null);
  const [month, setMonth] = useState(() => monthStart(new Date()));
  const [online, setOnline] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PipelineDraft>(() => newDraft("calendar"));
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [planConfirmId, setPlanConfirmId] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<CalendarEntry | null>(null);
  const [entryBrief, setEntryBrief] = useState("");

  const range = useMemo(() => calendarGridRange(month), [month]);
  const refresh = useCallback(async (checkAccounts = false) => {
    try {
      const [automationValue, entryValue, jobValue] = await Promise.all([
        fetchJson<{ automations: Automation[] }>(`${SERVICE_URL}/automations`),
        fetchJson<{ entries: CalendarEntry[] }>(`${SERVICE_URL}/calendar-entries?start=${range.start}&end=${range.end}`),
        fetchJson<{ jobs: LocalJob[] }>(`${SERVICE_URL}/jobs`),
      ]);
      setPipelines(automationValue.automations ?? []);
      setEntries(entryValue.entries ?? []);
      setJobs(jobValue.jobs ?? []);
      if (checkAccounts) setReadiness(await fetchJson<PublishingReadiness>(`${SERVICE_URL}/publishing/readiness`));
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, [range.end, range.start]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(true), 0);
    const timer = window.setInterval(() => void refresh(), 8_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  const calendarPipelines = pipelines.filter((pipeline) => pipeline.mode === "calendar");
  const quickPipelines = pipelines.filter((pipeline) => pipeline.mode === "quick");
  const monthDays = useMemo(() => calendarGridDays(month), [month]);
  const jobsById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs]);

  function openNew(targetMode = mode) {
    setDraft(newDraft(targetMode));
    setEditingId(null);
    setFormError("");
    setEditorOpen(true);
  }

  function openEdit(pipeline: Automation) {
    setDraft(draftFromPipeline(pipeline));
    setEditingId(pipeline.id);
    setFormError("");
    setEditorOpen(true);
  }

  function selectMode(next: ViewMode) {
    setMode(next);
    setPlanConfirmId(null);
    setSelectedEntry(null);
  }

  function toggleDay(day: number) {
    setDraft((current) => ({
      ...current,
      weekdays: current.weekdays.includes(day) ? current.weekdays.filter((value) => value !== day) : [...current.weekdays, day].sort(),
    }));
  }

  function updateTime(index: number, value: string) {
    setDraft((current) => ({ ...current, times: current.times.map((time, timeIndex) => timeIndex === index ? value : time) }));
  }

  function setLanguage(language: string) {
    setDraft((current) => ({ ...current, language, ttsEngine: defaultTtsEngine(language) }));
  }

  function togglePlatform(platformId: string) {
    setDraft((current) => ({
      ...current,
      platforms: current.platforms.includes(platformId)
        ? current.platforms.filter((value) => value !== platformId)
        : [...current.platforms, platformId],
    }));
  }

  async function savePipeline() {
    setFormError("");
    if (draft.mode === "calendar" && (!draft.weekdays.length || !draft.times.length)) {
      setFormError("Choose at least one day and one posting time.");
      return;
    }
    if (draft.publishMode === "auto" && !draft.platforms.length) {
      setFormError("Automatic publishing requires at least one destination.");
      return;
    }
    if (draft.enabled && draft.publishMode === "auto" && draft.platforms.some((id) => !readiness?.accounts?.[id]?.ready)) {
      setFormError("Connect every selected publishing destination before enabling automatic publishing.");
      return;
    }
    setSaving(true);
    try {
      const body = pipelinePayload(draft);
      await fetchJson(`${SERVICE_URL}/automations${editingId ? `/${editingId}` : ""}`, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setEditorOpen(false);
      setEditingId(null);
      setMode(draft.mode);
      setToast(editingId ? "Pipeline updated" : draft.mode === "calendar" ? "Calendar pipeline created" : "Quick cron pipeline created");
      await refresh();
    } catch (error) {
      setFormError(messageOf(error, "Pipeline could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  async function togglePipeline(pipeline: Automation) {
    setBusyId(pipeline.id);
    try {
      await fetchJson(`${SERVICE_URL}/automations/${pipeline.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !pipeline.enabled }),
      });
      setToast(pipeline.enabled ? "Pipeline paused" : "Pipeline enabled");
      await refresh();
    } catch (error) {
      setToast(messageOf(error, "Pipeline could not be updated."));
    } finally {
      setBusyId(null);
    }
  }

  async function runQuick(pipeline: Automation) {
    setBusyId(pipeline.id);
    try {
      await fetchJson(`${SERVICE_URL}/automations/${pipeline.id}/run`, { method: "POST" });
      setToast("Fresh brief generated and video added to the queue");
      await refresh();
    } catch (error) {
      setToast(messageOf(error, "Quick Automation could not start."));
    } finally {
      setBusyId(null);
    }
  }

  async function deletePipeline(pipeline: Automation) {
    if (!window.confirm(`Delete “${pipeline.name}”? Existing video jobs will remain in Library.`)) return;
    setBusyId(pipeline.id);
    try {
      await fetchJson(`${SERVICE_URL}/automations/${pipeline.id}`, { method: "DELETE" });
      setToast("Pipeline deleted; existing videos were kept");
      await refresh();
    } catch (error) {
      setToast(messageOf(error, "Pipeline could not be deleted."));
    } finally {
      setBusyId(null);
    }
  }

  async function generateCalendarBriefs(pipeline: Automation) {
    setBusyId(pipeline.id);
    try {
      const result = await fetchJson<{ queued: number }>(`${SERVICE_URL}/automations/${pipeline.id}/plan`, { method: "POST" });
      setPlanConfirmId(null);
      setToast(result.queued ? `${result.queued} calendar briefs queued` : "Every calendar brief is already generated");
      await refresh();
    } catch (error) {
      setToast(messageOf(error, "Calendar briefs could not be generated."));
    } finally {
      setBusyId(null);
    }
  }

  function openEntry(entry: CalendarEntry) {
    setSelectedEntry(entry);
    setEntryBrief(entry.brief ?? "");
  }

  async function saveEntryBrief() {
    if (!selectedEntry) return;
    setBusyId(selectedEntry.id);
    try {
      const value = await fetchJson<{ entry: CalendarEntry }>(`${SERVICE_URL}/calendar-entries/${selectedEntry.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief: entryBrief }),
      });
      setSelectedEntry(value.entry);
      setToast("Calendar brief updated");
      await refresh();
    } catch (error) {
      setToast(messageOf(error, "Brief could not be saved."));
    } finally {
      setBusyId(null);
    }
  }

  async function entryAction(action: "run" | "regenerate") {
    if (!selectedEntry) return;
    setBusyId(selectedEntry.id);
    try {
      await fetchJson(`${SERVICE_URL}/calendar-entries/${selectedEntry.id}/${action}`, { method: "POST" });
      setToast(action === "run" ? "Calendar video added to the queue" : "A replacement brief is being generated");
      if (action === "run") setSelectedEntry(null);
      await refresh();
    } catch (error) {
      setToast(messageOf(error, `Calendar entry could not ${action}.`));
    } finally {
      setBusyId(null);
    }
  }

  return <div className="content-wrap automation-page">
    <div className="page-heading automation-heading"><div><div className="eyebrow"><span /> CONTENT OPERATIONS</div><h1>Plan the calendar or run on cron.</h1><p>Every occurrence starts with a fresh AI Suggested Idea or source-grounded Latest News brief, then uses the same production pipeline.</p></div><button className="primary-small" onClick={() => openNew()}><Plus size={16} /> New {mode === "calendar" ? "calendar pipeline" : "cron pipeline"}</button></div>

    <div className={`automation-banner ${online ? "" : "offline"}`}><div>{online ? <Bot size={22} /> : <CircleAlert size={22} />}<span><strong>{online ? "Automation worker is ready" : "Automation worker is offline"}</strong><p>{pipelines.filter((item) => item.enabled).length} active pipelines · schedules and plans persist locally</p></span></div><em>{online ? "LIVE" : "OFFLINE"}</em></div>

    <nav className="automation-mode-tabs" aria-label="Automation flow">
      <button className={mode === "calendar" ? "active" : ""} onClick={() => selectMode("calendar")}><CalendarClock size={18} /><span><strong>Content Calendar</strong><small>Dated plans across a start and end date</small></span></button>
      <button className={mode === "quick" ? "active" : ""} onClick={() => selectMode("quick")}><Sparkles size={18} /><span><strong>Quick Automation</strong><small>Recurring cron pipelines with fresh briefs</small></span></button>
    </nav>

    {editorOpen && <PipelineEditor draft={draft} setDraft={setDraft} editing={Boolean(editingId)} saving={saving} error={formError} readiness={readiness} onClose={() => setEditorOpen(false)} onSave={savePipeline} onToggleDay={toggleDay} onUpdateTime={updateTime} onSetLanguage={setLanguage} onTogglePlatform={togglePlatform} onOpenSettings={onOpenSettings} />}

    {mode === "calendar" ? <div className="calendar-workspace">
      <section className="content-calendar-card">
        <header><div><button aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft size={17} /></button><strong>{monthLabel(month)}</strong><button aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight size={17} /></button><button className="calendar-today" onClick={() => setMonth(monthStart(new Date()))}>Today</button></div><span>{entries.length} planned posts shown</span></header>
        <div className="calendar-weekdays">{week.map(([, label]) => <span key={label}>{label}</span>)}</div>
        <div className="calendar-grid">{monthDays.map((date) => {
          const dateEntries = entries.filter((entry) => entry.date === isoDate(date)).sort((a, b) => a.time.localeCompare(b.time));
          const inMonth = date.getMonth() === month.getMonth();
          return <div className={`calendar-day ${inMonth ? "" : "outside"} ${isToday(date) ? "today" : ""}`} key={isoDate(date)}><header><time>{date.getDate()}</time>{dateEntries.length > 0 && <small>{dateEntries.length}</small>}</header><div>{dateEntries.slice(0, 5).map((entry) => <button className={`calendar-event ${entry.state}`} style={{ "--pipeline-color": entry.color } as React.CSSProperties} key={entry.id} onClick={() => openEntry(entry)}><span><time>{entry.time}</time><em>{entry.automationName}</em></span><strong>{entry.title}</strong><small>{entryStatus(entry)}</small></button>)}{dateEntries.length > 5 && <button className="calendar-more">+{dateEntries.length - 5} more</button>}</div></div>;
        })}</div>
      </section>
      <aside className="calendar-pipelines">
        <header><div><strong>Calendar pipelines</strong><span>Different colors stay distinct on busy days.</span></div><button onClick={() => openNew("calendar")}><Plus size={14} /></button></header>
        {calendarPipelines.length === 0 ? <EmptyPipeline mode="calendar" onCreate={() => openNew("calendar")} /> : calendarPipelines.map((pipeline) => {
          const missing = Math.max(0, (pipeline.calendarEntryCount ?? 0) - (pipeline.calendarBriefsReady ?? 0));
          return <article className="calendar-pipeline-card" key={pipeline.id}><header><i style={{ background: pipeline.color }} /><span><strong>{pipeline.name}</strong><small>{pipeline.startDate} → {pipeline.endDate}</small></span><button className={`toggle ${pipeline.enabled ? "on" : ""}`} disabled={busyId === pipeline.id} onClick={() => void togglePipeline(pipeline)}><span /></button></header><p>{pipeline.briefSource === "news" ? <Newspaper size={13} /> : <Lightbulb size={13} />}{pipeline.briefSource === "news" ? "Latest News" : "Suggested Idea"} · {(pipeline.times ?? []).length} post{(pipeline.times ?? []).length === 1 ? "" : "s"} per selected day</p><div className="pipeline-progress"><span><b style={{ width: `${(pipeline.calendarBriefsReady ?? 0) / Math.max(1, pipeline.calendarEntryCount ?? 1) * 100}%` }} /></span><small>{pipeline.calendarBriefsReady ?? 0}/{pipeline.calendarEntryCount ?? 0} briefs ready</small></div>{planConfirmId === pipeline.id ? <div className="calendar-token-confirm"><CircleAlert size={14} /><span><strong>Generate {missing} AI briefs?</strong><small>Each entry uses API tokens. Latest News also performs grounded search.</small></span><button onClick={() => void generateCalendarBriefs(pipeline)}>Confirm</button><button onClick={() => setPlanConfirmId(null)}>Cancel</button></div> : missing > 0 && <button className="generate-calendar-briefs" onClick={() => setPlanConfirmId(pipeline.id)} disabled={pipeline.briefPlanning}><WandSparkles size={14} /> {pipeline.briefPlanning ? "Generating briefs…" : `Generate ${missing} briefs`}</button>}<footer><button onClick={() => openEdit(pipeline)}><Edit3 size={13} /> Edit</button><button onClick={() => void deletePipeline(pipeline)}><Trash2 size={13} /> Delete</button></footer></article>;
        })}
      </aside>
    </div> : <section className="quick-pipeline-workspace">
      <header><div><strong>Recurring cron pipelines</strong><span>Each cron occurrence creates a new brief before video generation begins.</span></div><button className="primary-small" onClick={() => openNew("quick")}><Plus size={15} /> New cron pipeline</button></header>
      {quickPipelines.length === 0 ? <EmptyPipeline mode="quick" onCreate={() => openNew("quick")} /> : <div className="quick-pipeline-grid">{quickPipelines.map((pipeline) => <article className="quick-pipeline-card" key={pipeline.id} style={{ "--pipeline-color": pipeline.color } as React.CSSProperties}><header><i>{pipeline.briefSource === "news" ? <Newspaper size={18} /> : <Sparkles size={18} />}</i><span><strong>{pipeline.name}</strong><small>{pipeline.briefSource === "news" ? "AI Latest News" : "AI Suggested Idea"}</small></span><button className={`toggle ${pipeline.enabled ? "on" : ""}`} disabled={busyId === pipeline.id} onClick={() => void togglePipeline(pipeline)}><span /></button></header><p>{pipeline.topicFocus || "AI chooses within the selected category."}</p><div className="quick-schedule"><span><Clock3 size={14} /><strong>{cronLabel(pipeline.cron ?? "")}</strong></span><span><Globe2 size={14} />{pipeline.timezone}</span></div><div className="quick-pipeline-meta"><span><small>Next run</small><strong>{pipeline.enabled ? formatDateTime(pipeline.nextRunAt) : "Paused"}</strong></span><span><small>Videos created</small><strong>{pipeline.runCount ?? 0}</strong></span></div>{pipeline.lastError && <p className="pipeline-error"><CircleAlert size={13} /> {pipeline.lastError}</p>}<footer><button disabled={busyId === pipeline.id || Boolean(pipeline.activeJobId)} onClick={() => void runQuick(pipeline)}>{busyId === pipeline.id ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />} Generate now</button><button onClick={() => openEdit(pipeline)}><Edit3 size={13} /> Edit</button><button onClick={() => void deletePipeline(pipeline)}><Trash2 size={13} /></button></footer></article>)}</div>}
    </section>}

    {selectedEntry && <EntryDialog entry={selectedEntry} brief={entryBrief} setBrief={setEntryBrief} job={selectedEntry.jobId ? jobsById.get(selectedEntry.jobId) : undefined} busy={busyId === selectedEntry.id} onClose={() => setSelectedEntry(null)} onSave={saveEntryBrief} onRun={() => void entryAction("run")} onRegenerate={() => void entryAction("regenerate")} onOpenJob={onOpenJob} />}
  </div>;
}

function PipelineEditor(props: {
  draft: PipelineDraft; setDraft: (value: PipelineDraft | ((current: PipelineDraft) => PipelineDraft)) => void;
  editing: boolean; saving: boolean; error: string; readiness: PublishingReadiness | null;
  onClose: () => void; onSave: () => void; onToggleDay: (day: number) => void; onUpdateTime: (index: number, value: string) => void;
  onSetLanguage: (language: string) => void; onTogglePlatform: (id: string) => void; onOpenSettings: () => void;
}) {
  const { draft, setDraft } = props;
  return <section className="automation-editor pipeline-editor">
    <header><div><strong>{props.editing ? "Edit" : "Create"} {draft.mode === "calendar" ? "Content Calendar pipeline" : "Quick cron pipeline"}</strong><span>{draft.mode === "calendar" ? "Create dated slots across a bounded range." : "Run a fresh brief and full video workflow on cron."}</span></div><button aria-label="Close pipeline editor" onClick={props.onClose}><X size={16} /></button></header>
    <div className="pipeline-source-picker"><span>Brief source · uses AI tokens for every generated brief</span><div><button className={draft.briefSource === "suggested" ? "selected" : ""} onClick={() => setDraft({ ...draft, briefSource: "suggested" })}><Lightbulb size={18} /><span><strong>AI Suggested Idea</strong><small>Fresh topic selected from your focus and category.</small></span></button><button className={draft.briefSource === "news" ? "selected" : ""} onClick={() => setDraft({ ...draft, briefSource: "news" })}><Newspaper size={18} /><span><strong>AI Latest News</strong><small>Gemini grounded search from the last seven days.</small></span></button></div></div>
    <div className="automation-form-grid">
      <label><span>Pipeline name</span><input value={draft.name} maxLength={100} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label><span>Color</span><div className="pipeline-color-picker">{pipelineColors.map((color) => <button aria-label={`Use ${color}`} className={draft.color === color ? "selected" : ""} style={{ background: color }} key={color} onClick={() => setDraft({ ...draft, color })}>{draft.color === color && <Check size={12} />}</button>)}</div></label>
      <label><span>Content category</span><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}><option>Knowledge</option><option>Science</option><option>Psychology</option><option>Technology</option><option>History</option><option>Business</option><option>Wellness</option></select></label>
      <label className="automation-wide"><span>Topic focus</span><input value={draft.topicFocus} maxLength={300} onChange={(event) => setDraft({ ...draft, topicFocus: event.target.value })} placeholder="Optional — e.g. practical space science, creator psychology" /></label>
      {draft.mode === "calendar" ? <>
        <label><span>Start date</span><input type="date" value={draft.startDate} onChange={(event) => setDraft({ ...draft, startDate: event.target.value })} /></label>
        <label><span>End date</span><input type="date" value={draft.endDate} onChange={(event) => setDraft({ ...draft, endDate: event.target.value })} /></label>
        <label><span>Timezone</span><input value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} /></label>
        <div className="automation-wide calendar-slot-builder"><span>Days and posting times</span><div className="weekday-picker">{week.map(([value, label]) => <button className={draft.weekdays.includes(Number(value)) ? "selected" : ""} key={value} onClick={() => props.onToggleDay(Number(value))}>{label}</button>)}</div><div className="posting-times">{draft.times.map((time, index) => <label key={`${index}-${time}`}><Clock3 size={14} /><input type="time" value={time} onChange={(event) => props.onUpdateTime(index, event.target.value)} />{draft.times.length > 1 && <button aria-label={`Remove ${time}`} onClick={() => setDraft({ ...draft, times: draft.times.filter((_, itemIndex) => itemIndex !== index) })}><X size={13} /></button>}</label>)}{draft.times.length < 8 && <button onClick={() => setDraft({ ...draft, times: [...draft.times, nextTime(draft.times)] })}><Plus size={13} /> Add another post time</button>}</div></div>
      </> : <>
        <label><span>Cron schedule</span><select value={draft.scheduleKind} onChange={(event) => setDraft({ ...draft, scheduleKind: event.target.value as ScheduleKind })}><option value="weekdays">Weekdays</option><option value="daily">Every day</option><option value="weekly">Once a week</option><option value="custom">Custom cron</option></select></label>
        {draft.scheduleKind !== "custom" && <label><span>Run time</span><input type="time" value={draft.quickTime} onChange={(event) => setDraft({ ...draft, quickTime: event.target.value })} /></label>}
        {draft.scheduleKind === "weekly" && <label><span>Run day</span><select value={draft.quickWeekday} onChange={(event) => setDraft({ ...draft, quickWeekday: event.target.value })}>{week.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>}
        {draft.scheduleKind === "custom" && <label><span>Cron expression</span><input value={draft.cron} onChange={(event) => setDraft({ ...draft, cron: event.target.value })} placeholder="30 8 * * 1-5" /></label>}
        <label><span>Timezone</span><input value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} /></label>
      </>}
    </div>
    <details className="pipeline-production-settings"><summary>Video production settings <small>{draft.duration} · {draft.language} · {narrators.find((item) => item.id === draft.narratorId)?.name}</small></summary><div className="automation-form-grid"><label><span>Duration</span><select value={draft.duration} onChange={(event) => setDraft({ ...draft, duration: event.target.value })}>{durations.map((value) => <option key={value}>{value}</option>)}</select></label><label><span>Speech language</span><select value={draft.language} onChange={(event) => props.onSetLanguage(event.target.value)}>{speechLanguages.map((value) => <option key={value}>{value}</option>)}</select></label><label><span>Voice engine</span><select value={draft.ttsEngine} onChange={(event) => setDraft({ ...draft, ttsEngine: event.target.value as TtsEngine })}>{ttsEngineOptions(draft.language).map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label><span>Subtitle language</span><select value={draft.subtitleLanguage} onChange={(event) => setDraft({ ...draft, subtitleLanguage: event.target.value })}>{speechLanguages.map((value) => <option key={value}>{value}</option>)}</select></label><label><span>Script style</span><select value={draft.scriptStyle} onChange={(event) => setDraft({ ...draft, scriptStyle: event.target.value as ScriptStyle })}>{scriptStyles.map((style) => <option value={style.id} key={style.id}>{style.label}</option>)}</select></label><label><span>Narrator</span><select value={draft.narratorId} onChange={(event) => setDraft({ ...draft, narratorId: event.target.value as NarratorId })}>{narrators.map((narrator) => <option value={narrator.id} key={narrator.id}>{narrator.name} — {narrator.role}</option>)}</select></label></div></details>
    <div className="automation-destinations"><span>Publishing destinations</span><div>{platforms.map((platform) => <button key={platform.id} className={draft.platforms.includes(platform.id) ? "selected" : ""} onClick={() => props.onTogglePlatform(platform.id)}><i style={{ background: platform.tone }}>{platform.short}</i><span><strong>{platform.label}</strong><small>{props.readiness?.accounts?.[platform.id]?.ready ? "Connected" : "Setup required"}</small></span>{draft.platforms.includes(platform.id) && <Check size={13} />}</button>)}</div></div>
    <div className="automation-policy"><span>After video generation</span><div><button className={draft.publishMode === "review" ? "selected" : ""} onClick={() => setDraft({ ...draft, publishMode: "review" })}><ShieldCheck size={17} /><span><strong>Wait for review</strong><small>Video stops in Library for approval.</small></span></button><button className={draft.publishMode === "auto" ? "selected danger" : ""} onClick={() => setDraft({ ...draft, publishMode: "auto" })}><CloudUpload size={17} /><span><strong>Publish automatically</strong><small>External uploads begin without another confirmation.</small></span></button></div>{draft.publishMode === "auto" && draft.platforms.some((id) => !props.readiness?.accounts?.[id]?.ready) && <button className="secondary-action" onClick={props.onOpenSettings}>Connect selected accounts</button>}</div>
    {props.error && <p className="automation-form-error"><CircleAlert size={14} /> {props.error}</p>}
    <footer><label className="automation-enabled"><button className={`toggle ${draft.enabled ? "on" : ""}`} onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}><span /></button><span><strong>Pipeline enabled</strong><small>{draft.mode === "calendar" ? "Run dated entries automatically." : "Run automatically when cron fires."}</small></span></label><div><button className="secondary-action" onClick={props.onClose}>Cancel</button><button className="primary-small" disabled={props.saving || !draft.name.trim()} onClick={props.onSave}>{props.saving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Save pipeline</button></div></footer>
  </section>;
}

function EntryDialog({ entry, brief, setBrief, job, busy, onClose, onSave, onRun, onRegenerate, onOpenJob }: {
  entry: CalendarEntry; brief: string; setBrief: (value: string) => void; job?: LocalJob; busy: boolean;
  onClose: () => void; onSave: () => void; onRun: () => void; onRegenerate: () => void; onOpenJob: (job: LocalJob) => void;
}) {
  return <div className="calendar-entry-modal" role="presentation"><section role="dialog" aria-modal="true" aria-label="Calendar plan"><header style={{ borderColor: entry.color }}><div><span><i style={{ background: entry.color }} />{entry.automationName}</span><strong>{entry.date} at {entry.time}</strong><small>{entry.briefSource === "news" ? "AI Latest News" : "AI Suggested Idea"} · {entryStatus(entry)}</small></div><button aria-label="Close calendar plan" onClick={onClose}><X size={16} /></button></header><label><span>Video brief</span><textarea value={brief} onChange={(event) => setBrief(event.target.value)} placeholder={entry.briefState === "generating" ? "Brief is being generated…" : "Generate or write this brief"} disabled={Boolean(entry.jobId)} /></label>{entry.error && <p><CircleAlert size={13} /> {entry.error}</p>}<footer>{job ? <button className="primary-small" onClick={() => onOpenJob(job)}>Open video <ExternalLink size={13} /></button> : <><button className="secondary-action" disabled={busy} onClick={onRegenerate}><RotateCcw size={13} /> Regenerate</button><button className="secondary-action" disabled={busy || brief.trim().length < 3} onClick={onSave}><Check size={13} /> Save brief</button><button className="primary-small" disabled={busy || entry.briefState !== "ready"} onClick={onRun}>{busy ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />} Generate video now</button></>}</footer></section></div>;
}

function EmptyPipeline({ mode, onCreate }: { mode: ViewMode; onCreate: () => void }) {
  return <div className="automation-empty"><i>{mode === "calendar" ? <CalendarClock size={24} /> : <Sparkles size={24} />}</i><strong>{mode === "calendar" ? "No calendar pipelines" : "No cron pipelines"}</strong><span>{mode === "calendar" ? "Create a date range with one or many posts per day." : "Create a recurring cron recipe that starts with a fresh brief."}</span><button className="primary-small" onClick={onCreate}><Plus size={14} /> Create pipeline</button></div>;
}

function newDraft(mode: ViewMode): PipelineDraft {
  const today = isoDate(new Date());
  const end = new Date(); end.setDate(end.getDate() + 30);
  return {
    mode, name: mode === "calendar" ? "Monthly knowledge calendar" : "Weekday knowledge cron",
    color: pipelineColors[mode === "calendar" ? 0 : 1], briefSource: "suggested", category: "Knowledge", topicFocus: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Bangkok",
    startDate: today, endDate: isoDate(end), weekdays: [1, 2, 3, 4, 5], times: ["08:30"],
    scheduleKind: "weekdays", quickTime: "08:30", quickWeekday: "1", cron: "30 8 * * 1-5",
    duration: "60–90 sec", language: "English", ttsEngine: "kokoro", subtitleLanguage: "English",
    scriptStyle: "clear-explainer", narratorId: "maya", platforms: [], publishMode: "review", enabled: true,
  };
}

function draftFromPipeline(pipeline: Automation): PipelineDraft {
  const base = newDraft(pipeline.mode);
  const parsed = parseCron(pipeline.cron ?? "");
  return {
    ...base, mode: pipeline.mode, name: pipeline.name, color: pipeline.color, briefSource: pipeline.briefSource,
    category: pipeline.template.category ?? "Knowledge",
    topicFocus: pipeline.topicFocus ?? "", timezone: pipeline.timezone, startDate: pipeline.startDate ?? base.startDate,
    endDate: pipeline.endDate ?? base.endDate, weekdays: pipeline.weekdays ?? base.weekdays, times: pipeline.times ?? base.times,
    scheduleKind: parsed.kind, quickTime: parsed.time, quickWeekday: parsed.weekday, cron: pipeline.cron ?? base.cron,
    duration: pipeline.template.duration, language: pipeline.template.language,
    ttsEngine: pipeline.template.ttsEngine ?? defaultTtsEngine(pipeline.template.language),
    subtitleLanguage: pipeline.template.subtitleLanguage, scriptStyle: pipeline.template.scriptStyle ?? "clear-explainer",
    narratorId: pipeline.template.narratorId ?? "maya", platforms: pipeline.template.platforms,
    publishMode: pipeline.publishMode, enabled: pipeline.enabled,
  };
}

function pipelinePayload(draft: PipelineDraft) {
  const seed = draft.topicFocus.trim() || (draft.briefSource === "news" ? "Generate a fresh source-grounded current-news brief." : "Generate a fresh suggested knowledge-video brief.");
  return {
    mode: draft.mode, name: draft.name, color: draft.color, briefSource: draft.briefSource, topicFocus: draft.topicFocus,
    enabled: draft.enabled, timezone: draft.timezone, publishMode: draft.publishMode,
    ...(draft.mode === "calendar"
      ? { startDate: draft.startDate, endDate: draft.endDate, weekdays: draft.weekdays, times: draft.times, cron: null }
      : { cron: cronFromDraft(draft) }),
    template: {
      prompt: seed, category: draft.category, duration: draft.duration, language: draft.language,
      ttsEngine: draft.ttsEngine, subtitleLanguage: draft.subtitleLanguage, scriptStyle: draft.scriptStyle,
      narratorId: draft.narratorId, platforms: draft.platforms,
    },
  };
}

function cronFromDraft(draft: PipelineDraft) {
  if (draft.scheduleKind === "custom") return draft.cron.trim().replace(/\s+/g, " ");
  const [hour = "8", minute = "30"] = draft.quickTime.split(":");
  if (draft.scheduleKind === "daily") return `${Number(minute)} ${Number(hour)} * * *`;
  if (draft.scheduleKind === "weekly") return `${Number(minute)} ${Number(hour)} * * ${draft.quickWeekday}`;
  return `${Number(minute)} ${Number(hour)} * * 1-5`;
}

function parseCron(expression: string): { kind: ScheduleKind; time: string; weekday: string } {
  const [minute, hour, day, month, weekday] = expression.split(/\s+/);
  const time = /^\d+$/.test(hour) && /^\d+$/.test(minute) ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` : "08:30";
  if (day === "*" && month === "*" && weekday === "1-5") return { kind: "weekdays", time, weekday: "1" };
  if (day === "*" && month === "*" && weekday === "*") return { kind: "daily", time, weekday: "1" };
  if (day === "*" && month === "*" && /^[0-6]$/.test(weekday)) return { kind: "weekly", time, weekday };
  return { kind: "custom", time, weekday: "1" };
}

function cronLabel(expression: string) {
  const parsed = parseCron(expression);
  if (parsed.kind === "weekdays") return `Weekdays at ${parsed.time}`;
  if (parsed.kind === "daily") return `Every day at ${parsed.time}`;
  if (parsed.kind === "weekly") return `${week.find(([value]) => value === parsed.weekday)?.[1]} at ${parsed.time}`;
  return expression;
}

function calendarGridRange(month: Date) {
  const days = calendarGridDays(month);
  return { start: isoDate(days[0]), end: isoDate(days.at(-1) ?? days[0]) };
}
function calendarGridDays(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first); start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); return date; });
}
function monthStart(date: Date) { return new Date(date.getFullYear(), date.getMonth(), 1); }
function addMonths(date: Date, amount: number) { return new Date(date.getFullYear(), date.getMonth() + amount, 1); }
function monthLabel(date: Date) { return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date); }
function isoDate(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function isToday(date: Date) { return isoDate(date) === isoDate(new Date()); }
function formatDateTime(value?: string | null) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not scheduled"; }
function nextTime(times: string[]) { const last = times.at(-1) ?? "08:30"; const [hour, minute] = last.split(":").map(Number); return `${String((hour + 3) % 24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`; }
function entryStatus(entry: CalendarEntry) { return entry.briefState === "generating" ? "Generating brief" : entry.briefState === "pending" ? "Brief pending" : entry.briefState === "failed" ? "Needs attention" : entry.state.replaceAll("_", " "); }
function messageOf(error: unknown, fallback: string) { return error instanceof Error && error.message ? error.message : fallback; }
async function fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T> { const response = await fetch(url, init); const body = await response.json().catch(() => ({})) as { error?: string }; if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`); return body as T; }
