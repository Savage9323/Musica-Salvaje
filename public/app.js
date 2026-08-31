const status = document.querySelector("#status");
const songs = document.querySelector("#songs");
const idea = document.querySelector("#idea");

async function refresh() {
  const response = await fetch("/api/songs");
  const body = await response.json();
  songs.innerHTML = (body.songs || []).map((song) => `
    <article class="song">
      <div><strong>${escapeHtml(song.title || song.catalogId)}</strong><span>${escapeHtml(song.status)}</span></div>
      <small>${escapeHtml(song.catalogId)} · quality ${song.qualityScore ?? "—"}</small>
      <p>${escapeHtml(song.idea)}</p>
      ${song.audioUrls?.[0] ? `<audio controls src="${song.audioUrls[0]}"></audio>` : ""}
    </article>
  `).join("") || "<p>No songs yet.</p>";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
}

document.querySelector("#generate").addEventListener("click", async () => {
  const value = idea.value.trim();
  if (value.length < 12) {
    status.textContent = "Enter a more detailed song idea.";
    return;
  }
  status.textContent = "Generating with $0 test providers...";
  const response = await fetch("/api/songs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idea: value, testOnly: true })
  });
  const body = await response.json();
  status.textContent = JSON.stringify(body, null, 2);
  await refresh();
});

document.querySelector("#refresh").addEventListener("click", refresh);
refresh();
