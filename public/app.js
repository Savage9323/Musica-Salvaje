const $ = (selector) => document.querySelector(selector);
const idea = $("#idea");
const generate = $("#generate");
const activity = $("#activity");
const songsNode = $("#songs");
const liveToggle = $("#liveGeneration");
const adminPanel = $("#adminPanel");
const adminToken = $("#adminToken");
let budget = null;
let liveBudget = null;
let busy = false;

adminToken.value = sessionStorage.getItem("msAdminToken") || "";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}
function safeUrl(value) {
  try {
    const url = new URL(String(value), location.origin);
    if (!/^https?:$/.test(url.protocol)) return "";
    return escapeHtml(url.href);
  } catch { return ""; }
}
function statusClass(status) {
  const s = String(status || "").toLowerCase();
  if (["audio_ready", "video_ready", "ready_to_publish", "published"].includes(s)) return s === "published" ? "published" : "ready";
  if (s.includes("failed")) return "failed";
  if (s.includes("rejected")) return "rejected";
  if (s.includes("blocked")) return "blocked";
  return "";
}
function readableStatus(status) { return String(status || "UNKNOWN").replaceAll("_", " "); }
function currentToken() { return adminToken.value.trim(); }
function authorizedHeaders(source = {}) {
  const headers = new Headers(source);
  const token = currentToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: authorizedHeaders(options.headers || {}) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    const message = response.status === 401 ? "Admin token required to unlock this production Studio." : (body.error || `HTTP ${response.status}`);
    throw new Error(message);
  }
  return body;
}

async function refreshBudget() {
  try {
    const body = await api("/api/budget");
    budget = body.budget;
    const modeBadge = $("#modeBadge");
    modeBadge.textContent = budget.testMode ? "$0 TEST MODE" : "LIVE MODE";
    modeBadge.className = `badge ${budget.testMode ? "test" : "live"}`;
    adminPanel.hidden = budget.testMode;

    if (budget.testMode) {
      liveBudget = null;
      $("#budgetBadge").textContent = "$0 providers active";
      liveToggle.disabled = true;
      liveToggle.checked = false;
      $("#modeHelp").textContent = "Backend is locked to free test providers. No Suno credits can be spent.";
    } else {
      const live = await api("/api/live-budget");
      liveBudget = live;
      const ledger = live.ledger || {};
      $("#budgetBadge").textContent = `${ledger.dailyUsed ?? 0}/${live.maxDaily} today · ${ledger.monthlyUsed ?? 0}/${live.maxMonthly} month`;
      liveToggle.disabled = !live.liveEnabled;
      if (!live.liveEnabled) liveToggle.checked = false;
      $("#modeHelp").textContent = live.liveEnabled
        ? `Paid generation is unlocked behind the serialized budget gate. ${Math.max(0, live.maxDaily - (ledger.dailyUsed ?? 0) - (ledger.dailyReserved ?? 0))} daily slot(s) remain.`
        : "Production backend is online, but paid generation remains locked by LIVE_GENERATION_ENABLED.";
    }
    updateGenerateLabel();
  } catch (error) {
    budget = null;
    liveBudget = null;
    adminPanel.hidden = false;
    liveToggle.checked = false;
    liveToggle.disabled = true;
    $("#modeBadge").textContent = "ADMIN REQUIRED";
    $("#modeBadge").className = "badge live";
    $("#budgetBadge").textContent = "Locked";
    $("#modeHelp").textContent = error.message;
    updateGenerateLabel();
    throw error;
  }
}

