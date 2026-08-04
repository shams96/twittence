# Deploying Twittence to a Hostinger VPS

Architecture: this VPS runs the **same** Express app (`functions/index.js`) that currently runs as a
Firebase Cloud Function — it serves the static frontend and the `/api/*` routes from one process on
one origin, so nothing in the frontend needs to change. Firebase Auth and Firestore stay as-is; only
where the compute runs changes.

## One-time VPS setup

```bash
# On the VPS (Ubuntu/Debian assumed)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx
sudo npm install -g pm2
```

## Get the code onto the VPS

This local project isn't a git repo yet. Easiest path:

```bash
# From your local machine
cd "path/to/twittence"
git init && git add -A && git commit -m "Initial commit"
git remote add origin <your-private-repo-url>
git push -u origin main

# On the VPS
git clone <your-private-repo-url> twittence
cd twittence
```

(Or `rsync -av --exclude node_modules --exclude .env ./ user@your-vps:~/twittence/` if you'd rather not use git.)

## Configure secrets

```bash
# On the VPS
cp functions/.env.production.example functions/.env
nano functions/.env   # fill in ANTHROPIC_API_KEY, PAGESPEED_API_KEY, ALLOWED_ORIGINS, GOOGLE_APPLICATION_CREDENTIALS
chmod 600 functions/.env
```

Get the Firebase service-account key (required — a VPS has no automatic GCP credentials the way
Cloud Functions does): Firebase Console → **sound-octagon-444117-m9** → Project Settings → Service
Accounts → **Generate new private key**. Upload the downloaded JSON to the VPS *outside* the repo
(e.g. `/home/deploy/twittence-service-account.json`), `chmod 600` it, and point
`GOOGLE_APPLICATION_CREDENTIALS` at that path.

## Deploy

```bash
chmod +x deploy/deploy.sh
./deploy/deploy.sh
pm2 startup   # follow the printed instructions to persist PM2 across reboots
```

## nginx + TLS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/twittence
sudo sed -i 's/YOUR_DOMAIN/yourdomain.com/g' /etc/nginx/sites-available/twittence
sudo ln -s /etc/nginx/sites-available/twittence /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Certbot rewrites the site config to add real cert paths and auto-renewal.

## Point your Hostinger domain's DNS at the VPS

A records for `@` and `www` → your VPS's IP address. (Domain and VPS may or may not be on the same
Hostinger account/panel — check your Hostinger dashboard for the exact DNS editor.)

## Required manual step — Firebase authorized domains

Google Sign-In will fail with `auth/unauthorized-domain` until you add your new domain:
Firebase Console → Authentication → Settings → **Authorized domains** → Add `yourdomain.com`.
I don't have a way to set this from here — it's a console-only setting.

## Verify

```bash
curl -I https://yourdomain.com/api/health
```

Should return `200` with security headers (`content-security-policy`, `strict-transport-security`,
etc.) present. Then sign in and run a real audit against the live domain.

## Redeploying after code changes

```bash
git pull
./deploy/deploy.sh
```

`pm2 reload` does a zero-downtime restart, so no request is dropped mid-deploy.

## Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # 80 + 443
sudo ufw enable
```

Node itself listens only on `127.0.0.1:3000` (nginx proxies to it) — it's never exposed directly to
the internet, so no firewall rule is needed for port 3000.
