/* =============================================================================
   Mission WhiteCoat Lite v0.9 — Application Logic
   Vanilla JavaScript. No frameworks. Talks directly to Supabase.
   ============================================================================= */

/* -----------------------------------------------------------------------------
   0. CONFIGURATION
   ---------------------------------------------------------------------------
   Fill these in with your own Supabase project values before deploying.
   Find them in: Supabase Dashboard > Project Settings > API.
   The anon key is safe to expose in frontend code — Row Level Security (set
   up in supabase.sql) is what actually protects the data.
   ----------------------------------------------------------------------------- */
const SUPABASE_URL = "https://netkoayosrwmuvlhqevd.supabase.co"; // e.g. https://xxxxxxxx.supabase.co
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5ldGtvYXlvc3J3bXV2bGhxZXZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2NDQyMDEsImV4cCI6MjA5OTIyMDIwMX0._jeyEDrtET7Lrx5PlZoEUs1PgmA5TqzZP6gSBPF3CQo";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* -----------------------------------------------------------------------------
   1. GLOBAL STATE
   ----------------------------------------------------------------------------- */
const state = {
  session: null,
  admin: null,          // row from public.admins for the logged-in user
  players: [],          // all players
  battleDay: null,      // today's battle_days row
  matches: [],          // today's battle_matches rows, sorted by match_order
  currentView: "dashboard",
  lastDeletedPlayer: null,
  playerSearchTerm: "",
  saveTimers: {},        // debounce handles keyed by string id
  actionModalMode: null,  // 'move' | 'swap'
  actionModalContext: null,
  realtimeChannels: [],
  pollHandle: null,
  participantsDirty: false,   // true when local participant_ids has unsaved changes
  participantsSaving: false,  // true while a save request is in-flight
  participantsQueuedSave: false, // true when changes arrived during an in-flight save
};

/* -----------------------------------------------------------------------------
   2. SMALL UTILITIES
   ----------------------------------------------------------------------------- */

function qs(sel, root = document) { return root.querySelector(sel); }
function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function initials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}

/* ---------------------------------------------------------------------------
   Hours + Minutes helpers (FIX 2 / FIX 3 / FIX 4)

   Study time is still stored internally as a single decimal-hours number
   (e.g. 8.5) — this is unchanged and requires no database migration, so any
   existing record (8.5, 7.75, 6.333333, etc.) keeps working automatically.
   These helpers only translate between that stored decimal and the separate
   whole-number Hours / Minutes fields shown in the UI.
   --------------------------------------------------------------------------- */

// decimal hours -> { h: "8", m: "30" } for populating the two input fields.
// Also used for backward compatibility: an old record like 8.5 converts to
// { h: "8", m: "30" } automatically, with no migration needed.
function decimalToHM(decimalHours) {
  if (decimalHours === null || decimalHours === undefined || decimalHours === "") return { h: "", m: "" };
  const total = Number(decimalHours);
  if (Number.isNaN(total)) return { h: "", m: "" };

  let h = Math.floor(total);
  let m = Math.round((total - h) * 60);
  if (m >= 60) { m -= 60; h += 1; } // guard against floating-point rounding pushing minutes to 60
  if (m < 0) m = 0;
  return { h: String(h), m: String(m) };
}

// Whole-number Hours + Minutes fields -> a single decimal-hours number for
// storage (e.g. 8h 30m -> 8.5, 6h 20m -> 6.333333...). Winner/draw
// calculations continue to use this decimal value, exactly as before.
// Returns null only when BOTH fields are empty (i.e. nothing entered yet).
function hmToDecimal(hoursStr, minutesStr) {
  const hasHours = hoursStr !== "" && hoursStr !== null && hoursStr !== undefined;
  const hasMinutes = minutesStr !== "" && minutesStr !== null && minutesStr !== undefined;
  if (!hasHours && !hasMinutes) return null;

  let h = hasHours ? parseInt(hoursStr, 10) : 0;
  let m = hasMinutes ? parseInt(minutesStr, 10) : 0;
  if (Number.isNaN(h)) h = 0;
  if (Number.isNaN(m)) m = 0;

  h = Math.max(0, h);           // Hours: integer, minimum 0
  m = Math.max(0, Math.min(59, m)); // Minutes: integer, range 0–59

  return h + m / 60;
}

// decimal hours -> display string, e.g. 8.5 -> "8h 30m", 9 -> "9h".
// Used everywhere study time is shown as read-only text (Results, History,
// Copy Results) per FIX 3.
function formatHM(decimalHours) {
  if (decimalHours === null || decimalHours === undefined || decimalHours === "") return "";
  const { h, m } = decimalToHM(decimalHours);
  if (h === "" && m === "") return "";
  const hours = h === "" ? 0 : parseInt(h, 10);
  const minutes = m === "" ? 0 : parseInt(m, 10);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function todayLocalISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function friendlyDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function statusLabel(status) {
  return { not_generated: "Not Generated", battles_generated: "Battles Generated", results_published: "Results Published" }[status] || status;
}

function debounce(key, fn, delay = 500) {
  clearTimeout(state.saveTimers[key]);
  state.saveTimers[key] = setTimeout(fn, delay);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* -----------------------------------------------------------------------------
   3. TOASTS
   ----------------------------------------------------------------------------- */

function toast(message, type = "default", duration = 3200) {
  const container = qs("#toast-container");
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  container.appendChild(node);
  setTimeout(() => node.remove(), duration);
}

/* -----------------------------------------------------------------------------
   4. MODALS
   ----------------------------------------------------------------------------- */

function showBackdrop() { qs("#modal-backdrop").classList.remove("hidden"); }
function hideBackdrop() { qs("#modal-backdrop").classList.add("hidden"); }

function openModal(id) { showBackdrop(); qs(id).classList.remove("hidden"); }
function closeModal(id) { qs(id).classList.add("hidden"); hideBackdrop(); }

function confirmDialog(title, message) {
  return new Promise((resolve) => {
    qs("#confirm-title").textContent = title;
    qs("#confirm-message").textContent = message;
    openModal("#confirm-modal");

    const okBtn = qs("#confirm-ok");
    const cancelBtn = qs("#confirm-cancel");

    function cleanup(result) {
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      closeModal("#confirm-modal");
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
  });
}

qs("#modal-backdrop").addEventListener("click", () => {
  qsa(".modal").forEach((m) => m.classList.add("hidden"));
  hideBackdrop();
});

/* -----------------------------------------------------------------------------
   5. AUTHENTICATION
   ----------------------------------------------------------------------------- */

async function handleLoginSubmit(e) {
  e.preventDefault();
  const email = qs("#login-email").value.trim();
  const password = qs("#login-password").value;
  const btn = qs("#login-btn");
  const errorEl = qs("#login-error");

  errorEl.classList.add("hidden");
  btn.disabled = true;
  qs(".btn-label", btn).classList.add("hidden");
  qs(".spinner", btn).classList.remove("hidden");

  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;

    const { data: adminRow, error: adminErr } = await sb
      .from("admins")
      .select("*")
      .eq("id", data.user.id)
      .maybeSingle();

    if (adminErr || !adminRow) {
      await sb.auth.signOut();
      throw new Error("This account is not registered as an admin.");
    }

    state.session = data.session;
    state.admin = adminRow;
    await bootApp();
  } catch (err) {
    errorEl.textContent = err.message || "Login failed. Please check your credentials.";
    errorEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    qs(".btn-label", btn).classList.remove("hidden");
    qs(".spinner", btn).classList.add("hidden");
  }
}

async function handleLogout() {
  const ok = await confirmDialog("Log Out", "Are you sure you want to log out?");
  if (!ok) return;
  teardownRealtime();
  await sb.auth.signOut();
  state.session = null;
  state.admin = null;
  qs("#app-shell").classList.add("hidden");
  qs("#login-screen").classList.remove("hidden");
  qs("#login-form").reset();
}

async function checkExistingSession() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return false;

  const { data: adminRow, error } = await sb
    .from("admins")
    .select("*")
    .eq("id", data.session.user.id)
    .maybeSingle();

  if (error || !adminRow) {
    await sb.auth.signOut();
    return false;
  }

  state.session = data.session;
  state.admin = adminRow;
  return true;
}

/* -----------------------------------------------------------------------------
   6. NAVIGATION
   ----------------------------------------------------------------------------- */

function goToView(viewName) {
  state.currentView = viewName;
  qsa(".view").forEach((v) => v.classList.remove("active"));
  qs(`#view-${viewName}`).classList.add("active");
  qsa(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === viewName));
  qs(".sidebar").classList.remove("open");
  renderCurrentView();
}

