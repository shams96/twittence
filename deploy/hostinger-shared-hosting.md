# Deploying Twittence on Hostinger shared hosting (hPanel Node.js App)

You have Business Web Hosting (shared), not a VPS — there's no root/SSH admin here. Hostinger's
built-in **Node.js App** manager runs the app for you (process supervision, restarts) — you don't
need PM2 or nginx config; that's all handled by the panel. `deploy/README.md` and the `nginx.conf`/
`ecosystem.config.js` files are for a *VPS*, not this. This file is the real path for your account.

## 1. Get the code onto the server

hPanel's Node.js App setup wants a folder inside your hosting account containing the app. Easiest
way in since you don't have SSH:

- In hPanel, open **File Manager** for twittence.com's hosting.
- Create a folder for the app, e.g. `twittence-app` (keep it separate from `public_html` — the
  Node app manager serves it directly, it doesn't need to live under `public_html`).
- Download this repo as a zip from GitHub (**github.com/shams96/twittence** → Code → Download ZIP),
  upload the zip into `twittence-app` via File Manager, then extract it there.
- You should end up with `twittence-app/functions/` and `twittence-app/hosting/` as siblings —
  `functions/index.js` serves the static `hosting/` folder via a relative path
  (`path.resolve(__dirname, "..", "hosting")`), so this exact layout matters. Don't flatten it.

## 2. Set up the Node.js App

hPanel → your hosting → **Advanced** (or **Website**) → **Node.js** → **Create Application**:

- **Node.js version**: 20 (matches `functions/package.json`'s `engines.node`)
- **Application mode**: Production
- **Application root**: `twittence-app/functions` (the folder containing `package.json` and `index.js`)
- **Application URL**: `twittence.com`
- **Application startup file**: `index.js`

Save. Hostinger will show an **NPM install** button once the app is created — click it to install
`functions/package.json`'s dependencies (this reads `package.json` from the Application root you set).

## 3. Environment variables

Same screen, there's an **Environment Variables** section — add these (no quotes, one per row):

| Key | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your real key |
| `PAGESPEED_API_KEY` | your real key (optional — Lighthouse comparison feature) |
| `NODE_ENV` | `production` |
| `FIREBASE_PROJECT_ID` | `sound-octagon-444117-m9` |
| `ALLOWED_ORIGINS` | `https://twittence.com,https://www.twittence.com` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | the full contents of your service-account key, see below |

**Do not set `PORT`** — Hostinger's Node.js app manager assigns and manages the port itself; the app
already respects whatever it's given (`process.env.PORT || 3000`).

### Getting the service-account JSON

Firebase Console → **sound-octagon-444117-m9** → Project Settings (gear icon) → **Service Accounts**
tab → **Generate new private key**. This downloads a `.json` file. Open it, copy the *entire*
contents, and paste that as the value of `FIREBASE_SERVICE_ACCOUNT_JSON` — it needs to stay valid
JSON on one line (most panel input boxes handle a pasted multi-line JSON fine since it's just a text
value; if the field truly rejects newlines, minify it first, e.g. with `node -e "console.log(JSON.stringify(require('./key.json')))"`
run locally on the downloaded file).

Treat this like a password — it grants admin access to your Firestore data and user accounts. Don't
commit it, don't share it outside this one panel field.

## 4. Start it

Click **Restart** (or **Start**) on the Node.js app. Then check the app's logs (there's a **Logs**
tab in the same panel) for errors — the most likely first-run failure is a malformed
`FIREBASE_SERVICE_ACCOUNT_JSON` (a `JSON.parse` error in the logs means the paste got mangled).

## 5. SSL

hPanel → **SSL** (under Security or the domain's settings) → enable **free SSL** for twittence.com.
Hostinger auto-provisions and renews a Let's Encrypt certificate.

## 6. Verify

Visit `https://twittence.com/api/health` — should return
`{"status":"ok","timestamp":"..."}`. Then load `https://twittence.com/`, sign in with Google, and
run a real audit.

## Required manual step — Firebase authorized domains

You already did this for `twittence.com` earlier. If you add `www.twittence.com` too, repeat it:
Firebase Console → Authentication → Settings → Authorized domains.

## Redeploying after code changes

Re-download the repo zip (or re-upload changed files via File Manager), then click **Restart** on
the Node.js app in hPanel — no separate "deploy" step exists here, restart picks up the new files.
