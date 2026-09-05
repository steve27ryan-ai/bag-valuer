import express from "express";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || "claude-sonnet-5";
const PORT = process.env.PORT || 3000;
// Cost controls (overridable via env). Web searches are the biggest cost driver — each one
// pulls page content into the model as input tokens — so we cap them. Images are shrunk
// before sending too, which trims tokens and speeds uploads.
const WEB_SEARCH_MAX = Number(process.env.WEB_SEARCH_MAX_USES) || 4;
// 1536px keeps fine detail (hardware, heat stamps, silhouette) needed to tell similar models
// apart — images are token-capped by the API anyway, so this barely moves cost vs 1024.
const SEND_IMG_MAX_PX = Number(process.env.SEND_IMG_MAX_PX) || 1536;
// Reverse-image identification (Google Lens via SerpApi). When set, the photo is matched against
// Google's image index first to pin the EXACT model, which is then handed to the AI. Optional —
// without it the app still works, just relying on the AI's own identification.
const SERPAPI_KEY = (process.env.SERPAPI_KEY || "").trim();
// Shared passcode staff type in to use the app. If blank, the app is open (fine for local use).
const ACCESS_CODE = (process.env.ACCESS_CODE || "").trim();

// Optional Supabase storage of past valuations. If not configured, history is simply disabled.
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || "").trim();
const PHOTO_BUCKET = (process.env.SUPABASE_BUCKET || "bag-photos").trim();
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
    : null;

// ── Cost tracking ─────────────────────────────────────────────────
// What each valuation actually costs us, worked out from the API usage it reports.
// Rates are in USD and OVERRIDABLE via env so they can be kept in step with Anthropic's
// pricing without a code change. Defaults are standard Claude Sonnet + web-search rates —
// confirm against your current Anthropic pricing before you price the product on them.
const COST = {
  inPerM:    Number(process.env.COST_INPUT_PER_MTOK)  || 3.0,   // $/million input tokens
  outPerM:   Number(process.env.COST_OUTPUT_PER_MTOK) || 15.0,  // $/million output tokens
  searchEach:Number(process.env.COST_SEARCH_EACH)     || 0.01,  // $ per web search
  usdToEur:  Number(process.env.COST_USD_TO_EUR)      || 0.92,  // FX so totals read in €
};

