# Twittence — AI Visibility Engine

Twittence is a full-stack web application that audits websites across four weighted pillars: SEO (30%), AEO (25%), GEO (25%), and Sentiment (20%). It uses Firebase Hosting, Firebase Auth, Firestore, and Firebase Cloud Functions with an Express.js backend powered by Claude AI.

## Stack

- **Frontend:** Single-page app in `hosting/index.html` using Firebase SDK v10
- **Backend:** Express.js in `functions/index.js` deployed as Firebase Cloud Functions
- **Auth:** Firebase Google Sign-In
- **Database:** Cloud Firestore for audit history
- **AI:** Anthropic Claude SDK for scoring and self-healing plan generation

## Prerequisites

- Node.js >= 18
- Firebase CLI (`npm install -g firebase-tools`)
- A Firebase project with Auth, Firestore, and Functions enabled

## Local Development

1. Install backend dependencies:
   ```bash
   cd functions
   npm install
   ```

2. Create a `.env` file in `functions/`:
   ```env
   ANTHROPIC_API_KEY=your_key_here
   FIREBASE_PROJECT_ID=sound-octagon-444117-m9
   ```

3. Run the backend locally:
   ```bash
   npm start
   ```

4. Serve the frontend (from project root):
   ```bash
   firebase emulators:start --only hosting,functions,firestore,auth
   ```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/run-audit` | Run a single-page 4-pillar audit |
| POST | `/api/site-wide-audit` | Audit all pages discovered via sitemap |
| GET | `/api/health` | Health check |
| GET | `/api/user/history` | List user audit history |
| GET | `/api/output/schema/:id` | Generate Schema.org JSON-LD |
| GET | `/api/output/aeo/:id` | Generate AEO direct answer block |
| GET | `/api/output/llms-txt/:id` | Download `/llms.txt` output |
| GET | `/api/output/history/:id` | Retrieve raw audit data |

## Deployment

```bash
firebase deploy --only hosting,functions
```

## Project Structure

```
twittence/
├── firebase.json
├── .firebaserc
├── TWITTENCE.md
├── functions/
│   ├── .env
│   ├── .gitignore
│   ├── index.js
│   └── package.json
└── hosting/
    └── index.html
```
