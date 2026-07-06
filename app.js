"use strict";

/* ---------- Config ---------- */
const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1500;
const KEY_STORE = "spark.anthropic_key";

const SYSTEM_PROMPT = `You are Spark, an assistant for freelancers and small creative teams. \
The user gives you a raw, free-form project idea. Turn it into a clear, structured project plan.

Respond with ONLY a single JSON object — no prose, no markdown, no code fences — matching exactly this shape:

{
  "projectName": "A short, memorable, evocative name (2-4 words)",
  "tagline": "A punchy one-line description of the project",
  "brief": "A 2-3 sentence brief framing the goal, audience, and value",
  "tasks": [
    { "title": "Concrete, actionable task", "estimate": "Rough time estimate, e.g. '2h', '1 day', '3 days'" }
  ],
  "openQuestions": ["Important question that needs answering before/early in the work"],
  "risks": ["A key risk or pitfall to watch for"]
}

Rules:
- 5 to 8 tasks, ordered in true dependency sequence — discovery/alignment first, launch/handoff last; nothing may depend on a later task.
- Estimates must be realistic, not optimistic: include time for feedback rounds, revisions and integration. When unsure, round up (people underestimate by ~30%).
- Prefer tasks a freelancer can start and finish independently; split anything over ~5 days.
- Open questions must be decision-critical — things that would change the plan or price if answered differently.
- Risks must be specific to THIS project (never generic like "scope creep" without a concrete cause), each implying a watchable early signal.
- 3 to 5 open questions and 3 to 5 risks.
- Keep every string concise and free of filler.
- Output valid JSON only. Do not wrap it in backticks or add commentary.`;

const STRUCTURE_SYSTEM = `You are Spark. The user wrote their OWN rough project draft — a braindump. \
Your job is ONLY to organize what they wrote into the structure below. You are a librarian, not an author.

Respond with ONLY a single JSON object — no prose, no markdown, no code fences — matching exactly this shape:

{
  "projectName": "Short name composed from THEIR words",
  "tagline": "One line distilled from THEIR framing",
  "brief": "2-3 sentences summarizing THEIR goal in close to their own wording",
  "tasks": [ { "title": "A task they stated or directly implied", "estimate": "ONLY if they gave one, else empty string" } ],
  "openQuestions": ["Each genuine gap or ambiguity in their draft becomes a question"],
  "risks": ["ONLY concerns they themselves raised or directly implied"]
}

Hard rules:
- Never invent tasks, estimates, or risks the user didn't state or directly imply. Missing information becomes an open question, not made-up content.
- Preserve their wording and terminology wherever it is usable.
- Every task in their draft must appear; merge exact duplicates only.
- Output valid JSON only. Do not wrap it in backticks or add commentary.`;

const REWORK_SYSTEM = `You refine a single element of an existing project plan for a freelancer or small creative team. \
You are given the project context and one element to rework. Return ONLY a single JSON object — no prose, no markdown, no code fences. \
Keep it concise, useful, and distinct from the other listed elements.`;

const REFINE_SYSTEM = `You refine an existing project plan for a freelancer or small creative team based on the user's instruction. \
Apply only what they ask (plus naturally-required adjustments) and preserve everything else exactly. \
Return ONLY a single JSON object — no prose, no markdown, no code fences — with the same shape as the project plus a short "summary" of what you changed.`;

/* ---------- Elements ---------- */
const el = (id) => document.getElementById(id);
const chatThread  = el("chatThread");
const composerForm= el("composer");
const ideaInput   = el("ideaInput");
const sparkBtn    = el("sparkBtn");
const suggestionsEl = el("suggestions");
const toneSlider  = el("toneSlider");
const toneValue   = el("toneValue");
const applyToneBtn = el("applyToneBtn");
const newComposerBtn = el("newComposerBtn");
const clarifyToggle = el("clarifyToggle");
const clarifyLabel = el("clarifyLabel");
const micBtn = el("micBtn");
const emptyState  = el("emptyState");
const loadingState= el("loadingState");
const errorState  = el("errorState");
const errorText   = el("errorText");
const retryBtn    = el("retryBtn");
const result      = el("result");

const projectsBtn = el("projectsBtn");
const projectsDropdown = el("projectsDropdown");
const projectList = el("projectList");
const projectsEmpty = el("projectsEmpty");
const newProjectBtn = el("newProjectBtn");

const themeBtn = el("themeBtn");
const settingsBtn = el("settingsBtn");
const settingsModal = el("settingsModal");
const apiKeyInput = el("apiKeyInput");
const rateInput   = el("rateInput");
const currencyInput = el("currencyInput");
const modelSelect = el("modelSelect");
const brandNameInput = el("brandNameInput");
const brandEmailInput = el("brandEmailInput");
const brandPhoneInput = el("brandPhoneInput");
const brandWebsiteInput = el("brandWebsiteInput");
const brandAccentInput = el("brandAccentInput");
const brandLogoInput = el("brandLogoInput");
const brandLogoBtn = el("brandLogoBtn");
const brandLogoClear = el("brandLogoClear");
const brandLogoPreview = el("brandLogoPreview");
const saveKeyBtn  = el("saveKeyBtn");
const cancelKeyBtn= el("cancelKeyBtn");
const clearKeyBtn = el("clearKeyBtn");

/* ---------- App state (single source of truth) ---------- */
let project = null;        // the current project object — everything renders from this
let history = [];          // snapshots for undo
let busy = false;          // a spark or refine turn is in flight
let streaming = false;     // a streamed (token-by-token) response is in flight
let clarify = null;        // pre-project clarify-first state: { idea, questions, chat }
let clarifyEnabled = (() => { try { return localStorage.getItem("spark.clarify") === "1"; } catch (_) { return false; } })();
let pendingFocusId = null; // item to focus after the next render
let pendingHighlightId = null; // doc item to scroll-to/flash after the next render
let pendingMapEditId = null; // map node to open for inline rename after the next render
let suppressPersist = false; // true while loading an existing project (don't re-save/reorder)
let viewMode = "doc";      // "doc" | "map"
let mapInsights = false;   // critical-path / bottleneck highlight toggle (map)
let animatedProjectId = null; // entrance cascade plays once per project, not on every re-render

const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2, 10));

const listFor = (kind) =>
  kind === "task" ? project.tasks :
  kind === "question" ? project.openQuestions :
  kind === "risk" ? project.risks :
  kind === "note" ? (project.notes || (project.notes = [])) : null;

/* ---------- Key management ----------
 * localStorage can throw (file:// origins, sandboxed frames, storage disabled).
 * Always fall back to an in-memory value so the UI never breaks. */
let memoryKey = "";

const getKey = () => {
  try { return localStorage.getItem(KEY_STORE) || memoryKey; }
  catch (_) { return memoryKey; }
};
const setKey = (k) => {
  memoryKey = k;
  try { localStorage.setItem(KEY_STORE, k); } catch (_) { /* memory-only this session */ }
};
const clearKey = () => {
  memoryKey = "";
  try { localStorage.removeItem(KEY_STORE); } catch (_) { /* ignore */ }
};

/* ---------- Rate (for quotes) — global personal setting ---------- */
const RATE_STORE = "spark.rate";
const CUR_STORE = "spark.currency";
let memoryRate = 0, memoryCurrency = "$";

const getRate = () => {
  try { const v = parseFloat(localStorage.getItem(RATE_STORE)); return isNaN(v) ? memoryRate : v; }
  catch (_) { return memoryRate; }
};
const getCurrency = () => {
  try { return localStorage.getItem(CUR_STORE) || memoryCurrency; }
  catch (_) { return memoryCurrency; }
};
const setRate = (n) => {
  memoryRate = n || 0;
  try { if (n) localStorage.setItem(RATE_STORE, String(n)); else localStorage.removeItem(RATE_STORE); } catch (_) {}
};
const setCurrency = (c) => {
  memoryCurrency = c || "$";
  try { localStorage.setItem(CUR_STORE, memoryCurrency); } catch (_) {}
};

/* ---------- Model ---------- */
const MODEL_STORE = "spark.model";
let memoryModel = "";
const getModel = () => {
  try { return localStorage.getItem(MODEL_STORE) || memoryModel || MODEL; }
  catch (_) { return memoryModel || MODEL; }
};
const setModel = (m) => {
  memoryModel = m || "";
  try { if (m && m !== MODEL) localStorage.setItem(MODEL_STORE, m); else localStorage.removeItem(MODEL_STORE); } catch (_) {}
};

function openSettings() {
  apiKeyInput.value = getKey();
  const r = getRate();
  rateInput.value = r ? r : "";
  currencyInput.value = getCurrency();
  modelSelect.value = getModel();
  const brand = getBrand();
  brandNameInput.value = brand.name || "";
  brandEmailInput.value = brand.email || "";
  brandPhoneInput.value = brand.phone || "";
  // migrate a legacy single "contact" line into the website box if the new fields are empty
  brandWebsiteInput.value = brand.website || (!brand.email && !brand.phone ? (brand.contact || "") : "");
  brandAccentInput.value = (brand.accent && /^#[0-9a-f]{6}$/i.test(brand.accent)) ? brand.accent : "#2f945a";
  pendingLogo = brand.logo || null; // edits are staged; committed on Save
  renderLogoPreview();
  renderLearnPanel();
  settingsModal.hidden = false;
  apiKeyInput.focus();
}

/* "What Spark learned" — human-readable view of the calibration profile. */
function renderLearnPanel() {
  const list = el("learnList"), reset = el("learnResetBtn");
  if (!list) return;
  const p = getProfile();
  const rows = [];
  if (p.estSamples >= 3 && Math.abs(p.estCal - 1) >= 0.15) {
    const pct = Math.round(Math.abs(p.estCal - 1) * 100);
    rows.push(`<li><span class="learn-dot est"></span>Your real durations run <strong>~${pct}% ${p.estCal > 1 ? "longer" : "shorter"}</strong> than first drafts <span class="learn-meta">(${p.estSamples} estimate edit${p.estSamples > 1 ? "s" : ""})</span> — new estimates are adjusted.</li>`);
  } else if (p.estSamples > 0) {
    rows.push(`<li><span class="learn-dot est"></span>Watching your estimate edits <span class="learn-meta">(${p.estSamples} of 3 needed)</span> — no clear pattern yet.</li>`);
  }
  if (p.splitBias >= 4) rows.push(`<li><span class="learn-dot split"></span>You prefer <strong>granular plans</strong> — Spark aims for 8–10 smaller tasks.</li>`);
  else if (p.splitBias <= -4) rows.push(`<li><span class="learn-dot split"></span>You prefer <strong>chunkier plans</strong> — Spark aims for 4–6 larger tasks.</li>`);
  const anything = rows.length > 0;
  list.innerHTML = anything ? rows.join("")
    : `<li class="learn-empty">Nothing yet — Spark learns quietly as you re-estimate durations and add or remove tasks.</li>`;
  if (reset) reset.hidden = !anything && !(p.estSamples || p.splitBias);
}

const learnResetBtn = el("learnResetBtn");
if (learnResetBtn) learnResetBtn.addEventListener("click", () => {
  try { localStorage.removeItem(PROFILE_STORE); } catch (_) {}
  renderLearnPanel();
  toast("Spark's calibration was reset.");
});

/* ---------- Branding logo (staged until Save) ---------- */
let pendingLogo = null; // data URL or null
function renderLogoPreview() {
  if (!brandLogoPreview) return;
  if (pendingLogo) {
    brandLogoPreview.innerHTML = `<img src="${pendingLogo}" alt="Logo preview">`;
    brandLogoPreview.dataset.empty = "false";
    if (brandLogoClear) brandLogoClear.hidden = false;
  } else {
    brandLogoPreview.textContent = "Logo";
    brandLogoPreview.dataset.empty = "true";
    if (brandLogoClear) brandLogoClear.hidden = true;
  }
}

// Read a chosen file into a small data URL: SVGs pass through; rasters are
// downscaled to <=320px so localStorage stays lean and the proposal loads fast.
function readLogoFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error("Please choose an image file."));
    if (file.size > 4 * 1024 * 1024) return reject(new Error("That image is over 4 MB — pick a smaller one."));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    if (file.type === "image/svg+xml") { reader.onload = () => resolve(reader.result); reader.readAsDataURL(file); return; }
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 320;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        try { resolve(canvas.toDataURL("image/png")); }
        catch (_) { reject(new Error("Couldn't process that image.")); }
      };
      img.onerror = () => reject(new Error("That image couldn't be loaded."));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

if (brandLogoBtn) brandLogoBtn.addEventListener("click", () => brandLogoInput.click());
if (brandLogoClear) brandLogoClear.addEventListener("click", () => { pendingLogo = null; brandLogoInput.value = ""; renderLogoPreview(); });
if (brandLogoInput) brandLogoInput.addEventListener("change", async () => {
  const file = brandLogoInput.files && brandLogoInput.files[0];
  if (!file) return;
  try { pendingLogo = await readLogoFile(file); renderLogoPreview(); }
  catch (err) { toast(err.message || "Couldn't use that image."); }
  brandLogoInput.value = "";
});
function closeSettings() { settingsModal.hidden = true; }

settingsBtn.addEventListener("click", openSettings);
cancelKeyBtn.addEventListener("click", closeSettings);
saveKeyBtn.addEventListener("click", () => {
  const k = apiKeyInput.value.trim();
  if (k) setKey(k); else clearKey();
  setRate(parseFloat(rateInput.value) || 0);
  setCurrency(currencyInput.value.trim() || "$");
  setModel(modelSelect.value);
  setBrand({
    name: brandNameInput.value.trim(),
    email: brandEmailInput.value.trim(),
    phone: brandPhoneInput.value.trim(),
    website: brandWebsiteInput.value.trim(),
    accent: brandAccentInput.value,
    logo: pendingLogo || undefined,
  });
  closeSettings();
  if (project) renderProject(); // refresh the quote
});
clearKeyBtn.addEventListener("click", () => { clearKey(); apiKeyInput.value = ""; });
[apiKeyInput, rateInput, currencyInput].forEach((inp) =>
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveKeyBtn.click(); }
  }));
settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) closeSettings(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsModal.hidden) closeSettings();
});

/* ---------- Theme ---------- */
const THEME_STORE = "spark.theme";
function applyTheme(t) {
  if (t === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
}
themeBtn.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  applyTheme(next);
  try { localStorage.setItem(THEME_STORE, next); } catch (_) { /* memory-only this session */ }
});

/* ---------- View switching ---------- */
function show(state) {
  emptyState.hidden   = state !== "empty";
  loadingState.hidden = state !== "loading";
  errorState.hidden   = state !== "error";
  result.hidden       = state !== "result";
}
function showError(message) { errorText.textContent = message; show("error"); }

/* ---------- Toast ---------- */
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3400);
}

// A toast with an action button (e.g. Undo) that lingers longer.
function toastAction(msg, label, fn, ms = 6000) {
  const t = document.createElement("div");
  t.className = "toast toast-action";
  const span = document.createElement("span");
  span.textContent = msg;
  const btn = document.createElement("button");
  btn.className = "toast-btn";
  btn.textContent = label;
  t.append(span, btn);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  let closed = false;
  const dismiss = () => { if (closed) return; closed = true; t.classList.remove("show"); setTimeout(() => t.remove(), 300); };
  btn.addEventListener("click", () => { dismiss(); fn(); });
  setTimeout(dismiss, ms);
}

/* ---------- Composer ---------- */
function syncComposerHeight() {
  ideaInput.style.height = "auto";
  ideaInput.style.height = Math.min(ideaInput.scrollHeight, 168) + "px";
}

const TEMPLATE_IDEAS = [
  { chip: "App", ico: `<svg class="chip-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--c-task)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/></svg>`, text: "A mobile/web app that helps [who] to [do what]." },
  { chip: "Campaign", ico: `<svg class="chip-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--c-money)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10v4h3l6 4V6L6 10H3z"/><path d="M17 8a5 5 0 0 1 0 8"/></svg>`, text: "A marketing campaign to [goal] for [brand/audience]." },
  { chip: "Event", ico: `<svg class="chip-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--c-question)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`, text: "A [type] event for [audience] about [theme]." },
  { chip: "Brand", ico: `<svg class="chip-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--c-risk)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/></svg>`, text: "A brand refresh for [business] to feel more [qualities]." },
  { chip: "Launch", ico: `<svg class="chip-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-text)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>`, text: "Launch [product] to [target market] within [timeframe]." },
];
const REFINE_SUGGESTIONS = [
  { chip: "Granular tasks", text: "Make the tasks more granular" },
  { chip: "+ Marketing", text: "Add a marketing workstream" },
  { chip: "Tighten to MVP", text: "Tighten the scope to an MVP" },
  { chip: "More risks", text: "Surface more risks" },
];
function renderSuggestions() {
  if (!suggestionsEl) return;
  if (busy || clarify) { suggestionsEl.innerHTML = ""; return; }   // hide while a turn / clarify is in flight
  if (project) {
    suggestionsEl.innerHTML =
      `<span class="suggestions-label">Quick refine</span>` +
      REFINE_SUGGESTIONS.map((s) => `<button type="button" class="chip" data-sugg="refine" data-text="${esc(s.text)}" title="${esc(s.text)}">${esc(s.chip)}</button>`).join("");
  } else {
    suggestionsEl.innerHTML =
      `<span class="suggestions-label">Templates</span>` +
      TEMPLATE_IDEAS.map((t) => `<button type="button" class="chip" data-sugg="starter" data-text="${esc(t.text)}">${t.ico || ""}${esc(t.chip)}</button>`).join("");
  }
}

function updateComposer() {
  const label = sparkBtn.querySelector(".spark-btn-label");
  if (clarify) {
    if (label) label.textContent = "Build";
    ideaInput.placeholder = "Answer the questions above — or leave blank for sensible defaults…";
  } else if (project) {
    if (label) label.textContent = "Send";
    ideaInput.placeholder = 'Refine it — e.g. "make the tasks more granular" or "add a marketing workstream"…';
  } else {
    if (label) label.textContent = "Spark it";
    ideaInput.placeholder = "Describe your project idea — a rough thought is fine…";
  }
  if (clarifyLabel) clarifyLabel.hidden = !!project || !!clarify; // only for a fresh idea
  composerForm.classList.toggle("fresh", !project && !clarify);   // fresh idea → full-width Spark it
  renderSuggestions();
  syncTone();
  syncStructureBtn();
}

/* ---------- Tone (Creative ↔ Executive) ---------- */
const TONES = [
  { id: "creative",     label: "Creative",     desc: "imaginative, bold, energetic and inspiring language" },
  { id: "friendly",     label: "Friendly",     desc: "warm, casual, approachable and conversational" },
  { id: "balanced",     label: "Balanced",     desc: "clear, professional and neutral" },
  { id: "professional", label: "Professional", desc: "polished, precise and businesslike" },
  { id: "executive",    label: "Executive",    desc: "concise, formal and outcome-focused, board-room style" },
];
let currentTone = (() => { try { return localStorage.getItem("spark.tone") || "balanced"; } catch (_) { return "balanced"; } })();

const toneIndex = (id) => { const i = TONES.findIndex((t) => t.id === id); return i < 0 ? 2 : i; };
const toneById = (id) => TONES[toneIndex(id)];
function getActiveTone() { return (project && project.tone) ? project.tone : currentTone; }
function withTone(sys) {
  const t = toneById(getActiveTone());
  return `${sys}\n\nVoice: write in a ${t.label} tone — ${t.desc}.`;
}
function toneFill() { // filled portion of the slider track (design: accent up to the thumb)
  toneSlider.style.setProperty("--pct", (+toneSlider.value / (TONES.length - 1)) * 100 + "%");
}
function syncTone() {
  const id = getActiveTone();
  toneSlider.value = String(toneIndex(id));
  toneValue.textContent = toneById(id).label;
  applyToneBtn.hidden = !project;
  toneFill();
}

toneSlider.addEventListener("input", () => {
  const t = TONES[+toneSlider.value] || TONES[2];
  currentTone = t.id;
  try { localStorage.setItem("spark.tone", t.id); } catch (_) { /* memory-only */ }
  if (project) { project.tone = t.id; SparkStore.save(project); }
  toneValue.textContent = t.label;
  toneFill();
});
applyToneBtn.addEventListener("click", () => {
  if (!project || busy) return;
  const label = toneById(getActiveTone()).label;
  refine(`Rewrite the whole project in a ${label} tone. Keep the same substance — the tasks, questions and risks — and only change the wording and voice.`);
});

