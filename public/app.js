const $ = (selector) => document.querySelector(selector);
const idea = $("#idea");
const generate = $("#generate");
const activity = $("#activity");
const songsNode = $("#songs");
const liveToggle = $("#liveGeneration");
let budget = null;
let busy = false;

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

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function refreshBudget() {
  const body = await api("/api/budget");
  budget = body.budget;
  const modeBadge = $("#modeBadge");
  modeBadge.textContent = budget.testMode ? "$0 TEST MODE" : "LIVE MODE";
  modeBadge.className = `badge ${budget.testMode ? "test" : "live"}`;
  $("#budgetBadge").textContent = `${budget.paidGenerationsToday}/${budget.maxDailyPaidGenerations} paid generations today`;
  liveToggle.disabled = budget.testMode;
  if (budget.testMode) {
    liveToggle.checked = false;
    $("#modeHelp").textContent = "Backend is locked to free test providers. No Suno credits can be spent.";
  } else {
    $("#modeHelp").textContent = `Live mode can spend Suno credits. ${budget.paidGenerationRemaining} paid generation(s) remain under today's cap.`;
  }
  updateGenerateLabel();
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
  const live = liveToggle.checked && !budget?.testMode;
  generate.textContent = live ? "Generate live song" : "Generate free test song";
}

idea.addEventListener("input", () => { $("#charCount").textContent = `${idea.value.length} / 4000`; });
liveToggle.addEventListener("change", updateGenerateLabel);
$("#refresh").addEventListener("click", refreshAll);

generate.addEventListener("click", async () => {
  if (busy) return;
  const value = idea.value.trim();
  if (value.length < 12) { activity.textContent = "Add more detail to the song idea."; idea.focus(); return; }
  const live = liveToggle.checked && !budget?.testMode;
  if (live && !confirm("Live generation can spend SunoAPI credits. Continue with one generation request?")) {
    liveToggle.checked = false; updateGenerateLabel(); return;
  }
  busy = true; generate.disabled = true;
  activity.textContent = live ? "Running free lyric QA before the paid music call…" : "Generating with $0 test providers…";
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