function renderSongs(list) {
  $("#songCount").textContent = `${list.length} ${list.length === 1 ? "song" : "songs"}`;
  if (!list.length) {
    songsNode.innerHTML = $("#emptyTemplate").innerHTML;
    return;
  }
  songsNode.innerHTML = list.map((song) => {
    const cover = safeUrl(song.coverUrl);
    const audio = (song.audioUrls || []).map((url, i) => {
      const safe = safeUrl(url);
      return safe ? `<div class="track"><span>TAKE ${i + 1}</span><audio controls preload="none" src="${safe}"></audio></div>` : "";
    }).join("");
    const error = song.error ? `<p class="song-idea error-text">${escapeHtml(song.error)}</p>` : "";
    return `<article class="song">
      <div class="song-main">
        ${cover ? `<img class="cover" src="${cover}" alt="${escapeHtml(song.title || "Song cover")}" loading="lazy" />` : `<div class="cover cover-fallback">MS</div>`}
        <div>
          <div class="song-head"><h3>${escapeHtml(song.title || song.catalogId)}</h3><span class="status ${statusClass(song.status)}">${escapeHtml(readableStatus(song.status))}</span></div>
          <div class="song-meta">${escapeHtml(song.catalogId)} · <span class="score">${song.qualityScore == null ? "—" : `${escapeHtml(song.qualityScore)}/10`}</span> · ${escapeHtml(song.lyricsProvider || "pending")}</div>
          <p class="song-idea">${escapeHtml(song.idea)}</p>${error}
        </div>
      </div>
      ${audio ? `<div class="tracks">${audio}</div>` : ""}
      ${song.lyrics ? `<details><summary>Lyrics & Suno style</summary><pre class="lyrics">${escapeHtml(song.lyrics)}\n\nSTYLE\n${escapeHtml(song.stylePrompt || "")}</pre></details>` : ""}
    </article>`;
  }).join("");
}

async function refreshCatalog() {
  try {
    const body = await api("/api/songs?limit=50");
    renderSongs(body.songs || []);
  } catch (error) {
    songsNode.innerHTML = `<div class="empty error-text">${escapeHtml(error.message)}</div>`;
  }
}

async function refreshAll() {
  await Promise.allSettled([refreshBudget(), refreshCatalog()]);
}

function updateGenerateLabel() {
  const live = liveToggle.checked && budget && !budget.testMode && liveBudget?.liveEnabled;
  generate.textContent = live ? "Generate live song" : "Generate free test song";
}

idea.addEventListener("input", () => { $("#charCount").textContent = `${idea.value.length} / 4000`; });
liveToggle.addEventListener("change", updateGenerateLabel);
$("#refresh").addEventListener("click", refreshAll);
$("#unlock").addEventListener("click", async () => {
  const token = currentToken();
  if (!token) { activity.textContent = "Enter the admin token first."; adminToken.focus(); return; }
  sessionStorage.setItem("msAdminToken", token);
  activity.textContent = "Unlocking this browser tab…";
  await refreshAll();
  if (budget) activity.textContent = "Studio unlocked for this tab.";
});
$("#clearToken").addEventListener("click", async () => {
  sessionStorage.removeItem("msAdminToken");
  adminToken.value = "";
  budget = null;
  liveBudget = null;
  activity.textContent = "Admin token cleared from this tab.";
  await refreshAll();
});
adminToken.addEventListener("keydown", (event) => { if (event.key === "Enter") $("#unlock").click(); });

generate.addEventListener("click", async () => {
  if (busy) return;
  const value = idea.value.trim();
  if (value.length < 12) { activity.textContent = "Add more detail to the song idea."; idea.focus(); return; }
  const live = liveToggle.checked && budget && !budget.testMode && liveBudget?.liveEnabled;
  if (live && !confirm("Live generation can spend SunoAPI credits. Continue with one budget-reserved generation request?")) {
    liveToggle.checked = false; updateGenerateLabel(); return;
  }
  busy = true; generate.disabled = true;
  activity.textContent = live ? "Running lyric QA and budget checks before the paid music call…" : "Generating with $0 test providers…";
  try {
    const body = await api("/api/songs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idea: value,
        testOnly: !live,
        language: $("#language").value,
        genre: $("#genre").value.trim() || "regional Mexican",
        mood: $("#mood").value.split(",").map((v) => v.trim()).filter(Boolean),
        instrumental: $("#instrumental").checked
      })
    });
    activity.textContent = body.duplicate ? `Existing session returned: ${body.song.catalogId}` : `Created ${body.song.catalogId}: ${readableStatus(body.song.status)}`;
    await refreshAll();
  } catch (error) {
    activity.textContent = error.message;
  } finally {
    busy = false; generate.disabled = false; updateGenerateLabel();
  }
});

refreshAll();
setInterval(() => { if (!document.hidden) refreshCatalog(); }, 15000);