/* ---------- PM learning (Phase 8) ----------
 * Learns from how the user edits plans and feeds it back into generation:
 *  - estimate calibration: user's duration edits vs the AI's original estimate (EMA ratio)
 *  - granularity: whether the user tends to add or delete tasks (split bias)
 * Stored in localStorage under spark.profile; all client-side, no backend. */
const PROFILE_STORE = "spark.profile";
function getProfile() {
  try { return Object.assign({ estCal: 1, estSamples: 0, splitBias: 0 }, JSON.parse(localStorage.getItem(PROFILE_STORE) || "{}")); }
  catch (_) { return { estCal: 1, estSamples: 0, splitBias: 0 }; }
}
function setProfile(p) { try { localStorage.setItem(PROFILE_STORE, JSON.stringify(p)); } catch (_) {} }

/* User re-estimated a task: fold user/AI ratio into a running average. */
function learnEstimate(aiEstimate, userEstimate) {
  const ai = parseEstimateHours(aiEstimate), user = parseEstimateHours(userEstimate);
  if (!(ai > 0) || !(user > 0)) return;
  const ratio = Math.max(0.25, Math.min(4, user / ai)); // clamp outliers
  const p = getProfile();
  p.estCal = p.estSamples ? p.estCal * 0.75 + ratio * 0.25 : ratio; // EMA, recent edits weigh more
  p.estSamples = Math.min(50, p.estSamples + 1);
  setProfile(p);
}

/* User added (+1) or deleted (-1) a task by hand → granularity preference. */
function learnSplit(delta) {
  const p = getProfile();
  p.splitBias = Math.max(-12, Math.min(12, (p.splitBias || 0) + delta));
  setProfile(p);
}

/* Calibration block appended to generation prompts once there's signal. */
function profileContext() {
  const p = getProfile();
  const notes = [];
  if (p.estSamples >= 3 && Math.abs(p.estCal - 1) >= 0.15) {
    const pct = Math.round(Math.abs(p.estCal - 1) * 100);
    notes.push(p.estCal > 1
      ? `This user's real durations run ~${pct}% LONGER than typical estimates — be more generous with every estimate.`
      : `This user works ~${pct}% FASTER than typical estimates — tighten estimates accordingly.`);
  }
  if (p.splitBias >= 4) notes.push("This user prefers granular plans — aim for 8-10 smaller tasks.");
  else if (p.splitBias <= -4) notes.push("This user prefers chunkier plans — aim for 4-6 larger tasks.");
  return notes.length ? `\n\nPersonal calibration (learned from this user's edits):\n- ${notes.join("\n- ")}` : "";
}
const withLearning = (sys) => withTone(sys) + profileContext();

/* A turn: first message sparks (or clarifies); later messages refine. */
function send() {
  if (listening && recog) { try { recog.stop(); } catch (_) {} }
  const text = ideaInput.value.trim();
  if (clarify) { answerClarify(text); return; } // answers may be blank → sensible defaults
  if (!text) { ideaInput.focus(); return; }
  if (project) refine(text); else spark();
}

/* ---------- Voice input (Web Speech API) ---------- */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, listening = false;
(function initVoice() {
  if (!SpeechRec) { if (micBtn) micBtn.hidden = true; return; }
  recog = new SpeechRec();
  recog.lang = navigator.language || "en-US";
  recog.continuous = true;
  recog.interimResults = true;
  let base = "";
  recog.onstart = () => { listening = true; micBtn.classList.add("listening"); base = ideaInput.value ? ideaInput.value.replace(/\s+$/, "") + " " : ""; };
  recog.onend = () => { listening = false; micBtn.classList.remove("listening"); };
  recog.onerror = (e) => {
    listening = false; micBtn.classList.remove("listening");
    if (e.error === "not-allowed" || e.error === "service-not-allowed") toast("Microphone permission denied.");
  };
  recog.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) base += t; else interim += t;
    }
    ideaInput.value = (base + interim).replace(/\s+/g, " ").trimStart();
    syncComposerHeight();
  };
  micBtn.addEventListener("click", () => {
    if (listening) { try { recog.stop(); } catch (_) {} }
    else { try { recog.start(); ideaInput.focus(); } catch (_) {} }
  });
})();

// Pasting a long block of text (a client brief) — nudge the user to spark it.
ideaInput.addEventListener("paste", (e) => {
  const t = ((e.clipboardData || window.clipboardData) && (e.clipboardData || window.clipboardData).getData("text")) || "";
  if (t.length > 220 && !project && !clarify) {
    setTimeout(() => toast("Brief pasted — hit Spark it to turn it into a project."), 60);
  }
});

composerForm.addEventListener("submit", (e) => { e.preventDefault(); send(); });
ideaInput.addEventListener("input", syncComposerHeight);

/* Draft persistence — a fresh idea survives an accidental reload/close. */
const DRAFT_STORE = "spark.draft";
let draftTimer = null;
ideaInput.addEventListener("input", () => {
  if (project || clarify) return; // only fresh-idea drafts; refine text is throwaway
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      const v = ideaInput.value;
      if (v.trim()) localStorage.setItem(DRAFT_STORE, v); else localStorage.removeItem(DRAFT_STORE);
    } catch (_) {}
  }, 300);
});
function clearDraft() { try { localStorage.removeItem(DRAFT_STORE); } catch (_) {} }
function restoreDraft() {
  if (project || clarify || ideaInput.value) return;
  try {
    const d = localStorage.getItem(DRAFT_STORE);
    if (d) { ideaInput.value = d; syncComposerHeight(); }
  } catch (_) {}
}
ideaInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } // Shift+Enter = newline
});
suggestionsEl.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-sugg]");
  if (!chip) return;
  ideaInput.value = chip.dataset.text;
  if (chip.dataset.sugg === "refine") {
    send();                 // one-click refinement
  } else {
    syncComposerHeight();   // starter: fill it in so you can tweak, then ⏎
    ideaInput.focus();
  }
});
retryBtn.addEventListener("click", () => spark());
const errorSettingsBtn = el("errorSettingsBtn");
if (errorSettingsBtn) errorSettingsBtn.addEventListener("click", openSettings);

// Add AI map suggestions into the map/project from the chat tray.
chatThread.addEventListener("click", (e) => {
  const one = e.target.closest("[data-suggest]");
  if (one) return applySuggestionById(one.dataset.suggest);
  const all = e.target.closest("[data-suggest-all]");
  if (all) return applyAllSuggestions(all.dataset.suggestAll);
});

/* Human mode: a blank project — no AI, no key needed; Spark helps later if asked. */
function startBlankProject() {
  project = {
    id: uid(),
    createdAt: Date.now(),
    idea: "",
    projectName: "Untitled project",
    tagline: "",
    brief: "",
    tasks: [],
    openQuestions: [],
    risks: [],
    taskOrder: [],
    collapsed: {},
    tone: currentTone,
    chat: [{ id: uid(), role: "assistant", text: "Blank canvas — name it, then add tasks, questions and risks by hand. I'm here when you want help: ask me to estimate a task, suggest risks you're missing, or propose more tasks." }],
  };
  history = [];
  viewMode = "doc";
  renderProject();
  renderChat();
  updateComposer();
  // straight into naming it
  pendingFocusId = null;
  const name = result.querySelector('.result-name[contenteditable]');
  if (name) placeCursorEnd(name);
}
const scratchBtn = el("scratchBtn");
if (scratchBtn) scratchBtn.addEventListener("click", startBlankProject);

/* "See a live example" — a fully-built demo project, no API key needed, so a first-time
   visitor can experience the whole thing (quote, map, proposal) before signing up for a key. */
function loadExampleProject() {
  if (!getRate()) setRate(75); // so the price quote actually shows the value
  const now = Date.now();
  const t = (title, estimate, extra) => Object.assign({ id: uid(), title, estimate, genEstimate: estimate }, extra || {});
  const discovery = t("Discovery & brand direction", "3 days");
  const interviews = t("Owner + regulars interviews", "1 day", { parentId: discovery.id });
  const moodboard  = t("Moodboard & logo", "2 days", { parentId: discovery.id });
  const design  = t("Design the mobile app", "6 days");
  const build   = t("Build points & rewards engine", "5 days");
  const billing = t("Set up subscriptions & billing", "2 days");
  const launch  = t("Launch & onboarding", "1 day", { done: true });
  const tasks = [discovery, interviews, moodboard, design, build, billing, launch];
  const q = (text) => ({ id: uid(), text });
  project = {
    id: uid(), createdAt: now, updatedAt: now,
    idea: "a loyalty app for indie coffee shops",
    projectName: "Roastery Rewards",
    tagline: "A loyalty app for indie coffee shops",
    brief: "A mobile loyalty program that lets small roasters reward regulars with points, perks, and a subscription tier — designed, built and launched in about eight weeks.",
    tasks,
    openQuestions: [q("Which POS systems must we integrate with first?"), q("Price point for the perks subscription tier?")],
    risks: [q("Low adoption if signup adds friction at the counter"), q("Deposit / payment handling may be tricky with some banks")],
    tools: [
      { id: uid(), name: "Figma", category: "Design", why: "App UI and a clickable prototype for client sign-off" },
      { id: uid(), name: "Supabase", category: "Backend", why: "Auth + points data with minimal setup" },
      { id: uid(), name: "Stripe", category: "Payments", why: "Recurring billing for the perks tier" },
    ],
    notes: [{ id: uid(), text: "Client wants a spring launch — treat as a hard deadline" }],
    links: [
      { id: uid(), from: design.id, to: discovery.id, type: "depends" },
      { id: uid(), from: build.id, to: design.id, type: "depends" },
      { id: uid(), from: billing.id, to: build.id, type: "depends" },
      { id: uid(), from: launch.id, to: billing.id, type: "depends" },
    ],
    tone: currentTone,
    taskOrder: tasks.map((x) => x.id),
    collapsed: {},
    // Pre-baked so the Spark lenses open instantly with no API key (they're normally AI-generated).
    lenses: {
      pitch: "**The hook:** turn every coffee run into a reason to come back.\n\nRoastery Rewards is a lightweight loyalty app built for indie roasters — regulars earn points at the counter, unlock perks, and can subscribe to a monthly tier that keeps them coming through the door.\n\n- **Made for small shops, not chains** — set up in minutes, no enterprise POS required.\n- **Recurring revenue** — the perks subscription turns loyal customers into predictable monthly income.\n- **Launch-ready in ~8 weeks** — designed, built, and in customers' hands before spring.\n\nLet's get your regulars on a first-name basis with your app.",
      budget: "**Phase 1 — Discovery & brand (3 days)** — owner + regulars interviews, moodboard, logo.\n**Phase 2 — Design (6 days)** — full app UI plus a clickable prototype for sign-off.\n**Phase 3 — Build (5 days)** — points & rewards engine.\n**Phase 4 — Billing & launch (3 days)** — subscriptions, onboarding.\n\n**Assumptions:** timely feedback, one POS integration to start, two revision rounds included.\n\n**Total:** ~17 working days — the price quote up top turns that into a live cost at your rate.",
      lean: "**Ship this first:** points at the counter. A regular gives their number, earns a point, and sees their balance. Nothing else.\n\n**Cut for now:** the subscription tier, multi-shop support, and deep POS integration — add them once regulars are actually using it.\n\n**Fastest path:** a single-shop web app (no app-store review), points added manually to start, one screen. Live in about two weeks, then iterate on what regulars ask for.",
      premortem: "It's three months later and adoption stalled. The most likely reasons:\n\n- **Signup friction at the counter** — *early sign:* staff skip offering it during a rush. *Fix:* one-tap phone-number signup, no app download.\n- **POS integration dragged** — *early sign:* the first integration slips past week 3. *Fix:* start with manual points, integrate after launch.\n- **Perks weren't compelling** — *early sign:* few regulars upgrade to the paid tier. *Fix:* test the price point and perk with 5 regulars before building billing.",
    },
    chat: [
      { id: uid(), role: "user", text: "a loyalty app for indie coffee shops" },
      { id: uid(), role: "assistant", text: "Sparked it — here's a full example to explore. Try a Spark lens (Pitch, Budget…), check the price quote up top, switch to Map to see how the work connects, or Export a client proposal. When you're ready, hit ＋ New and describe your own idea." },
    ],
  };
  history = [];
  viewMode = "doc";
  clarify = null;
  SparkStore.save(project);
  renderProject();
  renderChat();
  updateComposer();
  toast("Loaded an example — explore freely, then hit ＋ New for your own.");
}
const exampleBtn = el("exampleBtn");
if (exampleBtn) exampleBtn.addEventListener("click", loadExampleProject);

/* ---------- Feedback form ---------- */
const FEEDBACK_EMAIL = "patrikv112@gmail.com"; // ← change this to route feedback elsewhere
const feedbackModal = el("feedbackModal");
let fbSentiment = "";
function openFeedback() {
  if (!feedbackModal) return;
  fbSentiment = "";
  el("fbSentiments").querySelectorAll(".fb-sentiment").forEach((b) => b.classList.remove("active"));
  el("fbText").value = "";
  el("fbFallback").hidden = true;
  feedbackModal.hidden = false;
  setTimeout(() => el("fbText").focus(), 40);
}
function closeFeedback() { if (feedbackModal) feedbackModal.hidden = true; }
function sendFeedback() {
  const text = el("fbText").value.trim();
  if (!fbSentiment && !text) { el("fbText").focus(); return; }
  const subject = `Spark feedback${fbSentiment ? " — " + fbSentiment : ""}`;
  const body = `${fbSentiment ? "Overall: " + fbSentiment + "\n\n" : ""}${text}`;
  const mailto = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  try { window.location.href = mailto; } catch (_) { /* ignore */ }
  // Fallback: if no mail client picks it up, show the address so they can still reach out.
  const fb = el("fbFallback");
  fb.innerHTML = `Didn't open your email app? Send it to <a href="mailto:${FEEDBACK_EMAIL}">${FEEDBACK_EMAIL}</a>.`;
  fb.hidden = false;
  toast("Thanks — opening your email to send it.");
  setTimeout(closeFeedback, 2500);
}
if (el("feedbackLink")) el("feedbackLink").addEventListener("click", openFeedback);
if (el("fbCancel")) el("fbCancel").addEventListener("click", closeFeedback);
if (el("fbSend")) el("fbSend").addEventListener("click", sendFeedback);
if (el("fbSentiments")) el("fbSentiments").addEventListener("click", (e) => {
  const b = e.target.closest(".fb-sentiment"); if (!b) return;
  fbSentiment = b.dataset.sentiment;
  el("fbSentiments").querySelectorAll(".fb-sentiment").forEach((x) => x.classList.toggle("active", x === b));
});
if (feedbackModal) feedbackModal.addEventListener("click", (e) => { if (e.target === feedbackModal) closeFeedback(); });

/* ---------- About Spark ---------- */
const aboutModal = el("aboutModal");
function openAbout() { if (aboutModal) aboutModal.hidden = false; }
function closeAbout() { if (aboutModal) aboutModal.hidden = true; }
if (el("aboutBtn")) el("aboutBtn").addEventListener("click", openAbout);
if (el("aboutClose")) el("aboutClose").addEventListener("click", closeAbout);
if (el("aboutFeedbackBtn")) el("aboutFeedbackBtn").addEventListener("click", () => { closeAbout(); openFeedback(); });
if (aboutModal) aboutModal.addEventListener("click", (e) => { if (e.target === aboutModal) closeAbout(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (aboutModal && !aboutModal.hidden) closeAbout();
  if (feedbackModal && !feedbackModal.hidden) closeFeedback();
});

/* Human mode: structure the user's own braindump — organize only, invent nothing. */
const structureBtn = el("structureBtn");
function syncStructureBtn() {
  if (!structureBtn) return;
  const fresh = !project && !clarify;
  structureBtn.hidden = !(fresh && ideaInput.value.trim().length >= 120 && !busy);
}
async function structureDraft() {
  if (busy) return;
  const draft = ideaInput.value.trim();
  if (!draft) { ideaInput.focus(); return; }
  const apiKey = getKey();
  if (!apiKey) { openSettings(); return; }

  busy = true; sparkBtn.disabled = true; structureBtn.disabled = true; show("loading");
  let failure = null;
  try {
    const text = await callClaude({ system: STRUCTURE_SYSTEM, user: draft, apiKey, maxTokens: MAX_TOKENS });
    let parsed;
    try { parsed = extractJson(text); }
    catch (_) { throw new Error("The AI's response wasn't valid JSON. Try again."); }
    project = buildProject(draft, parsed);
    project.tone = currentTone;
    project.taskOrder = project.tasks.map((t) => t.id);
    project.chat = [
      { id: uid(), role: "user", text: draft },
      { id: uid(), role: "assistant", text: "Structured your draft — I only organized what you wrote, nothing invented. Gaps I spotted are in Open questions. Ask me to fill anything in when you're ready." },
    ];
    history = [];
    ideaInput.value = ""; syncComposerHeight(); clearDraft();
  } catch (err) { failure = err; }
  busy = false; sparkBtn.disabled = false; structureBtn.disabled = false;
  updateComposer();
  if (failure) showError(failure.message || "Unexpected error. Please try again.");
  else { renderProject(); renderChat(); }
}
if (structureBtn) structureBtn.addEventListener("click", structureDraft);
ideaInput.addEventListener("input", syncStructureBtn);
newComposerBtn.addEventListener("click", () => newProject());

// Keyboard shortcut: ⌘/Ctrl-K toggles the projects menu. (⌘N is reserved by the
// browser, so "New" is the visible button instead.)
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); toggleProjectMenu(); }
});

/* ---------- JSON extraction ----------
 * Models occasionally wrap JSON in prose or ```fences```. Be forgiving. */
function extractJson(text) {
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON object found in the response.");
  }
  return JSON.parse(t.slice(start, end + 1));
}

/* ---------- Helpers ---------- */
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function asArray(v) { return Array.isArray(v) ? v : v == null ? [] : [v]; }

function pushHistory() {
  history.push(JSON.parse(JSON.stringify(project)));
  if (history.length > 50) history.shift();
}
function undo() {
  if (!history.length) return;
  project = history.pop();
  renderProject();
  renderChat();
}

/* Build a normalized project (every item gets a stable id) from raw AI JSON.
 * Does not set chat/id ownership — callers decide that. */
function buildProject(idea, data) {
  return {
    id: uid(),
    createdAt: Date.now(),
    idea,
    chat: [],
    projectName: data.projectName || "Untitled project",
    tagline: data.tagline || "",
    brief: data.brief || "",
    tasks: asArray(data.tasks).map((t) => ({
      id: uid(),
      title: typeof t === "string" ? t : (t.title || ""),
      estimate: typeof t === "string" ? "" : (t.estimate || ""),
      genEstimate: typeof t === "string" ? "" : (t.estimate || ""), // AI baseline for calibration learning
      done: typeof t === "string" ? false : !!t.done,
      parentId: typeof t === "string" ? null : (t.parentId || null),
    })),
    openQuestions: asArray(data.openQuestions).map((q) => ({
      id: uid(), text: typeof q === "string" ? q : (q.text || q.value || ""),
    })),
    risks: asArray(data.risks).map((r) => ({
      id: uid(), text: typeof r === "string" ? r : (r.text || r.value || ""),
    })),
  };
}

/* ---------- Chat rendering (left pane) ---------- */
function suggestionLabel(s) {
  if (s.kind === "task") return `Task: ${s.title}`;
  if (s.kind === "note") return `Note: ${s.text.length > 34 ? s.text.slice(0, 34) + "…" : s.text}`;
  const v = s.type === "depends" ? "depends on" : s.type === "blocks" ? "blocks" : "relates to";
  return `${s.from} ${v} ${s.to}`;
}
const PLUS_ICO = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`;
const CHECK_ICO = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4 10-11"/></svg>`;
function suggestTrayHtml(m) {
  if (!m.suggestions || !m.suggestions.length) return "";
  const chips = m.suggestions.map((s) =>
    `<button class="sugg-chip sugg-${s.kind}${s.applied ? " applied" : ""}" data-suggest="${s.id}"${s.applied ? " disabled" : ""}>${s.applied ? CHECK_ICO : PLUS_ICO}${esc(suggestionLabel(s))}</button>`).join("");
  const all = m.suggestions.some((s) => !s.applied)
    ? `<button class="sugg-chip sugg-all" data-suggest-all="${m.id}">Add all</button>` : "";
  return `<div class="chat-suggest"><span class="chat-suggest-label">Add to map</span>${chips}${all}</div>`;
}

