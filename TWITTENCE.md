# Twittence.com — Self-Healing SEO / AEO / GEO & Sentiment Engine

**Twittence** is a next-generation web presence and audience intelligence platform. Traditional search engines only tell part of the story. Twittence turns digital chatter across search engines (SEO), voice assistants (AEO), generative AI models (GEO), and social platforms (Sentiment) into a single, actionable visibility metric and self-healing content pipeline.

---

## ⚡ Key Features

* **Unified Twittence Score:** Evaluates modern brand presence across traditional search, direct answers, generative AI models, and cross-platform sentiment.
* **Self-Healing Agent Loop:** Audits pages, researches gaps, generates citable content fixes, and self-verifies output quality before displaying results.
* **Cross-Platform Sentiment Analysis:** Ingests digital chatter across X/Twitter, Reddit, and LLM context windows to resolve consumer skepticism.
* **Machine-Readable Outputs:** Automatically outputs verified Schema.org (`JSON-LD`), AEO direct answer blocks, and root `/llms.txt` files for AI crawlers.
* **Production-Grade Serverless Stack:** Built on Google Cloud / Firebase with Express.js backend proxies protecting external AI API credentials.

---

## 📊 The Twittence Unified Scoring Formula

The platform calculates brand authority using a 4-pillar weighted index ($0–100$):

$$Score_{\text{Twittence}} = (0.30 \times S_{\text{SEO}}) + (0.25 \times S_{\text{AEO}}) + (0.25 \times S_{\text{GEO}}) + (0.20 \times S_{\text{Sentiment}})$$

Where:
* **$S_{\text{SEO}}$ (30%):** Search Engine Optimization (Technical health, backlink velocity, organic rank index).
* **$S_{\text{AEO}}$ (25%):** Answer Engine Optimization (Featured snippets, schema validation, voice readiness).
* **$S_{\text{GEO}}$ (25%):** Generative Engine Optimization (Citation density in ChatGPT, Perplexity, Claude, Gemini).
* **$S_{\text{Sentiment}}$ (20%):** Cross-Platform Sentiment & Chatter Index (Public trust, consumer skepticism, forum sentiment).

---

## 📁 Repository Structure

```text
twittence/
├── firebase.json                 # Firebase Hosting & Function rewrites
├── README.md                     # Project documentation
├── functions/                    # Backend API (Google Cloud Functions v2)
│   ├── .env                      # Server-side secrets (ANTHROPIC_API_KEY)
│   ├── .gitignore                # Excludes node_modules and .env
│   ├── index.js                  # Express API, Auth Middleware & Claude SDK Integration
│   └── package.json              # Backend Node.js dependencies
└── hosting/                      # Frontend Client Application
    └── index.html                # Single-Page App (SPA) UI with Firebase SDK v10
```