// Turn one API response's usage into a cost (in both USD and EUR) plus the raw counts.
function computeCost(usage) {
  const u = usage || {};
  const inTok =
    (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const outTok = u.output_tokens || 0;
  const searches = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
  const usd =
    (inTok / 1e6) * COST.inPerM + (outTok / 1e6) * COST.outPerM + searches * COST.searchEach;
  const eur = usd * COST.usdToEur;
  return {
    input_tokens: inTok,
    output_tokens: outTok,
    web_searches: searches,
    cost_usd: Math.round(usd * 1e4) / 1e4,
    cost_eur: Math.round(eur * 1e4) / 1e4,
  };
}

// Seed staff names (used only to fill the team the first time — after that the list is
// managed in-app and stored). Set STAFF="Steve,Aoife,Niamh" to change the initial seed.
const STAFF = (process.env.STAFF || "Steve,Aoife,Niamh")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const STAFF_FILE = join(__dirname, "staff.local.json");

function localStaffRead() {
  try {
    return existsSync(STAFF_FILE) ? JSON.parse(readFileSync(STAFF_FILE, "utf8")) : [];
  } catch {
    return [];
  }
}
function localStaffWrite(a) {
  writeFileSync(STAFF_FILE, JSON.stringify(a, null, 2));
}

// Persistent, editable team list — Supabase `staff` table in prod, local file in dev.
// Seeds from the STAFF env the first time it's empty.
const staffStore = {
  async list() {
    if (supabase) {
      const { data, error } = await supabase
        .from("staff")
        .select("name")
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      let names = (data || []).map((r) => r.name);
      if (!names.length && STAFF.length) {
        await supabase.from("staff").insert(STAFF.map((n) => ({ name: n })));
        names = STAFF.slice();
      }
      return names;
    }
    let names = localStaffRead();
    if (!names.length) {
      names = STAFF.slice();
      localStaffWrite(names);
    }
    return names;
  },
  async add(name) {
    name = String(name || "").trim().slice(0, 80);
    if (!name) throw new Error("Enter a name.");
    const cur = await this.list();
    if (cur.some((n) => n.toLowerCase() === name.toLowerCase())) return cur;
    if (supabase) {
      const { error } = await supabase.from("staff").insert({ name });
      if (error) throw new Error(error.message);
    } else {
      const arr = localStaffRead();
      arr.push(name);
      localStaffWrite(arr);
    }
    return this.list();
  },
  async remove(name) {
    if (supabase) {
      const { error } = await supabase.from("staff").delete().eq("name", name);
      if (error) throw new Error(error.message);
    } else {
      localStaffWrite(localStaffRead().filter((n) => n !== name));
    }
    return this.list();
  },
};

// ── Message board ─────────────────────────────────────────────────
// Team updates (e.g. weekly sales target). Supabase `messages` table in prod, local file in dev.
const MSG_FILE = join(__dirname, "messages.local.json");
function localMsgRead() {
  try {
    return existsSync(MSG_FILE) ? JSON.parse(readFileSync(MSG_FILE, "utf8")) : [];
  } catch {
    return [];
  }
}
function localMsgWrite(a) {
  writeFileSync(MSG_FILE, JSON.stringify(a, null, 2));
}
const msgStore = {
  async list() {
    if (supabase) {
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      return data;
    }
    return localMsgRead().slice().reverse().slice(0, 50); // newest first
  },
  async add(text, author) {
    text = String(text || "").trim().slice(0, 500);
    if (!text) throw new Error("Write something first.");
    const row = {
      id: randomUUID(),
      text,
      author: (String(author || "").trim().slice(0, 80)) || null,
      created_at: new Date().toISOString(),
    };
    if (supabase) {
      const { error } = await supabase.from("messages").insert(row);
      if (error) throw new Error(error.message);
    } else {
      const arr = localMsgRead();
      arr.push(row);
      localMsgWrite(arr);
    }
    return this.list();
  },
  async remove(id) {
    if (supabase) {
      const { error } = await supabase.from("messages").delete().eq("id", id);
      if (error) throw new Error(error.message);
    } else {
      localMsgWrite(localMsgRead().filter((m) => m.id !== id));
    }
    return this.list();
  },
};

// ── Seller intakes (saved consignment slips) ──────────────────────
const INTAKES_FILE = join(__dirname, "intakes.local.json");
function localIntakesRead() {
  try {
    return existsSync(INTAKES_FILE) ? JSON.parse(readFileSync(INTAKES_FILE, "utf8")) : [];
  } catch {
    return [];
  }
}
function localIntakesWrite(a) {
  writeFileSync(INTAKES_FILE, JSON.stringify(a, null, 2));
}
const intakeStore = {
  async list() {
    if (supabase) {
      const { data, error } = await supabase
        .from("intakes")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      return data;
    }
    return localIntakesRead().slice().reverse().slice(0, 200);
  },
  async create({ consignor_name, account_number, items, created_by }) {
    const clean = (Array.isArray(items) ? items : []).slice(0, 100).map((it) => ({
      name: String((it && it.name) || "").slice(0, 300),
      price: Number(it && it.price) || 0,
      code: String((it && it.code) || "").slice(0, 4),
      pct: Number(it && it.pct) || 0,
      ours: Number(it && it.ours) || 0,
      seller: Number(it && it.seller) || 0,
    }));
    if (!clean.length) throw new Error("No items to save.");
    const row = {
      id: randomUUID(),
      consignor_name: (consignor_name || "").toString().trim().slice(0, 120) || null,
      account_number: (account_number || "").toString().trim().slice(0, 60) || null,
      items: clean,
      total_sale: clean.reduce((a, i) => a + i.price, 0),
      total_ours: clean.reduce((a, i) => a + i.ours, 0),
      total_seller: clean.reduce((a, i) => a + i.seller, 0),
      created_by: created_by || null,
      created_at: new Date().toISOString(),
    };
    if (supabase) {
      const { error } = await supabase.from("intakes").insert(row);
      if (error) throw new Error(error.message);
    } else {
      const arr = localIntakesRead();
      arr.push(row);
      localIntakesWrite(arr);
    }
    return row;
  },
  async remove(id) {
    if (supabase) {
      const { error } = await supabase.from("intakes").delete().eq("id", id);
      if (error) throw new Error(error.message);
      return true;
    }
    localIntakesWrite(localIntakesRead().filter((r) => r.id !== id));
    return true;
  },
};

// ── Task store ────────────────────────────────────────────────────
// Uses Supabase when configured (shared, always-on); falls back to a local
// JSON file so the board works fully on a dev machine with no database.
const TASKS_FILE = join(__dirname, "tasks.local.json");
const VALID_STATUS = ["todo", "doing", "done"];
const VALID_PRIORITY = ["high", "med", "low"];

function localRead() {
  try {
    return existsSync(TASKS_FILE) ? JSON.parse(readFileSync(TASKS_FILE, "utf8")) : [];
  } catch {
    return [];
  }
}
function localWrite(arr) {
  writeFileSync(TASKS_FILE, JSON.stringify(arr, null, 2));
}

function cleanTask(input, base) {
  const t = { ...(base || {}) };
  if (input.title !== undefined) t.title = String(input.title).slice(0, 300);
  if (input.assignee !== undefined) t.assignee = String(input.assignee).slice(0, 80);
  if (input.note !== undefined) t.note = input.note ? String(input.note).slice(0, 1000) : null;
  if (input.due_date !== undefined) t.due_date = input.due_date || null;
  if (input.priority !== undefined)
    t.priority = VALID_PRIORITY.includes(input.priority) ? input.priority : "med";
  if (input.status !== undefined)
    t.status = VALID_STATUS.includes(input.status) ? input.status : "todo";
  return t;
}

const MAX_TASK_IMAGES = 8;

// Turn incoming task images into stored URLs. New photos arrive as data: URIs; existing ones
// arrive as plain URLs and pass straight through. New ones are shrunk, then stored in Supabase
// (prod) or kept inline as a compact data URI (local dev, no database).
async function processTaskImages(images, taskId) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const item of images.slice(0, MAX_TASK_IMAGES)) {
    if (typeof item !== "string") continue;
    if (!item.startsWith("data:")) {
      out.push(item); // already-stored URL — keep as-is
      continue;
    }
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/i.exec(item);
    if (!m) continue;
    try {
      const resized = await sharp(Buffer.from(m[2], "base64"))
        .rotate()
        .resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
      if (supabase) {
        const path = `tasks/${taskId}/${randomUUID()}.jpg`;
        const { error } = await supabase.storage
          .from(PHOTO_BUCKET)
          .upload(path, resized, { contentType: "image/jpeg", upsert: true });
        if (error) {
          console.error("Task photo upload failed:", error.message);
          continue;
        }
        const { data: pub } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
        if (pub && pub.publicUrl) out.push(pub.publicUrl);
      } else {
        out.push("data:image/jpeg;base64," + resized.toString("base64"));
      }
    } catch (e) {
      console.error("Task photo processing failed:", e.message);
    }
  }
  return out;
}