function renderChat() {
  const msgs = (project && Array.isArray(project.chat)) ? project.chat : (clarify ? clarify.chat : null);
  let html;
  if (!msgs) {
    html = `<div class="chat-msg assistant">
      <div class="bubble intro">Hi — describe a project idea below and I'll spark it into a structured plan. Once it's there, just tell me what to refine and I'll update it live.</div>
    </div>`;
  } else {
    html = msgs.map((m) =>
      `<div class="chat-msg ${m.role === "user" ? "user" : "assistant"}${m.kind === "error" ? " error" : ""}">
        <div class="bubble">${esc(m.text)}</div>
        ${suggestTrayHtml(m)}
      </div>`).join("");
  }
  if (busy && (project || clarify) && !streaming) {
    html += `<div class="chat-msg assistant"><div class="bubble thinking-bubble"><span></span><span></span><span></span></div></div>`;
  }
  chatThread.innerHTML = html;
  chatThread.scrollTop = chatThread.scrollHeight;
  renderSuggestions(); // keep chips in sync with project/busy state
}

/* ---------- Project rendering (right pane, from state) ---------- */
/* ---------- Effort & quote ---------- */
// Parse a free-form estimate ("2h", "1 day", "3 days", "2-3 days", "1 week", "30m") into hours.
// Working day = 8h, week = 40h, month = 160h.
function parseEstimateHours(str) {
  if (!str) return 0;
  const s = String(str).toLowerCase();
  if (/half/.test(s) && /week/.test(s)) return 20;
  if (/half/.test(s) && /day/.test(s)) return 4;
  const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  const qty = nums.length >= 2 ? (nums[0] + nums[1]) / 2 : (nums.length ? nums[0] : 1);
  let unit;
  if (/month|\bmo\b/.test(s)) unit = 160;
  else if (/week|wk|\d\s*w\b|\bw\b/.test(s)) unit = 40;
  else if (/day|\d\s*d\b|\bd\b/.test(s)) unit = 8;
  else if (/min|\d\s*m\b/.test(s)) unit = 1 / 60;
  else unit = 1; // hours, incl. "2h" and bare numbers
  return qty * unit;
}

function totalHours() {
  return project.tasks.reduce((a, t) => a + parseEstimateHours(t.estimate), 0);
}

function formatDuration(h) {
  if (!h) return "—";
  if (h < 8) return `${+h.toFixed(h < 1 ? 2 : 1)}h`;
  const d = h / 8;
  if (d < 10) return `≈ ${+d.toFixed(1)}d`;
  return `≈ ${+(d / 5).toFixed(1)}w`;
}

function formatMoney(n, cur) {
  const v = Math.round(n).toLocaleString();
  cur = cur || "$";
  return /^[A-Za-z]{2,}$/.test(cur) ? `${v} ${cur}` : `${cur}${v}`;
}

// A realistic quote range around the point estimate (−10% best case, +40% contingency).
function quoteRange(hrs, rate) {
  const r10 = (n) => Math.round(n / 10) * 10;
  const likely = hrs * rate;
  return { likely: r10(likely), low: r10(likely * 0.9), high: r10(likely * 1.4) };
}

function summaryBarHtml() {
  const tasks = project.tasks;
  const hrs = totalHours();
  const unest = tasks.filter((t) => parseEstimateHours(t.estimate) === 0).length;
  const done = tasks.filter((t) => t.done).length;
  const total = tasks.length;
  const rate = getRate();
  const cur = getCurrency();
  const hoursLabel = hrs ? `${+hrs.toFixed(hrs < 10 ? 1 : 0)}h total effort` : "no estimates yet";

  let costChip;
  if (rate > 0 && hrs > 0) {
    const q = quoteRange(hrs, rate);
    costChip = `<button class="stat cost" data-action="rate" title="@ ${formatMoney(rate, cur)}/h — edit rate">
      <span class="stat-val">${formatMoney(q.likely, cur)}</span>
      <span class="stat-label">range ${formatMoney(q.low, cur)}–${formatMoney(q.high, cur)}</span></button>`;
  } else {
    costChip = `<button class="stat cost set" data-action="rate" title="Set your hourly rate">
      <span class="stat-val">Set rate →</span>
      <span class="stat-label">instant quote</span></button>`;
  }

  const progressChip = total
    ? `<span class="stat"><span class="stat-val">${done}/${total}</span><span class="stat-label">tasks done</span></span>` : "";
  const pct = total ? Math.round((done / total) * 100) : 0;
  const bar = total
    ? `<div class="progress" title="${done} of ${total} tasks done"><div class="progress-fill" style="width:${pct}%"></div></div>` : "";

  return `<div class="summary-bar">
    <span class="stat"><span class="stat-val">${formatDuration(hrs)}</span><span class="stat-label">${hoursLabel}</span></span>
    ${costChip}
    ${progressChip}
    ${unest ? `<span class="stat-note">${unest} task${unest > 1 ? "s" : ""} unestimated</span>` : ""}
  </div>${bar}`;
}

/* ---------- Export ---------- */
function buildMarkdown(p) {
  const hrs = totalHours();
  const rate = getRate(), cur = getCurrency();
  const L = [];
  L.push(`# ${p.projectName}`);
  if (p.tagline) L.push(`*${p.tagline}*`);
  L.push("");
  if (p.brief) { L.push(p.brief); L.push(""); }
  if (p.tasks.length) {
    L.push("## Tasks");
    p.tasks.forEach((t) => L.push(`- [${t.done ? "x" : " "}] ${t.title}${t.estimate ? ` — ${t.estimate}` : ""}`));
    L.push("");
  }
  if (p.openQuestions.length) { L.push("## Open questions"); p.openQuestions.forEach((q) => L.push(`- ${q.text}`)); L.push(""); }
  if (p.risks.length) { L.push("## Key risks"); p.risks.forEach((r) => L.push(`- ${r.text}`)); L.push(""); }
  if (Array.isArray(p.tools) && p.tools.length) {
    L.push("## Recommended tools");
    p.tools.forEach((t) => L.push(`- **${t.name}**${t.category ? ` (${t.category})` : ""}${t.why ? ` — ${t.why}` : ""}`));
    L.push("");
  }
  const effort = hrs ? `~${(hrs / 8).toFixed(1)}d (${Math.round(hrs)}h)` : "—";
  let quote = "";
  if (rate > 0 && hrs > 0) {
    const q = quoteRange(hrs, rate);
    quote = ` · Estimate: ${formatMoney(q.likely, cur)} (${formatMoney(q.low, cur)}–${formatMoney(q.high, cur)})`;
  }
  L.push(`**Effort:** ${effort}${quote}`);
  return L.join("\n");
}

async function copyMarkdown() {
  if (!project) return;
  try {
    await navigator.clipboard.writeText(buildMarkdown(project));
    toast("Copied as Markdown");
  } catch (_) {
    toast("Couldn't access the clipboard here.");
  }
}

