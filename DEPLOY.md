# Deployment Guide

Backend → **Railway** (US region, can reach Anthropic directly).
Frontend → **Vercel** (free tier).

The two are deployed from the same GitHub repo with different root directories.

---

## 0. Prerequisites

- A **GitHub** account, and the repo pushed there (see "Push to GitHub" below if you haven't done this yet).
- A **Railway** account (https://railway.app). Note: no free tier — minimum ~$5/mo. If cost is a concern, swap Railway for **Render** (auto-sleeping free tier) or **Fly.io** (free 3 small VMs).
- A **Vercel** account (https://vercel.com). Free for hobby projects.
- A **real Anthropic API key** from https://console.anthropic.com (new accounts get $5 in free credits). If you can't get one, you can still deploy and use a relay like UIUIAPI — see the env-var note below.

---

## 1. Push to GitHub

If you haven't already:

```bash
cd q:/src/YaoAINote
git init
git add .
git commit -m "Initial commit"
```

Then on github.com: create a new empty repo (don't initialize with a README — your repo isn't empty). Copy its URL, then:

```bash
git branch -M main
git remote add origin https://github.com/<your-username>/YaoAINote.git
git push -u origin main
```

**Double-check `.env` is NOT in the push.** Run `git ls-files | grep .env` — if it shows `server/.env`, stop and fix `.gitignore` (it should already say `.env`). Only `server/.env.example` should be in the repo.

---

## 2. Deploy backend to Railway

1. Go to https://railway.app → **New Project** → **Deploy from GitHub repo** → pick your YaoAINote repo.
2. After it loads, click the service → **Settings** tab.
3. Set:
   - **Root Directory:** `server`
   - **Build Command:** *(leave empty — Railway runs `npm install` automatically)*
   - **Start Command:** `node src/index.js`
4. Go to the **Variables** tab and add these (one at a time):

   | Key | Value |
   |---|---|
   | `APP_API_KEY` | Make up a long random string — this is what the frontend will send |
   | `ANTHROPIC_API_KEY` | Your real `sk-ant-...` key from console.anthropic.com |
   | `VOYAGE_API_KEY` | Your Voyage key |
   | `PINECONE_API_KEY` | Your Pinecone key |
   | `PINECONE_INDEX` | `yaoainote` |
   | `DATA_DIR` | `/data` |
   | `CORS_ORIGINS` | Leave empty for now — we'll fill after Vercel gives us a URL |

   **Optional, only if your Anthropic key is from UIUIAPI/another relay:**

   | Key | Value |
   |---|---|
   | `ANTHROPIC_BASE_URL` | The relay's host (e.g. `https://sg.uiuiapi.com`) |

5. Go to **Settings** tab → scroll to **Volumes** → **+ New Volume** → mount path `/data`. This persists the SQLite DB across redeploys.
6. Trigger a deploy. Wait for the build to go green.
7. Open the **Settings** tab again → **Networking** → click **Generate Domain**. Railway will give you a URL like `https://yaoainote-production-XXXX.up.railway.app`. **Copy this URL.**
8. Smoke test: `curl https://<your-railway-url>/api/health` should print `{"ok":true}`.

---

## 3. Deploy frontend to Vercel

1. Go to https://vercel.com/new → **Import** your GitHub repo.
2. On the import screen:
   - **Framework Preset:** Vite (auto-detected)
   - **Root Directory:** `client`
   - **Build / Output:** leave defaults (Vercel knows: `npm run build`, output `dist`)
3. **Environment Variables** — add this one:

   | Key | Value |
   |---|---|
   | `VITE_API_BASE_URL` | The Railway URL from step 2.7 (no trailing slash) |

4. Click **Deploy**. Wait for the build.
5. Vercel will give you a URL like `https://yaoainote-XXXX.vercel.app`. **Copy this URL.**

---

## 4. Wire up CORS

Now that we know the Vercel URL, tell the backend to accept requests from it.

1. Back to Railway → your service → **Variables** tab.
2. Edit `CORS_ORIGINS` and paste in the Vercel URL — e.g.:
   ```
   https://yaoainote-XXXX.vercel.app
   ```
   For multiple origins (e.g. previews + prod), comma-separate them.
3. Railway will auto-redeploy. Wait ~30 seconds.

---

## 5. Test it

1. Open the Vercel URL in your browser.
2. The gate asks for your `APP_API_KEY` — paste the value you set in Railway's `APP_API_KEY` variable.
3. Upload a `.txt` doc, ask a question.
4. If chat fails, open the Railway service → **Deployments** tab → click the active deploy → **Logs** to see the error trace.

---

## Common gotchas

- **502 / 504 from Vercel:** the backend isn't reachable. Check Railway is up and `VITE_API_BASE_URL` matches the Railway domain exactly.
- **CORS error in the browser console:** `CORS_ORIGINS` on Railway doesn't include the exact Vercel URL (or has a trailing slash). Edit and redeploy.
- **401 on every API call:** the `APP_API_KEY` you entered in the UI doesn't match Railway's `APP_API_KEY` env var.
- **403 from Anthropic on Railway:** unlikely (Railway is in US), but if it happens your `ANTHROPIC_API_KEY` is probably from UIUIAPI — set `ANTHROPIC_BASE_URL` on Railway too.
- **SQLite "no such table" or doc list empty after redeploy:** you forgot the volume mount, or `DATA_DIR` doesn't point at it.

---

## Updating after first deploy

Each `git push` to `main` triggers an auto-deploy on both Railway and Vercel. No CLI needed.
