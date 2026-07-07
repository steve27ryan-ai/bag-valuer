# Siopaella · Bag Valuer

Upload a photo of a designer bag → get its **brand, model, condition, RRP and an estimated resale range**.
Runs privately on your own Mac.

---

## One-time setup (about 5 minutes)

### 1. Get an Anthropic API key
This is what powers the image recognition. It's separate from your Claude subscription and is
pay-as-you-go — roughly **2–5p per bag**, no monthly fee.

1. Go to **https://console.anthropic.com** and sign in (or sign up).
2. Add a little credit: **Settings → Billing** → add e.g. £5.
3. **Settings → API Keys → Create Key**. Copy the key (starts with `sk-ant-...`).

### 2. Paste the key into the app
1. In this `bag-valuer` folder, open the file called **`.env`** (any text editor).
2. Replace `PASTE_YOUR_KEY_HERE` with your key so it reads, e.g.:
   ```
   ANTHROPIC_API_KEY=sk-ant-abc123...
   ```
3. Save the file.

### 3. Install & start (one time in Terminal)
Open **Terminal**, then paste these two lines (press Enter after each):

```bash
cd "/Users/stephenryan/Documents/Claude Co-Work/bag-valuer"
npm install
```

That downloads what it needs (only needed once).

---

## Using it, day to day

Every time you want to use it, run:

```bash
cd "/Users/stephenryan/Documents/Claude Co-Work/bag-valuer"
npm start
```

Then open **http://localhost:3000** in your browser. Upload **one or more photos** of the same bag
(up to 6), click **Value this bag**, and wait 15–40 seconds while it identifies the bag and searches
the market.

To stop it, go back to Terminal and press **Ctrl + C**.

---

## What it does & what to trust

- **Brand / model / condition** — read from your photo by Claude's vision model. Strong, but
  double-check the model name on anything unusual.
- **RRP** — looked up live via web search.
- **Resale range** — reasoned from publicly visible market data (Vestiaire, Fashionphile, The
  RealReal, Rebag, etc.). These sites block automated scraping, so this is a **well-reasoned
  estimate, not a live feed of sold prices.** Treat it as a ballpark and confirm against your own comps.

**Best results:** add several angles of the *same* bag — front, hardware close-up, date/serial
stamp, interior, and base/corners. More angles give a sharper ID and a more accurate condition grade.