/* UTF-8-safe, URL-safe base64 */
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64decode(b64) {
  b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function buildShareLink(p) {
  // Node refs are encoded as "kind:index" so links/subtasks survive the id regen on import.
  const ref = { root: "root" };
  p.tasks.forEach((t, i) => (ref[t.id] = "t:" + i));
  p.openQuestions.forEach((q, i) => (ref[q.id] = "q:" + i));
  p.risks.forEach((r, i) => (ref[r.id] = "r:" + i));
  (p.notes || []).forEach((n, i) => (ref[n.id] = "n:" + i));
  const slim = {
    v: 2, idea: p.idea, projectName: p.projectName, tagline: p.tagline, brief: p.brief, tone: p.tone,
    tasks: p.tasks.map((t) => ({ title: t.title, estimate: t.estimate, done: !!t.done, parent: t.parentId ? (ref[t.parentId] || null) : null })),
    openQuestions: p.openQuestions.map((q) => q.text),
    risks: p.risks.map((r) => r.text),
    notes: (p.notes || []).map((n) => n.text),
    tools: (p.tools || []).map((t) => ({ name: t.name, category: t.category, why: t.why })),
    links: (p.links || []).filter((l) => ref[l.from] && ref[l.to]).map((l) => ({ f: ref[l.from], t: ref[l.to], k: l.type })),
  };
  return location.origin + location.pathname + "#p=" + b64encode(JSON.stringify(slim));
}

async function copyShareLink() {
  if (!project) return;
  try {
    await navigator.clipboard.writeText(buildShareLink(project));
    toast("Share link copied");
  } catch (_) {
    toast("Couldn't copy the link here.");
  }
}

function importFromHash() {
  const m = location.hash.match(/^#p=(.+)$/);
  if (!m) return null;
  try {
    const data = JSON.parse(b64decode(m[1]));
    const p = buildProject(data.idea || "", {
      projectName: data.projectName, tagline: data.tagline, brief: data.brief,
      tasks: data.tasks, openQuestions: data.openQuestions, risks: data.risks,
    });
    p.tone = data.tone || "balanced";
    if (Array.isArray(data.tools)) p.tools = data.tools;
    if (Array.isArray(data.tasks)) p.tasks.forEach((t, i) => { t.done = !!(data.tasks[i] && data.tasks[i].done); });

    // Resolve "kind:index" refs to the freshly-minted ids.
    const byRef = { root: "root" };
    p.tasks.forEach((t, i) => (byRef["t:" + i] = t.id));
    p.openQuestions.forEach((q, i) => (byRef["q:" + i] = q.id));
    p.risks.forEach((r, i) => (byRef["r:" + i] = r.id));
    if (Array.isArray(data.notes)) {
      p.notes = data.notes.map((text) => ({ id: uid(), text: String(text || "") }));
      p.notes.forEach((n, i) => (byRef["n:" + i] = n.id));
    }
    if (Array.isArray(data.tasks)) data.tasks.forEach((st, i) => { // restore subtask parent links
      if (st && st.parent && byRef[st.parent] && p.tasks[i]) p.tasks[i].parentId = byRef[st.parent];
    });
    if (Array.isArray(data.links)) {
      p.links = data.links
        .map((l) => ({ id: uid(), from: byRef[l.f], to: byRef[l.t], type: l.k }))
        .filter((l) => l.from && l.to && ["depends", "blocks", "relates"].includes(l.type));
    }
    p.taskOrder = p.tasks.map((t) => t.id);
    return p;
  } catch (_) { return null; }
}

/* Client-ready proposal → opens a self-contained, printable document */
/* Branding + proposal options (persisted) */
const BRAND_STORE = "spark.brand";
const POPTS_STORE = "spark.proposalOpts";
function getBrand() { try { return JSON.parse(localStorage.getItem(BRAND_STORE)) || {}; } catch (_) { return {}; } }
function setBrand(b) { try { localStorage.setItem(BRAND_STORE, JSON.stringify(b || {})); } catch (_) {} }
function getProposalOpts() {
  const def = { variant: "standard", theme: "minimal", pricing: true, notes: true, tools: true, signature: true };
  try { return Object.assign(def, JSON.parse(localStorage.getItem(POPTS_STORE) || "{}")); } catch (_) { return def; }
}
function setProposalOpts(o) { try { localStorage.setItem(POPTS_STORE, JSON.stringify(o)); } catch (_) {} }

function proposalStyle(theme, acc) {
  const editorial = theme === "editorial", bold = theme === "bold";
  const ink = "#20261f";
  const bodyFont = editorial ? "'Source Serif 4', Georgia, 'Times New Roman', serif" : "'Instrument Sans', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
  return `
  @import url('https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&display=swap');
  * { box-sizing:border-box; }
  html { -webkit-print-color-adjust:exact; print-color-adjust:exact; background:#fff; }
  /* Force a white sheet so the on-screen preview stays light even in a dark-mode browser. */
  body { font-family:${bodyFont}; color:${ink}; background:#fff; max-width:780px; margin:48px auto; padding:0 40px; line-height:1.65; font-size:15px; }
  header { margin-bottom:34px; }
  .prop-logo { max-height:48px; max-width:220px; margin:0 0 18px; display:block; }
  .eyebrow { font-size:11px; letter-spacing:.2em; text-transform:uppercase; color:${editorial ? ink : acc}; font-weight:700; margin:0 0 12px; }
  h1 { font-family:${bodyFont}; font-size:44px; line-height:1.08; margin:0 0 8px; letter-spacing:-.02em; font-weight:700; }
  .tag { font-size:16px; color:rgba(32,38,31,.62); margin:0; ${editorial ? "font-style:italic;" : ""} }
  .brandline { font-size:12.5px; color:rgba(32,38,31,.55); margin:14px 0 0; }
  .date { font-size:12.5px; color:rgba(32,38,31,.42); margin:6px 0 0; }
  .rule { height:3px; width:56px; background:${acc}; border-radius:2px; margin:20px 0 0; }
  h2 { font-family:${bodyFont}; font-size:${editorial ? "19px" : "11.5px"}; ${editorial ? "" : "text-transform:uppercase; letter-spacing:.2em;"} color:${editorial ? ink : acc}; margin:32px 0 12px; font-weight:700; ${editorial ? `border-bottom:1px solid rgba(32,38,31,.14); padding-bottom:7px;` : ""} }
  section { margin-bottom:8px; break-inside:avoid; }
  p { margin:0 0 8px; }
  ul { margin:0; padding:0; list-style:none; }
  li { padding:9px 2px; border-bottom:1px solid rgba(32,38,31,.1); display:flex; justify-content:space-between; gap:18px; align-items:baseline; }
  li:last-child { border-bottom:none; }
  li em { font-style:normal; color:rgba(32,38,31,.5); font-size:12.5px; white-space:nowrap; font-variant-numeric:tabular-nums; }
  li > span::before { content:"— "; color:${acc}; }
  .tools li > span::before, .terms li::before { content:none; }
  .tools li { display:block; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th { text-align:left; font-size:10.5px; text-transform:uppercase; letter-spacing:.14em; color:rgba(32,38,31,.5); font-weight:700; padding:0 0 9px; border-bottom:2px solid ${editorial ? ink : acc}; }
  th.num, td.num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  td { padding:10px 0; border-bottom:1px solid rgba(32,38,31,.1); }
  tr.total td { border-top:2px solid ${ink}; border-bottom:none; font-weight:700; padding-top:13px; }
  .invest-box { background:${acc}12; border:1px solid ${acc}50; border-radius:14px; padding:18px 22px; }
  .invest { font-size:27px; font-weight:700; }
  .muted { color:rgba(32,38,31,.45); font-weight:400; font-size:15px; }
  .sign { display:flex; gap:44px; margin-top:10px; }
  .sign > div { flex:1; }
  .sign .line { border-bottom:1.5px solid ${ink}; height:38px; }
  .sign label { font-size:10.5px; text-transform:uppercase; letter-spacing:.14em; color:rgba(32,38,31,.5); font-weight:600; }
  footer { margin-top:46px; padding-top:16px; border-top:1px solid rgba(32,38,31,.12); font-size:11.5px; color:rgba(32,38,31,.4); }
  .phase { margin:0 0 4px; break-inside:avoid; }
  .phase-h { font-size:14px; font-weight:700; margin:18px 0 6px; display:flex; justify-content:space-between; gap:14px; align-items:baseline; }
  .phase-cost { color:${acc}; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .grand-total { display:flex; justify-content:space-between; gap:18px; border-top:2px solid ${ink}; margin-top:12px; padding-top:12px; font-weight:700; }
  .terms li { display:list-item; list-style:disc; margin-left:18px; padding:5px 0; border-bottom:none; }
  body.onepager { margin:30px auto; font-size:13px; line-height:1.5; }
  body.onepager h1 { font-size:27px; }
  body.onepager .prop-logo { max-height:38px; margin-bottom:12px; }
  body.onepager h2 { margin:16px 0 7px; }
  body.onepager header { margin-bottom:20px; }
  body.onepager section { margin-bottom:2px; }
  body.onepager .invest-box { padding:12px 16px; }
  body.onepager .invest { font-size:22px; }
  @page { margin:18mm; }
  @media print { body { margin:0; max-width:none; padding:0; } body.onepager { margin:0; } }
  ${bold ? `
    .banner { background:${acc}; color:#fff; margin:-48px -40px 34px; padding:46px 40px 36px; }
    .banner .eyebrow { color:rgba(255,255,255,.85); }
    .banner .brandline, .banner .date { color:rgba(255,255,255,.75); }
    .banner h1, .banner .tag { color:#fff; }
    .banner .tag { opacity:.92; }
    .rule { display:none; }
  ` : ""}`;
}

function buildProposalHtml(p, opts) {
  opts = opts || getProposalOpts();
  // Defensive: a project missing any of these arrays would otherwise throw mid-build
  // (and produce a silent "nothing happens" when generating).
  if (!Array.isArray(p.tasks)) p.tasks = [];
  if (!Array.isArray(p.openQuestions)) p.openQuestions = [];
  if (!Array.isArray(p.risks)) p.risks = [];
  if (!Array.isArray(p.tools)) p.tools = [];
  const brand = getBrand();
  const acc = (brand.accent && /^#[0-9a-f]{6}$/i.test(brand.accent)) ? brand.accent : "#2f945a";
  // contact line: email · phone · website (falls back to a legacy single "contact" field)
  const contactLine = [brand.email, brand.phone, brand.website].map((s) => (s || "").trim()).filter(Boolean).join(" · ") || (brand.contact || "");
  const theme = opts.theme || "minimal";
  const bold = theme === "bold", editorial = theme === "editorial";
  const variant = opts.variant || "standard";
  const onepager = variant === "onepager", sow = variant === "sow";
  // Per-variant section visibility: one-pager strips extras to fit a page; SOW forces the full set.
  const showPricing = onepager ? false : !!opts.pricing;
  const showNotes = onepager ? false : (sow ? true : !!opts.notes);
  const showTools = onepager ? false : (sow ? true : !!opts.tools);
  const showSig = onepager ? false : (sow ? true : !!opts.signature);

  const hrs = totalHours(), rate = getRate(), cur = getCurrency();
  const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const money = (n) => formatMoney(n, cur);
  const dur = hrs ? `${(hrs / 8).toFixed(1)} working days <span class="muted">(~${Math.round(hrs)} hours)</span>` : "";
  let invest = "";
  if (rate > 0 && hrs > 0) { const q = quoteRange(hrs, rate); invest = `${money(q.likely)} <span class="muted">(range ${money(q.low)}–${money(q.high)})</span>`; }
  const section = (title, inner) => inner ? `<section><h2>${title}</h2>${inner}</section>` : "";

  // Phases = top-level tasks; their subtasks are the deliverables under each.
  const byId = new Map(p.tasks.map((t) => [t.id, t]));
  const hasParent = (t) => t.parentId && byId.has(t.parentId);
  const phases = p.tasks.filter((t) => !hasParent(t)).map((top) => ({ task: top, children: p.tasks.filter((c) => c.parentId === top.id) }));
  const hasSubtasks = p.tasks.some(hasParent);
  const phaseHours = (ph) => [ph.task, ...ph.children].reduce((s, t) => s + Math.max(0, parseEstimateHours(t.estimate)), 0);

  let scope;
  if (sow && hasSubtasks) {
    // Grouped statement of work: a heading per phase, deliverables listed beneath.
    scope = phases.map((ph, i) => {
      const ph_hrs = phaseHours(ph);
      const cost = (showPricing && rate > 0 && ph_hrs > 0) ? `<span class="phase-cost">${money(ph_hrs * rate)}</span>` : "";
      const dels = (ph.children.length ? ph.children : [ph.task])
        .map((c) => `<li><span>${esc(c.title)}</span>${c.estimate ? `<em>${esc(c.estimate)}</em>` : ""}</li>`).join("");
      return `<div class="phase"><h3 class="phase-h"><span>Phase ${i + 1} — ${esc(ph.task.title)}</span>${cost}</h3><ul>${dels}</ul></div>`;
    }).join("");
    if (showPricing && rate > 0 && hrs > 0) scope += `<p class="grand-total"><span>Total</span><span>${money(quoteRange(hrs, rate).likely)} · ${(hrs / 8).toFixed(1)} days</span></p>`;
  } else if (showPricing && rate > 0) {
    const rows = p.tasks.map((t) => {
      const th = parseEstimateHours(t.estimate);
      return `<tr><td>${esc(t.title)}</td><td class="num">${esc(t.estimate || "—")}</td><td class="num">${th > 0 ? money(th * rate) : "—"}</td></tr>`;
    }).join("");
    const total = `<tr class="total"><td>Total</td><td class="num">${hrs ? (hrs / 8).toFixed(1) + "d" : "—"}</td><td class="num">${hrs ? money(quoteRange(hrs, rate).likely) : "—"}</td></tr>`;
    scope = `<table><thead><tr><th>Deliverable</th><th class="num">Effort</th><th class="num">Cost</th></tr></thead><tbody>${rows}${total}</tbody></table>`;
  } else {
    scope = `<ul>${p.tasks.map((t) => `<li><span>${esc(t.title)}</span>${t.estimate ? `<em>${esc(t.estimate)}</em>` : ""}</li>`).join("")}</ul>`;
  }

  // SOW-only generic terms (a starting template the freelancer can adapt).
  const terms = sow ? `<ul class="terms">
    <li>Estimates assume timely feedback and access to the required assets, accounts, and stakeholders.</li>
    <li>Up to two rounds of revisions are included per deliverable; further changes are quoted separately.</li>
    <li>Work beyond the scope above is agreed and quoted before it begins.</li>
    <li>Invoicing: 50% to commence, 50% on completion; payment due within 14 days unless otherwise agreed.</li>
  </ul>` : "";

  const qs = p.openQuestions.map((q) => `<li><span>${esc(q.text)}</span></li>`).join("");
  const risks = p.risks.map((r) => `<li><span>${esc(r.text)}</span></li>`).join("");
  const tools = (p.tools || []).map((t) => `<li><strong>${esc(t.name)}</strong>${t.category ? ` — ${esc(t.category)}` : ""}${t.why ? `<br><span class="muted">${esc(t.why)}</span>` : ""}</li>`).join("");

  const eyebrow = sow ? "Statement of work" : onepager ? "Proposal — one-pager" : "Project proposal";
  const header = `<header class="${bold ? "banner" : ""}">
    ${brand.logo ? `<img class="prop-logo" src="${brand.logo}" alt="${esc(brand.name || "Logo")}">` : ""}
    <p class="eyebrow">${eyebrow}</p>
    <h1>${esc(p.projectName || "Project")}</h1>
    ${p.tagline ? `<p class="tag">${esc(p.tagline)}</p>` : ""}
    ${(!bold && !editorial) ? '<div class="rule"></div>' : ""}
    ${brand.name ? `<p class="brandline">Prepared by ${esc(brand.name)}${contactLine ? ` · ${esc(contactLine)}` : ""}</p>` : ""}
    <p class="date">${date}</p>
  </header>`;

  const sig = showSig ? section("Acceptance",
    `<div class="sign"><div><div class="line"></div><label>Client signature</label></div><div><div class="line"></div><label>Date</label></div></div>`) : "";

  const docTitle = sow ? "Statement of Work" : "Proposal";
  const bodyClass = onepager ? "onepager" : sow ? "sow" : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(p.projectName)} — ${docTitle}</title>
<style>${proposalStyle(theme, acc)}</style></head>
<body class="${bodyClass}">
  ${header}
  ${section("Overview", p.brief ? `<p>${esc(p.brief)}</p>` : "")}
  ${section(sow ? "Scope &amp; deliverables" : "Scope of work", scope)}
  ${section("Timeline", dur ? `<p>${dur}</p>` : "")}
  ${section("Investment", invest ? `<div class="invest-box"><span class="invest">${invest}</span></div>` : "")}
  ${showNotes ? section("Open questions", qs ? `<ul>${qs}</ul>` : "") : ""}
  ${showNotes ? section("Key risks", risks ? `<ul>${risks}</ul>` : "") : ""}
  ${showTools && tools ? `<section><h2>Recommended tools</h2><ul class="tools">${tools}</ul></section>` : ""}
  ${sow ? section("Terms &amp; assumptions", terms) : ""}
  ${sig}
  <footer>${brand.name ? esc(brand.name) + " · " : ""}Prepared with Spark · ${date}</footer>
</body></html>`;
}

// Inject a toolbar (Back / Save as PDF) + auto-print into the proposal document.
// The ← Back button reloads Spark (the proposal replaced the page); state is saved.
function decorateProposal(html) {
  const css = `
    .spark-print-bar{position:fixed;top:0;left:0;right:0;z-index:99999;display:flex;gap:14px;align-items:center;justify-content:center;
      background:#12160f;color:#edefe4;padding:10px 16px;font-family:'Instrument Sans',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;box-shadow:0 2px 10px rgba(0,0,0,.25)}
    .spark-print-bar button{background:#4fb87a;color:#0c1a11;border:0;border-radius:999px;padding:9px 18px;font-weight:600;font-size:13px;cursor:pointer}
    .spark-print-bar button.ghost{background:transparent;border:1px solid rgba(255,255,255,.3);color:#fff}
    .spark-print-bar span{opacity:.85;flex:1;text-align:center}
    @media screen{body{margin-top:74px !important}}
    @media print{.spark-print-bar{display:none !important} body{margin-top:0 !important}}`;
  const bar = `<div class="spark-print-bar">
    <button class="ghost" onclick="location.href='./'">← Back to Spark</button>
    <span>Choose “Save as PDF” as the destination.</span>
    <button onclick="window.print()">⤓ Save as PDF</button>
  </div>`;
  const script = `<script>window.addEventListener('load',function(){setTimeout(function(){try{window.focus();window.print();}catch(e){}},500);});<\/script>`;
  return html
    .replace(/<\/head>/i, `<style>${css}</style></head>`)
    .replace(/(<body[^>]*>)/i, `$1${bar}`)
    .replace(/<\/body>/i, `${script}</body>`);
}

// Render the proposal AS the current top-level document, then print it with the
// page's own window.print — the exact path that already works here ("normal PDF").
// No pop-up, no iframe, no Blob: it can't be blocked and always shows something.
// ← Back reloads index.html and the workspace restores from localStorage.
function openProposal(opts) {
  if (!project) return;
  let html;
  try {
    SparkStore.save(project);                       // persist before we leave the app view
    html = decorateProposal(buildProposalHtml(project, opts || getProposalOpts()));
  } catch (e) {
    toast("Couldn't build the proposal — " + (e && e.message ? e.message : "unexpected error"));
    return;
  }
  try {
    document.open();
    document.write(html);
    document.close();
  } catch (e) {
    toast("Couldn't open the proposal.");
  }
}

function openProposalDialog() {
  if (!project) return;
  closeExportMenu();
  const opts = getProposalOpts();
  const cur = { ...opts };
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  const variantBtns = [["standard", "Standard"], ["onepager", "One-pager"], ["sow", "Full SOW"]]
    .map(([v, l]) => `<button type="button" class="prop-theme prop-variant${cur.variant === v ? " active" : ""}" data-variant="${v}">${l}</button>`).join("");
  const themeBtns = ["minimal", "editorial", "bold"]
    .map((t) => `<button type="button" class="prop-theme${cur.theme === t ? " active" : ""}" data-theme="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("");
  const toggle = (opt, label) => `<label class="prop-toggle"><input type="checkbox" data-opt="${opt}" ${cur[opt] ? "checked" : ""}> ${label}</label>`;
  back.innerHTML = `
    <div class="modal proposal-dialog">
      <h2 class="modal-title">Client proposal</h2>
      <p class="modal-text">Pick a format and look, then generate a print-ready PDF.</p>
      <p class="prop-field-label">Format</p>
      <div class="prop-variants">${variantBtns}</div>
      <p class="prop-field-label">Style</p>
      <div class="prop-themes">${themeBtns}</div>
      <p class="prop-field-label">Include</p>
      <div class="prop-toggles">
        ${toggle("pricing", "Pricing table")}
        ${toggle("notes", "Questions &amp; risks")}
        ${toggle("tools", "Recommended tools")}
        ${toggle("signature", "Signature line")}
      </div>
      <p class="modal-note" id="propVariantNote"></p>
      <div class="modal-actions">
        <button type="button" class="ghost-btn" data-x="cancel">Cancel</button>
        <button type="button" class="spark-btn small" data-x="gen">⤓ Generate PDF</button>
      </div>
    </div>`;
  document.body.appendChild(back);

  // One-pager / SOW manage their own sections, so lock the include-toggles for those.
  const note = back.querySelector("#propVariantNote");
  const NOTES = {
    standard: "Set your name, contact &amp; accent colour in Settings → Branding.",
    onepager: "One-pager keeps it to the essentials — the include options are set for you.",
    sow: "Full SOW includes every section and groups tasks into phases.",
  };
  const reflectVariant = () => {
    const locked = cur.variant !== "standard";
    back.querySelectorAll(".prop-toggle").forEach((l) => l.classList.toggle("locked", locked));
    back.querySelectorAll("[data-opt]").forEach((c) => { c.disabled = locked; });
    note.innerHTML = NOTES[cur.variant] || NOTES.standard;
  };
  reflectVariant();

  back.addEventListener("click", (e) => {
    if (e.target === back || e.target.closest('[data-x="cancel"]')) { back.remove(); return; }
    const v = e.target.closest("[data-variant]");
    if (v) { cur.variant = v.dataset.variant; back.querySelectorAll("[data-variant]").forEach((b) => b.classList.toggle("active", b === v)); reflectVariant(); return; }
    const th = e.target.closest("[data-theme]:not(.prop-variant)");
    if (th) { cur.theme = th.dataset.theme; back.querySelectorAll(".prop-theme:not(.prop-variant)").forEach((b) => b.classList.toggle("active", b === th)); return; }
    if (e.target.closest('[data-x="gen"]')) {
      if (cur.variant === "standard") back.querySelectorAll("[data-opt]").forEach((c) => { cur[c.dataset.opt] = c.checked; });
      setProposalOpts(cur);
      back.remove();
      openProposal(cur);
    }
  });
}

/* Export menu (popover) */
let exportPop = null;
function closeExportMenu() { if (exportPop) { exportPop.remove(); exportPop = null; } }
function openExportMenu(anchor) {
  closeExportMenu();
  exportPop = document.createElement("div");
  exportPop.className = "export-pop";
  exportPop.innerHTML = `
    <button type="button" data-ex="proposal"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"/><path d="M9 12h6M9 16h6"/></svg>Client proposal (PDF)</button>
    <button type="button" data-ex="md"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>Copy as Markdown</button>
    <button type="button" data-ex="link"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 10a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1"/></svg>Copy share link</button>
    <button type="button" data-ex="pdf"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></svg>Print / Save as PDF</button>`;
  document.body.appendChild(exportPop);
  const r = anchor.getBoundingClientRect();
  exportPop.style.top = (r.bottom + 6) + "px";
  exportPop.style.left = Math.max(12, Math.min(r.left, window.innerWidth - exportPop.offsetWidth - 12)) + "px";
  exportPop.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ex]");
    if (!b) return;
    closeExportMenu();
    if (b.dataset.ex === "proposal") openProposalDialog();
    else if (b.dataset.ex === "md") copyMarkdown();
    else if (b.dataset.ex === "link") copyShareLink();
    else if (b.dataset.ex === "pdf") { if (viewMode !== "doc") setView("doc"); setTimeout(() => window.print(), 60); }
  });
}
document.addEventListener("click", (e) => {
  if (exportPop && !e.target.closest(".export-pop") && !e.target.closest('[data-action="export"]')) closeExportMenu();
});

/* ---------- Collapsible blocks (rolldown) ---------- */
function isCollapsed(section) { return !!(project && project.collapsed && project.collapsed[section]); }
function blockCls(section) { return `block${isCollapsed(section) ? " collapsed" : ""}`; }
function blockLabel(text, extra = "") {
  return `<p class="block-label" data-action="collapse"><span class="block-chevron">▾</span>${text}${extra}</p>`;
}
function toggleCollapse(blk) {
  const section = blk.dataset.section;
  if (!section || !project) return;
  if (!project.collapsed) project.collapsed = {};
  const now = !project.collapsed[section];
  project.collapsed[section] = now;
  blk.classList.toggle("collapsed", now);
  SparkStore.saveQuiet(project); // UI state — don't bump "edited"
}

function headerHtml() {
  return `
    <header class="result-header">
      <div class="result-titles">
        <div class="name-row">
          <h2 class="result-name" contenteditable="true" data-kind="name" data-field="projectName">${esc(project.projectName)}</h2>
          <span class="type-dots" aria-hidden="true"><span class="dot money"></span><span class="dot question"></span><span class="dot risk"></span></span>
        </div>
        <p class="result-tagline" contenteditable="true" data-kind="tagline" data-field="tagline">${esc(project.tagline)}</p>
        ${project.updatedAt ? `<span class="edited-at">edited ${relTime(project.updatedAt)}</span>` : ""}
      </div>
      <div class="result-actions">
        <div class="view-toggle" role="tablist">
          <button data-action="view" data-view="doc" class="${viewMode === "doc" ? "active" : ""}">Doc</button>
          <button data-action="view" data-view="map" class="${viewMode === "map" ? "active" : ""}">Map</button>
        </div>
        <button class="ghost-btn small" data-action="undo" ${history.length ? "" : "disabled"} title="Undo last change">↶ Undo</button>
        <button class="ghost-btn small" data-action="respark" title="Regenerate the whole project from the original idea"><svg width="12" height="12" viewBox="0 0 24 24"><path d="M13.5 2L6 13.2h4.4L10.2 22l7.8-11.6h-4.6z" fill="var(--accent-text)"/></svg>Re-spark</button>
        <button class="ghost-btn small" data-action="export" title="Export this project">⤓ Export</button>
      </div>
    </header>`;
}

function renderProject() {
  if (!project) { show("empty"); return; }
  if (!Array.isArray(project.taskOrder)) project.taskOrder = project.tasks.map((t) => t.id); // backfill legacy projects
  if (viewMode === "map") return renderMap();

  const _rate = getRate(), _cur = getCurrency();
  const taskHtml = project.tasks.map((t) => {
    const th = parseEstimateHours(t.estimate);
    const cost = (_rate > 0 && th > 0) ? `<span class="task-cost">${formatMoney(th * _rate, _cur)}</span>` : "";
    return `
    <li class="task-item${t.done ? " done" : ""}" data-kind="task" data-id="${t.id}">
      <span class="task-drag" draggable="true" title="Drag to reorder">⠿</span>
      <button class="task-check${t.done ? " done" : ""}" type="button" data-action="toggle" aria-label="Toggle done" title="Mark done"></button>
      <span class="task-title" contenteditable="true" data-field="title">${esc(t.title)}</span>
      ${cost}
      <button class="task-est${t.estimate ? "" : " empty"}" type="button" data-action="duration" title="Set duration">${esc(t.estimate || "+ time")}</button>
      ${itemTools()}
    </li>`;
  }).join("");

  const bulletHtml = (arr, kind, ico) => arr.map((it) => `
    <li class="bullet-item" data-kind="${kind}" data-id="${it.id}">
      <span class="ico">${ico}</span>
      <span class="bullet-text" contenteditable="true" data-field="text">${esc(it.text)}</span>
      ${itemTools()}
    </li>`).join("");

  result.innerHTML = `
    ${headerHtml()}
    ${summaryBarHtml()}
    ${lensBarHtml()}

    <div class="${blockCls("brief")}" data-section="brief">
      ${blockLabel("Brief", `<button class="mini-rework" data-action="rework" data-kind="brief" title="Rework with AI">↻</button>`)}
      <p class="brief-text" contenteditable="true" data-kind="brief" data-field="brief">${esc(project.brief)}</p>
    </div>

    <div class="${blockCls("tasks")}" data-section="tasks">
      ${blockLabel("Tasks &amp; estimates", taskHeaderTools())}
      <ul class="task-list">${taskHtml}</ul>
      <button class="add-btn" data-action="add" data-kind="task">+ Add task</button>
    </div>

    <div class="${blockCls("questions")} questions" data-section="questions">
      ${blockLabel("Open questions")}
      <ul class="bullet-list">${bulletHtml(project.openQuestions, "question", "?")}</ul>
      <button class="add-btn" data-action="add" data-kind="question">+ Add question</button>
    </div>

    <div class="${blockCls("risks")} risks" data-section="risks">
      ${blockLabel("Key risks")}
      <ul class="bullet-list">${bulletHtml(project.risks, "risk", "▲")}</ul>
      <button class="add-btn" data-action="add" data-kind="risk">+ Add risk</button>
    </div>

    ${toolsBlockHtml()}
  `;

  // Play the row entrance cascade only the first time this project appears — not on
  // in-place re-renders (toggle done, inline edit…), which would flicker the section.
  const freshAppearance = project.id !== animatedProjectId;
  result.classList.toggle("animate-in", freshAppearance);
  animatedProjectId = project.id;

  show("result");
  if (!suppressPersist) SparkStore.save(project);
  refreshProjectMenu();

  if (pendingFocusId) {
    const node = result.querySelector(`[data-id="${pendingFocusId}"] [contenteditable]`);
    if (node) placeCursorEnd(node);
    pendingFocusId = null;
  }

  if (pendingHighlightId) {
    const li = result.querySelector(`[data-id="${pendingHighlightId}"]`);
    if (li) {
      li.scrollIntoView({ behavior: "smooth", block: "center" });
      li.classList.add("flash");
      setTimeout(() => li.classList.remove("flash"), 1200);
    }
    pendingHighlightId = null;
  }
}

/* ---------- Brain map view ---------- */
function mapNodes() {
  // ordered list of item nodes (root handled separately); numbered per category
  const tasks = project.tasks.map((t, i) => ({
    id: t.id, kind: "task", num: "T" + (i + 1),
    label: t.title || "Untitled task", estimate: t.estimate || "", parentId: t.parentId || null,
  }));
  const qs = project.openQuestions.map((q, i) => ({ id: q.id, kind: "question", num: "Q" + (i + 1), label: q.text || "Open question" }));
  const rs = project.risks.map((r, i) => ({ id: r.id, kind: "risk", num: "R" + (i + 1), label: r.text || "Risk" }));
  const ns = (project.notes || []).map((n) => ({ id: n.id, kind: "note", num: "", label: n.text || "Empty note" }));
  return [...tasks, ...qs, ...rs, ...ns];
}

// A concise ~5-6 word label for the map nodes (full text lives in the doc).
function shortLabel(text, maxWords = 6, maxChars = 48) {
  const s = String(text || "").trim();
  const words = s.split(/\s+/).filter(Boolean);
  let out = words.slice(0, maxWords).join(" ");
  if (out.length > maxChars) out = out.slice(0, maxChars).replace(/\s+\S*$/, "");
  if (out.length < s.length) out = out.replace(/[.,;:]$/, "") + "…";
  return out;
}

/* ---------- Map pan / zoom ---------- */
let mapView = { x: 0, y: 0, scale: 1 };
let mapViewSaveTimer = null;
function applyMapTransform() {
  const w = el("mapWorld");
  if (w) w.style.transform = `translate(${mapView.x}px, ${mapView.y}px) scale(${mapView.scale})`;
}
function persistMapView() {
  if (!project) return;
  project.mapView = { ...mapView };
  clearTimeout(mapViewSaveTimer);
  mapViewSaveTimer = setTimeout(() => SparkStore.saveQuiet(project), 400);
}
function zoomAt(cx, cy, factor) {
  const ns = Math.max(0.35, Math.min(2.5, mapView.scale * factor));
  const wx = (cx - mapView.x) / mapView.scale, wy = (cy - mapView.y) / mapView.scale;
  mapView.x = cx - wx * ns; mapView.y = cy - wy * ns; mapView.scale = ns;
  applyMapTransform();
}
function doZoom(dir) {
  const canvas = el("mapCanvas"); if (!canvas) return;
  if (dir === "reset") { mapView = { x: 0, y: 0, scale: 1 }; applyMapTransform(); persistMapView(); return; }
  const rect = canvas.getBoundingClientRect();
  zoomAt(rect.width / 2, rect.height / 2, dir === "in" ? 1.2 : 1 / 1.2);
  persistMapView();
}

/* Fit: pan+zoom so every node is in view with breathing room. */
function fitMap() {
  const canvas = el("mapCanvas");
  if (!canvas || !project || !project.map) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  canvas.querySelectorAll(".map-node").forEach((n) => {
    const pos = project.map[n.dataset.id];
    if (!pos) return;
    const hw = n.offsetWidth / 2, hh = n.offsetHeight / 2;
    minX = Math.min(minX, pos.x - hw); maxX = Math.max(maxX, pos.x + hw);
    minY = Math.min(minY, pos.y - hh); maxY = Math.max(maxY, pos.y + hh);
  });
  if (!isFinite(minX)) return;
  const cw = canvas.clientWidth, ch = canvas.clientHeight, pad = 36;
  const scale = Math.max(0.35, Math.min(1.5,
    Math.min((cw - pad * 2) / Math.max(1, maxX - minX), (ch - pad * 2) / Math.max(1, maxY - minY))));
  mapView = {
    scale,
    x: (cw - (minX + maxX) * scale) / 2,
    y: (ch - (minY + maxY) * scale) / 2,
  };
  applyMapTransform();
  persistMapView();
}

function renderMap() {
  mapView = (project.mapView && typeof project.mapView.scale === "number") ? { ...project.mapView } : { x: 0, y: 0, scale: 1 };

  // Phase collapse: a parent task can hide its subtasks (cluster → one node).
  const collapsed = project.mapCollapsed || {};
  const childCount = {};
  project.tasks.forEach((t) => { if (t.parentId) childCount[t.parentId] = (childCount[t.parentId] || 0) + 1; });
  const hidden = new Set(project.tasks.filter((t) => t.parentId && collapsed[t.parentId]).map((t) => t.id));

  const nodes = mapNodes().filter((n) => !hidden.has(n.id));
  const wired = nodes.filter((n) => n.kind !== "note"); // notes are decoupled — no hub spoke
  const links = (project.links || []).filter((l) => !hidden.has(l.from) && !hidden.has(l.to));

  // Insights overlay: critical path + bottlenecks (only meaningful with depends-links)
  const insightsOn = mapInsights && hasTaskDeps();
  let crit = null, bneck = null;
  const critLinkIds = new Set();
  if (insightsOn) {
    crit = criticalPath();
    bneck = bottlenecks();
    links.forEach((l) => { if (l.type === "depends" && crit.path.has(l.from) && crit.back.get(l.from) === l.to) critLinkIds.add(l.id); });
  }
  const nodeInsightCls = (id) => insightsOn ? ((crit.path.has(id) ? " crit" : "") + (bneck.set.has(id) ? " bottleneck" : "")) : "";
  const edges =
    `<defs>
      <marker id="mk-depends" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="mk-depends" d="M0 0L10 5L0 10z"/></marker>
      <marker id="mk-blocks" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="mk-blocks" d="M0 0L10 5L0 10z"/></marker>
    </defs>` +
    wired.map((n) => `<path id="edge-${n.id}" class="edge" d=""></path>`).join("") +
    links.map((l) => `<path id="link-${l.id}" class="link link-${l.type}${critLinkIds.has(l.id) ? " crit" : ""}" data-link="${l.id}" d=""${l.type === "depends" ? ' marker-end="url(#mk-depends)"' : l.type === "blocks" ? ' marker-end="url(#mk-blocks)"' : ""}></path>` +
      `<path id="hit-${l.id}" class="link-hit" data-link="${l.id}" d=""></path>`).join("") +
    `<circle id="dot-root" class="edge-dot" r="5"></circle>` +
    wired.map((n) => `<circle id="dot-${n.id}" class="edge-dot" r="3.5"></circle>`).join("");

  const linkBtn = `<button class="map-node-btn" data-action="maplink" title="Link to another node"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 10a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1"/></svg></button>`;
  const toolsHtml = (kind) => `
    <span class="map-node-tools">
      <button class="map-node-btn" data-action="mapedit" title="Rename"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4L8 20H4v-4z"/></svg></button>
      <button class="map-node-btn" data-action="elaborate" title="Explain in chat"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l1.8-2.7A8.5 8.5 0 1 1 21 11.5z"/></svg></button>
      ${linkBtn}
      ${kind === "task" ? `<button class="map-node-btn" data-action="expand" title="Break into subtasks with AI">＋</button>` : ""}
      <button class="map-node-btn del" data-action="delete" title="Remove">×</button>
    </span>`;

  const phaseToggle = (id) => {
    const c = childCount[id];
    if (!c) return "";
    const on = !!collapsed[id];
    return `<button class="map-phase${on ? " on" : ""}" data-action="mapcollapse" title="${on ? "Show" : "Hide"} ${c} subtask${c > 1 ? "s" : ""}">${on
      ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>${c}`
      : `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`}</button>`;
  };
  const itemNodes = nodes.map((n) => `
    <div class="map-node ${n.kind}${nodeInsightCls(n.id)}${collapsed[n.id] && childCount[n.id] ? " phase-collapsed" : ""}" data-id="${n.id}" data-kind="${n.kind}" title="${esc(n.label)}">
      ${insightsOn && bneck.set.has(n.id) ? `<span class="neck-flag" title="Bottleneck — the most tasks depend on this"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg></span>` : ""}
      <div class="map-node-head">
        <span class="type-dot"></span>
        ${n.estimate ? `<span class="map-est">${esc(n.estimate)}</span>` : ""}
        ${phaseToggle(n.id)}
      </div>
      <span class="map-node-label">${esc(shortLabel(n.label))}</span>
      ${toolsHtml(n.kind)}
    </div>`).join("");

  const rootNode = `<div class="map-node root" data-id="root" data-kind="" title="${esc(project.projectName || "Project")}">
    <span class="node-badge">Project</span>
    <span class="map-node-label">${esc(shortLabel(project.projectName || "Project", 6, 34))}</span>
    ${project.tagline ? `<span class="node-tagline">${esc(shortLabel(project.tagline, 8, 60))}</span>` : ""}
    <span class="map-node-tools">
      <button class="map-node-btn" data-action="mapedit" title="Rename project"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4L8 20H4v-4z"/></svg></button>
    </span>
  </div>`;

  let hintHtml = `Drag to arrange · click opens it in Doc · link nodes with the link tool · click a wire to edit it.`;
  if (insightsOn) {
    const neckNames = [...bneck.set].map((id) => (project.tasks.find((t) => t.id === id) || {}).title).filter(Boolean);
    hintHtml = `<span class="crit-read"><span class="crit-key"></span>Critical path <strong>${daysLabel(crit.hours)}</strong> across ${crit.path.size} task${crit.path.size !== 1 ? "s" : ""}${neckNames.length ? ` · bottleneck: <strong>${esc(shortLabel(neckNames.join(", "), 5, 34))}</strong>` : ""}</span>`;
  }
  const insightsBtn = hasTaskDeps()
    ? `<button class="ghost-btn small${insightsOn ? " active" : ""}" data-action="insights" title="Highlight the critical path and bottlenecks"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M7.5 6H14a4 4 0 0 1 0 8H10a4 4 0 0 0 0 8h0"/></svg>Critical path</button>`
    : "";
  const askBtn = project.tasks.length >= 2
    ? `<button class="ghost-btn small map-ask" data-action="mapask" ${busy ? "disabled" : ""} title="Ask AI to analyze the graph — parallel work, risky path, gaps"><svg width="12" height="12" viewBox="0 0 24 24"><path d="M13.5 2L6 13.2h4.4L10.2 22l7.8-11.6h-4.6z" fill="currentColor"/></svg>Ask the map</button>`
    : "";

  result.innerHTML = `
    ${headerHtml()}
    <div class="map-bar">
      <p class="map-hint" id="mapHint">${hintHtml}</p>
      ${askBtn}
      ${insightsBtn}
      <button class="ghost-btn small" data-action="mapadd" title="Add a new task node">＋ Task</button>
      <button class="ghost-btn small" data-action="mapaddnote" title="Add a free-floating note — not a task, just a thought">＋ Note</button>
      <button class="ghost-btn small" data-action="fit" title="Fit every node in view"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>Fit</button>
      <button class="ghost-btn small" data-action="tidy" title="Auto-arrange the nodes">⤢ Tidy</button>
    </div>
    <div class="map-canvas" id="mapCanvas">
      <div class="map-world" id="mapWorld">
        <svg class="map-edges" id="mapEdges">${edges}</svg>
        ${rootNode}
        ${itemNodes}
      </div>
      <div class="map-zoom">
        <button class="map-zoom-btn" data-action="zoom" data-z="in" title="Zoom in">+</button>
        <button class="map-zoom-btn" data-action="zoom" data-z="reset" title="Reset view">⊙</button>
        <button class="map-zoom-btn" data-action="zoom" data-z="out" title="Zoom out">−</button>
      </div>
    </div>
  `;

  show("result");
  if (!suppressPersist) SparkStore.save(project);
  refreshProjectMenu();
  wireMap();
}

function ensureMapPositions(canvas) {
  if (!project.map) project.map = {};
  const cw = canvas.clientWidth || 640;
  const ch = canvas.clientHeight || 580;
  const cx = cw / 2, cy = ch / 2;
  if (!project.map.root) project.map.root = { x: cx, y: cy };

  const rad = (d) => (d * Math.PI) / 180;
  const rx = cw * 0.33, ry = ch * 0.37; // keep parents inward so children have room to branch
  let created = false;
  const place = (id, x, y) => {
    if (project.map[id]) return;
    project.map[id] = { x: Math.max(90, Math.min(cw - 90, x)), y: Math.max(36, Math.min(ch - 36, y)) };
    created = true;
  };

  const hasParent = (t) => t.parentId && project.tasks.some((p) => p.id === t.parentId);
  const topTasks = project.tasks.filter((t) => !hasParent(t));

  // Top-level clusters around the hub — wide arcs, staggered rings when crowded.
  const groups = [
    { items: topTasks,              start: -92,  end: 92  }, // right
    { items: project.openQuestions, start: -100, end: -168 }, // upper-left
    { items: project.risks,         start: 100,  end: 168 }, // lower-left
  ];
  groups.forEach((g) => {
    const n = g.items.length;
    g.items.forEach((it, i) => {
      const t = n === 1 ? 0.5 : (i + 0.5) / n;
      const ang = rad(g.start + t * (g.end - g.start));
      const tier = (n > 3 && i % 2 === 1) ? 0.6 : 1;
      place(it.id, cx + rx * tier * Math.cos(ang), cy + ry * tier * Math.sin(ang));
    });
  });

  // Free notes settle in the lower-left quadrant, loosely stacked.
  (project.notes || []).forEach((n, i) => {
    place(n.id, cx - rx * (0.62 + (i % 2) * 0.3), cy + ry * (0.66 + Math.floor(i / 2) * 0.26));
  });

  // Children branch outward from their parent, continuing the root→parent direction.
  const kids = project.tasks.filter(hasParent);
  for (let pass = 0; pass < 5; pass++) {
    const byParent = {};
    kids.forEach((c) => {
      if (project.map[c.id] || !project.map[c.parentId]) return;
      (byParent[c.parentId] = byParent[c.parentId] || []).push(c);
    });
    const parents = Object.keys(byParent);
    if (!parents.length) break;
    parents.forEach((pid) => {
      const p = project.map[pid], root = project.map.root;
      let dx = p.x - root.x, dy = p.y - root.y;
      const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
      const list = byParent[pid];
      list.forEach((c, i) => {
        const spread = (i - (list.length - 1) / 2) * 0.55; // fan around the branch direction
        const ca = Math.cos(spread), sa = Math.sin(spread);
        place(c.id, p.x + (dx * ca - dy * sa) * 108, p.y + (dx * sa + dy * ca) * 108);
      });
    });
  }
  return created;
}

function positionNode(node) {
  const pos = project.map[node.dataset.id];
  if (!pos) return;
  node.style.left = (pos.x - node.offsetWidth / 2) + "px";
  node.style.top = (pos.y - node.offsetHeight / 2) + "px";
}

/* Connector = horizontal cubic bézier (design: fans out from the hub) + endpoint dot. */
function setEdge(pathEl, fromId, toId) {
  const a = project.map[fromId], b = project.map[toId];
  if (!a || !b) return;
  const mid = (a.x + b.x) / 2;
  pathEl.setAttribute("d", `M${a.x},${a.y} C ${mid},${a.y} ${mid},${b.y} ${b.x},${b.y}`);
  const dot = pathEl.ownerSVGElement && pathEl.ownerSVGElement.querySelector(`#dot-${CSS.escape(toId)}`);
  if (dot) { dot.setAttribute("cx", b.x); dot.setAttribute("cy", b.y); }
}

function wireMap() {
  const canvas = el("mapCanvas");
  if (!canvas) return;
  const created = ensureMapPositions(canvas);
  if (created && !suppressPersist) SparkStore.save(project);

  const drawEdges = () => {
    mapNodes().forEach((n) => {
      if (n.kind === "note") return; // decoupled — no hub spoke
      const line = canvas.querySelector(`#edge-${CSS.escape(n.id)}`);
      if (!line) return;
      const src = (n.parentId && project.map[n.parentId]) ? n.parentId : "root";
      setEdge(line, src, n.id);
    });
    // typed relationships — endpoint pulled back so the arrowhead clears the card
    (project.links || []).forEach((l) => {
      const p = canvas.querySelector(`#link-${CSS.escape(l.id)}`);
      const a = project.map[l.from], b = project.map[l.to];
      if (!p || !a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const back = Math.min(78, len * 0.35);
      const bx = b.x - (dx / len) * back, by = b.y - (dy / len) * back;
      const mid = (a.x + bx) / 2;
      const d = `M${a.x},${a.y} C ${mid},${a.y} ${mid},${by} ${bx},${by}`;
      p.setAttribute("d", d);
      const hit = canvas.querySelector(`#hit-${CSS.escape(l.id)}`); // fat invisible twin = clickable
      if (hit) hit.setAttribute("d", d);
    });
    const rootDot = canvas.querySelector("#dot-root");
    if (rootDot && project.map.root) { rootDot.setAttribute("cx", project.map.root.x); rootDot.setAttribute("cy", project.map.root.y); }
  };
  canvas.querySelectorAll(".map-node").forEach(positionNode);
  drawEdges();
  applyMapTransform();

  // A freshly added node opens straight into inline rename.
  if (pendingMapEditId) {
    const fresh = canvas.querySelector(`.map-node[data-id="${pendingMapEditId}"]`);
    pendingMapEditId = null;
    if (fresh) startMapEdit(fresh);
  }

  // client px → world coords (undo pan + scale)
  const toWorld = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - mapView.x) / mapView.scale,
      y: (clientY - rect.top - mapView.y) / mapView.scale,
    };
  };

  // --- Typed-link editing: click a wire (fat invisible hit path) to retype/remove it ---
  canvas.querySelectorAll("path.link-hit").forEach((hit) => {
    const visible = canvas.querySelector(`#link-${CSS.escape(hit.dataset.link)}`);
    hit.addEventListener("click", (e) => {
      e.stopPropagation();
      openLinkPopover(e.clientX, e.clientY, null, hit.dataset.link);
    });
    hit.addEventListener("pointerenter", () => visible && visible.classList.add("hot"));
    hit.addEventListener("pointerleave", () => visible && visible.classList.remove("hot"));
  });

  // --- Node drag ---
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".map-node-btn") || e.target.closest(".map-phase")) return; // let click handle expand / delete / collapse
    const node = e.target.closest(".map-node");
    // linking mode: the next node click completes the link instead of dragging
    if (linkingFrom) {
      if (node && node.dataset.id !== linkingFrom) completeLink(node.dataset.id, e.clientX, e.clientY);
      else cancelLink();
      return;
    }
    if (!node) return;
    if (node.classList.contains("editing") || e.target.isContentEditable) return; // renaming — don't drag
    const pos = project.map[node.dataset.id];
    const w = toWorld(e.clientX, e.clientY);
    drag = { node, id: node.dataset.id, moved: false, sx: e.clientX, sy: e.clientY, dx: w.x - pos.x, dy: w.y - pos.y };
    try { node.setPointerCapture(e.pointerId); } catch (_) { /* synthetic / unsupported */ }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) <= 4) return; // ignore jitter
      drag.moved = true;
      drag.node.classList.add("dragging");
    }
    const w = toWorld(e.clientX, e.clientY);
    project.map[drag.id] = { x: w.x - drag.dx, y: w.y - drag.dy };
    positionNode(drag.node);
    drawEdges();
  });
  const end = () => {
    if (!drag) return;
    const d = drag; drag = null;
    d.node.classList.remove("dragging");
    if (d.moved) SparkStore.save(project);
    else if (d.node.dataset.kind === "note") startMapEdit(d.node); // notes live only here — click edits
    else goToDoc(d.id); // a click (no drag) opens the doc at that item
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  // --- Pan (drag empty space) ---
  let pan = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (linkingFrom) return; // linking click is handled above
    if (e.target.closest(".map-node") || e.target.closest(".map-zoom") || e.target.closest("path.link-hit")) return;
    pan = { sx: e.clientX, sy: e.clientY, px: mapView.x, py: mapView.y };
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    canvas.classList.add("panning");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pan) return;
    mapView.x = pan.px + (e.clientX - pan.sx);
    mapView.y = pan.py + (e.clientY - pan.sy);
    applyMapTransform();
  });
  const endPan = () => { if (!pan) return; pan = null; canvas.classList.remove("panning"); persistMapView(); };
  canvas.addEventListener("pointerup", endPan);
  canvas.addEventListener("pointercancel", endPan);

  // --- Wheel zoom (focal at cursor) ---
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    persistMapView();
  }, { passive: false });
}