function renderCurrentView() {
  if (state.currentView === "dashboard") renderDashboard();
  if (state.currentView === "players") renderPlayers();
  if (state.currentView === "today") renderToday();
  if (state.currentView === "battles") renderBattles();
  if (state.currentView === "results") renderResults();
  if (state.currentView === "history") renderHistory();
}

/* -----------------------------------------------------------------------------
   7. DATA LOADING
   ----------------------------------------------------------------------------- */

async function loadPlayers() {
  const { data, error } = await sb.from("players").select("*").order("name", { ascending: true });
  if (error) { toast("Failed to load players: " + error.message, "error"); return; }
  state.players = data;
}

async function loadActiveBattleDay() {
  // FIX 1 — Resume Unfinished Battle Day.
  // A battle day stays "active" across midnight until Publish Results is
  // clicked. On every load we resume the most recent battle_day that hasn't
  // been published yet, rather than always looking up today's calendar date
  // (which would silently strand yesterday's unpublished battles). Only when
  // no unfinished day exists do we fall back to creating/loading today's row.
  let { data: unfinished, error: unfinishedErr } = await sb
    .from("battle_days")
    .select("*")
    .neq("status", "results_published")
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (unfinishedErr) { toast("Failed to load battle day: " + unfinishedErr.message, "error"); return; }

  let data = unfinished;

  if (!data) {
    const today = todayLocalISO();
    const { data: todays, error: fetchErr } = await sb.from("battle_days").select("*").eq("date", today).maybeSingle();
    if (fetchErr) { toast("Failed to load today's data: " + fetchErr.message, "error"); return; }
    data = todays;

    if (!data) {
      const { data: created, error: insertErr } = await sb
        .from("battle_days")
        .insert({ date: today })
        .select()
        .single();
      if (insertErr) { toast("Failed to create today's record: " + insertErr.message, "error"); return; }
      data = created;
    }
  }

  // Guard against a lost update: if there is a local participant-selection
  // change that hasn't been confirmed saved yet (or a save is currently
  // in-flight), keep the local participant_ids instead of letting a
  // realtime event or the 30s poll fallback overwrite it with a
  // not-yet-caught-up copy from the server. Every other field still refreshes
  // normally so status/date stay in sync.
  if (state.battleDay && state.battleDay.id === data.id && (state.participantsDirty || state.participantsSaving)) {
    data.participant_ids = state.battleDay.participant_ids;
  }

  state.battleDay = data;
}

async function loadMatches() {
  if (!state.battleDay) return;
  const { data, error } = await sb
    .from("battle_matches")
    .select("*")
    .eq("battle_day_id", state.battleDay.id)
    .order("match_order", { ascending: true });
  if (error) { toast("Failed to load battles: " + error.message, "error"); return; }
  state.matches = data;
}

// Keeps battle_days.status accurate whenever the set of matches changes
// (e.g. a battle is deleted, or Generate Battles is clicked). It deliberately
// never auto-changes a day that has already been published — "Results
// Published" is a manual, explicit state that only Publish Results sets, and
// only a fresh Publish click should move a day out of it.
async function syncBattleDayStatusIfNeeded() {
  if (!state.battleDay) return;
  if (state.battleDay.status === "results_published") return;
  const desired = state.matches.length > 0 ? "battles_generated" : "not_generated";
  if (state.battleDay.status !== desired) {
    const { error } = await sb.from("battle_days").update({ status: desired }).eq("id", state.battleDay.id);
    if (!error) state.battleDay.status = desired;
  }
}

async function refreshAll() {
  await loadPlayers();
  await loadActiveBattleDay();
  await loadMatches();
  await syncBattleDayStatusIfNeeded();
  renderCurrentView();
}

/* -----------------------------------------------------------------------------
   8. DASHBOARD
   ----------------------------------------------------------------------------- */

function renderDashboard() {
  const today = todayLocalISO();
  qs("#dashboard-date").textContent = friendlyDate(today);
  qs("#stat-date").textContent = friendlyDate(today).split(",")[0];
  qs("#stat-total-players").textContent = state.players.length;
  qs("#stat-participants").textContent = participantPlayers().length;
  qs("#stat-status").textContent = state.battleDay ? statusLabel(state.battleDay.status) : "—";
}

/* -----------------------------------------------------------------------------
   9. PLAYER MANAGER
   ----------------------------------------------------------------------------- */

function filteredPlayers() {
  const term = state.playerSearchTerm.trim().toLowerCase();
  if (!term) return state.players;
  return state.players.filter((p) => p.name.toLowerCase().includes(term));
}

