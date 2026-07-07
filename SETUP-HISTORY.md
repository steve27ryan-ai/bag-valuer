# Turning on History (saving every valuation)

This connects the app to **Supabase** — a free, always-on database — so every valuation is saved
with its photos, and staff can browse them under the **History** tab. ~10 minutes, one time.

If you skip this, the app still works perfectly; it just won't keep a history.

---

## Step 1 — Create a free Supabase project

1. Go to [supabase.com](https://supabase.com) → **Start your project** → sign in with GitHub or email.
2. Click **New project**. Give it a name (e.g. `bag-valuer`), set a database password (save it
   somewhere; you won't need it day-to-day), pick the region closest to Ireland (**West EU (Ireland)**
   if offered), and create it. Wait ~2 minutes for it to finish setting up.

## Step 2 — Create the table

1. In the Supabase dashboard, open the **SQL Editor** (left sidebar) → **New query**.
2. Paste this in and click **Run**:

```sql
create table if not exists valuations (
  id uuid primary key,
  created_at timestamptz default now(),
  brand text,
  model text,
  condition_grade text,
  authenticity_assessment text,
  rrp_amount numeric,
  rrp_currency text,
  resale_low numeric,
  resale_high numeric,
  note text,
  photo_urls jsonb,
  data jsonb
);
```

You should see "Success. No rows returned." — that's correct.

## Step 3 — Create the photo storage

1. Open **Storage** (left sidebar) → **New bucket**.
2. Name it exactly **`bag-photos`**, toggle it to **Public**, and create it.
   (Public means the app can show the thumbnails. The photo links are long and random, so they
   aren't browseable by outsiders — but don't put anything in here you'd never want shared.)

## Step 4 — Copy your two keys

1. Open **Project Settings** (gear icon) → **API**.
2. You'll use two values:
   - **Project URL** — e.g. `https://abcdefgh.supabase.co`
   - **service_role** secret key — under "Project API keys", reveal and copy the **`service_role`**
     one (NOT the `anon` one). This is a secret — treat it like a password.

## Step 5 — Give them to the app

**If testing locally:** open `.env` and fill in:
```
SUPABASE_URL=https://abcdefgh.supabase.co
SUPABASE_SERVICE_KEY=your-service_role-key
```
Then restart (`npm start`). You'll see "History (Supabase): ON" in the terminal.

**If deploying on Render:** add these as two more Environment Variables (see DEPLOY.md), alongside
your API key and passcode:
| Key | Value |
|-----|-------|
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_SERVICE_KEY` | your service_role key |

---

## Checking it works

Value a bag. If it worked, you'll see **"✓ Saved to History"** under the result, a **History** tab
appears at the top, and the bag shows up there. You can also see the row appear in Supabase under
**Table Editor → valuations**.

## Notes

- Free tier covers **500 MB database + 1 GB photos** — hundreds of bags. Plenty to start; you can
  upgrade later if you ever fill it.
- The `service_role` key is powerful — only ever put it in `.env` (which is never uploaded) or in
  Render's Environment settings. Never commit it to GitHub.