const taskStore = {
  async list() {
    if (supabase) {
      const { data, error } = await supabase
        .from("tasks")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return data;
    }
    let arr = localRead();
    if (!arr.length) {
      arr = seedTasks();
      localWrite(arr);
    }
    return arr;
  },
  async create(input, createdBy) {
    const now = new Date().toISOString();
    const id = randomUUID();
    const row = cleanTask(input, {
      id,
      title: "Untitled task",
      assignee: STAFF[0] || "",
      note: null,
      due_date: null,
      priority: "med",
      status: "todo",
      completed_at: null,
      created_by: createdBy || null,
      created_at: now,
    });
    row.images = await processTaskImages(input.images || [], id);
    if (supabase) {
      const { data, error } = await supabase.from("tasks").insert(row).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    const arr = localRead();
    arr.push(row);
    localWrite(arr);
    return row;
  },
  async update(id, input) {
    const patch = cleanTask(input, {});
    // Stamp the completion time when a task is moved to Done; clear it if it moves back out.
    if (input.status !== undefined) {
      patch.completed_at = input.status === "done" ? new Date().toISOString() : null;
    }
    if (input.images !== undefined) patch.images = await processTaskImages(input.images, id);
    if (supabase) {
      const { data, error } = await supabase
        .from("tasks")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }
    const arr = localRead();
    const i = arr.findIndex((t) => t.id === id);
    if (i === -1) return null;
    arr[i] = { ...arr[i], ...patch };
    localWrite(arr);
    return arr[i];
  },
  async remove(id) {
    if (supabase) {
      const { error } = await supabase.from("tasks").delete().eq("id", id);
      if (error) throw new Error(error.message);
      return true;
    }
    const arr = localRead().filter((t) => t.id !== id);
    localWrite(arr);
    return true;
  },
};

// ── Daily snapshots ───────────────────────────────────────────────
// Once-a-day frozen copy of the whole board, so any past day can be
// reopened exactly as it looked. Keyed by the Dublin calendar date.
const SNAPS_FILE = join(__dirname, "snapshots.local.json");

function dublinDate(d = new Date()) {
  // en-CA formats as YYYY-MM-DD; Europe/Dublin keeps it on the shop's clock.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" }).format(d);
}

// The live board shows everything still open, plus tasks completed TODAY. A task
// finished on an earlier day drops off the board (it's preserved in that day's
// snapshot in Daily history), so the board tidies itself each morning.
function activeToday(tasks) {
  const today = dublinDate();
  return (tasks || []).filter(
    (t) => !(t.status === "done" && t.completed_at && dublinDate(new Date(t.completed_at)) < today)
  );
}
function snapsRead() {
  try {
    return existsSync(SNAPS_FILE) ? JSON.parse(readFileSync(SNAPS_FILE, "utf8")) : [];
  } catch {
    return [];
  }
}
function snapsWrite(arr) {
  writeFileSync(SNAPS_FILE, JSON.stringify(arr, null, 2));
}

const snapshotStore = {
  // Save (or refresh) today's snapshot from the live board. Called after every
  // change, so today's row always mirrors the board and freezes once the day rolls over.
  async saveToday() {
    // Snapshot the board as it actually appears today (open + completed-today),
    // matching what staff see — earlier days keep their own frozen snapshots.
    const tasks = activeToday(await taskStore.list());
    const date = dublinDate();
    const done = tasks.filter((t) => t.status === "done").length;
    const total = tasks.length;
    const row = {
      date,
      updated_at: new Date().toISOString(),
      total,
      done_count: done,
      open_count: total - done,
      data: tasks,
    };
    if (supabase) {
      const { error } = await supabase.from("task_snapshots").upsert(row, { onConflict: "date" });
      if (error) throw new Error(error.message);
      return row;
    }
    const arr = snapsRead().filter((s) => s.date !== date);
    arr.push(row);
    snapsWrite(arr);
    return row;
  },
  async list() {
    if (supabase) {
      const { data, error } = await supabase
        .from("task_snapshots")
        .select("date, updated_at, total, done_count, open_count")
        .order("date", { ascending: false });
      if (error) throw new Error(error.message);
      return data;
    }
    return snapsRead()
      .map(({ data, ...meta }) => meta)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  },
  async get(date) {
    if (supabase) {
      const { data, error } = await supabase
        .from("task_snapshots")
        .select("*")
        .eq("date", date)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data || null;
    }
    return snapsRead().find((s) => s.date === date) || null;
  },
};

// Refresh today's snapshot without letting a snapshot failure break the task write.
async function snapshotSafe() {
  try {
    await snapshotStore.saveToday();
  } catch (e) {
    console.error("Snapshot failed:", e.message);
  }
}

// ── Cash-out (daily till / Visa photos per store) ─────────────────
const CASHOUT_FILE = join(__dirname, "cashouts.local.json");
const CASHOUT_STORES = ["30", "29"];
const MAX_CASHOUT_IMAGES = 4;

function cashoutRead() {
  try {
    return existsSync(CASHOUT_FILE) ? JSON.parse(readFileSync(CASHOUT_FILE, "utf8")) : [];
  } catch {
    return [];
  }
}
function cashoutWrite(arr) {
  writeFileSync(CASHOUT_FILE, JSON.stringify(arr, null, 2));
}

// Till/Visa total photos need to stay legible, so keep them larger than task thumbnails.
// New photos arrive as data: URIs; already-stored URLs pass straight through.
async function processCashoutImages(images, date, store) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const item of images.slice(0, MAX_CASHOUT_IMAGES)) {
    if (typeof item !== "string") continue;
    if (!item.startsWith("data:")) {
      out.push(item);
      continue;
    }
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/i.exec(item);
    if (!m) continue;
    try {
      const resized = await sharp(Buffer.from(m[2], "base64"))
        .rotate()
        .resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      if (supabase) {
        const path = `cashout/${date}/${store}/${randomUUID()}.jpg`;
        const { error } = await supabase.storage
          .from(PHOTO_BUCKET)
          .upload(path, resized, { contentType: "image/jpeg", upsert: true });
        if (error) {
          console.error("Cash-out upload failed:", error.message);
          continue;
        }
        const { data: pub } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
        if (pub && pub.publicUrl) out.push(pub.publicUrl);
      } else {
        out.push("data:image/jpeg;base64," + resized.toString("base64"));
      }
    } catch (e) {
      console.error("Cash-out image processing failed:", e.message);
    }
  }
  return out;
}

const cashoutStore = {
  async listByDate(date) {
    if (supabase) {
      const { data, error } = await supabase.from("cashouts").select("*").eq("date", date);
      if (error) throw new Error(error.message);
      return data || [];
    }
    return cashoutRead().filter((r) => r.date === date);
  },
  // One row per (date, store); the frontend sends the full image set, so we replace.
  async upsert(date, store, images, note, by) {
    const now = new Date().toISOString();
    if (supabase) {
      const row = { date, store, images, note: note || null, updated_by: by || null, updated_at: now };
      const { data, error } = await supabase
        .from("cashouts")
        .upsert(row, { onConflict: "date,store" })
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }
    const arr = cashoutRead();
    const i = arr.findIndex((r) => r.date === date && r.store === store);
    const row = {
      id: i >= 0 ? arr[i].id : randomUUID(),
      date,
      store,
      images,
      note: note || null,
      updated_by: by || null,
      created_at: i >= 0 ? arr[i].created_at : now,
      updated_at: now,
    };
    if (i >= 0) arr[i] = row;
    else arr.push(row);
    cashoutWrite(arr);
    return row;
  },
  async days(limit = 30) {
    let rows;
    if (supabase) {
      const { data, error } = await supabase.from("cashouts").select("date").order("date", { ascending: false });
      if (error) throw new Error(error.message);
      rows = data || [];
    } else {
      rows = cashoutRead().sort((a, b) => (a.date < b.date ? 1 : -1));
    }
    const seen = [];
    for (const r of rows) if (!seen.includes(r.date)) seen.push(r.date);
    return seen.slice(0, limit);
  },
};

// A few sample tasks so the local board isn't empty while testing.
function seedTasks() {
  const now = new Date().toISOString();
  const day = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const mk = (title, assignee, priority, status, due) => ({
    id: randomUUID(), title, assignee, priority, status, due_date: due,
    note: null, created_by: assignee, created_at: now,
  });
  const [a = "Steve", b = "Aoife", c = "Niamh"] = STAFF;
  return [
    mk("Authenticate Chanel Boy — order #4821", a, "high", "doing", day(0)),
    mk("Approve July consignment payouts", a, "med", "todo", day(1)),
    mk("Reply to 3 authentication queries", b, "high", "todo", day(-1)),
    mk("Photograph 6 LV intakes for shoot", b, "high", "doing", day(0)),
    mk("List Gucci Marmont on Vestiaire", b, "med", "todo", day(2)),
    mk("Steam & prep bags for window display", c, "low", "todo", day(0)),
    mk("Update Dior Saddle price — market dropped", c, "med", "todo", day(3)),
    mk("Pack & ship 2 sold orders", c, "low", "done", day(-1)),
  ];
}

