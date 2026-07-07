# Putting Bag Valuer online (for staff iPhones)

This puts the app on the internet so any staff phone can use it with a link + passcode —
your Mac does **not** need to be on. Budget ~15 minutes, one time.

Recommended host: **Render** (render.com). It's browser-based (no coding), handles the ~1-minute
valuations well, and the plan that keeps it always-on is about **€7/month**.

---

## Before you start — two must-dos

1. **Roll your API key.** The current key was pasted in a chat, so treat it as exposed.
   At [console.anthropic.com](https://console.anthropic.com) → **API Keys** → create a **new** key
   (delete the old one). You'll paste the new key into Render below — not into any file you upload.
2. **Pick a real passcode** for staff (not the default `siopaella`). Something simple they'll
   remember, e.g. a word + number. You'll set it in Render below.

---

## Step 1 — Put the code on GitHub (free)

Render reads the app from a GitHub repository.

1. Make a free account at [github.com](https://github.com).
2. Click **+** (top right) → **New repository**. Name it `bag-valuer`, keep it **Private**, click
   **Create repository**.
3. On the next page click **uploading an existing file**.
4. From the `bag-valuer` folder on your Mac, drag in **these items only**:
   - `server.js`
   - `package.json`
   - `package-lock.json`
   - `README.md`
   - `.gitignore`
   - the whole `public` folder
5. **Do NOT upload** `node_modules` (huge) or `.env` (it holds your key — keep it off the internet).
6. Click **Commit changes**.

## Step 2 — Deploy on Render

1. Make a free account at [render.com](https://render.com) and, when asked, connect your GitHub.
2. Click **New +** → **Web Service** → pick your `bag-valuer` repo → **Connect**.
3. Render usually fills these in automatically; confirm they read:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Choose an instance type: **Starter (~€7/mo)** is recommended so it's always instant for staff.
   (The Free option works but "sleeps" when idle, so the first valuation after a quiet spell takes
   an extra minute to wake up.)
5. Click **Advanced** → **Add Environment Variable**, and add these three:
   | Key | Value |
   |-----|-------|
   | `ANTHROPIC_API_KEY` | your **new** key from console.anthropic.com |
   | `ACCESS_CODE` | the staff passcode you chose |
   | `MODEL` | `claude-sonnet-5` |

   **Optional — to save a History of valuations:** if you've done the Supabase setup in
   `SETUP-HISTORY.md`, also add `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` here. You can add these
   later too — just edit the environment and Render redeploys itself.
6. Click **Create Web Service**. Wait ~2–3 minutes for it to build.
7. When it's live, Render shows a URL like **`https://bag-valuer.onrender.com`**. That's your app.

## Step 3 — Get it onto staff phones

1. Send staff the Render URL and the passcode.
2. On the iPhone, open the link in **Safari**, tap the **Share** button (box with an up-arrow),
   then **Add to Home Screen** → **Add**. It now sits on the home screen as a "Bag Valuer" icon
   and opens full-screen like a normal app.
3. First time, they type the passcode once — the phone remembers it after that.
4. Tap the upload area to take photos or pick from the library, then **Value this bag**.

---

## Changing things later

- **Change the passcode or key:** Render dashboard → your service → **Environment** → edit the
  value → **Save** (it redeploys itself). No need to touch GitHub.
- **Update the app itself** (if I make changes): re-upload the changed files to GitHub; Render
  redeploys automatically.

## Costs, recap

- Render Starter: ~€7/month (always-on hosting).
- Anthropic API: pay-as-you-go, ~2–5c per valuation.
- No other fees.