function setView(v) {
  if (viewMode === v || !project) return;
  viewMode = v;
  suppressPersist = true; renderProject(); suppressPersist = false; // navigation, not an edit
}

function sectionOf(id) {
  if (!project) return null;
  if (project.tasks.some((t) => t.id === id)) return "tasks";
  if (project.openQuestions.some((q) => q.id === id)) return "questions";
  if (project.risks.some((r) => r.id === id)) return "risks";
  if ((project.notes || []).some((n) => n.id === id)) return "notes";
  return null;
}

// Clicking a map node jumps to the Doc view and highlights that item.
function goToDoc(id) {
  pendingHighlightId = (id && id !== "root") ? id : null;
  if (pendingHighlightId) {
    // make sure the item's section is open, or the highlight is hidden
    const sec = sectionOf(id);
    if (sec && project.collapsed && project.collapsed[sec]) {
      project.collapsed[sec] = false;
      SparkStore.saveQuiet(project);
    }
  }
  if (viewMode !== "doc") viewMode = "doc";
  suppressPersist = true; renderProject(); suppressPersist = false; // navigation, not an edit
}

function expandPrompt(task) {
  return `Project name: ${project.projectName}\nBrief: ${project.brief}\n\n` +
    `Break this task into 2-3 concrete, smaller subtasks: "${task.title}"\n` +
    `Return JSON: {"subtasks": [{"title": "...", "estimate": "short duration like '2h' or '1 day'"}]}`;
}

async function expandNode(taskId, btn) {
  const apiKey = getKey();
  if (!apiKey) { openSettings(); return; }
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task || btn.classList.contains("loading")) return;

  btn.classList.add("loading");
  try {
    const text = await callClaude({ system: withLearning(REWORK_SYSTEM), user: expandPrompt(task), apiKey, maxTokens: 500 });
    const parsed = extractJson(text);
    const subs = asArray(parsed.subtasks || parsed.tasks).slice(0, 4)
      .map((s) => (typeof s === "string" ? { title: s, estimate: "" } : { title: s.title || "", estimate: s.estimate || "" }))
      .filter((s) => s.title);
    if (!subs.length) throw new Error("No subtasks returned — try again.");
    pushHistory();
    subs.forEach((s) => {
      project.tasks.push({ id: uid(), title: s.title, estimate: s.estimate, genEstimate: s.estimate, parentId: taskId });
    });
    learnSplit(1); // breaking work down = granularity preference
    renderProject(); // layout branches the new children out from their parent
  } catch (err) {
    btn.classList.remove("loading");
    toast(err.message || "Couldn't expand that task.");
  }
}

/* ---------- Map: add node + inline rename ---------- */
function findMapItem(id) {
  return project.tasks.find((t) => t.id === id)
    || project.openQuestions.find((q) => q.id === id)
    || project.risks.find((r) => r.id === id)
    || (project.notes || []).find((n) => n.id === id)
    || null;
}

// Add a free-form task node at the centre of the current view, then edit it.
function addMapNode() {
  if (!project) return;
  pushHistory();
  const item = { id: uid(), title: "", estimate: "" };
  project.tasks.push(item);
  if (!project.map) project.map = {};
  const canvas = el("mapCanvas");
  if (canvas) {
    const rect = canvas.getBoundingClientRect();
    const cx = (rect.width / 2 - mapView.x) / mapView.scale;
    const cy = (rect.height / 2 - mapView.y) / mapView.scale;
    project.map[item.id] = { x: cx + 30, y: cy - 64 }; // drop it where the user is looking
  }
  pendingMapEditId = item.id; // wireMap opens it for rename after render
  renderProject();
}