if (!API_KEY || API_KEY.includes("PASTE_YOUR")) {
  console.log("\n\x1b[33m⚠  No Anthropic API key found yet.\x1b[0m");
  console.log("   Open the file  .env  in this folder and paste your key after ANTHROPIC_API_KEY=");
  console.log("   Get a key at https://console.anthropic.com  →  API Keys\n");
}

const anthropic = new Anthropic({ apiKey: API_KEY });

const app = express();
const MAX_PHOTOS = 6;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: MAX_PHOTOS }, // 15 MB each
});

app.use(express.json({ limit: "25mb" })); // room for attached task photos (base64)
// Don't let phones cache the HTML — otherwise a deploy doesn't show until they clear Safari.
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) res.set("Cache-Control", "no-store");
  next();
});
app.use(express.static(join(__dirname, "public")));

// Tells the frontend whether a passcode is required, whether history is on, and the staff list.
app.get("/api/session", async (req, res) => {
  let staff = STAFF;
  try {
    staff = await staffStore.list();
  } catch (e) {
    console.error("staff list failed:", e.message);
  }
  res.json({ codeRequired: !!ACCESS_CODE, historyEnabled: true, staff });
});

// Team management.
app.get("/api/staff", requireCode, async (req, res) => {
  try {
    res.json({ staff: await staffStore.list() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/staff", requireCode, async (req, res) => {
  try {
    res.json({ staff: await staffStore.add((req.body || {}).name) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete("/api/staff/:name", requireCode, async (req, res) => {
  try {
    res.json({ staff: await staffStore.remove(req.params.name) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Message board.
app.get("/api/messages", requireCode, async (req, res) => {
  try {
    res.json({ messages: await msgStore.list() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/messages", requireCode, async (req, res) => {
  try {
    const b = req.body || {};
    res.json({ messages: await msgStore.add(b.text, b.author) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete("/api/messages/:id", requireCode, async (req, res) => {
  try {
    res.json({ messages: await msgStore.remove(req.params.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Seller intakes (saved consignment slips).
app.get("/api/intakes", requireCode, async (req, res) => {
  try {
    res.json({ intakes: await intakeStore.list() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/intakes", requireCode, async (req, res) => {
  try {
    res.json({ intake: await intakeStore.create(req.body || {}) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete("/api/intakes/:id", requireCode, async (req, res) => {
  try {
    await intakeStore.remove(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The login screen posts the typed code here to check it.
app.post("/api/check", (req, res) => {
  if (!ACCESS_CODE) return res.json({ ok: true });
  const code = (req.body && req.body.code ? String(req.body.code) : "").trim();
  res.json({ ok: code === ACCESS_CODE });
});

// Middleware: protect the (paid) analyze endpoint with the shared passcode.
function requireCode(req, res, next) {
  if (!ACCESS_CODE) return next();
  const supplied = (req.get("x-access-code") || "").trim();
  if (supplied === ACCESS_CODE) return next();
  return res.status(401).json({ error: "Wrong or missing passcode. Please sign in again." });
}

// The instruction that turns Claude into a luxury-resale appraiser.
const SYSTEM_PROMPT = `You are an expert authenticator and appraiser of pre-owned LUXURY & DESIGNER
items for a high-end resale business. You cover every category the business resells:
HANDBAGS & small leather goods, WATCHES, FINE & COSTUME JEWELLERY, SHOES/TRAINERS, READY-TO-WEAR
CLOTHING, and ACCESSORIES (sunglasses, belts, scarves, wallets). You know the current secondhand
market intimately across all of them — Vestiaire Collective, Fashionphile, The RealReal, Rebag,
Chrono24, WatchCharts, StockX, GOAT, Grailed, 1stDibs, the local Irish reseller Designer Exchange
(designerexchange.ie), and auction results (Sotheby's, Christie's).

You will be given one OR MORE photos of the SAME item from different angles. Consider them together —
later photos often confirm the model, reveal a stamp/serial, or show wear not visible in the first.
Work out the CATEGORY first (handbag / watch / jewellery / shoes / clothing / accessory), then apply
the category-appropriate checks below. Your job:

1. IDENTIFY the item as precisely as the photos allow. Give: category, brand, model/line/reference,
   and the key specs for its type —
     • Handbag: model/line, size/variant, material/leather, colour, hardware colour.
     • Watch: model + reference number, case size & material, dial colour, bracelet/strap, movement
       if determinable.
     • Jewellery: piece type, metal (and purity — 18k/750, 14k/585, platinum/PT950, silver/925),
       gemstones (type & approx carat), any maker's mark/hallmark.
     • Shoes: model, size, material/colourway.
     • Clothing: garment type, size, material, collection/season if identifiable.
   Use any visible stamps, serial/reference numbers, hallmarks or date codes. If uncertain, say so
   and give a best guess with a confidence level.
   SEARCH BUDGET — you have only a few web searches, so SPEND THEM ON PRICE, not on identification.
   When the Google Lens matches or the user's note already give you the model (they usually will),
   trust that and do NOT waste a search re-confirming the ID — go straight to finding the current
   EURO RRP and resale prices. Only use a search to confirm identity if the model is genuinely
   unclear from the photos, the note and the Lens matches. When you do need the RRP, check the
   brand's OFFICIAL site (Ireland/EU) — treat it as the source of truth over resale listings.
   MODEL DISAMBIGUATION — many designer lines have several models that look alike in the same
   material (e.g. Louis Vuitton Damier totes: Westminster vs Iéna vs Neverfull; Chanel Classic
   Flap vs Coco Handle). Do NOT lock onto the first plausible name. When two or more models could
   match, deliberately COMPARE the distinguishing features you can see — overall silhouette and
   proportions, base shape (flat vs rounded), handle style and drop length, strap, closure, pocket
   layout, hardware, feet, and any model name embossed on the heat stamp — and search the brand's
   current AND archived/discontinued catalogue to pick the right one. Size codes matter (PM/MM/GM,
   small/medium/large) — infer size from proportions and any note the user gave. If you cannot be
   sure of the exact model, state the most likely one with your confidence level and name the
   runner-up (e.g. "likely Westminster GM; possibly Iéna MM") rather than committing confidently
   to a single wrong answer. A hedged, honest ID is more useful than a precise-sounding wrong one.
   USER-PROVIDED MODEL IS AUTHORITATIVE — if the user's note names a specific model, reference or
   size (e.g. "Westminster GM", "Speedy 30", "Ref 116610LN"), TREAT IT AS CORRECT. These sellers
   know their stock. Do not override it with your own guess; instead verify that named model's spec
   and current price and value THAT. Only push back if the photo plainly contradicts the note
   (e.g. note says a watch but the photo is a handbag) — and then say so explicitly.
2. ASSESS CONDITION from all photos, graded on the standard resale scale: Pristine / Excellent /
   Very Good / Good / Fair. Note the specific, category-appropriate wear you can see and which photo
   shows it (bag: corners/handles/hardware; watch: case/crystal/bracelet scratches, dial/lume;
   jewellery: scratches, stone security, clasp; shoes: soles/creasing; clothing: pilling/marks/holes).
   Be honest — condition drives price.
3. AUTHENTICITY SCREENING — adversarial, and NEVER a guarantee. Approach this as a SCEPTIC whose
   job is to find evidence the item is FAKE, not to confirm it is real. Assume it could be a
   high-quality counterfeit — designer goods across ALL these categories are replicated well enough
   to pass casual inspection, so a correct-looking logo, shape, monogram, dial or hallmark is NOT
   evidence of authenticity; those are the EASIEST things to fake. Do not be reassured by them.
   - GROUND YOUR CHECK: use web_search to pull a CURRENT authentication / "real vs fake" guide for
     THIS exact brand + item (e.g. "how to authenticate Chanel Classic Flap real vs fake serial",
     "Rolex Submariner real vs fake serial rehaut movement", "Cartier Love bracelet fake tells
     hallmark", "Nike Jordan 1 legit check"). Extract the SPECIFIC checkpoints professional
     authenticators use for that category and test the photos against each.
   - For EACH checkpoint report CONSISTENT, INCONSISTENT (a red flag), or NOT VISIBLE. A counterfeit's
     whole purpose is to copy the general look, logo and layout — so "it looks like a genuine one" is
     NOT a positive signal and must NOT be marked CONSISTENT. Only mark CONSISTENT when the photo
     clearly shows a SPECIFIC, hard-to-fake genuine trait; if the shot only shows the general look,
     mark it NOT VISIBLE.
   - CRITICAL MARKERS — the category-specific make-or-break points that must ALL be clearly visible
     AND consistent before a "no red flags" result is even permitted. If ANY one is NOT VISIBLE (or
     you are unsure), you are FORBIDDEN from returning "No red flags" and MUST return "Insufficient
     photos to screen":
       * Handbags: interior brand/"Made in" heat stamp & font; serial/date code + hologram and that
         its era matches the hardware/leather; logo-lock engraving/orientation; stitch density; hardware engraving.
       * Watches: serial & reference/model numbers (and whether they match the model and era); rehaut/
         dial printing crispness; caseback & lug engraving; crown/logo; movement finishing if the
         caseback is open; weight/feel notes. (Super-fakes exist — a photo can rarely clear a watch.)
       * Jewellery: maker's hallmark & metal-purity stamp (750/585/PT950/925); engraving quality;
         gemstone setting & any lab certificate. NOTE fine jewellery/gemstones really need a
         jeweller/gemologist and often an acid/XRF metal test — say so.
       * Shoes: insole/sole & box-label stamps, size-tag font, stitching & construction.
       * Clothing: brand + care/composition labels, stitching, hardware, any hologram/RFID.
   - Choose ONE assessment:
       * "Red flags — likely counterfeit": any marker is inconsistent, misspelled, wrong font, or a
         serial/reference does not match the model/era.
       * "Insufficient photos to screen": ANY critical marker for this category is not clearly
         visible/legible — the case for MOST casual photo sets. This is the correct, honest answer
         when the make-or-break photos are missing; default here whenever unsure. Never pass an item
         whose critical markers you could not actually inspect.
       * "No red flags in visible areas": ONLY when EVERY critical marker for the category is both
         visible and consistent. Even then it is NOT a statement that the item is genuine.
   - A good fake can pass a photo screen; absence of red flags is NEVER proof of authenticity. Give a
     confidence level and list the exact additional photos needed to properly screen for this
     category (e.g. watch: caseback, serial between lugs, rehaut, movement; jewellery: hallmark macro,
     certificate; bag: interior stamp, serial macro; shoes: insole & box label). When evidence is
     thin, return "Insufficient".
4. RETAIL PRICE (RRP) — this MUST be the European / Irish EURO price actually charged in Ireland.
   CRITICAL RULE: brands (especially Louis Vuitton) set DIFFERENT prices per region. You must NEVER
   take a US dollar price and convert it into euros — a USD→EUR conversion is NOT the RRP and is
   wrong. Only report a euro figure that a source actually states as the European/Irish retail price.
   Process:
   a) First try the brand's official Ireland/EU site. Note: these pages are often JavaScript-rendered
      and their price will NOT appear in search snippets — if you cannot actually read the euro price,
      do NOT convert a dollar price instead.
   b) If the official price isn't directly readable, find the current EURO retail price from a
      reputable European price source: luxury price-tracker/price-guide sites that list European
      prices, euro-language pages, or European retail/resale listings that explicitly cite the euro
      RETAIL price. Search using euro-oriented queries, e.g. "<model> prix euro", "<model> Preis Euro",
      "<model> prezzo euro", "<model> Europe price €", "<model> Ireland retail price".
   c) Put the euro figure in rrp.amount, name the exact source in rrp.note, and include its URL in
      "sources". If — and only if — you truly cannot find any source quoting the European euro RRP,
      set rrp.amount to null and explain in rrp.note. Do NOT fall back to a USD conversion.
      (For some categories RRP differs from market value — e.g. hyped watches like Rolex/Patek and
      hyped trainers routinely trade ABOVE retail; note this in rrp.note when relevant.)
   Then gather recent RESALE comps, and PRIORITISE European & Irish euro-priced sources — they reflect
   the market this item will actually sell in. Search these FIRST for bags/clothing/jewellery:
   Vestiaire Collective, Designer Exchange (designerexchange.ie), Rebelle (rebelle.com, DE), Collector
   Square (FR), Vinted, and UK resellers (Hardly Ever Worn It, Luxury Promise, Sign of the Times).
   Watches → Chrono24 (European, euro-priced), WatchCharts. Shoes/trainers → Vestiaire, and StockX using
   its EU/€ price. US sites (The RealReal, Fashionphile, Rebag, Yoogi's Closet, 1stDibs) may be used ONLY
   as a secondary sanity-check — their prices are USD and reflect the US market; NEVER convert a US price
   to euro and quote it as the value. In the "sources" list, cite the euro/European/Irish listings you
   actually used; fall back to a US comp only if you truly cannot find a European one, and say so in the
   resale note.
5. Produce a RESALE PRICE ESTIMATE as a range, and show how it shifts by condition grade.
6. MEASUREMENTS — for HANDBAGS, WALLETS, small leather goods and ACCESSORIES only, give the item's
   dimensions in CENTIMETRES once you've identified the exact model: width, height and depth (these
   are published by the brand and by resale listings — search for them if needed). Put them in the
   "measurements" object with unit "cm". For WATCHES, JEWELLERY, SHOES and CLOTHING, set width/height/
   depth to null (they are sized differently — case mm, ring size, EU shoe size, garment size).

Use web_search several times (retail price; then resale comps on the major platforms). Give ALL
prices in EUR (euros). If a source lists a price in another currency, convert it to euros and use
the euro figure. Every currency field in the JSON must be "EUR".

IMPORTANT — keep the written portion BRIEF: at most ~200 words of plain prose, no long tables.
The single most important part of your reply is the JSON block at the very end, and it MUST be
present and complete. Put all detail into the JSON fields, not into long prose. End your reply with
a single fenced code block labelled json containing EXACTLY this shape (no extra keys, use null
when genuinely unknown):

\`\`\`json
{
  "category": "Handbag | Watch | Jewellery | Shoes | Clothing | Accessory | Other",
  "brand": "",
  "model": "",
  "variant_size": "",
  "material": "",
  "colour": "",
  "hardware": "",
  "identification_confidence": "high | medium | low",
  "identification_notes": "",
  "condition_grade": "Pristine | Excellent | Very Good | Good | Fair",
  "condition_notes": "",
  "authenticity": {
    "assessment": "No red flags in visible areas | Some concerns | Red flags — likely counterfeit | Insufficient photos to screen",
    "confidence": "high | medium | low",
    "checks": [
      { "feature": "", "status": "consistent | inconsistent | not visible", "note": "" }
    ],
    "red_flags": [],
    "photos_needed": []
  },
  "rrp": { "amount": null, "currency": "EUR", "note": "" },
  "resale_estimate": { "low": null, "high": null, "currency": "EUR", "for_condition": "" },
  "resale_by_condition": [
    { "grade": "Excellent", "low": null, "high": null },
    { "grade": "Very Good", "low": null, "high": null },
    { "grade": "Good", "low": null, "high": null }
  ],
  "measurements": { "unit": "cm", "width": null, "height": null, "depth": null },
  "sources": [ "" ],
  "summary": ""
}
\`\`\``;

function extractJson(text) {
  // Grab the last ```json ... ``` block.
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (matches.length) {
    try {
      return JSON.parse(matches[matches.length - 1][1].trim());
    } catch (e) {
      return null;
    }
  }
  return null;
}

// Valuation history store — Supabase in prod, local file in dev (so History works either way).
const VALUATIONS_FILE = join(__dirname, "valuations.local.json");
function localValsRead() {
  try {
    return existsSync(VALUATIONS_FILE) ? JSON.parse(readFileSync(VALUATIONS_FILE, "utf8")) : [];
  } catch {
    return [];
  }
}
function localValsWrite(a) {
  writeFileSync(VALUATIONS_FILE, JSON.stringify(a, null, 2));
}

// Save one valuation (photos + record). Best-effort: never throws, so a storage hiccup can't
// break the valuation the user just paid for.
async function saveValuation({ data, note, files }) {
  if (!data) return null;
  const id = randomUUID();

  const photo_urls = [];
  for (let i = 0; i < files.length; i++) {
    try {
      // Shrink the STORED copy only (the identification already used the full-res image).
      let resized;
      try {
        resized = await sharp(files[i].buffer)
          .rotate()
          .resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 72 })
          .toBuffer();
      } catch (rz) {
        resized = files[i].buffer;
      }
      if (supabase) {
        const path = `${id}/${i}.jpg`;
        const { error } = await supabase.storage
          .from(PHOTO_BUCKET)
          .upload(path, resized, { contentType: "image/jpeg", upsert: true });
        if (!error) {
          const { data: pub } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
          if (pub && pub.publicUrl) photo_urls.push(pub.publicUrl);
        } else {
          console.error("Photo upload failed:", error.message);
        }
      } else {
        photo_urls.push("data:image/jpeg;base64," + resized.toString("base64"));
      }
    } catch (e) {
      console.error("Photo save threw:", e.message);
    }
  }

  const rrp = data.rrp || {};
  const re = data.resale_estimate || {};
  const auth = data.authenticity || {};
  const row = {
    id,
    brand: data.brand || null,
    model: data.model || null,
    condition_grade: data.condition_grade || null,
    authenticity_assessment: auth.assessment || null,
    rrp_amount: typeof rrp.amount === "number" ? rrp.amount : null,
    rrp_currency: rrp.currency || null,
    resale_low: typeof re.low === "number" ? re.low : null,
    resale_high: typeof re.high === "number" ? re.high : null,
    note: note || null,
    photo_urls,
    data,
    created_at: new Date().toISOString(),
  };

  if (supabase) {
    const { error } = await supabase.from("valuations").insert(row);
    if (error) {
      console.error("Supabase insert error:", error.message);
      return null;
    }
  } else {
    const arr = localValsRead();
    arr.push(row);
    localValsWrite(arr);
  }
  return id;
}

// Delete one saved valuation (and best-effort its stored photos).
async function deleteValuation(id) {
  if (supabase) {
    // Remove the photo folder first (best-effort — don't block the row delete on it).
    try {
      const { data: listed } = await supabase.storage.from(PHOTO_BUCKET).list(id);
      if (Array.isArray(listed) && listed.length) {
        await supabase.storage.from(PHOTO_BUCKET).remove(listed.map((f) => `${id}/${f.name}`));
      }
    } catch (e) {
      console.error("Valuation photo cleanup failed:", e.message);
    }
    const { error } = await supabase.from("valuations").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return true;
  }
  localValsWrite(localValsRead().filter((r) => r.id !== id));
  return true;
}

// ── Usage log ─────────────────────────────────────────────────────
// Records the cost of every valuation so we can see the real average per search.
// Always prints to the server log (visible in Render → Logs). Also stores durably:
// Supabase `usage_events` table if it exists (best-effort), else a local JSON file.
const USAGE_FILE = join(__dirname, "usage.local.json");
function localUsageRead() {
  try {
    return existsSync(USAGE_FILE) ? JSON.parse(readFileSync(USAGE_FILE, "utf8")) : [];
  } catch {
    return [];
  }
}
function localUsageWrite(a) {
  try { writeFileSync(USAGE_FILE, JSON.stringify(a, null, 2)); } catch {}
}

async function logUsage({ kind, cost, brand, model }) {
  const row = {
    id: randomUUID(),
    kind: kind || "single",              // "single" | "batch-item"
    input_tokens: cost.input_tokens,
    output_tokens: cost.output_tokens,
    web_searches: cost.web_searches,
    cost_usd: cost.cost_usd,
    cost_eur: cost.cost_eur,
    brand: brand || null,
    model_item: model || null,
    created_at: new Date().toISOString(),
  };
  // Always visible in logs, even before any table exists.
  console.log(
    `[cost] ${row.kind} · in ${row.input_tokens} out ${row.output_tokens} ` +
    `· ${row.web_searches} searches · €${row.cost_eur} ($${row.cost_usd})`
  );
  try {
    if (supabase) {
      const { error } = await supabase.from("usage_events").insert(row);
      if (error) throw new Error(error.message);
    } else {
      const arr = localUsageRead();
      arr.push(row);
      localUsageWrite(arr);
    }
  } catch (e) {
    // Table may not exist yet — keep a local copy so nothing is lost, and note it once.
    const arr = localUsageRead();
    arr.push(row);
    localUsageWrite(arr);
    console.error("usage_events store failed (kept locally):", e.message);
  }
}

function noKey() {
  return !API_KEY || API_KEY.includes("PASTE_YOUR");
}

// Reverse-image identification via SerpApi's Google Lens engine. Hosts the photo on Supabase
// storage (Lens needs a public URL), asks Lens what it matches, and returns the top match titles —
// the same "visual matches" you see in the Google Lens app. Best-effort: any failure returns [].
async function lensMatchTitles(buffer) {
  if (!SERPAPI_KEY || !supabase) return [];
  let path = null;
  try {
    path = `lens/${randomUUID()}.jpg`;
    const { error: upErr } = await supabase.storage
      .from(PHOTO_BUCKET)
      .upload(path, buffer, { contentType: "image/jpeg", upsert: true });
    if (upErr) throw new Error(upErr.message);
    const { data: pub } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
    const imgUrl = pub && pub.publicUrl;
    if (!imgUrl) throw new Error("no public url");

    const api =
      "https://serpapi.com/search.json?engine=google_lens&hl=en&country=ie" +
      `&url=${encodeURIComponent(imgUrl)}&api_key=${SERPAPI_KEY}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let titles = [];
    try {
      const r = await fetch(api, { signal: ctrl.signal });
      const j = await r.json();
      const matches = Array.isArray(j.visual_matches) ? j.visual_matches : [];
      titles = matches
        .map((m) => (m && m.title ? String(m.title).trim() : ""))
        .filter(Boolean)
        .slice(0, 8);
    } finally {
      clearTimeout(timer);
    }
    return titles;
  } catch (e) {
    console.error("Lens lookup failed:", e.message);
    return [];
  } finally {
    // We only needed the hosted image for the Lens call — remove it.
    if (path) {
      try { await supabase.storage.from(PHOTO_BUCKET).remove([path]); } catch {}
    }
  }
}

// Core: run the vision + web-search valuation for a set of photos of ONE item.
async function analyzeImages(files, userNote) {
  const imageContent = [];
  let firstBuf = null;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    // Shrink before sending — the AI doesn't need full phone-camera resolution to identify
    // an item, and smaller images mean fewer input tokens and faster uploads.
    let buf = file.buffer;
    let mediaType = file.mimetype || "image/jpeg";
    try {
      buf = await sharp(file.buffer)
        .rotate()
        .resize({ width: SEND_IMG_MAX_PX, height: SEND_IMG_MAX_PX, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer();
      mediaType = "image/jpeg";
    } catch (e) {
      buf = file.buffer; // fall back to the original if resizing fails
    }
    if (i === 0) firstBuf = buf;
    imageContent.push({ type: "text", text: `Photo ${i + 1} of ${files.length}:` });
    imageContent.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: buf.toString("base64") },
    });
  }

  // Reverse-image match the first photo with Google Lens to pin the exact model.
  const lensTitles = firstBuf ? await lensMatchTitles(firstBuf) : [];
  if (lensTitles.length) console.log(`[lens] ${lensTitles.length} matches · e.g. "${lensTitles[0]}"`);
  const lensBlock = lensTitles.length
    ? `\n\nGOOGLE LENS reverse-image matches for photo 1 — these are listings of what is very ` +
      `likely the SAME item, matched by image, so they are a STRONG signal for the exact brand, ` +
      `model and size. Identify the item from the consensus across them (sanity-check against what ` +
      `you actually see in the photos; ignore any that clearly don't match):\n- ` +
      lensTitles.join("\n- ")
    : "";

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCH_MAX }],
    messages: [
      {
        role: "user",
        content: [
          ...imageContent,
          {
            type: "text",
            text:
              `These ${files.length} photo(s) all show the SAME item from different angles. ` +
              "Identify it (any luxury/designer category — bag, watch, jewellery, shoes, clothing, accessory), " +
              "assess its condition, screen its authenticity, find its RRP and estimate its resale value." +
              (userNote ? `\n\nExtra context from me: ${userNote}` : "") +
              lensBlock,
          },
        ],
      },
    ],
  });

  const fullText = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const data = extractJson(fullText);

  // Safety net: never let a photo screen stand as a "pass" when markers are unseen.
  if (data && data.authenticity) {
    const a = data.authenticity;
    const checks = Array.isArray(a.checks) ? a.checks : [];
    const anyUnseen = checks.some((c) => /not\s*visible/i.test((c && c.status) || ""));
    const s = (a.assessment || "").toLowerCase();
    const flaggedFake = s.includes("counterfeit") || s.includes("likely fake");
    if (!flaggedFake && anyUnseen) a.assessment = "Insufficient photos to screen";
  }

  const cost = computeCost(response.usage);

  return {
    data,
    cost,
    narrative: fullText.replace(/```json[\s\S]*?```/gi, "").trim(),
    raw: data ? undefined : fullText,
  };
}

app.post("/api/analyze", requireCode, upload.array("photos", MAX_PHOTOS), async (req, res) => {
  try {
    if (noKey()) {
      return res.status(400).json({
        error: "No API key configured. Open the .env file in the bag-valuer folder and paste your Anthropic API key.",
      });
    }
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: "No photos uploaded." });
    }
    const userNote = (req.body.note || "").toString().slice(0, 500);
    const { data, cost, narrative, raw } = await analyzeImages(req.files, userNote);

    logUsage({ kind: "single", cost, brand: data && data.brand, model: data && data.model });

    let savedId = null;
    try {
      savedId = await saveValuation({ data, note: userNote, files: req.files });
    } catch (e) {
      console.error("saveValuation error:", e.message);
    }
    res.json({ data, savedId, narrative, raw });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err?.error?.error?.message || err?.message || "Something went wrong analysing the photo.",
    });
  }
});

// Batch: value EACH photo as its own separate item, in parallel.
app.post("/api/analyze-batch", requireCode, upload.array("photos", MAX_PHOTOS), async (req, res) => {
  try {
    if (noKey()) return res.status(400).json({ error: "No API key configured." });
    if (!req.files || !req.files.length) return res.status(400).json({ error: "No photos uploaded." });
    const userNote = (req.body.note || "").toString().slice(0, 500);
    // Per-item notes: sent as notes[] aligned to the files, falling back to the shared note.
    let perNotes = req.body["notes[]"] ?? req.body.notes ?? [];
    if (!Array.isArray(perNotes)) perNotes = [perNotes];

    const items = await Promise.all(
      req.files.map(async (file, i) => {
        try {
          const itemNote = ((perNotes[i] || "").toString().trim() || userNote).slice(0, 500);
          const { data, cost } = await analyzeImages([file], itemNote);
          logUsage({ kind: "batch-item", cost, brand: data && data.brand, model: data && data.model });
          let savedId = null;
          try {
            savedId = await saveValuation({ data, note: itemNote, files: [file] });
          } catch (e) {
            console.error("batch save error:", e.message);
          }
          return { index: i, data, savedId };
        } catch (e) {
          console.error("batch item failed:", e.message);
          return { index: i, data: null, error: e.message };
        }
      })
    );
    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || "Batch valuation failed." });
  }
});

// Past valuations, newest first.
app.get("/api/history", requireCode, async (req, res) => {
  try {
    if (supabase) {
      const { data, error } = await supabase
        .from("valuations")
        .select(
          "id, created_at, brand, model, condition_grade, authenticity_assessment, rrp_amount, rrp_currency, resale_low, resale_high, photo_urls, data"
        )
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ enabled: true, items: data });
    }
    const items = localValsRead().slice().reverse().slice(0, 200);
    res.json({ enabled: true, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.delete("/api/history/:id", requireCode, async (req, res) => {
  try {
    await deleteValuation(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// What have valuations actually cost us? Averages so we can price the product.
app.get("/api/usage-summary", requireCode, async (req, res) => {
  try {
    let rows = [];
    if (supabase) {
      const { data, error } = await supabase
        .from("usage_events")
        .select("cost_usd, cost_eur, web_searches, input_tokens, output_tokens, created_at")
        .order("created_at", { ascending: false })
        .limit(5000);
      if (error) throw new Error(error.message);
      rows = data || [];
    } else {
      rows = localUsageRead();
    }
    const n = rows.length;
    const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const totalEur = sum("cost_eur");
    const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
    res.json({
      count: n,
      total_cost_eur: round(totalEur),
      total_cost_usd: round(sum("cost_usd")),
      avg_cost_eur: n ? round(totalEur / n) : 0,
      avg_searches: n ? round(sum("web_searches") / n, 2) : 0,
      avg_input_tokens: n ? Math.round(sum("input_tokens") / n) : 0,
      avg_output_tokens: n ? Math.round(sum("output_tokens") / n) : 0,
      since: n ? rows[rows.length - 1].created_at : null,
      rates: COST,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SerpApi (Google Lens) quota — how many lookups are left this month, so we can watch the limit.
app.get("/api/serpapi-quota", requireCode, async (req, res) => {
  try {
    if (!SERPAPI_KEY) return res.json({ enabled: false });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let j = {};
    try {
      const r = await fetch(`https://serpapi.com/account.json?api_key=${SERPAPI_KEY}`, { signal: ctrl.signal });
      j = await r.json();
    } finally {
      clearTimeout(timer);
    }
    const limit = Number(j.searches_per_month) || null;
    const used = Number(j.this_month_usage) || 0;
    const left = j.plan_searches_left != null ? Number(j.plan_searches_left)
      : (limit != null ? Math.max(0, limit - used) : null);
    res.json({
      enabled: true,
      plan: j.plan_name || null,
      limit_per_month: limit,
      used_this_month: used,
      left,
      pct_used: limit ? Math.round((used / limit) * 100) : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Tasks API ─────────────────────────────────────────────────────
app.get("/api/tasks", requireCode, async (req, res) => {
  try {
    res.json({ tasks: activeToday(await taskStore.list()), staff: await staffStore.list() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Daily history — list of saved days (newest first), and one day's full board.
app.get("/api/tasks/snapshots", requireCode, async (req, res) => {
  try {
    res.json({ snapshots: await snapshotStore.list() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/tasks/snapshots/:date", requireCode, async (req, res) => {
  try {
    const snapshot = await snapshotStore.get(req.params.date);
    if (!snapshot) return res.status(404).json({ error: "No saved board for that day." });
    res.json({ snapshot });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/tasks", requireCode, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.title || !String(body.title).trim()) {
      return res.status(400).json({ error: "A task needs a title." });
    }
    const task = await taskStore.create(body, body.created_by);
    await snapshotSafe();
    res.json({ task });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/tasks/:id", requireCode, async (req, res) => {
  try {
    const task = await taskStore.update(req.params.id, req.body || {});
    if (!task) return res.status(404).json({ error: "Task not found." });
    await snapshotSafe();
    res.json({ task });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/tasks/:id", requireCode, async (req, res) => {
  try {
    await taskStore.remove(req.params.id);
    await snapshotSafe();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cash-out API ──────────────────────────────────────────────────
app.get("/api/cashouts", requireCode, async (req, res) => {
  try {
    const date = (req.query.date && String(req.query.date).slice(0, 10)) || dublinDate();
    res.json({
      date,
      stores: CASHOUT_STORES,
      cashouts: await cashoutStore.listByDate(date),
      days: await cashoutStore.days(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/cashouts", requireCode, async (req, res) => {
  try {
    const b = req.body || {};
    const date = (b.date && String(b.date).slice(0, 10)) || dublinDate();
    const store = String(b.store || "");
    if (!CASHOUT_STORES.includes(store)) return res.status(400).json({ error: "Unknown store." });
    const images = await processCashoutImages(b.images || [], date, store);
    const note = b.note ? String(b.note).slice(0, 300) : null;
    const cashout = await cashoutStore.upsert(date, store, images, note, b.updated_by);
    res.json({ cashout });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n\x1b[32m✓ Bag Valuer running.\x1b[0m  Open  \x1b[36mhttp://localhost:${PORT}\x1b[0m  in your browser.`);
  console.log(
    ACCESS_CODE
      ? "   Passcode protection: ON"
      : "   \x1b[33mPasscode protection: OFF\x1b[0m (set ACCESS_CODE before putting this online)"
  );
  console.log(
    supabase
      ? "   History (Supabase): ON"
      : "   History (Supabase): off (set SUPABASE_URL + SUPABASE_SERVICE_KEY to enable saving)"
  );
  console.log(
    SERPAPI_KEY && supabase
      ? "   Google Lens identification: ON\n"
      : SERPAPI_KEY
      ? "   Google Lens identification: needs Supabase (to host the photo) — off\n"
      : "   Google Lens identification: off (set SERPAPI_KEY to turn on)\n"
  );
});