function renderPlayers() {
  const list = qs("#players-list");
  const empty = qs("#players-empty");
  const players = filteredPlayers();

  if (players.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    empty.querySelector("p:last-child").textContent = state.playerSearchTerm
      ? "No players match your search."
      : "No players yet. Add your first player to get started.";
    return;
  }
  empty.classList.add("hidden");

  list.innerHTML = players.map((p) => `
    <div class="data-row" data-id="${p.id}">
      <div class="data-row-main">
        <div class="player-avatar">${escapeHtml(initials(p.name))}</div>
        <div>
          <div class="data-row-title">${escapeHtml(p.name)}</div>
          <div class="data-row-sub">Added ${new Date(p.created_at).toLocaleDateString()}</div>
        </div>
      </div>
      <div class="data-row-actions">
        <button class="btn btn-ghost btn-edit-player" data-id="${p.id}">Edit</button>
        <button class="btn btn-danger btn-delete-player" data-id="${p.id}">Delete</button>
      </div>
    </div>
  `).join("");

  qsa(".btn-edit-player", list).forEach((btn) =>
    btn.addEventListener("click", () => openPlayerModal(btn.dataset.id))
  );
  qsa(".btn-delete-player", list).forEach((btn) =>
    btn.addEventListener("click", () => deletePlayer(btn.dataset.id))
  );
}

function openPlayerModal(editId = null) {
  qs("#player-edit-id").value = editId || "";
  if (editId) {
    const player = state.players.find((p) => p.id === editId);
    qs("#player-modal-title").textContent = "Edit Player";
    qs("#player-name-input").value = player ? player.name : "";
  } else {
    qs("#player-modal-title").textContent = "Add Player";
    qs("#player-name-input").value = "";
  }
  openModal("#player-modal");
  qs("#player-name-input").focus();
}

async function savePlayerModal() {
  const name = qs("#player-name-input").value.trim();
  const editId = qs("#player-edit-id").value;
  if (!name) { toast("Please enter a name.", "warn"); return; }

  if (editId) {
    const { error } = await sb.from("players").update({ name }).eq("id", editId);
    if (error) { toast("Update failed: " + error.message, "error"); return; }
    toast("Player updated.", "success");
  } else {
    const { error } = await sb.from("players").insert({ name });
    if (error) {
      if (error.code === "23505") toast("A player with that name already exists.", "warn");
      else toast("Add failed: " + error.message, "error");
      return;
    }
    toast("Player added.", "success");
  }

  closeModal("#player-modal");
  await refreshAll();
}

async function deletePlayer(id) {
  const player = state.players.find((p) => p.id === id);
  if (!player) return;
  const ok = await confirmDialog("Delete Player", `Delete "${player.name}"? You can undo this immediately after.`);
  if (!ok) return;

  const { error } = await sb.from("players").delete().eq("id", id);
  if (error) { toast("Delete failed: " + error.message, "error"); return; }

  // Remove the deleted id from today's participant list, if present, so it
  // doesn't linger as a "ghost" selection.
  if (state.battleDay && state.battleDay.participant_ids.includes(id)) {
    const cleaned = state.battleDay.participant_ids.filter((pid) => pid !== id);
    await sb.from("battle_days").update({ participant_ids: cleaned }).eq("id", state.battleDay.id);
  }

  state.lastDeletedPlayer = player;
  qs("#undo-delete-btn").disabled = false;
  toast(`Deleted "${player.name}".`, "success");
  await refreshAll();
}

async function undoLastDelete() {
  const player = state.lastDeletedPlayer;
  if (!player) return;
  const { error } = await sb.from("players").insert({ name: player.name });
  if (error) {
    if (error.code === "23505") toast("That player already exists again.", "warn");
    else toast("Undo failed: " + error.message, "error");
    return;
  }
  toast(`Restored "${player.name}".`, "success");
  state.lastDeletedPlayer = null;
  qs("#undo-delete-btn").disabled = true;
  await refreshAll();
}