/* Free note node — a thought on the map, deliberately NOT wired to the hub. */
function addMapNote() {
  if (!project) return;
  pushHistory();
  if (!Array.isArray(project.notes)) project.notes = [];
  const item = { id: uid(), text: "" };
  project.notes.push(item);
  if (!project.map) project.map = {};
  const canvas = el("mapCanvas");
  if (canvas) {
    const rect = canvas.getBoundingClientRect();
    const cx = (rect.width / 2 - mapView.x) / mapView.scale;
    const cy = (rect.height / 2 - mapView.y) / mapView.scale;
    project.map[item.id] = { x: cx - 50, y: cy + 80 };
  }
  pendingMapEditId = item.id;
  renderProject();
}

/* ---------- Typed relationships (Map 2.0) ---------- */
let linkingFrom = null, linkPop = null;

function beginLink(id) {
  if (!id || id === "root") return;
  linkingFrom = id;
  const canvas = el("mapCanvas");
  if (canvas) canvas.classList.add("linking");
  const hint = el("mapHint");
  if (hint) hint.textContent = "Linking — click the node it connects to (Esc to cancel).";
}
function cancelLink() {
  linkingFrom = null;
  const canvas = el("mapCanvas");
  if (canvas) canvas.classList.remove("linking");
  const hint = el("mapHint");
  if (hint) hint.textContent = "Drag to arrange · click opens it in Doc · the link tool connects nodes.";
}
function completeLink(toId, cx, cy) {
  const from = linkingFrom;
  cancelLink();
  if (!from || !toId || from === toId || toId === "root") return;
  if (!Array.isArray(project.links)) project.links = [];
  if (project.links.some((l) => (l.from === from && l.to === toId) || (l.from === toId && l.to === from))) {
    toast("Those two are already linked — click the wire to change it.");
    return;
  }
  openLinkPopover(cx, cy, { from, to: toId });
}

function closeLinkPopover() { if (linkPop) { linkPop.remove(); linkPop = null; } }
let linkPopOpenedAt = 0; // the opening click itself must not count as an "outside click"
/* Pick / change a relationship type; `draft` creates, `existingId` edits. */
function openLinkPopover(cx, cy, draft, existingId) {
  closeLinkPopover();
  linkPopOpenedAt = Date.now();
  const existing = existingId && (project.links || []).find((l) => l.id === existingId);
  if (existingId && !existing) return;
  linkPop = document.createElement("div");
  linkPop.className = "link-pop";
  const opt = (type, label) =>
    `<button type="button" data-lt="${type}" class="${existing && existing.type === type ? "active" : ""}"><span class="lt-dot ${type}"></span>${label}</button>`;
  linkPop.innerHTML = `
    <p class="link-pop-label">${existing ? "Relationship" : "How do they relate?"}</p>
    ${opt("depends", "Depends on")}
    ${opt("blocks", "Blocks")}
    ${opt("relates", "Relates to")}
    ${existing ? `<button type="button" data-lt="_del" class="del">Remove link</button>` : ""}`;
  document.body.appendChild(linkPop);
  linkPop.style.top = Math.min(cy + 8, window.innerHeight - linkPop.offsetHeight - 12) + "px";
  linkPop.style.left = Math.max(12, Math.min(cx - 20, window.innerWidth - linkPop.offsetWidth - 12)) + "px";
  linkPop.addEventListener("click", (e) => {
    const b = e.target.closest("[data-lt]");
    if (!b) return;
    const t = b.dataset.lt;
    pushHistory();
    if (!Array.isArray(project.links)) project.links = [];
    if (t === "_del") project.links = project.links.filter((l) => l.id !== existingId);
    else if (existing) existing.type = t;
    else project.links.push({ id: uid(), from: draft.from, to: draft.to, type: t });
    closeLinkPopover();
    SparkStore.save(project);
    renderProject();
  });
}
document.addEventListener("click", (e) => {
  if (!linkPop) return;
  if (Date.now() - linkPopOpenedAt < 300) return; // the click that opened it is still in flight
  if (!e.target.closest(".link-pop") && !e.target.closest("path.link") && !e.target.closest("path.link-hit")) closeLinkPopover();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeLinkPopover(); if (linkingFrom) cancelLink(); }
});

// Turn a node's label into an editable field showing its full text.
function startMapEdit(node) {
  if (!node) return;
  const label = node.querySelector(".map-node-label");
  if (!label || label.isContentEditable) return;
  const id = node.dataset.id;
  const item = id === "root" ? null : findMapItem(id);
  if (id !== "root" && !item) return;
  const full = id === "root" ? (project.projectName || "Project")
    : (("title" in item) ? item.title : item.text) || "";

  label.textContent = full;
  label.contentEditable = "true";
  label.classList.add("editing");
  node.classList.add("editing");

  const sel = window.getSelection();
  const r = document.createRange();
  r.selectNodeContents(label);
  sel.removeAllRanges();
  sel.addRange(r); // select-all so typing replaces
  label.focus();

  const commit = () => commitMapEdit(node, label, id);
  label.addEventListener("blur", commit, { once: true });
  label.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); label.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); label.removeEventListener("blur", commit); renderProject(); }
  });
}

function commitMapEdit(node, label, id) {
  const val = label.textContent.trim();
  label.contentEditable = "false";
  label.classList.remove("editing");
  if (node) node.classList.remove("editing");

  if (id === "root") {
    if (val && val !== project.projectName) {
      pushHistory();
      project.projectName = val;
      SparkStore.save(project);
      refreshProjectMenu();
    }
    return renderProject();
  }

  const item = findMapItem(id);
  if (!item) return renderProject();
  const isTask = "title" in item;
  const oldVal = (isTask ? item.title : item.text) || "";
  const sec = sectionOf(id);
  const kind = sec === "tasks" ? "task" : sec === "questions" ? "question" : sec === "notes" ? "note" : "risk";
  if (!val) {                                          // empty → remove the node
    if (oldVal) return deleteItem(kind, id);           // cleared existing text → undoable trim
    const arr = listFor(kind);                         // abandoned a brand-new blank node → drop it quietly
    const i = arr ? arr.findIndex((x) => x.id === id) : -1;
    if (i > -1) arr.splice(i, 1);
    return renderProject();
  }
  if (val === oldVal) return renderProject();          // unchanged → restore truncated label
  pushHistory();
  if (isTask) item.title = val; else item.text = val;
  SparkStore.save(project);
  renderProject();
}

const itemTools = () => `
  <span class="item-tools">
    <button class="item-btn" data-action="elaborate" title="Ask the AI to explain this (in chat)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l1.8-2.7A8.5 8.5 0 1 1 21 11.5z"/></svg></button>
    <button class="item-btn" data-action="rework" title="Rework with AI">↻</button>
    <button class="item-btn del" data-action="delete" title="Remove">×</button>
  </span>`;

function placeCursorEnd(node) {
  node.focus();
  const r = document.createRange();
  r.selectNodeContents(node);
  r.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/* ---------- Inline edit + actions (event delegation) ---------- */
result.addEventListener("focusout", (e) => {
  const field = e.target.closest("[data-field]");
  if (!field || !(field.isContentEditable || field.tagName === "INPUT")) return;
  saveField(field);
});

result.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && (e.target.isContentEditable || e.target.tagName === "INPUT")) {
    e.preventDefault();
    e.target.blur(); // commit the edit
  }
});

result.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const host = btn.closest("[data-kind]") || btn;
  const kind = host.dataset.kind || btn.dataset.kind;
  const id = host.dataset.id;

  if (action === "rate") { openSettings(); setTimeout(() => rateInput && rateInput.focus(), 60); return; }
  if (action === "copy") return copyMarkdown();
  if (action === "export") return openExportMenu(btn);
  if (action === "lens") return openLens(btn.dataset.lens);
  if (action === "collapse") { const blk = btn.closest(".block"); if (blk) toggleCollapse(blk); return; }
  if (action === "toggle") {
    const t = project.tasks.find((x) => x.id === id);
    if (t) { t.done = !t.done; SparkStore.save(project); renderProject(); }
    return;
  }
  if (action === "view") return setView(btn.dataset.view);
  if (action === "zoom") return doZoom(btn.dataset.z);
  if (action === "fit") return fitMap();
  if (action === "insights") { mapInsights = !mapInsights; suppressPersist = true; renderProject(); suppressPersist = false; return; }
  if (action === "mapask") return askMapInsights();
  if (action === "mapcollapse") {
    if (!project.mapCollapsed) project.mapCollapsed = {};
    if (project.mapCollapsed[id]) delete project.mapCollapsed[id]; else project.mapCollapsed[id] = true;
    SparkStore.saveQuiet(project); // UI state — don't bump "edited"
    suppressPersist = true; renderProject(); suppressPersist = false;
    return;
  }
  if (action === "tidy") { pushHistory(); project.map = {}; mapView = { x: 0, y: 0, scale: 1 }; persistMapView(); return renderProject(); }
  if (action === "mapadd") return addMapNode();
  if (action === "mapaddnote") return addMapNote();
  if (action === "maplink") return beginLink(id);
  if (action === "mapedit") return startMapEdit(host);
  if (action === "undo") return undo();
  if (action === "respark") {
    if (project && !window.confirm("Re-spark regenerates the whole project from the original idea — your current edits will be replaced. Continue?")) return;
    return spark(project ? project.idea : undefined);
  }
  if (action === "add") return addItem(kind);
  if (action === "resetorder") return resetTaskOrder();
  if (action === "orderdeps") return orderByDependencies();
  if (action === "delete") return deleteItem(kind, id);
  if (action === "rework") return reworkItem(kind, id, btn);
  if (action === "elaborate") return elaborate(kind, id);
  if (action === "expand") return expandNode(id, btn);
  if (action === "duration") return openDurationPicker(id, btn);
  if (action === "suggesttools") return suggestTools(btn);
});

function saveField(node) {
  if (!project) return;
  const host = node.closest("[data-kind]");
  const kind = host.dataset.kind;
  const fieldName = node.dataset.field;
  const val = (node.tagName === "INPUT" ? node.value : node.textContent).trim();

  // Resolve the current value to detect a real change (and to auto-trim blanks).
  let item = null, oldVal;
  if (kind === "name") oldVal = project.projectName;
  else if (kind === "tagline") oldVal = project.tagline;
  else if (kind === "brief") oldVal = project.brief;
  else {
    item = (listFor(kind) || []).find((x) => x.id === host.dataset.id);
    if (!item) return;
    oldVal = kind === "task" ? item.title : item.text;
  }
  if (val === (oldVal || "")) return; // nothing actually changed

  // Auto-trim: clearing a list item's text removes the item.
  if (item && !val) { deleteItem(kind, host.dataset.id); return; }

  pushHistory();                 // inline edits are now undoable
  if (kind === "name") project.projectName = val;
  else if (kind === "tagline") project.tagline = val;
  else if (kind === "brief") project.brief = val;
  else if (kind === "task") item.title = val;
  else item.text = val;

  SparkStore.save(project);      // bumps updatedAt; no full re-render (keeps focus flow)
  refreshProjectMenu();
  const u = result.querySelector('[data-action="undo"]');
  if (u) u.disabled = false;     // reflect that undo is now available
}

/* ---------- Task order (reset to the post-generation default) ---------- */
function defaultOrdered(tasks, taskOrder) {
  if (!Array.isArray(taskOrder)) return tasks.slice();
  const idx = new Map(taskOrder.map((id, i) => [id, i]));
  return tasks.slice().sort((a, b) => (idx.has(a.id) ? idx.get(a.id) : Infinity) - (idx.has(b.id) ? idx.get(b.id) : Infinity));
}
function orderDiffersFromDefault() {
  if (!project || !Array.isArray(project.taskOrder) || project.tasks.length < 2) return false;
  const d = defaultOrdered(project.tasks, project.taskOrder);
  return d.some((t, i) => t.id !== project.tasks[i].id);
}
function resetTaskOrder() {
  if (!project) return;
  const d = defaultOrdered(project.tasks, project.taskOrder);
  if (d.every((t, i) => t.id === project.tasks[i].id)) return; // already in order
  pushHistory();
  project.tasks = d;
  SparkStore.save(project);
  renderProject();
}

/* ---------- Dependency-aware ordering (Map 2.0) ----------
 * A "depends" link A→B means A depends on B, so B must come first.
 * Kahn topological sort over the task subgraph; keeps the current order as the
 * tie-breaker (stable) and tolerates cycles by emitting stragglers in place. */
function taskDepEdges() {
  if (!project || !Array.isArray(project.links)) return [];
  const taskIds = new Set(project.tasks.map((t) => t.id));
  // edge = [prereq, dependent]: the prereq must be ordered before the dependent
  return project.links
    .filter((l) => l.type === "depends" && taskIds.has(l.from) && taskIds.has(l.to) && l.from !== l.to)
    .map((l) => [l.to, l.from]); // A depends on B → B before A
}
function dependencyOrdered() {
  const tasks = project.tasks;
  const edges = taskDepEdges();
  if (!edges.length) return tasks.slice();
  const pos = new Map(tasks.map((t, i) => [t.id, i]));      // current order = tie-breaker
  const indeg = new Map(tasks.map((t) => [t.id, 0]));
  const next = new Map(tasks.map((t) => [t.id, []]));       // prereq → dependents
  edges.forEach(([pre, dep]) => {
    if (!next.has(pre) || !indeg.has(dep)) return;
    next.get(pre).push(dep);
    indeg.set(dep, indeg.get(dep) + 1);
  });
  // ready = indegree 0, popped in current-order to stay stable
  const ready = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  const out = [];
  const seen = new Set();
  const takeReady = () => ready.sort((a, b) => pos.get(a) - pos.get(b));
  while (ready.length) {
    takeReady();
    const id = ready.shift();
    if (seen.has(id)) continue;
    seen.add(id); out.push(id);
    next.get(id).forEach((dep) => {
      indeg.set(dep, indeg.get(dep) - 1);
      if (indeg.get(dep) === 0) ready.push(dep);
    });
  }
  // cycle survivors: append in current order so nothing is lost
  tasks.forEach((t) => { if (!seen.has(t.id)) out.push(t.id); });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return out.map((id) => byId.get(id));
}
/* True when the current order violates a "depends" link (a dependent sits before its prereq). */
function orderViolatesDeps() {
  if (!project || project.tasks.length < 2) return false;
  const edges = taskDepEdges();
  if (!edges.length) return false;
  const pos = new Map(project.tasks.map((t, i) => [t.id, i]));
  return edges.some(([pre, dep]) => pos.get(pre) > pos.get(dep)); // prereq after dependent = violation
}
function orderByDependencies() {
  if (!project) return;
  const d = dependencyOrdered();
  if (d.every((t, i) => t.id === project.tasks[i].id)) return;
  pushHistory();
  project.tasks = d;
  SparkStore.save(project);
  renderProject();
  toast("Reordered so prerequisites come first.");
}

/* ---------- Critical path & bottlenecks (Map 2.0) ---------- */
function dependencyGraph() {
  const taskIds = new Set(project.tasks.map((t) => t.id));
  const prereq = new Map(project.tasks.map((t) => [t.id, []]));      // n → tasks that must precede it
  const dependents = new Map(project.tasks.map((t) => [t.id, []]));  // n → tasks waiting on it
  (project.links || []).forEach((l) => {
    if (l.type !== "depends" || !taskIds.has(l.from) || !taskIds.has(l.to) || l.from === l.to) return;
    prereq.get(l.from).push(l.to);      // "from depends on to" ⇒ to precedes from
    dependents.get(l.to).push(l.from);
  });
  return { prereq, dependents };
}
/* Longest duration-weighted dependency chain — the schedule driver. */
function criticalPath() {
  const { prereq } = dependencyGraph();
  const hours = new Map(project.tasks.map((t) => [t.id, Math.max(0, parseEstimateHours(t.estimate) || 0)]));
  const order = dependencyOrdered().map((t) => t.id); // topo order (prereqs first), cycle-safe
  const done = new Set(), ef = new Map(), back = new Map(); // earliest-finish + best predecessor
  order.forEach((id) => {
    let best = 0, bestPre = null;
    prereq.get(id).forEach((p) => {
      if (!done.has(p)) return; // skip cycle back-edges
      const v = ef.get(p) || 0;
      if (v > best) { best = v; bestPre = p; }
    });
    ef.set(id, best + (hours.get(id) || 0));
    back.set(id, bestPre);
    done.add(id);
  });
  let endId = null, max = -1;
  ef.forEach((v, id) => { if (v > max) { max = v; endId = id; } });
  const path = new Set();
  for (let cur = endId, g = 0; cur != null && g < 999; cur = back.get(cur), g++) path.add(cur);
  return { path, back, hours: max, endId };
}
/* Bottlenecks — tasks with the most work transitively waiting on them. */
function bottlenecks() {
  const { dependents } = dependencyGraph();
  const count = new Map();
  project.tasks.forEach((t) => {
    const seen = new Set(), stack = [...(dependents.get(t.id) || [])];
    while (stack.length) {
      const x = stack.pop();
      if (seen.has(x)) continue;
      seen.add(x);
      (dependents.get(x) || []).forEach((y) => stack.push(y));
    }
    count.set(t.id, seen.size);
  });
  let max = 0; count.forEach((c) => { if (c > max) max = c; });
  const set = new Set();
  if (max >= 2) count.forEach((c, id) => { if (c === max) set.add(id); });
  return { count, set, max };
}
function hasTaskDeps() { return taskDepEdges().length > 0; }
function daysLabel(hrs) { const d = hrs / 8; return (d < 10 ? d.toFixed(1) : Math.round(d)) + "d"; }

/* Buttons in the Tasks block header: reorder-by-deps (only when the graph is violated) + reset-order. */
function taskHeaderTools() {
  if (!project || project.tasks.length < 2) return "";
  const btns = [];
  if (orderViolatesDeps()) {
    btns.push(`<button class="order-deps" data-action="orderdeps" title="Reorder so each task's prerequisites come first (from the map's Depends-on links)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v13M4 14l3 3 3-3M17 20V7M14 10l3-3 3 3"/></svg>By dependencies</button>`);
  }
  btns.push(`<button class="order-reset${orderDiffersFromDefault() ? " active" : ""}" data-action="resetorder" title="Reset tasks to their original order">⤺ order</button>`);
  return `<span class="block-tools">${btns.join("")}</span>`;
}

/* ---------- Drag-to-reorder tasks ---------- */
let dragTaskId = null;
function commitTaskOrder() {
  const ids = [...result.querySelectorAll(".task-item")].map((li) => li.dataset.id);
  if (!ids.length) return;
  const byId = Object.fromEntries(project.tasks.map((t) => [t.id, t]));
  const next = ids.map((id) => byId[id]).filter(Boolean);
  project.tasks.forEach((t) => { if (!ids.includes(t.id)) next.push(t); }); // safety
  if (next.length !== project.tasks.length || next.every((t, i) => t.id === project.tasks[i].id)) return; // no change
  pushHistory();
  project.tasks = next;
  SparkStore.save(project);
  renderProject();
}
result.addEventListener("dragstart", (e) => {
  const handle = e.target.closest(".task-drag");
  if (!handle) return;
  const li = handle.closest(".task-item");
  dragTaskId = li.dataset.id;
  li.classList.add("dragging");
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", dragTaskId); } catch (_) {} }
});
result.addEventListener("dragover", (e) => {
  if (!dragTaskId) return;
  const li = e.target.closest(".task-item");
  const dragged = result.querySelector(".task-item.dragging");
  if (!li || !dragged || li === dragged) return;
  e.preventDefault();
  const rect = li.getBoundingClientRect();
  const after = e.clientY > rect.top + rect.height / 2;
  li.parentNode.insertBefore(dragged, after ? li.nextSibling : li);
});
result.addEventListener("dragend", () => {
  const d = result.querySelector(".task-item.dragging");
  if (d) d.classList.remove("dragging");
  if (dragTaskId) { commitTaskOrder(); dragTaskId = null; }
});

function addItem(kind) {
  const arr = listFor(kind);
  if (!arr) return;
  pushHistory();
  const item = kind === "task" ? { id: uid(), title: "", estimate: "" } : { id: uid(), text: "" };
  arr.push(item);
  pendingFocusId = item.id;
  if (kind === "task") learnSplit(1); // prefers more granular plans
  renderProject();
}

function deleteItem(kind, id) {
  const arr = listFor(kind);
  if (!arr) return;
  const i = arr.findIndex((x) => x.id === id);
  if (i === -1) return;
  pushHistory();
  const removed = arr[i];
  arr.splice(i, 1);
  if (Array.isArray(project.links)) project.links = project.links.filter((l) => l.from !== id && l.to !== id); // no orphaned wires
  if (kind === "task" && (removed.title || "").trim()) learnSplit(-1); // prefers chunkier plans (blank trims don't count)
  renderProject();
  const label = kind === "task" ? (removed.title || "Task") : (removed.text || "Item");
  toastAction(`Deleted "${label.slice(0, 28)}${label.length > 28 ? "…" : ""}"`, "Undo", undo);
}

