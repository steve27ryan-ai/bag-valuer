# Turning on the Team Hub (tasks, team, updates)

The task board, team list, and message board all save to your existing **Supabase** project
(the same one History uses). You just need to create three small tables. ~3 minutes, one time.

Until you do this, the Team Hub features work locally but won't appear on the live site.

## Step 1 — Create the tables

1. In the Supabase dashboard, open the **SQL Editor** → **New query**.
2. Paste this in and click **Run**. If it asks about Row Level Security, choose **Run and enable RLS**
   (your app uses the secret `service_role` key, which bypasses RLS — so it keeps full access while
   the data stays private).

```sql
-- Task board
create table if not exists tasks (
  id uuid primary key,
  title text,
  assignee text,
  status text,
  priority text,
  due_date date,
  note text,
  images jsonb,
  created_by text,
  created_at timestamptz default now()
);
alter table tasks enable row level security;

-- Team members
create table if not exists staff (
  name text primary key,
  created_at timestamptz default now()
);
alter table staff enable row level security;

-- Team updates (message board)
create table if not exists messages (
  id uuid primary key,
  text text,
  author text,
  created_at timestamptz default now()
);
alter table messages enable row level security;

-- Seller intakes (saved consignment slips)
create table if not exists intakes (
  id uuid primary key,
  consignor_name text,
  account_number text,
  items jsonb,
  total_sale numeric,
  total_ours numeric,
  total_seller numeric,
  created_by text,
  created_at timestamptz default now()
);
alter table intakes enable row level security;
```

You should see "Success. No rows returned." — that's correct.

## Step 2 — (Optional) set the starting team

The team list seeds itself the first time from a setting. Two options:

- **Easiest:** do nothing now — it'll start with `Steve, Aoife, Niamh`, and you can fix the names
  in the app under **Tasks → manage team** (add your real staff, remove the samples).
- **Or seed real names up front:** in Render → your service → **Environment**, add a variable
  `STAFF` set to your team, comma-separated, e.g. `Steve,Aoife,Ciara,Mark`. (Only used to fill the
  list the very first time; after that it's managed in the app.)

## Notes

- **Photos on tasks** reuse the `bag-photos` storage bucket you already created for History — nothing
  new to set up.
- No new API keys or env variables are required (beyond the optional `STAFF`).
- Everything is covered by the free tier for a long time.