function exportPlayers() {
  if (state.players.length === 0) { toast("No players to export.", "warn"); return; }
  const csv = "Name\n" + state.players.map((p) => `"${p.name.replace(/"/g, '""')}"`).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `whitecoat-players-${todayLocalISO()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Player list exported.", "success");
}

async function importPlayers() {
  const raw = qs("#import-textarea").value;
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) { toast("Paste at least one name.", "warn"); return; }

  const seen = new Set();
  const rows = [];
  for (const name of lines) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ name });
  }

  const { data, error } = await sb
    .from("players")
    .upsert(rows, { onConflict: "name_key", ignoreDuplicates: true })
    .select();

  if (error) { toast("Import failed: " + error.message, "error"); return; }

  const importedCount = data ? data.length : 0;
  const skipped = rows.length - importedCount;
  toast(`Imported ${importedCount} player${importedCount === 1 ? "" : "s"}${skipped > 0 ? `, skipped ${skipped} duplicate${skipped === 1 ? "" : "s"}` : ""}.`, "success");

  qs("#import-textarea").value = "";
  closeModal("#import-modal");
  await refreshAll();
}

/* -----------------------------------------------------------------------------
   10. TODAY'S PARTICIPANTS
   ----------------------------------------------------------------------------- */

function renderToday() {
  if (state.battleDay) {
    const activeIsToday = state.battleDay.date === todayLocalISO();
    qs("#today-date-label").textContent = activeIsToday
      ? friendlyDate(state.battleDay.date)
      : `${friendlyDate(state.battleDay.date)} — resumed unfinished battle day`;
  }
  const list = qs("#participants-list");
  const empty = qs("#participants-empty");

  if (state.players.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    updateParticipantCount();
    return;
  }
  empty.classList.add("hidden");

  const selected = new Set(state.battleDay ? state.battleDay.participant_ids : []);

  list.innerHTML = state.players.map((p) => `
    <label class="checkbox-item ${selected.has(p.id) ? "checked" : ""}" data-id="${p.id}">
      <input type="checkbox" ${selected.has(p.id) ? "checked" : ""} data-id="${p.id}" />
      <span>${escapeHtml(p.name)}</span>
    </label>
  `).join("");

  qsa("input[type=checkbox]", list).forEach((cb) =>
    cb.addEventListener("change", () => toggleParticipant(cb.dataset.id, cb.checked))
  );

  updateParticipantCount();
}

function updateParticipantCount() {
  // Uses participantPlayers() rather than the raw participant_ids array so a
  // player deleted elsewhere doesn't inflate the count with a "ghost" id.
  qs("#participant-count").textContent = participantPlayers().length;
}

/* ---------------------------------------------------------------------------
   Participant selection saving — race-condition-safe.

   Every entry point (checkbox toggle, Select All, Clear Selection) mutates
   the local state.battleDay.participant_ids array SYNCHRONOUSLY and
   immediately, so rapid clicks can never overwrite each other locally — each
   click always builds on the very latest in-memory selection.

   Persisting that selection to Supabase is handled by saveParticipants(),
   which is serialized: only one UPDATE request is ever in flight at a time.
   If local changes happen while a save is already running, they're captured
   by the participantsDirty flag and automatically flushed in a follow-up
   save the instant the in-flight one finishes — so no overlapping requests
   are ever sent, and the very latest selection always wins.

   loadActiveBattleDay() (see above) also refuses to let a realtime event or
   the 30s poll fallback clobber participant_ids while participantsDirty or
   participantsSaving is true, so an in-progress local edit can never be
   stomped by a stale server read arriving mid-save.
   --------------------------------------------------------------------------- */

function scheduleParticipantSave(immediate = false) {
  clearTimeout(state.saveTimers.participants);
  if (immediate) {
    saveParticipants();
  } else {
    // Coalesce bursts of rapid clicks into a single save ~250ms after the
    // last one, rather than firing a request per click.
    state.saveTimers.participants = setTimeout(saveParticipants, 250);
  }
}

async function saveParticipants() {
  if (!state.battleDay) return;
  if (!state.participantsDirty) return; // nothing unsaved — no-op, avoids redundant requests

  if (state.participantsSaving) {
    // A save is already in flight. Don't send an overlapping request —
    // just note that another save is needed once this one finishes.
    state.participantsQueuedSave = true;
    return;
  }

  state.participantsSaving = true;
  const battleDayId = state.battleDay.id;
  const payload = state.battleDay.participant_ids.slice(); // snapshot of the latest selection
  state.participantsDirty = false; // this payload is about to become the saved state

  try {
    const { error } = await sb
      .from("battle_days")
      .update({ participant_ids: payload })
      .eq("id", battleDayId);
    if (error) {
      toast("Failed to save selection: " + error.message, "error");
      state.participantsDirty = true; // retry needed
    }
  } catch (err) {
    toast("Failed to save selection: " + err.message, "error");
    state.participantsDirty = true;
  } finally {
    state.participantsSaving = false;
    if (state.participantsQueuedSave || state.participantsDirty) {
      // More changes arrived while this request was in flight (or it
      // failed) — flush them immediately, still one request at a time.
      state.participantsQueuedSave = false;
      saveParticipants();
    }
  }
}

function toggleParticipant(playerId, checked) {
  if (!state.battleDay) return;
  const set = new Set(state.battleDay.participant_ids);
  if (checked) set.add(playerId); else set.delete(playerId);
  state.battleDay.participant_ids = Array.from(set);
  state.participantsDirty = true;

  const item = qs(`.checkbox-item[data-id="${playerId}"]`);
  if (item) item.classList.toggle("checked", checked);
  updateParticipantCount();

  scheduleParticipantSave();
}

async function selectAllParticipants() {
  if (!state.battleDay) return;
  state.battleDay.participant_ids = state.players.map((p) => p.id);
  state.participantsDirty = true;
  toast("All players selected.", "success");
  renderToday();
  scheduleParticipantSave(true);
}

async function clearSelection() {
  if (!state.battleDay) return;
  const ok = await confirmDialog("Clear Selection", "Remove all players from today's participants?");
  if (!ok) return;
  state.battleDay.participant_ids = [];
  state.participantsDirty = true;
  toast("Selection cleared.", "success");
  renderToday();
  scheduleParticipantSave(true);
}

/* -----------------------------------------------------------------------------
   11. BATTLE GENERATOR
   ----------------------------------------------------------------------------- */

function participantPlayers() {
  if (!state.battleDay) return [];
  const ids = new Set(state.battleDay.participant_ids);
  return state.players.filter((p) => ids.has(p.id));
}

function lockedMatches() { return state.matches.filter((m) => m.locked); }
function unlockedMatches() { return state.matches.filter((m) => !m.locked); }

function unassignedPlayers() {
  const assignedIds = new Set();
  state.matches.forEach((m) => m.players.forEach((p) => assignedIds.add(p.player_id)));
  return participantPlayers().filter((p) => !assignedIds.has(p.id));
}

function buildMatchGroups(playerList) {
  // playerList: array of {id, name}. Returns array of arrays (groups of 2,
  // with the last group being 3 when the count is odd). For n >= 2 this
  // always produces fully-valid groups. The only way to get a stray group of
  // exactly 1 is when the caller passes exactly 1 player in — that can
  // legitimately happen if locked battles have already claimed players in
  // multiples of 2 or 3, leaving a single un-pairable straggler. Callers must
  // check for and handle groups of length 1 (see generateBattles).
  const list = playerList.slice();
  const n = list.length;
  if (n === 0) return [];
  if (n === 1) return [list];

  const groups = [];
  const isOdd = n % 2 !== 0;
  let tripleGroup = null;
  if (isOdd) tripleGroup = list.splice(list.length - 3, 3);
  while (list.length >= 2) groups.push(list.splice(0, 2));
  if (tripleGroup) groups.push(tripleGroup);
  return groups;
}

function toMatchPlayers(group) {
  return group.map((p) => ({ player_id: p.id, name: p.name, hours: null, result: null }));
}

async function generateBattles() {
  if (!state.battleDay) return;
  const participants = participantPlayers();
  if (participants.length < 2 && lockedMatches().length === 0) {
    toast("Select at least 2 participants before generating battles.", "warn");
    return;
  }

  const btn = qs("#generate-battles-btn");
  btn.disabled = true;
  try {
    const locked = lockedMatches().slice().sort((a, b) => a.match_order - b.match_order);
    const lockedIds = new Set();
    locked.forEach((m) => m.players.forEach((p) => lockedIds.add(p.player_id)));

    const pool = shuffle(participants.filter((p) => !lockedIds.has(p.id)));
    const groups = buildMatchGroups(pool);

    // A group of length 1 means a single participant couldn't be paired
    // because locked battles absorbed the rest of the pool. Rather than
    // creating an invalid 1-player "battle", leave them unassigned and warn.
    const validGroups = groups.filter((g) => g.length >= 2);
    const stranded = groups.filter((g) => g.length === 1);
    if (stranded.length > 0) {
      const names = stranded.map((g) => g[0].name).join(", ");
      toast(`${names} could not be paired due to locked battles and stayed unassigned.`, "warn", 5000);
    }

    // Remove all currently unlocked matches for today, then insert fresh ones.
    const toDelete = unlockedMatches().map((m) => m.id);
    if (toDelete.length > 0) {
      const { error: delErr } = await sb.from("battle_matches").delete().in("id", toDelete);
      if (delErr) throw delErr;
    }

    // Renumber locked matches to a contiguous 0..n-1 sequence first (their
    // relative order is preserved), then continue numbering the newly
    // generated battles after them. This avoids match_order collisions that
    // could otherwise occur when locked battles have non-contiguous orders.
    let order = 0;
    for (const m of locked) {
      if (m.match_order !== order) {
        const { error: reErr } = await sb.from("battle_matches").update({ match_order: order }).eq("id", m.id);
        if (reErr) throw reErr;
      }
      order++;
    }

    const rows = validGroups.map((group) => ({
      battle_day_id: state.battleDay.id,
      match_order: order++,
      players: toMatchPlayers(group),
      locked: false,
    }));

    if (rows.length > 0) {
      const { error: insErr } = await sb.from("battle_matches").insert(rows);
      if (insErr) throw insErr;
    }

    toast("Battles generated.", "success");
    await refreshAll(); // status is recalculated centrally in refreshAll()
    goToView("battles");
  } catch (err) {
    toast("Failed to generate battles: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function regenerateAll() {
  const ok = await confirmDialog("Regenerate All", "This reshuffles every unlocked battle. Locked battles are kept. Continue?");
  if (!ok) return;
  await generateBattles();
}

async function toggleLock(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) return;
  const { error } = await sb.from("battle_matches").update({ locked: !match.locked }).eq("id", matchId);
  if (error) { toast("Failed: " + error.message, "error"); return; }
  toast(match.locked ? "Battle unlocked." : "Battle locked.", "success");
  await refreshAll();
}

async function deleteBattle(matchId) {
  const ok = await confirmDialog("Delete Battle", "Delete this battle? Its players become unassigned and can be reassigned manually or picked up by Regenerate All.");
  if (!ok) return;
  const { error } = await sb.from("battle_matches").delete().eq("id", matchId);
  if (error) { toast("Failed: " + error.message, "error"); return; }
  toast("Battle deleted.", "success");
  await refreshAll();
}

async function regenerateOneMatch(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) return;
  if (match.locked) { toast("Unlock this battle before regenerating it.", "warn"); return; }

  const others = unlockedMatches().filter((m) => m.id !== matchId);

  if (others.length === 0) {
    // Nothing to swap with — just shuffle this match's own player order.
    const shuffled = shuffle(match.players).map((p) => ({ ...p, hours: null, result: null }));
    const { error } = await sb.from("battle_matches").update({ players: shuffled }).eq("id", matchId);
    if (error) { toast("Failed: " + error.message, "error"); return; }
    toast("Battle reshuffled.", "success");
    await refreshAll();
    return;
  }

  const otherMatch = others[Math.floor(Math.random() * others.length)];
  const thisIdx = Math.floor(Math.random() * match.players.length);
  const otherIdx = Math.floor(Math.random() * otherMatch.players.length);

  const thisPlayers = match.players.map((p) => ({ ...p, hours: null, result: null }));
  const otherPlayers = otherMatch.players.map((p) => ({ ...p, hours: null, result: null }));

  const tmp = thisPlayers[thisIdx];
  thisPlayers[thisIdx] = { ...otherPlayers[otherIdx] };
  otherPlayers[otherIdx] = { ...tmp };

  const { error: err1 } = await sb.from("battle_matches").update({ players: thisPlayers }).eq("id", matchId);
  const { error: err2 } = await sb.from("battle_matches").update({ players: otherPlayers }).eq("id", otherMatch.id);
  if (err1 || err2) { toast("Failed to regenerate battle.", "error"); return; }

  toast("Battle regenerated.", "success");
  await refreshAll();
}

function openSwapModal(matchId, playerId) {
  const match = state.matches.find((m) => m.id === matchId);
  const player = match.players.find((p) => p.player_id === playerId);
  if (!match || !player) return;

  const otherOptions = [];
  state.matches.forEach((m) => {
    if (m.locked) return;
    m.players.forEach((p) => {
      if (!(m.id === matchId && p.player_id === playerId)) {
        otherOptions.push({ value: `${m.id}::${p.player_id}`, label: `${p.name} (Battle #${m.match_order + 1})` });
      }
    });
  });

  if (otherOptions.length === 0) { toast("No other unlocked players available to swap with.", "warn"); return; }

  qs("#move-modal-title").textContent = "Swap Player";
  qs("#move-modal-subtitle").textContent = `Swap "${player.name}" with:`;
  qs("#move-target-select").innerHTML = otherOptions.map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join("");

  state.actionModalMode = "swap";
  state.actionModalContext = { matchId, playerId };
  openModal("#move-modal");
}