/* ---------- Duration picker ---------- */
const DURATION_PRESETS = ["1h", "2h", "4h", "1 day", "2 days", "3 days", "5 days", "1 week", "2 weeks"];
let durPop = null, durTaskId = null;

function closeDurationPicker() {
  if (durPop) { durPop.remove(); durPop = null; durTaskId = null; }
}

function setDuration(val) {
  const t = project && project.tasks.find((x) => x.id === durTaskId);
  if (t) {
    const next = String(val).trim();
    if (t.genEstimate && next !== t.estimate) learnEstimate(t.genEstimate, next); // calibration signal
    t.estimate = next;
    SparkStore.save(project);
  }
  closeDurationPicker();
  renderProject(); // refresh the timeline + quote live
}

function openDurationPicker(taskId, anchor) {
  const task = project && project.tasks.find((t) => t.id === taskId);
  if (!task) return;
  closeDurationPicker();
  durTaskId = taskId;

  durPop = document.createElement("div");
  durPop.className = "dur-pop";
  durPop.innerHTML = `
    <input class="dur-custom" type="text" value="${esc(task.estimate)}" placeholder="custom — e.g. 2.5d, half a day" aria-label="Custom duration" />
    <div class="dur-presets">${DURATION_PRESETS.map((p) => `<button type="button" class="dur-chip" data-dur="${esc(p)}">${esc(p)}</button>`).join("")}</div>`;
  document.body.appendChild(durPop);

  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 6;
  durPop.style.top = (top + durPop.offsetHeight > window.innerHeight ? r.top - durPop.offsetHeight - 6 : top) + "px";
  durPop.style.left = Math.max(12, Math.min(r.left, window.innerWidth - durPop.offsetWidth - 12)) + "px";

  const input = durPop.querySelector(".dur-custom");
  input.focus();
  input.select();
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); setDuration(input.value); }
    else if (e.key === "Escape") { e.preventDefault(); closeDurationPicker(); }
  });
  durPop.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-dur]");
    if (chip) setDuration(chip.dataset.dur);
  });
}

document.addEventListener("click", (e) => {
  if (durPop && !e.target.closest(".dur-pop") && !e.target.closest('[data-action="duration"]')) closeDurationPicker();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDurationPicker(); });

/* ---------- Per-item AI rework ---------- */
function reworkPrompt(kind, item) {
  const ctx = `Project name: ${project.projectName}\nTagline: ${project.tagline}\nBrief: ${project.brief}`;
  if (kind === "brief") {
    return `${ctx}\n\nRewrite the project brief in 2-3 crisp sentences with a fresh framing. \
Current brief: "${project.brief}"\nReturn JSON: {"brief": "..."}`;
  }
  if (kind === "task") {
    const others = project.tasks.filter((t) => t.id !== item.id).map((t) => "- " + t.title).join("\n");
    return `${ctx}\n\nOther tasks:\n${others || "(none)"}\n\nRework this single task into an improved or alternative version, \
distinct from the others: "${item.title}"\nReturn JSON: {"title": "...", "estimate": "short duration like '2h' or '1 day'"}`;
  }
  const label = kind === "question" ? "open question" : "risk";
  const list = listFor(kind).filter((x) => x.id !== item.id).map((x) => "- " + x.text).join("\n");
  return `${ctx}\n\nOther ${label}s:\n${list || "(none)"}\n\nRework this single ${label} into a sharper, more useful version, \
distinct from the others: "${item.text}"\nReturn JSON: {"text": "..."}`;
}

async function reworkItem(kind, id, btn) {
  const apiKey = getKey();
  if (!apiKey) { openSettings(); return; }

  const item = kind === "brief" ? { id: "brief" } : (listFor(kind) || []).find((x) => x.id === id);
  if (!item) return;
  if (btn.classList.contains("loading")) return;

  btn.classList.add("loading");
  btn.disabled = true;

  try {
    const text = await callClaude({ system: withTone(REWORK_SYSTEM), user: reworkPrompt(kind, item), apiKey, maxTokens: 400 });
    const parsed = extractJson(text);
    pushHistory();
    if (kind === "brief") {
      project.brief = parsed.brief || project.brief;
    } else if (kind === "task") {
      const t = project.tasks.find((x) => x.id === id);
      if (t) { t.title = parsed.title || t.title; if (parsed.estimate) t.estimate = parsed.estimate; }
    } else {
      const x = (listFor(kind) || []).find((y) => y.id === id);
      if (x) x.text = parsed.text || parsed.value || x.text;
    }
    renderProject();
  } catch (err) {
    btn.classList.remove("loading");
    btn.disabled = false;
    toast(err.message || "Couldn't rework that — try again.");
  }
}

/* ---------- Elaborate an item (chat context feature) ---------- */
const ELABORATE_SYSTEM = `You are Spark, a helpful project assistant. The user wants more detail on one element of their project. \
Give a concise, practical elaboration in 2-4 short sentences of plain text (no markdown, no bullets, no preamble) — what it means and how to approach it.`;

function elaboratePrompt(kind, item) {
  const label = kind === "task" ? item.title : item.text;
  const what = kind === "task" ? "task" : kind === "question" ? "open question" : kind === "note" ? "note" : "risk";
  const angle = kind === "task" ? "Explain what it involves and how to tackle it."
    : kind === "question" ? "Explain why it matters and how to resolve it."
    : kind === "note" ? "Explain how it connects to the project and what to do with it."
    : "Explain the risk and how to mitigate it.";
  return `Project: ${project.projectName}\nBrief: ${project.brief}\n\nElaborate on this ${what}: "${label}"\n${angle}`;
}

async function elaborate(kind, id) {
  if (busy || !project) return;
  const apiKey = getKey();
  if (!apiKey) { openSettings(); return; }
  const item = (listFor(kind) || []).find((x) => x.id === id);
  if (!item) return;
  const label = kind === "task" ? item.title : item.text;

  if (!Array.isArray(project.chat)) project.chat = [];
  project.chat.push({ id: uid(), role: "user", text: `Tell me more about: "${label}"` });
  const answer = { id: uid(), role: "assistant", text: "" };
  project.chat.push(answer);
  busy = true;
  streaming = true;
  sparkBtn.disabled = true;
  renderChat(); // question + empty answer bubble (which fills as tokens arrive)
  const bubble = chatThread.querySelector(".chat-msg:last-child .bubble");

  try {
    const full = await callClaudeStream({
      system: withTone(ELABORATE_SYSTEM), user: elaboratePrompt(kind, item), apiKey, maxTokens: 600,
      onToken: (_, acc) => { if (bubble) { bubble.textContent = acc; chatThread.scrollTop = chatThread.scrollHeight; } },
    });
    answer.text = full.trim() || "…";
  } catch (err) {
    answer.kind = "error";
    answer.text = (err && err.message) || "Couldn't elaborate — try again.";
  }
  busy = false;
  streaming = false;
  sparkBtn.disabled = false;
  renderChat();
  SparkStore.saveQuiet(project); // persist the conversation without bumping "edited"
}

/* ---------- AI map insights (graph-level analysis + addable suggestions) ---------- */
const MAP_INSIGHTS_SYSTEM = `You are Spark, analyzing a freelancer's project as a DEPENDENCY GRAPH. \
You are given tasks (with estimates), their dependency/blocks/relates links, any free notes, and the pre-computed critical path and bottleneck.

Return ONLY a single JSON object — no prose, no markdown, no code fences — of this shape:
{
  "insights": "2-4 short sentences of graph-level insight: what can safely run in PARALLEL, the RISKIEST stretch and why, where to add BUFFER. Reference tasks by name. Plain text.",
  "suggestions": [
    { "kind": "task", "title": "A concrete missing task worth adding", "estimate": "rough duration, or empty string" },
    { "kind": "link", "from": "exact existing task name", "to": "exact existing task name", "type": "depends" },
    { "kind": "note", "text": "a short reminder/consideration worth capturing on the map" }
  ]
}

Rules for suggestions (2 to 6, only genuinely useful additions the graph is missing):
- "task": a gap you noticed (e.g. testing, staging, handoff) not already in the list.
- "link": for "from"/"to" use the EXACT names of tasks in the given list; type is depends|blocks|relates (depends = 'from' needs 'to' done first). Only propose missing dependencies you'd expect.
- "note": a consideration or open decision worth pinning.
- If there is nothing worth adding, return an empty "suggestions" array. Output valid JSON only.`;

function nodeLabel(id) {
  if (id === "root") return project.projectName;
  const it = findMapItem(id);
  return it ? (("title" in it) ? it.title : it.text) : null;
}
function mapGraphContext() {
  const L = [`Project: ${project.projectName}`, "", "Tasks (estimate):"];
  project.tasks.forEach((t) => L.push(`- ${t.title || "Untitled"}${t.estimate ? ` (${t.estimate})` : " (no estimate)"}`));
  const byType = (type, verb) => {
    const ls = (project.links || []).filter((l) => l.type === type)
      .map((l) => { const a = nodeLabel(l.from), b = nodeLabel(l.to); return a && b ? `- ${a} ${verb} ${b}` : null; })
      .filter(Boolean);
    if (ls.length) { L.push("", `${type[0].toUpperCase() + type.slice(1)} links:`); L.push(...ls); }
  };
  if (taskDepEdges().length) byType("depends", "needs done first:"); else L.push("", "No dependencies drawn.");
  byType("blocks", "blocks");
  byType("relates", "relates to");
  const notes = project.notes || [];
  if (notes.length) { L.push("", "Notes on the map:"); notes.forEach((n) => L.push(`- ${n.text}`)); }
  if (hasTaskDeps()) {
    const cp = criticalPath(), bn = bottlenecks();
    L.push("", `Computed critical path (${daysLabel(cp.hours)}): ${[...cp.path].reverse().map(nodeLabel).filter(Boolean).join(" → ")}`);
    if (bn.set.size) L.push(`Computed bottleneck: ${[...bn.set].map(nodeLabel).filter(Boolean).join(", ")}`);
  }
  return L.join("\n");
}

function normalizeSuggestion(s) {
  if (!s || typeof s !== "object") return null;
  if (s.kind === "task" && s.title) return { id: uid(), kind: "task", title: String(s.title).trim(), estimate: String(s.estimate || "").trim(), applied: false };
  if (s.kind === "note" && s.text) return { id: uid(), kind: "note", text: String(s.text).trim(), applied: false };
  if (s.kind === "link" && s.from && s.to && ["depends", "blocks", "relates"].includes(s.type))
    return { id: uid(), kind: "link", from: String(s.from).trim(), to: String(s.to).trim(), type: s.type, applied: false };
  return null;
}

async function askMapInsights() {
  if (busy || !project) return;
  const apiKey = getKey();
  if (!apiKey) { openSettings(); return; }
  if (!Array.isArray(project.chat)) project.chat = [];
  project.chat.push({ id: uid(), role: "user", text: "Analyze the map — parallel work, risky path, and gaps." });
  busy = true; sparkBtn.disabled = true;
  renderChat(); // busy + !streaming ⇒ shows the thinking indicator
  let failure = null, parsed = null;
  try {
    const text = await callClaude({ system: withTone(MAP_INSIGHTS_SYSTEM), user: mapGraphContext(), apiKey, maxTokens: 800 });
    parsed = extractJson(text);
  } catch (err) { failure = err; }
  busy = false; sparkBtn.disabled = false;
  if (failure) {
    project.chat.push({ id: uid(), role: "assistant", kind: "error", text: (failure && failure.message) || "Couldn't analyze the map — try again." });
  } else {
    const sugg = asArray(parsed.suggestions).map(normalizeSuggestion).filter(Boolean);
    project.chat.push({ id: uid(), role: "assistant", text: (parsed.insights || "").trim() || "Here's how the graph looks.", suggestions: sugg.length ? sugg : undefined });
  }
  renderChat();
  SparkStore.saveQuiet(project);
}

/* Resolve an AI-referenced task name to an id (exact, then loose contains). */
function resolveTaskId(title) {
  const n = String(title || "").trim().toLowerCase();
  if (!n) return null;
  let t = project.tasks.find((x) => (x.title || "").trim().toLowerCase() === n);
  if (!t) t = project.tasks.find((x) => { const xt = (x.title || "").trim().toLowerCase(); return xt && (xt.includes(n) || n.includes(xt)); });
  return t ? t.id : null;
}
function applySuggestion(s) {
  if (s.kind === "task") {
    const t = { id: uid(), title: s.title, estimate: s.estimate || "", genEstimate: "" };
    project.tasks.push(t);
    if (Array.isArray(project.taskOrder)) project.taskOrder.push(t.id);
    return true;
  }
  if (s.kind === "note") {
    if (!Array.isArray(project.notes)) project.notes = [];
    project.notes.push({ id: uid(), text: s.text });
    return true;
  }
  if (s.kind === "link") {
    const from = resolveTaskId(s.from), to = resolveTaskId(s.to);
    if (!from || !to || from === to) { toast("Couldn't match those tasks — add them first."); return false; }
    if (!Array.isArray(project.links)) project.links = [];
    if (project.links.some((l) => (l.from === from && l.to === to) || (l.from === to && l.to === from))) { toast("Those are already linked."); return false; }
    project.links.push({ id: uid(), from, to, type: s.type });
    return true;
  }
  return false;
}
function findSuggestion(id) {
  for (const m of project.chat || []) { const s = (m.suggestions || []).find((x) => x.id === id); if (s) return s; }
  return null;
}
function applySuggestionById(id) {
  const s = findSuggestion(id);
  if (!s || s.applied) return;
  pushHistory();
  if (applySuggestion(s)) { s.applied = true; SparkStore.save(project); renderProject(); renderChat(); }
  else history.pop(); // nothing changed → drop the snapshot
}
function applyAllSuggestions(msgId) {
  const m = (project.chat || []).find((x) => x.id === msgId);
  if (!m || !Array.isArray(m.suggestions)) return;
  const pending = m.suggestions.filter((s) => !s.applied);
  if (!pending.length) return;
  pushHistory();
  let any = false;
  // non-links first so link endpoints exist by the time links apply
  pending.sort((a, b) => (a.kind === "link" ? 1 : 0) - (b.kind === "link" ? 1 : 0));
  pending.forEach((s) => { if (applySuggestion(s)) { s.applied = true; any = true; } });
  if (any) { SparkStore.save(project); renderProject(); renderChat(); } else history.pop();
}

/* ---------- Recommended software ---------- */
const TOOLS_SYSTEM = `You recommend real, well-known software tools that help freelancers and small businesses execute a project. \
Prefer affordable or freemium, widely-used options. Return ONLY a single JSON object — no prose, no markdown, no code fences.`;

function toolsPrompt() {
  return `Project: ${project.projectName}\nTagline: ${project.tagline}\nBrief: ${project.brief}\n` +
    `Tasks:\n${project.tasks.map((t) => "- " + t.title).join("\n")}\n\n` +
    `Recommend 5-7 software tools that would genuinely help execute this project. Span the relevant categories ` +
    `(e.g. design, website/development, marketing, payments, analytics, project management, communication). ` +
    `Return JSON: {"tools":[{"name":"Tool name","category":"short category","why":"one short sentence on how it helps here"}]}`;
}

function toolsBlockHtml() {
  const tools = Array.isArray(project.tools) ? project.tools : [];
  if (!tools.length) {
    return `<div class="${blockCls("tools")}" data-section="tools">
      ${blockLabel("Recommended tools")}
      <button class="suggest-tools-btn" data-action="suggesttools">Suggest software for this project</button>
    </div>`;
  }
  const cards = tools.map((t) => `
    <li class="tool-card">
      <div class="tool-head">
        <a class="tool-name" href="https://www.google.com/search?q=${encodeURIComponent(t.name + " software")}" target="_blank" rel="noopener">${esc(t.name)}</a>
        ${t.category ? `<span class="tool-cat">${esc(t.category)}</span>` : ""}
      </div>
      ${t.why ? `<p class="tool-why">${esc(t.why)}</p>` : ""}
    </li>`).join("");
  return `<div class="${blockCls("tools")}" data-section="tools">
    ${blockLabel("Recommended tools", `<button class="mini-rework" data-action="suggesttools" title="Suggest again">↻</button>`)}
    <ul class="tool-list">${cards}</ul>
  </div>`;
}

async function suggestTools(btn) {
  const apiKey = getKey();
  if (!apiKey) { openSettings(); return; }
  if (btn) {
    btn.disabled = true;
    btn.classList.add("loading");
    if (btn.classList.contains("suggest-tools-btn")) btn.textContent = "Finding tools…";
  }
  try {
    const text = await callClaude({ system: TOOLS_SYSTEM, user: toolsPrompt(), apiKey, maxTokens: 800 });
    const parsed = extractJson(text);
    const tools = asArray(parsed.tools)
      .map((t) => (typeof t === "string" ? { name: t, category: "", why: "" } : { name: t.name || "", category: t.category || "", why: t.why || "" }))
      .filter((t) => t.name);
    if (!tools.length) throw new Error("No tools came back — try again.");
    project.tools = tools;
    renderProject();
  } catch (err) {
    toast(err.message || "Couldn't suggest tools.");
    renderProject(); // restore the button
  }
}

/* ---------- Spark lenses ---------- */
const LENS_SYSTEM = `You are Spark. Given a project, produce a focused, genuinely useful take through a specific lens, \
for a freelancer or small creative team. Respond in concise markdown — short headings, tight paragraphs, and bullets. No preamble, no sign-off.`;

const LENS_ICONS = {
  pitch: `<svg class="lens-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--c-task)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V3M5 4h11l-2 4 2 4H5"/></svg>`,
  budget: `<svg class="lens-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--c-money)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M6 21v-7M12 21V9M18 21v-4"/></svg>`,
  lean: `<svg class="lens-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--c-question)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22V12M12 12c0-4 3-6 7-6 0 4-3 6-7 6zM12 14c0-3-3-5-7-5 0 3 3 5 7 5z"/></svg>`,
  premortem: `<svg class="lens-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--c-risk)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg>`,
};
const LENSES = [
  { id: "pitch", label: "Pitch", instruction: "Write a persuasive client-facing pitch. Include a one-line hook, a 2-3 sentence elevator pitch, 3 key selling points as bullets, and a short closing call to action." },
  { id: "budget", label: "Budget", instruction: "Write a budget breakdown. Group the work into phases, give effort per phase, list key assumptions, and end with a total effort and a cost range." },
  { id: "lean", label: "Lean MVP", instruction: "Describe the leanest viable version: the single core thing to ship first, what to cut for now, the fastest path to launch, and a rough timeline." },
  { id: "premortem", label: "Pre-mortem", instruction: "Run a pre-mortem: imagine it's 3 months later and the project failed. List the most likely failure modes, an early warning sign for each, and one concrete mitigation." },
];

function lensPrompt(lens) {
  return `Project: ${project.projectName}\nTagline: ${project.tagline}\nBrief: ${project.brief}\n` +
    `Tasks:\n${project.tasks.map((t) => "- " + t.title + (t.estimate ? ` (${t.estimate})` : "")).join("\n")}\n` +
    `Open questions:\n${project.openQuestions.map((q) => "- " + q.text).join("\n")}\n` +
    `Risks:\n${project.risks.map((r) => "- " + r.text).join("\n")}\n\n${lens.instruction}`;
}

