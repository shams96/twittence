# Deploying Twittence on Hostinger shared hosting (verified working setup)

This is what's actually live at twittence.com, confirmed by direct SSH access and Hostinger's own
runtime error logs — not generic assumptions. `deploy/README.md` and the `nginx.conf`/
`ecosystem.config.js` files are for a *VPS*; this Business Web Hosting plan is shared hosting with a
different deploy mechanism (Hostinger's "Web Apps" deploy wizard), described here.

## Two platform quirks that aren't obvious and will break a naive deploy

1. **`require.main === module` doesn't work here.** Hostinger's Node.js runner loads `index.js` via
   `require()`, not by executing it directly, so that guard is always false and `app.listen()` never
   fires — the app "deploys successfully" but the site 503s forever. Fixed in code: the app now
   listens only when `STANDALONE_SERVER=true` is set explicitly (see env vars below), rather than
   trying to auto-detect the environment.
2. **Sibling folders outside the selected "Application root" are silently dropped.** Even though the
   uploaded zip contains `hosting/` next to `functions/`, Hostinger's deployed runtime only keeps the
   exact subtree you set as Application root — `hosting/` never makes it to the live version. Fixed
   in code: `functions/index.js` checks for `hosting/` as a sibling first (Firebase/VPS layout), and
   falls back to `functions/hosting/` (bundled alongside) if the sibling doesn't exist — so the zip
   for Hostinger needs `hosting/` copied *inside* `functions/`, not next to it.

## 1. Build the right zip

Unlike the GitHub repo's layout (`functions/` and `hosting/` as siblings, which is what Firebase
needs), the Hostinger zip needs `hosting/` nested inside `functions/`:

```
twittence-app/
└── functions/
    ├── index.js
    ├── package.json
    └── hosting/        ← copied in here, not next to functions/
        ├── index.html
        ├── assets/
        ├── css/
        └── js/
```

Don't include `node_modules/` or `.env` in the zip — Hostinger runs its own `npm install`, and
secrets go in via the panel's Environment Variables, not a committed file.

## 2. Deploy via hPanel's Web Apps wizard

hPanel → your website → **Deployments** (or wherever the "Deploy" / "Web Apps" entry point is) →
upload the zip. On the config screen:

- **Framework preset**: `Express` (not the auto-detected default — verify it, auto-detection has
  guessed wrong before)
- **Node version**: `20.x` (matches `functions/package.json`'s `engines.node`)
- **Root directory**: `twittence-app/functions`
- **Build and output settings → Change → Entry file**: `index.js` (this field exists — auto-detect
  may leave it wrong; the panel's own AI error-diagnosis tool will misdirect you toward a
  non-existent `server.js` problem if this is the actual issue, don't trust that diagnosis blindly)

## 3. Environment variables

Same screen, **Environment Variables** section — add these:

| Key | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your real key |
| `PAGESPEED_API_KEY` | your real key (optional — Lighthouse comparison feature) |
| `STANDALONE_SERVER` | `true` — **required**, see quirk #1 above |
| `NODE_ENV` | `production` |
| `FIREBASE_PROJECT_ID` | `sound-octagon-444117-m9` |
| `ALLOWED_ORIGINS` | `https://twittence.com,https://www.twittence.com` |
| `INTERNAL_FETCH_SECRET` | a random secret string — same value must also be set on the Firebase deployment's `functions/.env` |
| `FETCH_PROXY_URL` | `https://us-central1-sound-octagon-444117-m9.cloudfunctions.net` |

### Why FETCH_PROXY_URL matters here specifically

Shared hosting IPs get rate-limited by sites' bot protection (Cloudflare, etc.) far more than Google
Cloud's IPs do — confirmed live against a real site whose Cloudflare protection blocked Hostinger's
IP outright while Google's own infrastructure fetched the identical page successfully. When a direct
page fetch fails, this makes the app fall back to fetching through the Firebase Cloud Function
instead, at no extra cost since that infrastructure already exists. Skip these two vars and audits
will still work — they'll just be more likely to fail against Cloudflare-protected sites.

### Getting the service-account credentials

Firebase Console → **sound-octagon-444117-m9** → Project Settings (gear icon) → **Service Accounts**
tab → **Generate new private key**. This downloads a `.json` file.

Don't paste its contents into an env var — a real key is 1600+ chars, over Hostinger's env-var field
length limit. Instead, **rename the downloaded file to `service-account.json` and put it directly
inside `functions/` in the zip** (next to `index.js`, *not* inside `hosting/` — `express.static` only
ever serves `hosting/`, so a file placed in `functions/` itself is never reachable over HTTP). The
code (`functions/index.js`) automatically detects and loads it from there if no
`FIREBASE_SERVICE_ACCOUNT_JSON`/`GOOGLE_APPLICATION_CREDENTIALS` env var is set — no extra
configuration needed.

Treat this file like a password — it grants admin access to your Firestore data and user accounts.
It's already covered by `.gitignore` (`service-account.json`); never commit it, and don't keep a copy
of the zip with it included lying around anywhere public.

## 4. Deploy, then check runtime logs — don't guess

Click **Deploy**. If the site 503s or the panel's own AI diagnosis seems off, check the actual
runtime log yourself: hPanel has a **Runtime logs** entry in the site's sidebar, and it's specific —
e.g. *"App did not call listen() within 3 seconds"* is the exact signal for quirk #1 above, not a
generic failure.

## 5. SSL

hPanel → **SSL** (under Security or the domain's settings) → enable **free SSL** for twittence.com.
Hostinger auto-provisions and renews a Let's Encrypt certificate.

## 6. Verify

```
curl https://twittence.com/api/health
curl -I https://twittence.com/
```

Both should return `200`. Then load `https://twittence.com/`, sign in with Google, and run a real
audit.

## Required manual step — Firebase authorized domains

Google Sign-In will fail with `auth/unauthorized-domain` until your domain is added:
Firebase Console → Authentication → Settings → **Authorized domains** → add `twittence.com` (and
`www.twittence.com` if you'll use that too).

## Weekly re-audit email (Task 5)

`POST /api/internal/weekly-reaudit` re-audits every paid user's most recently audited page and emails
score deltas. It's not scheduled automatically — trigger it weekly via hPanel → **Advanced → Cron
Jobs**, once a week (e.g. Monday 09:00):

```
curl -s -X POST -H "x-internal-secret: $INTERNAL_FETCH_SECRET" https://twittence.com/api/internal/weekly-reaudit
```

To test against a single account instead of every paid user (the acceptance-test path), pass a uid:

```
curl -s -X POST -H "x-internal-secret: $INTERNAL_FETCH_SECRET" -H "Content-Type: application/json" \
  -d '{"uid":"<test-uid>"}' https://twittence.com/api/internal/weekly-reaudit
```

Requires `INTERNAL_FETCH_SECRET` and the `SMTP_*` vars (see `.env.production.example`) set on this
deployment — without SMTP configured, the job still runs and records the re-audit, but logs
`Email not sent (SMTP not configured)` instead of sending.

## Redeploying after code changes

Rebuild the zip with the same nested layout (step 1), re-upload through the same Deployments screen,
Deploy again. If SSH access is available on the account (Advanced → SSH Access in hPanel — some
Business plans have it), code and env changes can also be pushed directly to the live version's
folder without a full redeploy — ask whoever has that access for the exact path under
`~/domains/<domain>/hbuilds/versions/<latest-version-id>/nodejs/`.