function openMoveModal(matchId, playerId) {
  const match = state.matches.find((m) => m.id === matchId);
  const player = match.players.find((p) => p.player_id === playerId);
  if (!match || !player) return;

  const targets = unlockedMatches().filter((m) => m.id !== matchId);
  if (targets.length === 0) { toast("No other unlocked battle to move this player to.", "warn"); return; }

  qs("#move-modal-title").textContent = "Move Player";
  qs("#move-modal-subtitle").textContent = `Move "${player.name}" to:`;
  qs("#move-target-select").innerHTML = targets.map((m) =>
    `<option value="${m.id}">Battle #${m.match_order + 1} (${m.players.map((p) => p.name).join(" vs ")})</option>`
  ).join("");

  state.actionModalMode = "move";
  state.actionModalContext = { matchId, playerId };
  openModal("#move-modal");
}

function openAssignModal(playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const targets = unlockedMatches();
  if (!player) return;
  if (targets.length === 0) { toast("No open battle to assign this player to. Use Generate Battles instead.", "warn"); return; }

  qs("#move-modal-title").textContent = "Assign Player";
  qs("#move-modal-subtitle").textContent = `Add "${player.name}" to:`;
  qs("#move-target-select").innerHTML = targets.map((m) =>
    `<option value="${m.id}">Battle #${m.match_order + 1} (${m.players.map((p) => p.name).join(" vs ")})</option>`
  ).join("");

  state.actionModalMode = "assign";
  state.actionModalContext = { playerId };
  openModal("#move-modal");
}