// Minimal, safe markdown → HTML (headings, bullets, bold/italic/code, paragraphs).
function mdToHtml(md) {
  const e = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const inline = (s) => e(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+?)\*/g, "$1<em>$2</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
  let html = "", inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  for (const raw of String(md || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)/))) { closeList(); const lv = Math.min(m[1].length + 2, 6); html += `<h${lv}>${inline(m[2])}</h${lv}>`; }
    else if ((m = line.match(/^[-*]\s+(.*)/)) || (m = line.match(/^\d+\.\s+(.*)/))) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(m[1])}</li>`; }
    else { closeList(); html += `<p>${inline(line)}</p>`; }
  }
  closeList();
  return html;
}

function lensBarHtml() {
  return `<div class="lens-bar">
    <span class="lens-bar-label">Lenses</span>
    ${LENSES.map((l) => `<button class="lens-chip${project.lenses && project.lenses[l.id] ? " has" : ""}" data-action="lens" data-lens="${l.id}">${LENS_ICONS[l.id] || ""} ${esc(l.label)}</button>`).join("")}
  </div>`;
}

let lensModalEl = null, lensCurrent = null;
function closeLensModal() { if (lensModalEl) { lensModalEl.remove(); lensModalEl = null; lensCurrent = null; } }
function showLensModal(lens, content) {
  lensCurrent = lens.id;
  if (!lensModalEl) {
    lensModalEl = document.createElement("div");
    lensModalEl.className = "modal-backdrop lens-backdrop";
    document.body.appendChild(lensModalEl);
    lensModalEl.addEventListener("click", (e) => { if (e.target === lensModalEl) closeLensModal(); });
  }
  lensModalEl.innerHTML = `
    <div class="modal lens-modal">
      <div class="lens-head">
        <h2 class="lens-title">${LENS_ICONS[lens.id] || ""} ${esc(lens.label)}</h2>
        <button class="ghost-btn small" data-x="close">Close</button>
      </div>
      <div class="lens-body">${content
        ? mdToHtml(content)
        : `<div class="lens-loading"><span class="thinking-spark"><svg width="14" height="14" viewBox="0 0 24 24"><path d="M13.5 2L6 13.2h4.4L10.2 22l7.8-11.6h-4.6z" fill="currentColor"/></svg></span> Generating ${esc(lens.label.toLowerCase())}…</div>`}</div>
      <div class="lens-foot">
        <button class="ghost-btn small" data-x="regen" ${content ? "" : "disabled"}>↻ Regenerate</button>
        <button class="spark-btn small" data-x="copy" ${content ? "" : "disabled"}>⧉ Copy</button>
      </div>
    </div>`;
  lensModalEl.querySelector('[data-x="close"]').onclick = closeLensModal;
  lensModalEl.querySelector('[data-x="regen"]').onclick = () => openLens(lens.id, true);
  lensModalEl.querySelector('[data-x="copy"]').onclick = async () => {
    try { await navigator.clipboard.writeText((project.lenses && project.lenses[lens.id]) || ""); toast("Copied"); }
    catch (_) { toast("Clipboard unavailable here."); }
  };
}

async function openLens(lensId, regen) {
  const lens = LENSES.find((l) => l.id === lensId);
  if (!lens || !project) return;
  if (!project.lenses) project.lenses = {};
  if (project.lenses[lensId] && !regen) { showLensModal(lens, project.lenses[lensId]); return; }

  const apiKey = getKey();
  if (!apiKey) { openSettings(); return; }
  showLensModal(lens, null); // loading
  const bodyEl = lensModalEl && lensModalEl.querySelector(".lens-body");
  try {
    const full = await callClaudeStream({
      system: withTone(LENS_SYSTEM), user: lensPrompt(lens), apiKey, maxTokens: 900,
      onToken: (_, acc) => {
        if (lensCurrent === lensId && bodyEl) { bodyEl.innerHTML = `<div class="lens-stream">${esc(acc)}</div>`; bodyEl.scrollTop = bodyEl.scrollHeight; }
      },
    });
    project.lenses[lensId] = full.trim();
    SparkStore.save(project);
    if (lensCurrent === lensId) showLensModal(lens, project.lenses[lensId]); // final rendered markdown
    refreshLensChips();
  } catch (err) {
    closeLensModal();
    toast(err.message || "Couldn't generate that lens.");
  }
}

function refreshLensChips() {
  document.querySelectorAll(".lens-chip").forEach((c) => {
    c.classList.toggle("has", !!(project.lenses && project.lenses[c.dataset.lens]));
  });
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLensModal(); });

/* ---------- Chat refine (whole-project, context-aware) ---------- */
function refinePrompt(instruction) {
  const current = {
    projectName: project.projectName,
    tagline: project.tagline,
    brief: project.brief,
    tasks: project.tasks.map((t) => ({ title: t.title, estimate: t.estimate })),
    openQuestions: project.openQuestions.map((q) => q.text),
    risks: project.risks.map((r) => r.text),
  };
  return `Here is the current project as JSON:\n${JSON.stringify(current, null, 2)}\n\n` +
    `The user wants this change: "${instruction}"\n\n` +
    `Apply only that change (plus naturally-required adjustments) and keep everything else exactly as-is. ` +
    `Return the COMPLETE updated project as a single JSON object with the same shape, plus a "summary" field ` +
    `describing what changed in one short sentence:\n` +
    `{ "projectName": "...", "tagline": "...", "brief": "...", "tasks": [{"title":"...","estimate":"..."}], ` +
    `"openQuestions": ["..."], "risks": ["..."], "summary": "..." }`;
}

async function refine(instruction) {
  if (busy || !project) return;
  const apiKey = getKey();
  if (!apiKey) { openSettings(); return; }

  if (!Array.isArray(project.chat)) project.chat = [];
  pushHistory();
  project.chat.push({ id: uid(), role: "user", text: instruction });
  ideaInput.value = "";
  syncComposerHeight();
  busy = true;
  sparkBtn.disabled = true;
  renderChat(); // user message + thinking indicator

  let failure = null;
  try {
    const text = await callClaude({ system: withLearning(REFINE_SYSTEM), user: refinePrompt(instruction), apiKey, maxTokens: MAX_TOKENS });
    const parsed = extractJson(text);
    const updated = buildProject(project.idea, parsed);
    updated.id = project.id;
    updated.createdAt = project.createdAt;
    updated.idea = project.idea;
    updated.chat = project.chat;
    updated.tools = project.tools; // keep recommended software across a refine
    updated.tone = project.tone;
    updated.collapsed = project.collapsed; // keep section collapse state
    updated.taskOrder = updated.tasks.map((t) => t.id); // refresh default order for the new generation
    updated.mapView = project.mapView; // keep pan/zoom
    updated.notes = project.notes || []; // map notes are the user's own — always survive a refine
    // Typed links reference item ids, which a refine regenerates; remap by
    // category + index (same heuristic as positions) and drop any that die.
    if (Array.isArray(project.links) && project.links.length) {
      const idMap = { root: "root" };
      const mapIds = (o, n) => n.forEach((it, i) => { if (o[i]) idMap[o[i].id] = it.id; });
      mapIds(project.tasks, updated.tasks);
      mapIds(project.openQuestions, updated.openQuestions);
      mapIds(project.risks, updated.risks);
      (project.notes || []).forEach((x) => { idMap[x.id] = x.id; });
      updated.links = project.links
        .map((l) => ({ ...l, from: idMap[l.from], to: idMap[l.to] }))
        .filter((l) => l.from && l.to);
    }
    // Carry map positions across the refine by matching category + index, so the
    // map doesn't scramble; new/extra items fall back to default layout.
    if (project.map) {
      const om = project.map, carried = {};
      if (om.root) carried.root = om.root;
      const carry = (oldArr, newArr) => newArr.forEach((it, i) => {
        const p = oldArr[i] && om[oldArr[i].id];
        if (p) carried[it.id] = p;
      });
      carry(project.tasks, updated.tasks);
      carry(project.openQuestions, updated.openQuestions);
      carry(project.risks, updated.risks);
      carry(project.notes || [], updated.notes);
      updated.map = carried;
    }
    project = updated;
    project.chat.push({ id: uid(), role: "assistant", text: parsed.summary || "Updated the project." });
  } catch (err) {
    failure = err;
    project.chat.push({ id: uid(), role: "assistant", kind: "error", text: (err && err.message) || "Couldn't apply that — try rephrasing." });
  }

  busy = false;
  sparkBtn.disabled = false;
  renderProject();   // live refresh of the right side (persists)
  renderChat();
  if (failure) toast(failure.message || "Refine failed.");
}

/* ---------- API call ---------- */
function apiError(status, detail) {
  if (status === 401) return new Error("Invalid API key. Open Settings (top right) and check your key.");
  if (status === 429) return new Error("Rate limited by the API. Wait a moment and try again.");
  return new Error(`API error ${status}${detail ? ": " + detail : ""}.`);
}

// Streamed variant — calls onToken(delta, accumulated) as text arrives; returns the full text.
async function callClaudeStream({ system, user, apiKey, maxTokens, onToken }) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: getModel(), max_tokens: maxTokens || MAX_TOKENS, system, messages: [{ role: "user", content: user }], stream: true }),
  });
  if (!res.ok || !res.body) {
    let detail = ""; try { detail = (await res.json())?.error?.message || ""; } catch (_) { /* non-JSON */ }
    throw apiError(res.status, detail);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let ev; try { ev = JSON.parse(data); } catch (_) { continue; }
      if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
        full += ev.delta.text;
        if (onToken) onToken(ev.delta.text, full);
      } else if (ev.type === "error") {
        throw new Error((ev.error && ev.error.message) || "Streaming error.");
      }
    }
  }
  return full;
}

async function callClaude({ system, user, apiKey, maxTokens }) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: getModel(),
      max_tokens: maxTokens || MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch (_) { /* non-JSON body */ }
    if (res.status === 401) throw new Error("Invalid API key. Open Settings (top right) and check your key.");
    if (res.status === 429) throw new Error("Rate limited by the API. Wait a moment and try again.");
    throw new Error(`API error ${res.status}${detail ? ": " + detail : ""}.`);
  }

  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === "text");
  if (!block) throw new Error("The model returned no text content.");
  return block.text;
}

/* ---------- Clarify-first ---------- */
const CLARIFY_SYSTEM = `You are Spark. Before building a project plan, you ask a few sharp clarifying questions. \
Return ONLY a single JSON object — no prose, no markdown — of the form {"questions": ["...", "..."]}.`;

function clarifyPrompt(idea) {
  return `Project idea: "${idea}"\n\nAsk 2-4 concise clarifying questions that would most improve the plan ` +
    `(audience, scope, budget, timeline, key constraints). Return JSON: {"questions": ["...", "..."]}`;
}

clarifyToggle.addEventListener("change", () => {
  clarifyEnabled = clarifyToggle.checked;
  try { localStorage.setItem("spark.clarify", clarifyEnabled ? "1" : "0"); } catch (_) {}
});

async function askClarify(idea) {
  const apiKey = getKey();
  if (!apiKey) { openSettings(); return; }
  clarify = { idea, questions: [], chat: [{ id: uid(), role: "user", text: idea }] };
  busy = true; sparkBtn.disabled = true;
  updateComposer();
  renderChat(); // idea + thinking indicator
  try {
    const text = await callClaude({ system: withTone(CLARIFY_SYSTEM), user: clarifyPrompt(idea), apiKey, maxTokens: 400 });
    const qs = asArray(extractJson(text).questions).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 4);
    if (!qs.length) throw new Error("no questions");
    clarify.questions = qs;
    clarify.chat.push({
      id: uid(), role: "assistant",
      text: "A few quick questions to sharpen this:\n" + qs.map((q, i) => `${i + 1}. ${q}`).join("\n") + "\n\nAnswer what you can, then hit Build.",
    });
    busy = false; sparkBtn.disabled = false;
    updateComposer(); renderChat();
  } catch (_) {
    // Clarify failed — fall back to building directly from the idea.
    clarify = null;
    busy = false; sparkBtn.disabled = false;
    updateComposer();
    generateProject(idea, idea, null);
  }
}

function answerClarify(answers) {
  if (!clarify) return;
  const { idea, questions } = clarify;
  const userPrompt = `${idea}\n\nThe user was asked these clarifying questions:\n` +
    questions.map((q, i) => `${i + 1}. ${q}`).join("\n") +
    `\n\nTheir answers / notes: ${answers || "(none — use sensible defaults)"}\n\nBuild the plan using this.`;
  const seed = [...clarify.chat, { id: uid(), role: "user", text: answers || "(build with sensible defaults)" }];
  clarify = null;
  ideaInput.value = ""; syncComposerHeight(); clearDraft();
  generateProject(idea, userPrompt, seed);
}

// Core generation shared by spark and the clarify answer step.
async function generateProject(idea, userPrompt, chatSeed, keepId, keepCreated) {
  const apiKey = getKey();
  if (!apiKey) { openSettings(); return; }
  busy = true; sparkBtn.disabled = true; show("loading");
  let failure = null;
  try {
    const text = await callClaude({ system: withLearning(SYSTEM_PROMPT), user: userPrompt || idea, apiKey, maxTokens: MAX_TOKENS });
    let parsed;
    try { parsed = extractJson(text); }
    catch (_) { throw new Error("The AI's response wasn't valid JSON. Try sparking again."); }
    project = buildProject(idea, parsed);
    project.tone = currentTone;
    project.taskOrder = project.tasks.map((t) => t.id);
    if (keepId) { project.id = keepId; project.createdAt = keepCreated; }
    project.chat = chatSeed || [
      { id: uid(), role: "user", text: idea },
      { id: uid(), role: "assistant", text: "Sparked it — here's your project. Tell me what to refine on the left." },
    ];
    history = [];
    ideaInput.value = ""; syncComposerHeight(); clearDraft();
  } catch (err) { failure = err; }
  busy = false; sparkBtn.disabled = false;
  updateComposer();
  if (failure) showError(failure.message || "Unexpected error. Please try again.");
  else { renderProject(); renderChat(); }
}

/* ---------- Full spark (initial generate, or Re-spark from idea) ---------- */
async function spark(presetIdea) {
  if (busy) return;
  const idea = (typeof presetIdea === "string" ? presetIdea : ideaInput.value).trim();
  if (!idea) { ideaInput.focus(); return; }

  const apiKey = getKey();
  if (!apiKey) { openSettings(); return; }

  // Clarify-first: for a brand-new idea (not a re-spark), ask questions before building.
  if (typeof presetIdea !== "string" && !project && clarifyEnabled && !clarify) { return askClarify(idea); }

  // Re-spark keeps the same project identity; a brand-new idea creates a new one.
  const keepId = (typeof presetIdea === "string" && project) ? project.id : null;
  const keepCreated = keepId ? project.createdAt : null;

  busy = true;
  sparkBtn.disabled = true;
  show("loading");

  let failure = null;
  try {
    const text = await callClaude({ system: withLearning(SYSTEM_PROMPT), user: idea, apiKey, maxTokens: MAX_TOKENS });
    let parsed;
    try { parsed = extractJson(text); }
    catch (_) { throw new Error("The AI's response wasn't valid JSON. Try sparking again."); }
    project = buildProject(idea, parsed);
    project.tone = currentTone;
    project.taskOrder = project.tasks.map((t) => t.id); // default order to reset to
    if (keepId) { project.id = keepId; project.createdAt = keepCreated; }
    project.chat = [
      { id: uid(), role: "user", text: idea },
      { id: uid(), role: "assistant", text: "Sparked it — here's your project. Tell me what to refine on the left." },
    ];
    history = [];
    if (typeof presetIdea !== "string") { ideaInput.value = ""; syncComposerHeight(); clearDraft(); }
  } catch (err) {
    failure = err;
  }

  busy = false;
  sparkBtn.disabled = false;
  updateComposer();
  if (failure) showError(failure.message || "Unexpected error. Please try again.");
  else { renderProject(); renderChat(); }
}

/* ---------- Workspace (saved projects) ---------- */
function relTime(ts) {
  if (!ts) return "";
  const d = Date.now() - ts, m = 60000, h = 3600000, day = 86400000;
  if (d < m) return "just now";
  if (d < h) return Math.floor(d / m) + "m ago";
  if (d < day) return Math.floor(d / h) + "h ago";
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function refreshProjectMenu() {
  const items = SparkStore.list();
  projectsEmpty.hidden = items.length > 0;
  projectList.innerHTML = items.map((e) => `
    <li class="dropdown-item ${project && e.id === project.id ? "active" : ""}">
      <button class="dropdown-open" data-id="${e.id}">
        <span class="dd-name">${esc(e.name)}</span>
        <span class="dd-date">${relTime(e.updatedAt)}</span>
      </button>
      <button class="dropdown-dup" data-id="${e.id}" title="Duplicate project" aria-label="Duplicate project"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>
      <button class="dropdown-ren" data-id="${e.id}" title="Rename project" aria-label="Rename project"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4L8 20H4v-4z"/></svg></button>
      <button class="dropdown-del" data-id="${e.id}" title="Delete project" aria-label="Delete project">×</button>
    </li>`).join("");
  // search: only worth showing once the list is long; re-apply any active filter
  const search = el("projectSearch");
  if (search) {
    search.hidden = items.length < 6;
    if (search.hidden) search.value = "";
    else if (search.value) filterProjectMenu(search.value);
  }
}

function filterProjectMenu(q) {
  const needle = q.trim().toLowerCase();
  let visible = 0;
  projectList.querySelectorAll(".dropdown-item").forEach((li) => {
    const hit = !needle || li.querySelector(".dd-name").textContent.toLowerCase().includes(needle);
    li.hidden = !hit;
    if (hit) visible++;
  });
  projectsEmpty.hidden = visible > 0;
  projectsEmpty.textContent = visible ? "No saved projects yet." : "No projects match.";
}

function duplicateProject(id) {
  const src = SparkStore.load(id);
  if (!src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid();
  copy.createdAt = Date.now();
  copy.projectName = (src.projectName || "Untitled project") + " (copy)";
  SparkStore.save(copy);
  openProject(copy.id);
  toast("Duplicated — you're now in the copy.");
}

function toggleProjectMenu(open) {
  const willOpen = open ?? projectsDropdown.hidden;
  if (willOpen) refreshProjectMenu();
  projectsDropdown.hidden = !willOpen;
  projectsBtn.setAttribute("aria-expanded", String(willOpen));
}

function resetComposer() {
  ideaInput.value = "";
  syncComposerHeight();
  updateComposer();
}

function newProject() {
  project = null;
  clarify = null;
  history = [];
  viewMode = "doc";
  resetComposer();
  restoreDraft(); // an unfinished idea comes back
  show("empty");
  renderChat();
  toggleProjectMenu(false);
  ideaInput.focus();
}

function openProject(id) {
  const p = SparkStore.load(id);
  if (!p) return;
  project = p;
  clarify = null;
  history = [];
  viewMode = "doc";
  resetComposer();
  suppressPersist = true;   // opening shouldn't re-save / reorder
  renderProject();
  suppressPersist = false;
  renderChat();
  toggleProjectMenu(false);
}

function deleteProject(id) {
  if (!window.confirm("Delete this project? This can't be undone.")) return;
  SparkStore.remove(id);
  if (project && project.id === id) {
    const next = SparkStore.latest();
    if (next) openProject(next.id);
    else { project = null; history = []; resetComposer(); show("empty"); renderChat(); }
  }
  refreshProjectMenu();
}

projectsBtn.addEventListener("click", () => toggleProjectMenu());
newProjectBtn.addEventListener("click", newProject);
projectList.addEventListener("click", (e) => {
  const ren = e.target.closest(".dropdown-ren");
  if (ren) { e.stopPropagation(); renameProject(ren.dataset.id); return; }
  const dup = e.target.closest(".dropdown-dup");
  if (dup) { e.stopPropagation(); duplicateProject(dup.dataset.id); return; }
  const del = e.target.closest(".dropdown-del");
  if (del) { e.stopPropagation(); deleteProject(del.dataset.id); return; }
  const open = e.target.closest(".dropdown-open");
  if (open) openProject(open.dataset.id);
});
const projectSearchInput = el("projectSearch");
if (projectSearchInput) projectSearchInput.addEventListener("input", () => filterProjectMenu(projectSearchInput.value));

function renameProject(id) {
  const entry = SparkStore.list().find((x) => x.id === id);
  const name = window.prompt("Rename project", entry ? entry.name : "");
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  if (project && project.id === id) {
    project.projectName = trimmed;
    SparkStore.save(project);
    renderProject();
  } else {
    const p = SparkStore.load(id);
    if (p) { p.projectName = trimmed; SparkStore.save(p); }
  }
  refreshProjectMenu();
}
document.addEventListener("click", (e) => {
  if (!projectsDropdown.hidden && !e.target.closest(".projects-menu")) toggleProjectMenu(false);
});

/* ---------- Init ---------- */
(function init() {
  const shared = importFromHash();
  if (shared) {
    project = shared;
    project.chat = [{ id: uid(), role: "assistant", text: "Imported a shared project — refine it or make it your own." }];
    history = [];
    SparkStore.save(project);
    renderProject();
    try { window.history.replaceState(null, "", location.pathname); } catch (_) { /* ignore */ }
  } else {
    const last = SparkStore.latest();
    if (last) {
      project = last;
      suppressPersist = true;
      renderProject();
      suppressPersist = false;
    } else {
      show("empty");
    }
  }
  if (clarifyToggle) clarifyToggle.checked = clarifyEnabled;
  resetComposer();
  restoreDraft(); // unfinished fresh-idea draft survives a reload (empty boot only)
  renderChat();
  refreshProjectMenu();
})();