async function confirmActionModal() {
  const target = qs("#move-target-select").value;
  const mode = state.actionModalMode;
  const ctx = state.actionModalContext;

  try {
    if (mode === "move") {
      const source = state.matches.find((m) => m.id === ctx.matchId);
      const dest = state.matches.find((m) => m.id === target);
      const player = source.players.find((p) => p.player_id === ctx.playerId);

      const newSourcePlayers = source.players.filter((p) => p.player_id !== ctx.playerId);
      const newDestPlayers = [...dest.players, { ...player, hours: null, result: null }];

      if (newSourcePlayers.length === 0) {
        await sb.from("battle_matches").delete().eq("id", source.id);
      } else {
        await sb.from("battle_matches").update({ players: newSourcePlayers.map((p) => ({ ...p, hours: null, result: null })) }).eq("id", source.id);
      }
      await sb.from("battle_matches").update({ players: newDestPlayers }).eq("id", dest.id);
      toast("Player moved.", "success");
    }

    if (mode === "swap") {
      const [otherMatchId, otherPlayerId] = target.split("::");
      const thisMatch = state.matches.find((m) => m.id === ctx.matchId);
      const otherMatch = state.matches.find((m) => m.id === otherMatchId);

      const thisPlayers = thisMatch.players.map((p) =>
        p.player_id === ctx.playerId
          ? { ...otherMatch.players.find((op) => op.player_id === otherPlayerId), hours: null, result: null }
          : { ...p, hours: null, result: null }
      );
      const otherPlayers = otherMatch.players.map((p) =>
        p.player_id === otherPlayerId
          ? { ...thisMatch.players.find((tp) => tp.player_id === ctx.playerId), hours: null, result: null }
          : { ...p, hours: null, result: null }
      );

      await sb.from("battle_matches").update({ players: thisPlayers }).eq("id", thisMatch.id);
      await sb.from("battle_matches").update({ players: otherPlayers }).eq("id", otherMatch.id);
      toast("Players swapped.", "success");
    }

    if (mode === "assign") {
      const dest = state.matches.find((m) => m.id === target);
      const player = state.players.find((p) => p.id === ctx.playerId);
      const newDestPlayers = [...dest.players, { player_id: player.id, name: player.name, hours: null, result: null }];
      await sb.from("battle_matches").update({ players: newDestPlayers }).eq("id", dest.id);
      toast("Player assigned.", "success");
    }
  } catch (err) {
    toast("Action failed: " + err.message, "error");
  }

  closeModal("#move-modal");
  state.actionModalMode = null;
  state.actionModalContext = null;
  await refreshAll();
}

function renderBattleCard(match, { editable, showHours }) {
  const isThree = match.players.length === 3;
  const playersHtml = match.players.map((p, idx) => {
    const resultClass = p.result === "winner" ? "winner" : p.result === "draw" ? "draw" : p.result === "loser" ? "loser" : "";
    const badge = p.result === "winner" ? '<span class="battle-player-badge">✅ Winner</span>'
      : p.result === "draw" ? '<span class="battle-player-badge">🤝 Draw</span>'
      : p.result === "loser" ? '<span class="battle-player-badge">❌ Loser</span>' : "";

    // FIX 2 / FIX 6: compact Hours + Minutes entry, editable on the
    // Study Hours & Results page. Old decimal records (e.g. 8.5) convert
    // to { h: "8", m: "30" } automatically — see decimalToHM().
    const hm = decimalToHM(p.hours);
    const timeControl = showHours
      ? `<div class="time-input-group" data-match="${match.id}" data-player="${p.player_id}">
           <input type="number" inputmode="numeric" min="0" step="1" class="time-part-input" data-match="${match.id}" data-player="${p.player_id}" data-unit="hours" value="${hm.h}" placeholder="0" />
           <span class="time-unit-label">h</span>
           <input type="number" inputmode="numeric" min="0" max="59" step="1" class="time-part-input" data-match="${match.id}" data-player="${p.player_id}" data-unit="minutes" value="${hm.m}" placeholder="0" />
           <span class="time-unit-label">m</span>
         </div>`
      : "";

    // FIX 3: read-only "8h 30m" label everywhere study time is displayed but
    // not being actively edited (Battle Generator's unassigned-player carry
    // over, and History).
    const timeLabel = (!showHours && p.hours !== null && p.hours !== undefined)
      ? `<span class="battle-player-time">${escapeHtml(formatHM(p.hours))}</span>`
      : "";

    const rowActions = editable ? `
        <button class="btn btn-ghost btn-swap-player" data-match="${match.id}" data-player="${p.player_id}" title="Swap">⇄</button>
        <button class="btn btn-ghost btn-move-player" data-match="${match.id}" data-player="${p.player_id}" title="Move">↪</button>
      ` : "";

    return `
      <div class="battle-player-row ${resultClass}">
        <span class="battle-player-name">${escapeHtml(p.name)}</span>
        <div style="display:flex;align-items:center;gap:8px;">
          ${timeControl}
          ${timeLabel}
          ${badge}
          ${rowActions}
        </div>
      </div>
      ${idx < match.players.length - 1 ? '<div class="vs-divider">VS</div>' : ""}
    `;
  }).join("");

  const actions = editable ? `
    <div class="battle-card-actions">
      <button class="btn btn-secondary btn-lock-match" data-id="${match.id}">${match.locked ? "Unlock" : "Lock"}</button>
      <button class="btn btn-ghost btn-regen-match" data-id="${match.id}" ${match.locked ? "disabled" : ""}>Regenerate</button>
      <button class="btn btn-danger btn-delete-match" data-id="${match.id}">Delete</button>
    </div>
  ` : "";

  return `
    <div class="battle-card ${match.locked ? "locked" : ""}">
      <div class="battle-card-header">
        <h4>Battle #${match.match_order + 1}${isThree ? " · Triple" : ""}</h4>
        ${match.locked ? '<span class="lock-badge">🔒 Locked</span>' : ""}
      </div>
      <div class="battle-players">${playersHtml}</div>
      ${actions}
    </div>
  `;
}

function renderBattles() {
  const list = qs("#battles-list");
  const empty = qs("#battles-empty");

  if (state.matches.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
    let html = state.matches.map((m) => renderBattleCard(m, { editable: true, showHours: false })).join("");

    const unassigned = unassignedPlayers();
    if (unassigned.length > 0) {
      html += `
        <div class="battle-card">
          <div class="battle-card-header"><h4>Unassigned Players</h4></div>
          <div class="battle-players">
            ${unassigned.map((p) => `
              <div class="battle-player-row">
                <span class="battle-player-name">${escapeHtml(p.name)}</span>
                <button class="btn btn-ghost btn-assign-player" data-player="${p.id}">Assign</button>
              </div>
            `).join("")}
          </div>
        </div>
      `;
    }
    list.innerHTML = html;

    qsa(".btn-lock-match", list).forEach((b) => b.addEventListener("click", () => toggleLock(b.dataset.id)));
    qsa(".btn-delete-match", list).forEach((b) => b.addEventListener("click", () => deleteBattle(b.dataset.id)));
    qsa(".btn-regen-match", list).forEach((b) => b.addEventListener("click", () => regenerateOneMatch(b.dataset.id)));
    qsa(".btn-swap-player", list).forEach((b) => b.addEventListener("click", () => openSwapModal(b.dataset.match, b.dataset.player)));
    qsa(".btn-move-player", list).forEach((b) => b.addEventListener("click", () => openMoveModal(b.dataset.match, b.dataset.player)));
    qsa(".btn-assign-player", list).forEach((b) => b.addEventListener("click", () => openAssignModal(b.dataset.player)));
  }
}

/* -----------------------------------------------------------------------------
   12. STUDY HOURS & RESULTS
   ----------------------------------------------------------------------------- */

function computeMatchResults(players) {
  const allFilled = players.every((p) => p.hours !== null && p.hours !== undefined && p.hours !== "");
  if (!allFilled) return players.map((p) => ({ ...p, result: null }));

  const nums = players.map((p) => Number(p.hours));
  const max = Math.max(...nums);
  const tiedCount = nums.filter((h) => h === max).length;

  return players.map((p, i) => {
    let result;
    if (tiedCount === players.length) result = "draw";
    else if (nums[i] === max) result = tiedCount > 1 ? "draw" : "winner";
    else result = "loser";
    return { ...p, result };
  });
}

function renderResults() {
  const list = qs("#results-list");
  const empty = qs("#results-empty");

  if (state.matches.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  list.innerHTML = state.matches.map((m) => renderBattleCard(m, { editable: false, showHours: true })).join("");

  qsa(".time-part-input", list).forEach((input) => {
    input.addEventListener("input", () =>
      onTimePartInput(input.dataset.match, input.dataset.player, input.dataset.unit, input.value)
    );
  });
}

function onTimePartInput(matchId, playerId, unit, rawValue) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) return;
  const player = match.players.find((p) => p.player_id === playerId);
  if (!player) return;

  // Start from whatever h/m the stored decimal currently represents, then
  // override just the part the admin edited, and re-derive the decimal.
  // Storage stays decimal (FIX 4 — no schema/migration needed); winner/draw
  // logic keeps consuming that same decimal, unchanged.
  const current = decimalToHM(player.hours);
  const hoursStr = unit === "hours" ? rawValue : current.h;
  const minutesStr = unit === "minutes" ? rawValue : current.m;
  const decimal = hmToDecimal(hoursStr, minutesStr);

  match.players = match.players.map((p) => (p.player_id === playerId ? { ...p, hours: decimal } : p));
  match.players = computeMatchResults(match.players);

  // FIX 5: auto-save, debounced so rapid keystrokes coalesce into one
  // request rather than firing on every character.
  debounce(`hours-${matchId}`, async () => {
    const { error } = await sb.from("battle_matches").update({ players: match.players }).eq("id", matchId);
    if (error) { toast("Failed to save study time: " + error.message, "error"); return; }

    // Re-render to reflect the computed winner/loser/draw badges, but keep
    // whichever hours/minutes field the admin is still focused in (and
    // cursor position) so a brief pause while typing doesn't kick focus out.
    const active = document.activeElement;
    const wasTimeInput = active && active.classList && active.classList.contains("time-part-input");
    const focusMatch = wasTimeInput ? active.dataset.match : null;
    const focusPlayer = wasTimeInput ? active.dataset.player : null;
    const focusUnit = wasTimeInput ? active.dataset.unit : null;
    const selectionStart = wasTimeInput ? active.selectionStart : null;

    renderResults();

    if (wasTimeInput) {
      const restored = qs(`.time-part-input[data-match="${focusMatch}"][data-player="${focusPlayer}"][data-unit="${focusUnit}"]`);
      if (restored) {
        restored.focus();
        if (selectionStart !== null && restored.setSelectionRange) {
          try { restored.setSelectionRange(selectionStart, selectionStart); } catch (e) { /* number inputs may not support this in all browsers */ }
        }
      }
    }
  }, 500);
}

async function publishResults() {
  if (state.matches.length === 0) { toast("No battles to publish yet.", "warn"); return; }

  const incomplete = state.matches.some((m) => m.players.some((p) => p.hours === null || p.hours === undefined || p.hours === ""));
  if (incomplete) {
    const proceed = await confirmDialog("Incomplete Hours", "Some players don't have study hours entered yet. Publish anyway?");
    if (!proceed) return;
  }

  const snapshot = state.matches.map((m) => ({
    match_order: m.match_order,
    players: m.players,
    locked: m.locked,
  }));

  const { error: upsertErr } = await sb
    .from("battle_results")
    .upsert(
      { battle_day_id: state.battleDay.id, date: state.battleDay.date, battles: snapshot, published_at: new Date().toISOString() },
      { onConflict: "battle_day_id" }
    );
  if (upsertErr) { toast("Publish failed: " + upsertErr.message, "error"); return; }

  const { error: statusErr } = await sb.from("battle_days").update({ status: "results_published" }).eq("id", state.battleDay.id);
  if (statusErr) { toast("Publish failed: " + statusErr.message, "error"); return; }

  toast("Results published.", "success");
  await refreshAll();
}

/* -----------------------------------------------------------------------------
   13. HISTORY
   ----------------------------------------------------------------------------- */

async function loadHistory() {
  const { data, error } = await sb.from("battle_results").select("*").order("date", { ascending: false });
  if (error) { toast("Failed to load history: " + error.message, "error"); return []; }
  return data;
}

async function renderHistory() {
  const list = qs("#history-list");
  const empty = qs("#history-empty");
  const history = await loadHistory();

  if (history.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  list.innerHTML = history.map((h) => `
    <div class="data-row" data-id="${h.id}">
      <div class="data-row-main">
        <div>
          <div class="data-row-title">${friendlyDate(h.date)}</div>
          <div class="data-row-sub">${h.battles.length} battle${h.battles.length === 1 ? "" : "s"} &middot; Published ${new Date(h.published_at).toLocaleString()}</div>
        </div>
      </div>
      <div class="data-row-actions">
        <button class="btn btn-secondary btn-view-history" data-id="${h.id}">View Details</button>
        <button class="btn btn-danger btn-delete-history" data-id="${h.id}">Delete</button>
      </div>
    </div>
  `).join("");

  qsa(".btn-view-history", list).forEach((b) =>
    b.addEventListener("click", () => viewHistoryDetail(history.find((h) => h.id === b.dataset.id)))
  );
  qsa(".btn-delete-history", list).forEach((b) =>
    b.addEventListener("click", () => deleteHistory(b.dataset.id))
  );
}

function viewHistoryDetail(record) {
  if (!record) return;
  qs("#history-detail-title").textContent = `Battle Day — ${friendlyDate(record.date)}`;
  qs("#history-detail-body").innerHTML = record.battles.map((m) =>
    renderBattleCard({ ...m, id: `hist-${m.match_order}` }, { editable: false, showHours: false })
  ).join("");
  openModal("#history-detail-modal");
}

async function deleteHistory(id) {
  const ok = await confirmDialog("Delete History", "Permanently delete this history entry? This cannot be undone.");
  if (!ok) return;
  const { error } = await sb.from("battle_results").delete().eq("id", id);
  if (error) { toast("Delete failed: " + error.message, "error"); return; }
  toast("History entry deleted.", "success");
  renderHistory();
}

/* -----------------------------------------------------------------------------
   14. COPY BUTTONS
   ----------------------------------------------------------------------------- */

async function copyToClipboard(text, successMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMsg, "success");
  } catch (err) {
    toast("Could not copy to clipboard.", "error");
  }
}

function copyTodaysBattles() {
  if (state.matches.length === 0) { toast("No battles to copy yet.", "warn"); return; }
  const lines = state.matches
    .slice()
    .sort((a, b) => a.match_order - b.match_order)
    .map((m) => m.players.map((p) => p.name).join(" 🆚 "));

  const text = `⚔ Mission WhiteCoat Lite\n\nToday's Battles\n\n${lines.join("\n")}\n\n------------------------`;
  copyToClipboard(text, "Today's battles copied to clipboard.");
}

function copyTodaysResults() {
  if (state.matches.length === 0) { toast("No results to copy yet.", "warn"); return; }
  const lines = [];
  state.matches
    .slice()
    .sort((a, b) => a.match_order - b.match_order)
    .forEach((m) => {
      m.players.forEach((p) => {
        const timeStr = formatHM(p.hours);
        let suffix = "";
        if (p.result === "winner") suffix = " ✅ Winner";
        else if (p.result === "draw") suffix = " 🤝 Draw";
        lines.push(`${p.name} — ${timeStr || "?"}${suffix}`);
      });
    });

  const text = `🏆 Today's Results\n\n${lines.join("\n")}`;
  copyToClipboard(text, "Today's results copied to clipboard.");
}

/* -----------------------------------------------------------------------------
   15. REALTIME + POLLING FALLBACK
   ----------------------------------------------------------------------------- */

function setRealtimeIndicator(status) {
  ["#realtime-dot", "#realtime-dot-desktop"].forEach((sel) => {
    const dot = qs(sel);
    if (!dot) return;
    dot.classList.remove("live", "polling");
    if (status === "live") dot.classList.add("live");
    if (status === "polling") dot.classList.add("polling");
  });
}

function setupRealtime() {
  const tables = ["players", "battle_days", "battle_matches", "battle_results"];
  let subscribedCount = 0;

  tables.forEach((table) => {
    const channel = sb
      .channel(`realtime-${table}`)
      .on("postgres_changes", { event: "*", schema: "public", table }, () => {
        refreshAll();
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          subscribedCount++;
          setRealtimeIndicator("live");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setRealtimeIndicator("polling");
        }
      });
    state.realtimeChannels.push(channel);
  });
}

function teardownRealtime() {
  state.realtimeChannels.forEach((ch) => sb.removeChannel(ch));
  state.realtimeChannels = [];
  if (state.pollHandle) clearInterval(state.pollHandle);
  state.pollHandle = null;
}

function setupPollingFallback() {
  // Runs regardless of realtime status as a safety net, per spec.
  state.pollHandle = setInterval(() => {
    if (state.session) refreshAll();
  }, 30000);
}

/* -----------------------------------------------------------------------------
   16. EVENT WIRING
   ----------------------------------------------------------------------------- */

function wireEvents() {
  qs("#login-form").addEventListener("submit", handleLoginSubmit);
  qs("#logout-btn").addEventListener("click", handleLogout);

  qsa(".nav-item").forEach((btn) => btn.addEventListener("click", () => goToView(btn.dataset.view)));
  qsa("[data-goto]").forEach((btn) => btn.addEventListener("click", () => goToView(btn.dataset.goto)));

  qs("#mobile-menu-btn").addEventListener("click", () => qs(".sidebar").classList.toggle("open"));

  // Players
  qs("#open-add-player").addEventListener("click", () => openPlayerModal());
  qs("#player-modal-cancel").addEventListener("click", () => closeModal("#player-modal"));
  qs("#player-modal-save").addEventListener("click", savePlayerModal);
  qs("#player-search").addEventListener("input", (e) => { state.playerSearchTerm = e.target.value; renderPlayers(); });
  qs("#export-players").addEventListener("click", exportPlayers);
  qs("#undo-delete-btn").addEventListener("click", undoLastDelete);

  qs("#open-import").addEventListener("click", () => openModal("#import-modal"));
  qs("#import-modal-cancel").addEventListener("click", () => closeModal("#import-modal"));
  qs("#import-modal-confirm").addEventListener("click", importPlayers);

  // Today's participants
  qs("#select-all-btn").addEventListener("click", selectAllParticipants);
  qs("#clear-selection-btn").addEventListener("click", clearSelection);

  // Battle generator
  qs("#generate-battles-btn").addEventListener("click", generateBattles);
  qs("#regenerate-all-btn").addEventListener("click", regenerateAll);
  qs("#copy-battles-btn").addEventListener("click", copyTodaysBattles);

  // Results
  qs("#publish-results-btn").addEventListener("click", publishResults);
  qs("#copy-results-btn").addEventListener("click", copyTodaysResults);

  // History
  qs("#history-detail-close").addEventListener("click", () => closeModal("#history-detail-modal"));

  // Move/Swap/Assign modal
  qs("#move-modal-cancel").addEventListener("click", () => closeModal("#move-modal"));
  qs("#move-modal-confirm").addEventListener("click", confirmActionModal);

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      qsa(".modal").forEach((m) => m.classList.add("hidden"));
      hideBackdrop();
    }
    if (state.session && (e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      goToView("players");
      qs("#player-search").focus();
    }
  });
}

/* -----------------------------------------------------------------------------
   17. BOOT
   ----------------------------------------------------------------------------- */

async function bootApp() {
  qs("#login-screen").classList.add("hidden");
  qs("#app-shell").classList.remove("hidden");

  const name = state.admin.full_name || state.admin.email.split("@")[0];
  qs("#admin-name").textContent = name;
  qs("#admin-email").textContent = state.admin.email;
  qs("#admin-avatar").textContent = initials(name);

  await refreshAll();
  setupRealtime();
  setupPollingFallback();
  goToView("dashboard");
}

async function init() {
  wireEvents();
  const hasSession = await checkExistingSession();
  if (hasSession) {
    await bootApp();
  } else {
    qs("#login-screen").classList.remove("hidden");
    qs("#app-shell").classList.add("hidden");
  }
}

document.addEventListener("DOMContentLoaded", init);
