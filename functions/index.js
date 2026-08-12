require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");
const { Anthropic } = require("@anthropic-ai/sdk");
const cheerio = require("cheerio");
const he = require("he");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

// Live citation tracking (Google AI Overview / ChatGPT / Perplexity) needs a paid third-party SERP
// data provider — there's no free API for this. Both the "bring your own key" and "buy credits" paths
// are inert until these are configured; nothing here fabricates data or fakes a working integration.
const CITATION_ENCRYPTION_SECRET = process.env.CITATION_KEY_ENCRYPTION_SECRET;
const CITATION_PROVIDER_LOGIN = process.env.CITATION_PROVIDER_LOGIN; // Twittence's own DataForSEO login (managed/credits path)
const CITATION_PROVIDER_PASSWORD = process.env.CITATION_PROVIDER_PASSWORD;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const CREDIT_PACK_PRICE_USD = Number(process.env.CREDIT_PACK_PRICE_USD || 9);
const CREDIT_PACK_SIZE = Number(process.env.CREDIT_PACK_SIZE || 10);
const stripe = STRIPE_SECRET_KEY ? require("stripe")(STRIPE_SECRET_KEY) : null;

function encryptSecret(plaintext) {
  if (!CITATION_ENCRYPTION_SECRET) throw new Error("CITATION_KEY_ENCRYPTION_SECRET is not configured");
  const key = crypto.scryptSync(CITATION_ENCRYPTION_SECRET, "twittence-citation-salt", 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

function decryptSecret(stored) {
  if (!CITATION_ENCRYPTION_SECRET) throw new Error("CITATION_KEY_ENCRYPTION_SECRET is not configured");
  const [ivB64, authTagB64, ciphertextB64] = stored.split(":");
  const key = crypto.scryptSync(CITATION_ENCRYPTION_SECRET, "twittence-citation-salt", 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]).toString("utf8");
}

const app = express();
const PORT = process.env.PORT || 3000;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "sound-octagon-444117-m9";
// Firebase and a VPS keep hosting/ as a sibling of functions/ (the repo's real layout). Hostinger's
// Node.js App deploy only keeps the selected Application root in the running version and drops
// sibling folders from the uploaded zip entirely — so hosting/ has to be bundled inside functions/
// for that target instead. Support both without restructuring the repo itself.
const siblingHostingDir = path.resolve(__dirname, "..", "hosting");
const bundledHostingDir = path.resolve(__dirname, "hosting");
const hostingDir = fs.existsSync(siblingHostingDir) ? siblingHostingDir : bundledHostingDir;

// On Cloud Functions, application-default credentials are provided automatically. Off Google Cloud
// (a Hostinger VPS or shared-hosting Node.js app), there's no automatic credential source, so this
// falls back to an explicit service-account key — either as a file path (GOOGLE_APPLICATION_CREDENTIALS,
// convenient on a VPS you control) or as the key's JSON pasted directly into an env var
// (FIREBASE_SERVICE_ACCOUNT_JSON, needed on shared hosting where you can't place files outside the
// web root and the panel's UI is env-vars-only). See functions/.env.production.example.
let firebaseCredential;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  firebaseCredential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
}
admin.initializeApp({
  projectId: FIREBASE_PROJECT_ID,
  ...(firebaseCredential ? { credential: firebaseCredential } : {}),
});

const db = admin.firestore();
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Behind a reverse proxy (nginx on the VPS) req.ip/X-Forwarded-For is only trustworthy once this is
// set — required for rate limiting to key on the real client IP instead of the proxy's.
app.set("trust proxy", 1);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : [
      "https://sound-octagon-444117-m9.firebaseapp.com",
      "https://*.firebaseapp.com",
      "http://localhost:*",
      "http://127.0.0.1:*",
    ];

// Helmet must run before express.static — otherwise static file responses (the actual HTML/CSS/JS
// every visitor loads) short-circuit the middleware chain and ship with zero security headers.
app.use(
  helmet({
    // Helmet's default Cross-Origin-Opener-Policy ("same-origin") isolates a popup window from its
    // opener, breaking the window.closed/postMessage handshake Firebase's signInWithPopup relies on
    // — it misreports the popup as closed even while it's still open and working (confirmed live:
    // the "Auth failed" toast fired while the Google account picker was still visibly on screen).
    // "same-origin-allow-popups" keeps the isolation for everything except windows this page opens.
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://www.gstatic.com"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: [
          "'self'",
          "https://*.googleapis.com",
          "https://securetoken.googleapis.com",
          "https://identitytoolkit.googleapis.com",
          "wss://*.firebaseio.com",
        ],
        frameSrc: ["https://sound-octagon-444117-m9.firebaseapp.com", "https://accounts.google.com"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
  })
);

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(express.static(hostingDir, { extensions: ["html"] }));

// Stripe webhook signature verification needs the exact raw request body, so this route (and only
// this one) must be registered with express.raw() *before* the global express.json() parser below —
// once express.json() has consumed and re-serialized the body, signature verification would fail.
app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: "Billing is not configured" });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return res.status(400).json({ error: "Invalid signature" });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const uid = session.client_reference_id;
    const credits = Number(session.metadata?.credits || 0);
    if (uid && credits > 0) {
      // Idempotency guard: Stripe retries webhook delivery on any non-2xx response or timeout, so the
      // same "checkout.session.completed" event can arrive more than once. A transaction keyed on the
      // Stripe event ID ensures credits are only ever granted once per completed checkout, even if
      // this handler is invoked for the same session multiple times.
      const eventRef = db.collection("processedStripeEvents").doc(event.id);
      const userRef = db.collection("users").doc(uid);
      try {
        await db.runTransaction(async (tx) => {
          const eventDoc = await tx.get(eventRef);
          if (eventDoc.exists) return; // already processed, no-op
          tx.set(eventRef, { processedAt: admin.firestore.FieldValue.serverTimestamp(), sessionId: session.id });
          tx.set(userRef, { citationCredits: admin.firestore.FieldValue.increment(credits) }, { merge: true });
        });
      } catch (err) {
        console.error("Failed to credit citation purchase:", err.message);
        return res.status(500).json({ error: "Failed to process payment" });
      }
    }
  }

  res.status(200).json({ received: true });
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Cloud Functions has its own platform-level abuse protection; a VPS has none by default, so this is
// the app's own defense against a runaway client hammering the expensive Claude+PSI-backed endpoints.
const auditLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many audit requests from this IP. Please try again later." },
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests from this IP. Please try again later." },
});
app.use("/api/", apiLimiter);
app.use(["/api/run-audit", "/api/site-wide-audit"], auditLimiter);

async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const token = authHeader.split("Bearer ")[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error("Token verification failed:", error.message);
    return res.status(401).json({ error: "Invalid or expired authentication token" });
  }
}

const BLOCKED_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|zip|rar|exe|mp4|mp3|wav|avi|mov|mkv|woff|woff2|ttf|eot|css|js|map)(\?.*)?$/i;

function validateUrl(url) {
  const errors = [];
  if (!url || typeof url !== "string" || !url.trim()) {
    errors.push("url is required and must be a non-empty string");
  } else if (!/^https?:\/\/.+/.test(url.trim())) {
    errors.push("url must be a valid HTTP or HTTPS address");
  } else if (BLOCKED_EXTENSIONS.test(url.trim())) {
    errors.push("url points to a binary file (image, pdf, etc.) — please provide an html page url");
  }
  return errors;
}

function validateAuditPayload(body) {
  const errors = [];
  errors.push(...validateUrl(body.url));

  if (!body.topic || typeof body.topic !== "string" || !body.topic.trim()) {
    errors.push("topic is required and must be a non-empty string");
  } else if (body.topic.trim().length > 200) {
    errors.push("topic must be 200 characters or fewer");
  }

  const validVerticals = ["all", "technical", "seo", "aeo", "geo", "sentiment", "content", "local", "ppc", "social", "email"];
  if (!body.vertical || typeof body.vertical !== "string" || !body.vertical.trim()) {
    errors.push("vertical is required and must be a non-empty string");
  } else if (!validVerticals.includes(body.vertical.trim().toLowerCase())) {
    errors.push("vertical must be one of: " + validVerticals.join(", "));
  }

  return errors;
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const protocol = parsed.protocol === "https:" ? https : null;
    if (!protocol) return reject(new Error("Only HTTP/HTTPS URLs are supported"));

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent": "TwittenceBot/1.0 (Audit Agent; +https://twittence.com)",
        "Accept": "text/html,application/xhtml+xml",
      },
      timeout: 15000,
    };

    const req = protocol.request(options, (res) => {
      // A non-2xx response (rate limiting, bot-blocking, a dead page) is not the real page — analyzing
      // its body as if it were would silently produce a misleadingly low/wrong score. Confirmed live:
      // a site's Cloudflare rate limiting returned a tiny 429 body that got scored as an empty page.
      if (res.statusCode < 200 || res.statusCode >= 300) {
        req.destroy();
        const err = new Error(`URL returned HTTP ${res.statusCode} — the page may be blocking automated requests (rate limiting, bot protection) or temporarily unavailable.`);
        err.statusCode = res.statusCode;
        return reject(err);
      }

      const contentType = (res.headers["content-type"] || "").toLowerCase();
      if (!contentType.includes("html") && !contentType.includes("xhtml") && !contentType.includes("text")) {
        req.destroy();
        return reject(new Error(`URL returned non-html content type: ${contentType}. Please provide an html page url.`));
      }

      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, html: data, headers: res.headers }));
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Fetch timeout")); });
    req.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A 429/503 is often a temporary window (Cloudflare rate limiting, a brief upstream hiccup), not a
// permanent block — one or two short retries can succeed for free where an immediate failure
// wouldn't. Anything else (403, timeout, DNS failure) isn't worth retrying.
async function fetchHtmlWithRetry(url, retries = 2) {
  const delays = [1000, 3000];
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchHtml(url);
    } catch (err) {
      lastError = err;
      const retryable = err.statusCode === 429 || err.statusCode === 503;
      if (!retryable || attempt === retries) throw err;
      await sleep(delays[attempt] || 3000);
    }
  }
  throw lastError;
}

function postJson(targetUrl, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers },
      timeout: timeoutMs || 25000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Proxy fetch returned HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("Proxy fetch returned invalid JSON")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Proxy fetch timeout")); });
    req.write(payload);
    req.end();
  });
}

// A shared cheap-hosting IP (Hostinger) gets a worse bot-reputation score from services like
// Cloudflare than Google Cloud's IP ranges do — confirmed live: nutrifysupp.com's Cloudflare
// protection returned 429 "local_rate_limited" to Hostinger's IP while Google's own infrastructure
// (via the PageSpeed Insights API, same origin, same site) fetched the identical page successfully.
// Rather than fighting IP reputation with paid rotating-proxy services, this routes a failed direct
// fetch through the Firebase Cloud Function instead — infrastructure this project already runs, at
// no extra cost. Only activates when FETCH_PROXY_URL + INTERNAL_FETCH_SECRET are configured (e.g.
// on the Hostinger deployment, pointed at the Firebase function); a no-op everywhere else, including
// on Firebase itself, where there's no better IP to fall back to.
async function fetchHtmlWithFallback(url) {
  try {
    return await fetchHtmlWithRetry(url);
  } catch (directError) {
    if (!process.env.FETCH_PROXY_URL || !process.env.INTERNAL_FETCH_SECRET) throw directError;
    console.error("Direct fetch failed, trying proxy fallback:", directError.message);
    try {
      const proxied = await postJson(
        `${process.env.FETCH_PROXY_URL}/api/internal/fetch-proxy`,
        { url },
        { "X-Internal-Secret": process.env.INTERNAL_FETCH_SECRET },
        25000
      );
      if (!proxied.html) throw new Error("Proxy fallback returned no HTML");
      return { statusCode: proxied.statusCode, html: proxied.html, headers: {} };
    } catch (proxyError) {
      console.error("Proxy fallback also failed:", proxyError.message);
      throw directError;
    }
  }
}

// Google's own Lighthouse SEO score via the PageSpeed Insights API — a credible, independently-
// verifiable external benchmark for the SEO pillar specifically. Requires PAGESPEED_API_KEY (free,
// see functions/.env.example) since the unauthenticated shared quota is effectively unusable in
// practice. PSI itself can be slow, so this is time-boxed and allowed to fail silently — a missing
// external score should never block the audit itself.
function fetchPageSpeedInsights(url) {
  return new Promise((resolve) => {
    if (!process.env.PAGESPEED_API_KEY) return resolve(null);
    const apiUrl =
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}` +
      `&category=SEO&category=PERFORMANCE&category=ACCESSIBILITY&category=BEST_PRACTICES&strategy=mobile` +
      `&key=${encodeURIComponent(process.env.PAGESPEED_API_KEY)}`;
    const parsed = new URL(apiUrl);

    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      timeout: 25000,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const categories = json.lighthouseResult?.categories;
          if (!categories) return resolve(null);
          resolve({
            source: "Google PageSpeed Insights (Lighthouse)",
            seoScore: categories.seo ? Math.round(categories.seo.score * 100) : null,
            performanceScore: categories.performance ? Math.round(categories.performance.score * 100) : null,
            accessibilityScore: categories.accessibility ? Math.round(categories.accessibility.score * 100) : null,
            bestPracticesScore: categories["best-practices"] ? Math.round(categories["best-practices"].score * 100) : null,
          });
        } catch (_) {
          resolve(null);
        }
      });
    });

    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function analyzeSeo($, html) {
  const checks = {
    titleLength: null,
    metaDescription: null,
    hasH1: false,
    hasCanonical: false,
    hasOGTags: false,
    hasStructuredData: false,
    headingStructure: [],
    internalLinks: 0,
    externalLinks: 0,
    imagesWithoutAlt: 0,
    totalImages: 0,
    pageLoadBlockedResources: [],
  };

  const title = $("title").first().text().trim();
  checks.titleLength = title.length;

  const metaDesc = $('meta[name="description"]').attr("content");
  checks.metaDescription = metaDesc ? metaDesc.length : 0;

  checks.hasH1 = $("h1").length > 0;
  checks.hasCanonical = $("link[rel='canonical']").length > 0;
  checks.hasOGTags = $('meta[property^="og:"]').length > 0;
  checks.hasStructuredData = $("script[type='application/ld+json']").length > 0;

  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    checks.headingStructure.push({ level: parseInt(el.name.slice(1)), text: $(el).text().trim().substring(0, 80) });
  });

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href && href.startsWith("http")) checks.externalLinks++;
    else if (href && !href.startsWith("#") && !href.startsWith("javascript")) checks.internalLinks++;
  });

  $("img").each((_, el) => {
    checks.totalImages++;
    if (!$(el).attr("alt")) checks.imagesWithoutAlt++;
  });

  let seoScore = 0;
  const maxPoints = 100;
  const weights = {
    titleLength: 12,
    metaDescription: 10,
    hasH1: 8,
    hasCanonical: 6,
    hasOGTags: 4,
    hasStructuredData: 6,
    headingStructure: 12,
    internalLinks: 8,
    externalLinks: 6,
    imagesWithoutAlt: 14,
  };

  if (checks.titleLength >= 30 && checks.titleLength <= 60) seoScore += weights.titleLength;

  if (checks.metaDescription >= 50 && checks.metaDescription <= 160) seoScore += weights.metaDescription;
  if (checks.metaDescription === 0) seoScore += 2;

  if (checks.hasH1) seoScore += weights.hasH1;
  if (checks.hasCanonical) seoScore += weights.hasCanonical;
  if (checks.hasOGTags) seoScore += weights.hasOGTags;
  if (checks.hasStructuredData) seoScore += weights.hasStructuredData;

  const h1Count = checks.headingStructure.filter((h) => h.level === 1).length;
  if (h1Count === 1) seoScore += weights.headingStructure;

  if (checks.internalLinks > 3) seoScore += weights.internalLinks;
  if (checks.externalLinks > 1) seoScore += weights.externalLinks;

  const altRatio = checks.totalImages > 0 ? (checks.totalImages - checks.imagesWithoutAlt) / checks.totalImages : 1;
  seoScore += Math.round(weights.imagesWithoutAlt * altRatio);

  checks.seoScore = Math.min(100, Math.max(0, seoScore));
  return checks;
}

function analyzeAeo($, html) {
  const checks = {
    hasFAQsSchema: false,
    hasHowToSchema: false,
    faqsCount: 0,
    howToSteps: null,
    voiceReadability: 0,
    directAnswerLikelihood: 0,
  };

  const ldJsonScripts = $("script[type='application/ld+json']");
  ldJsonScripts.each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const items = Array.isArray(json) ? json : [json];
      items.forEach((item) => {
        if (item["@type"] === "FAQPage") {
          checks.hasFAQsSchema = true;
          checks.faqsCount = item.mainEntity ? item.mainEntity.length : 0;
        }
        if (item["@type"] === "HowTo") {
          checks.hasHowToSchema = true;
          checks.howToSteps = item.step ? item.step.length : 0;
        }
      });
    } catch (_) { /* skip invalid JSON-LD */ }
  });

  const paragraphs = $("p").map((_, el) => $(el).text().trim()).get().filter((t) => t.length > 20);
  const avgWords = paragraphs.length > 0
    ? paragraphs.reduce((sum, p) => sum + p.split(/\s+/).length, 0) / paragraphs.length
    : 0;
  checks.voiceReadability = avgWords > 0 && avgWords < 15 ? 80 : avgWords <= 20 ? 60 : 40;

  const answerParagraphs = paragraphs.filter((p) => p.length > 40 && p.length < 300);
  checks.directAnswerLikelihood = Math.min(100, Math.round((answerParagraphs.length / Math.max(paragraphs.length, 1)) * 100));

  let aeoScore = 0;
  if (checks.hasFAQsSchema) aeoScore += 25;
  if (checks.hasHowToSchema) aeoScore += 20;
  if (checks.faqsCount > 0) aeoScore += 15;
  aeoScore += Math.round(checks.voiceReadability * 0.3);
  aeoScore += Math.round(checks.directAnswerLikelihood * 0.3);
  checks.aeoScore = Math.min(100, aeoScore);
  return checks;
}

const GENERIC_TOPIC_VALUES = new Set(["all", "run all", ""]);
const QUESTION_HEADING_PATTERN = /^(what|how|why|when|where|who|which|can|should|is|are|does|do|will|would|could)\b/i;

// Shared by analyzeGeo and analyzeContent — AI citation research (Princeton's GEO study, 2026
// practitioner guides) consistently ties named-author attribution and content freshness to whether
// generative engines treat a page as citable, not just whether Google can crawl it.
function detectAuthorityAndFreshness($) {
  const hasAuthor = $("[rel='author'], [class*='author' i], meta[name='author']").length > 0;
  const authorHasExternalLink = $("[class*='author' i] a[href*='linkedin'], a[rel='author'][href]").length > 0;
  const hasDatePublished = $("time, [datetime], meta[property='article:published_time']").length > 0;
  const hasDateModified = $("meta[property='article:modified_time'], time[itemprop='dateModified']").length > 0;

  const dtAttr = $("time[datetime]").first().attr("datetime")
    || $("meta[property='article:modified_time']").attr("content")
    || $("meta[property='article:published_time']").attr("content");
  let isRecentlyUpdated = false;
  if (dtAttr) {
    const parsed = new Date(dtAttr);
    if (!isNaN(parsed.getTime())) {
      const monthsAgo = (Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24 * 30);
      isRecentlyUpdated = monthsAgo <= 18;
    }
  }

  return { hasAuthor, authorHasExternalLink, hasDatePublished, hasDateModified, isRecentlyUpdated };
}

// Heuristic proxy for "does the page lead with a direct answer" (AI retrieval research says
// generative engines weigh a page's opening content heavily — the first ~200 words should answer
// the query, not build up to it). True intent detection needs NLP; this checks whether a
// substantive paragraph (15+ words) appears among the first content blocks once nav/header/footer
// chrome is stripped out, as a deterministic stand-in for "gets to the point quickly."
function hasEarlyDirectAnswer($) {
  const main = $.root().clone();
  main.find("nav, header, footer, script, style").remove();
  const blocks = main.find("p, li").toArray();
  for (let i = 0; i < Math.min(blocks.length, 5); i++) {
    const wordCount = $(blocks[i]).text().trim().split(/\s+/).filter(Boolean).length;
    if (wordCount >= 15) return true;
  }
  return false;
}

// AI retrieval consistently favors headings phrased as the literal question a user would type —
// "What is X" beats "X Overview" for extraction into a conversational answer.
function analyzeHeadingQuestions($) {
  const headings = $("h2, h3, h4").map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const questionHeadings = headings.filter((h) => h.endsWith("?") || QUESTION_HEADING_PATTERN.test(h));
  return { totalHeadings: headings.length, questionHeadings: questionHeadings.length };
}

// FAQ *presence* is necessary but not sufficient — research ties citation likelihood to answers
// sized for extraction (roughly 40-160 words: long enough to be a complete answer, short enough to
// lift verbatim into a generated response).
function analyzeFaqQuality($) {
  let hasFAQ = false;
  let totalQuestions = 0;
  let wellSizedAnswers = 0;
  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const items = Array.isArray(json) ? json : [json];
      items.forEach((item) => {
        if (item["@type"] === "FAQPage" && Array.isArray(item.mainEntity)) {
          hasFAQ = true;
          item.mainEntity.forEach((q) => {
            totalQuestions++;
            const answerText = q.acceptedAnswer && q.acceptedAnswer.text ? String(q.acceptedAnswer.text) : "";
            const wordCount = answerText.split(/\s+/).filter(Boolean).length;
            if (wordCount >= 40 && wordCount <= 160) wellSizedAnswers++;
          });
        }
      });
    } catch (_) { /* skip invalid JSON-LD */ }
  });
  return { hasFAQ, totalQuestions, wellSizedAnswers };
}

// GEO Layer-1 signal: "information gain" — original/proprietary data and specific figures an LLM
// can't already synthesize from web consensus (a named study, "we surveyed N", a specific %/stat)
// beats generic restated claims. Business-agnostic: triggers on the language pattern, not a vertical.
function hasOriginalDataSignal(bodyText) {
  const originalDataLanguage = /\bwe (surveyed|tested|analyzed|studied)\b|\bour (research|study|data|analysis) (shows?|found|reveals?)\b|\bproprietary\b|\bin a study of\b|\bproprietary data\b|\bfirst-party data\b|\bexclusive data\b/i.test(bodyText);
  const statMatches = bodyText.match(/\b\d+(\.\d+)?%|\b\d{2,}\s*(participants|users|patients|respondents|customers|studies)\b/gi) || [];
  return { hasOriginalDataLanguage: originalDataLanguage, statDensity: statMatches.length };
}

// GEO Layer-1 signal: scannability — tables and well-formed lists are what RAG/snippet extraction
// lifts cleanly; dense unbroken paragraphs are not.
function analyzeScannability($) {
  const hasTable = $("table").length > 0;
  const listItems = $("li").length;
  const paragraphs = $("p").length;
  const hasGoodListDensity = listItems >= 3 && listItems >= paragraphs * 0.3;
  return { hasTable, listItems, hasGoodListDensity };
}

// GEO Layer-1 signal: authoritative citations & clinical/expert signal — external links to
// high-trust reference domains, and language patterns for expert/clinical attribution. Auto-detected
// from content so it applies equally to a cited Gartner stat on a SaaS page or a dermatologist quote
// on a skincare page — no vertical hardcoding, per the engine's business-agnostic design.
function analyzeAuthoritativeCitations($, bodyText) {
  const citationLinkPattern = /\.gov\/|\.edu\/|pubmed\.ncbi|doi\.org|scholar\.google/i;
  const externalCitationLinks = $("a[href]").toArray().filter((el) => citationLinkPattern.test($(el).attr("href") || "")).length;
  const hasExpertOrClinicalLanguage = /\bdr\.\s|\bdermatologist\b|\bclinically (proven|tested)\b|\bpeer-review(ed)?\b|\bclinical (trial|study)\b|\bpublished in\b|\baccording to (a |the )?(study|research|report)\b|\bmd\b,|\bphd\b/i.test(bodyText);
  return { externalCitationLinks, hasExpertOrClinicalLanguage };
}

function detectSchemaTypes($) {
  const types = new Set();
  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const items = Array.isArray(json) ? json : [json];
      items.forEach((item) => { if (item["@type"]) types.add(String(item["@type"])); });
    } catch (_) { /* skip invalid JSON-LD */ }
  });
  return types;
}

// Rebuilt around AI-citation research rather than keyword density: rank-#1-on-Google only
// correlates with ~31% AI-citation odds and drops to ~2.6% by rank #4 (90% of pages AI actually
// cites rank #21+ on Google) — GEO and traditional SEO are measurably different games, so this no
// longer scores primarily on how often the topic's words appear on the page. Structural
// extractability (does the page lead with an answer, are headings phrased as real questions, are
// FAQ answers sized for lifting into a response) and authority/freshness signals are what the
// research ties to actual citation likelihood.
function analyzeGeo($, html, url, topic) {
  const authority = detectAuthorityAndFreshness($);
  const headingQ = analyzeHeadingQuestions($);
  const faqQuality = analyzeFaqQuality($);
  const schemaTypes = detectSchemaTypes($);
  const hasArticleSchema = ["Article", "BlogPosting", "NewsArticle"].some((t) => schemaTypes.has(t));

  const pageText = $("body").text() || "";
  const wordCount = pageText.split(/\s+/).filter((w) => w.length > 2).length;
  const originalData = hasOriginalDataSignal(pageText);
  const scannability = analyzeScannability($);
  const citations = analyzeAuthoritativeCitations($, pageText);

  // Kept as informational context only (surfaced to findings/recommendations), not a scoring
  // input — "does this page even seem to be about the stated topic" is a sanity check, not the
  // primary measure of AI-citation readiness the way it used to be.
  let topicWords = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (topicWords.length === 0 || GENERIC_TOPIC_VALUES.has(topic.trim().toLowerCase())) {
    const titleText = $("title").first().text() || "";
    const h1Text = $("h1").first().text() || "";
    topicWords = (titleText + " " + h1Text)
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .filter((w, i, arr) => arr.indexOf(w) === i)
      .slice(0, 12);
  }
  const pageTextLower = pageText.toLowerCase();
  const topicKeywordsPresent = topicWords.filter((w) => pageTextLower.includes(w)).length;

  const checks = {
    wordCount,
    hasEarlyDirectAnswer: hasEarlyDirectAnswer($),
    totalHeadings: headingQ.totalHeadings,
    questionPhrasedHeadings: headingQ.questionHeadings,
    questionHeadingRatio: headingQ.totalHeadings > 0
      ? Math.round((headingQ.questionHeadings / headingQ.totalHeadings) * 100)
      : 0,
    hasFAQSchema: faqQuality.hasFAQ,
    faqQuestionCount: faqQuality.totalQuestions,
    faqWellSizedAnswers: faqQuality.wellSizedAnswers,
    hasHowToSchema: schemaTypes.has("HowTo"),
    hasArticleSchema,
    schemaTypesFound: Array.from(schemaTypes),
    hasAuthor: authority.hasAuthor,
    authorHasExternalLink: authority.authorHasExternalLink,
    hasDatePublished: authority.hasDatePublished,
    hasDateModified: authority.hasDateModified,
    isRecentlyUpdated: authority.isRecentlyUpdated,
    topicRelevance: Math.min(100, Math.round((topicKeywordsPresent / Math.max(topicWords.length, 1)) * 100)),
    hasOriginalDataLanguage: originalData.hasOriginalDataLanguage,
    statDensity: originalData.statDensity,
    hasTable: scannability.hasTable,
    hasGoodListDensity: scannability.hasGoodListDensity,
    externalCitationLinks: citations.externalCitationLinks,
    hasExpertOrClinicalLanguage: citations.hasExpertOrClinicalLanguage,
  };

  // Six-dimension rebalance (100 pts total) covering the full GEO Layer-1 rubric: Direct Answer &
  // Structure, Information Gain, Schema Clarity, Authoritative Citations, Scannability, Freshness —
  // FAQ/schema/heading signals folded in rather than scored standalone to avoid double-counting.
  let geoScore = 0;
  // A) Direct Answer & Structure — 20
  geoScore += checks.hasEarlyDirectAnswer ? 12 : 0;
  geoScore += Math.min(8, Math.round(checks.questionHeadingRatio * 0.08));
  // B) Information Gain / Original Data — 15
  geoScore += checks.hasOriginalDataLanguage ? 10 : 0;
  geoScore += Math.min(5, checks.statDensity);
  // C) Schema & Structural Clarity — 15
  geoScore += (checks.hasFAQSchema ? 6 : 0) + (checks.hasHowToSchema ? 4 : 0) + (checks.hasArticleSchema ? 3 : 0);
  geoScore += checks.hasFAQSchema ? Math.round((checks.faqWellSizedAnswers / Math.max(checks.faqQuestionCount, 1)) * 2) : 0;
  // D) Authoritative Entities & Citations — 20
  geoScore += (checks.hasAuthor ? 5 : 0) + (checks.authorHasExternalLink ? 3 : 0);
  geoScore += Math.min(7, checks.externalCitationLinks * 2);
  geoScore += checks.hasExpertOrClinicalLanguage ? 5 : 0;
  // E) Scannability & Formatting — 15
  geoScore += checks.hasTable ? 6 : 0;
  geoScore += checks.hasGoodListDensity ? 6 : 0;
  geoScore += wordCount > 300 ? 3 : 0;
  // F) Freshness — 15
  geoScore += (checks.hasDatePublished ? 7 : 0) + (checks.isRecentlyUpdated ? 8 : 0);
  geoScore += (checks.hasAuthor ? 6 : 0) + (checks.authorHasExternalLink ? 4 : 0);
  checks.geoScore = Math.min(100, geoScore);
  return checks;
}

function analyzeSentiment(html) {
  const checks = {
    trustSignals: 0,
    skepticismTriggers: 0,
    trustRatio: 0,
    hasContactPage: false,
    hasPrivacyPolicy: false,
    hasTermsOfService: false,
    hasTestimonials: false,
    hasTrustBadges: false,
  };

  const $ = cheerio.load(html);
  const bodyText = $("body").text() || "";

  // Word-boundary matched — plain substring matching previously counted "but" inside
  // "about"/"distribute"/"button" etc., inflating skepticism on any long-form page regardless
  // of industry. Only genuine pressure-tactic phrases are treated as skepticism triggers;
  // generic connectives ("but", "however") carry no real signal and were removed. A disclaimer
  // is a transparency signal, not a red flag, so it was moved out of the skepticism list.
  const trustKeywords = ["verified", "trusted", "secure", "certified", "guaranteed", "award", "testimonial", "review", "privacy", "compliant", "gdpr", "ssl", "encryption", "disclaimer"];
  const skepticismKeywords = ["free trial", "cancel anytime", "no commitment", "limited time", "act now", "hurry", "scarcity", "guaranteed results", "risk-free"];

  trustKeywords.forEach((kw) => {
    const regex = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    const matches = bodyText.match(regex);
    if (matches) checks.trustSignals += matches.length;
  });

  skepticismKeywords.forEach((kw) => {
    const regex = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    const matches = bodyText.match(regex);
    if (matches) checks.skepticismTriggers += matches.length;
  });

  checks.hasContactPage = $("a[href*='contact'], a[href*='Contact']").length > 0;
  checks.hasPrivacyPolicy = $("a[href*='privacy'], a[href*='Privacy']").length > 0;
  checks.hasTermsOfService = $("a[href*='terms'], a[href*='Terms']").length > 0;
  checks.hasTestimonials = /testimonial|review|case study/gi.test(bodyText);
  checks.hasTrustBadges = /ssl|secure|verified|trusted|certified|norton|mcafee|bbb|better business/i.test(bodyText);

  checks.trustRatio = checks.trustSignals > 0
    ? Math.round((checks.trustSignals / Math.max(checks.trustSignals + checks.skepticismTriggers, 1)) * 100)
    : 50;

  let sentimentScore = checks.trustRatio;
  if (checks.hasContactPage) sentimentScore += 5;
  if (checks.hasPrivacyPolicy) sentimentScore += 5;
  if (checks.hasTermsOfService) sentimentScore += 5;
  if (checks.hasTestimonials) sentimentScore += 10;
  if (checks.hasTrustBadges) sentimentScore += 10;
  if (checks.trustSignals === 0) sentimentScore -= 10;

  checks.sentimentScore = Math.min(100, Math.max(0, sentimentScore));
  return checks;
}

function analyzeContent($, html) {
  const authority = detectAuthorityAndFreshness($);
  const checks = {
    wordCount: 0,
    headingCount: 0,
    hasDatePublished: authority.hasDatePublished,
    hasAuthor: authority.hasAuthor,
    internalLinkDepth: 0,
  };
  const bodyText = $("body").text() || "";
  checks.wordCount = bodyText.split(/\s+/).filter((w) => w.length > 2).length;
  checks.headingCount = $("h1, h2, h3, h4, h5, h6").length;
  checks.internalLinkDepth = $("a[href^='/'], a[href*='" + "://" + "']").length;

  let contentScore = 0;
  contentScore += checks.wordCount > 1200 ? 35 : checks.wordCount > 600 ? 22 : checks.wordCount > 200 ? 10 : 3;
  contentScore += Math.min(25, checks.headingCount * 4);
  contentScore += checks.hasDatePublished ? 15 : 0;
  contentScore += checks.hasAuthor ? 10 : 0;
  contentScore += Math.min(15, checks.internalLinkDepth);
  checks.contentScore = Math.min(100, contentScore);
  return checks;
}

// Google's Gemini-powered "Ask Maps" local results weigh attribute-rich content (pricing, fit
// guidance, problem specificity) over proximity — a real, recent shift away from the "near me"
// ranking factors local SEO has relied on for a decade. These are the deterministic proxies for
// that "trust content" pattern: does the page actually say what things cost, who it's/isn't a good
// fit for, what specific problems it addresses, and how options compare — rather than just
// asserting local presence via an address and a phone number.
function analyzeLocalAttributeContent(bodyText) {
  return {
    hasPricingContent: /\$\d|\bprice[sd]?\b|\bpricing\b|\bcost[s]?\b|\bstarting at\b|\bquote\b|\bestimate\b/i.test(bodyText),
    hasFitGuidance: /\bnot (a )?(good )?fit\b|\bideal for\b|\bbest for\b|\bisn'?t right for\b|\bwho (this|it) is for\b|\bnot recommended for\b/i.test(bodyText),
    hasProblemContent: /\bcommon (problem|issue)s?\b|\bsymptoms? of\b|\bsigns? of\b|\bwhy (does|is|do)\b|\bissues? with\b|\btroubleshoot/i.test(bodyText),
    hasComparisonContent: /\bvs\.?\b|\bversus\b|\bcompared to\b|\brepair or replace\b|\bwhich is better\b|\bpros and cons\b/i.test(bodyText),
  };
}

// "Local" relevance splits into two structurally different models, and a business-agnostic engine
// can't assume which one applies: (1) own-location businesses (a plumber, a dentist) where the
// business itself is the place someone travels to, vs. (2) DTC/product brands with no storefront of
// their own, whose local relevance is "where can someone buy this near them" via third-party
// retailers — the model Google's Local Inventory Ads / "See what's in store" is built around, keyed
// off Schema.org Offer.availableAtOrFrom. A skincare DTC brand stocked at a retailer and a local
// HVAC company are both legitimately "strong on local" but via entirely different signals — score
// both signal groups and let whichever applies actually count, rather than assuming one model.
function analyzeRetailAvailability($, bodyText) {
  const stockistLinkPattern = /store.?locator|find.{0,3}(a )?store|find.{0,3}in.?store|find.{0,3}us|stockists?|where.?to.?buy|retail.?locations?|carried.?at|find.?a.?retailer/i;
  const hasStockistLink = $("a").toArray().some((el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text() || "";
    return stockistLinkPattern.test(href) || stockistLinkPattern.test(text);
  });

  const hasRetailAvailabilityLanguage = /\b(available|carried|sold|now in stores?|find (it|us)) at\b|\bin stores? near you\b|\bauthorized (retailer|dealer)s?\b|\bstockists?\b/i.test(bodyText);

  let hasAvailableAtOrFromSchema = false;
  let hasMultiSellerOffers = false;
  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        const offers = Array.isArray(item.offers) ? item.offers : item.offers ? [item.offers] : [];
        if (offers.some((o) => o && o.availableAtOrFrom)) hasAvailableAtOrFromSchema = true;
        if (offers.length > 1 || offers.some((o) => o && Array.isArray(o.seller))) hasMultiSellerOffers = true;
      }
    } catch (_) { /* skip invalid JSON-LD */ }
  });

  return { hasStockistLink, hasRetailAvailabilityLanguage, hasAvailableAtOrFromSchema, hasMultiSellerOffers };
}

function analyzeLocal($, html) {
  const bodyText = $("body").text() || "";
  const attributeContent = analyzeLocalAttributeContent(bodyText);
  const retailAvailability = analyzeRetailAvailability($, bodyText);
  const checks = {
    hasPhoneNumber: /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(bodyText),
    hasAddressPattern: /\d{1,5}\s+[\w\s]{2,30}\s+(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln)\b/i.test(bodyText),
    hasLocalBusinessSchema: false,
    hasMapEmbed: $("iframe[src*='google.com/maps'], iframe[src*='maps.google']").length > 0,
    ...attributeContent,
    ...retailAvailability,
  };
  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const items = Array.isArray(json) ? json : [json];
      if (items.some((item) => /LocalBusiness|Organization/.test(item["@type"] || ""))) {
        checks.hasLocalBusinessSchema = true;
      }
    } catch (_) { /* skip invalid JSON-LD */ }
  });

  // Own-location signals (max 35) — a physical business people travel to.
  let ownLocationScore = 0;
  if (checks.hasPhoneNumber) ownLocationScore += 10;
  if (checks.hasAddressPattern) ownLocationScore += 10;
  if (checks.hasLocalBusinessSchema) ownLocationScore += 10;
  if (checks.hasMapEmbed) ownLocationScore += 5;

  // Retail-availability signals (max 35) — "find near you" via a third-party retailer, the DTC model.
  let retailScore = 0;
  if (checks.hasStockistLink) retailScore += 15;
  if (checks.hasAvailableAtOrFromSchema) retailScore += 12;
  if (checks.hasMultiSellerOffers) retailScore += 3;
  if (checks.hasRetailAvailabilityLanguage) retailScore += 5;

  // Attribute-rich "trust content" signals (max 30) — apply regardless of which local model fits.
  let attributeScore = 0;
  if (checks.hasPricingContent) attributeScore += 10;
  if (checks.hasFitGuidance) attributeScore += 8;
  if (checks.hasProblemContent) attributeScore += 7;
  if (checks.hasComparisonContent) attributeScore += 5;

  checks.ownLocationScore = ownLocationScore;
  checks.retailAvailabilityScore = retailScore;
  checks.localScore = Math.min(100, ownLocationScore + retailScore + attributeScore);
  return checks;
}

// Google's own 2015 "micro-moments" framework (want-to-know / want-to-go / want-to-do / want-to-buy)
// — AI retrieval research ties citation likelihood to matching the whole situational moment behind
// a query, not the keyword. This is a coarse heuristic classifier, not true intent detection: it
// exists to steer the narrative's recommendations toward the right kind of content for the moment
// the audit topic and page content actually represent, rather than generic advice.
const MICRO_MOMENT_PATTERNS = [
  { moment: "want-to-buy", pattern: /\b(buy|price|pricing|cost|quote|purchase|order|shop|deal|discount)\b/i },
  { moment: "want-to-go", pattern: /\b(near me|nearby|local|location|directions|hours|open now|closest)\b/i },
  { moment: "want-to-do", pattern: /\b(how to|fix|repair|install|troubleshoot|diy|steps to|guide)\b/i },
];
function classifyMicroMoment(topic, pageText) {
  const combined = `${topic} ${(pageText || "").slice(0, 2000)}`.toLowerCase();
  for (const { moment, pattern } of MICRO_MOMENT_PATTERNS) {
    if (pattern.test(combined)) return moment;
  }
  return "want-to-know";
}

// Verticals with real page-measurable signal vs. verticals that need data this tool has no access to
// (ad accounts, social platform APIs, ESP data) — those are never assigned a fabricated numeric score.
const VERTICAL_ANALYSIS = {
  all: { measurable: true },
  technical: { measurable: true, key: "seo" },
  seo: { measurable: true, key: "seo" },
  aeo: { measurable: true, key: "aeo" },
  geo: { measurable: true, key: "geo" },
  sentiment: { measurable: true, key: "sentiment" },
  content: { measurable: true, key: "content" },
  local: { measurable: true, key: "local" },
  ppc: { measurable: false, reason: "PPC performance requires ad platform account data (Google Ads/Meta Ads) that this page-crawl audit cannot access." },
  social: { measurable: false, reason: "Social amplification requires platform API data (X, LinkedIn, Instagram) that this page-crawl audit cannot access." },
  email: { measurable: false, reason: "Email marketing performance requires ESP account data (open/click rates) that this page-crawl audit cannot access." },
};

function computeUnifiedScore(scores) {
  return Math.round(
    0.30 * (scores.seo?.seoScore ?? 0) +
    0.25 * (scores.aeo?.aeoScore ?? 0) +
    0.25 * (scores.geo?.geoScore ?? 0) +
    0.20 * (scores.sentiment?.sentimentScore ?? 0)
  );
}

app.get("/api/health", (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// Server-to-server only, not for end users — lets one deployment of this app fetch a page through
// another deployment's IP when its own direct fetch gets rate-limited/blocked (see
// fetchHtmlWithFallback). Guarded by a shared secret rather than verifyToken since there's no
// end-user Firebase session in this call; without a matching secret this would otherwise be an open
// proxy anyone could use to fetch arbitrary URLs through our server.
app.post("/api/internal/fetch-proxy", async (req, res) => {
  if (!process.env.INTERNAL_FETCH_SECRET || req.headers["x-internal-secret"] !== process.env.INTERNAL_FETCH_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const { url } = req.body || {};
  const validationErrors = validateUrl(url);
  if (validationErrors.length > 0) {
    return res.status(400).json({ error: "Validation failed", details: validationErrors });
  }
  try {
    const result = await fetchHtmlWithRetry(url);
    res.status(200).json({ statusCode: result.statusCode, html: result.html });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/run-audit", verifyToken, async (req, res) => {
  let auditRef = null;
  let responseSent = false;

  try {
    const { url, topic, vertical } = req.body;
    const uid = req.user.uid;

    const validationErrors = validateAuditPayload(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: "Validation failed", details: validationErrors });
    }

    const trimmedUrl = url.trim();
    const trimmedTopic = topic.trim();
    const trimmedVertical = vertical.trim().toLowerCase();

    auditRef = db.collection("users").doc(uid).collection("audits").doc();
    await auditRef.set({
      url: trimmedUrl,
      topic: trimmedTopic,
      vertical: trimmedVertical,
      status: "running",
      phase: "initializing",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      uid: uid,
    });

    const seoRelevant = ["all", "technical", "seo"].includes(trimmedVertical);
    const [fetchOutcome, externalBenchmark] = await Promise.all([
      fetchHtmlWithFallback(trimmedUrl).catch((fetchError) => {
        console.error("Page fetch failed:", fetchError.message);
        return null;
      }),
      seoRelevant ? fetchPageSpeedInsights(trimmedUrl) : Promise.resolve(null),
    ]);
    const html = fetchOutcome?.html || null;

    let seoAnalysis = null, aeoAnalysis = null, geoAnalysis = null, sentimentAnalysis = null, contentAnalysis = null, localAnalysis = null;
    let $ = null;
    let microMoment = classifyMicroMoment(trimmedTopic, "");

    if (html) {
      $ = cheerio.load(html, { decodeEntities: false });
      seoAnalysis = analyzeSeo($, html);
      aeoAnalysis = analyzeAeo($, html);
      geoAnalysis = analyzeGeo($, html, trimmedUrl, trimmedTopic);
      sentimentAnalysis = analyzeSentiment(html);
      contentAnalysis = analyzeContent($, html);
      localAnalysis = analyzeLocal($, html);
      microMoment = classifyMicroMoment(trimmedTopic, $("body").text());

      await auditRef.update({
        status: "scoring",
        phase: "analyzing",
      });
    } else {
      await auditRef.update({
        status: "scoring",
        phase: "fallback",
      });
    }

    const ANALYSIS_BY_KEY = { seo: seoAnalysis, aeo: aeoAnalysis, geo: geoAnalysis, sentiment: sentimentAnalysis, content: contentAnalysis, local: localAnalysis };
    const SCORE_FIELD_BY_KEY = { seo: "seoScore", aeo: "aeoScore", geo: "geoScore", sentiment: "sentimentScore", content: "contentScore", local: "localScore" };
    const vertConfig = VERTICAL_ANALYSIS[trimmedVertical] || { measurable: true, key: trimmedVertical };

    const fetchSystemPrompt = `You are an expert AI-powered visibility auditor. You are given the results of a deterministic, rule-based crawl analysis of a real page — treat those numbers as ground truth, not as something to re-estimate. Your job is to explain what they mean, cite specific evidence from the analysis in your findings, and produce actionable, evidence-grounded recommendations and a self-healing plan.

Ground your reasoning in how AI search actually works, not outdated keyword-ranking assumptions:
- Google ranking and AI citation are measurably decoupled: ranking #1 on Google only correlates with roughly a 31% chance of being cited in an AI answer, and that drops to ~2.6% by rank #4 — the majority of pages AI actually cites rank far outside Google's top 10. Never imply that a good SEO score alone means the page will be cited by AI.
- Generative engines match whole situational queries ("moment matching"), not keyword strings. A page optimized for a keyword is not the same as a page optimized for the real question behind it.
- What drives AI citation: content that leads with a direct answer in the first ~200 words, headings phrased as the literal question a user would ask, FAQ answers sized for extraction (roughly 40-160 words each), named-author attribution, and recent "last updated" freshness signals.
- For local/service businesses specifically, proximity-based "near me" ranking is being displaced by attribute-matching (pricing specifics, who a service is/isn't a good fit for, specific problem/symptom content, comparison content) — this is a live, recent shift, not a hypothetical.
- Most of what AI cites for a given query comes from outside the brand's own site (review platforms, forums, third-party roundups) — when a page's on-page signals are strong but you have no way to verify off-site presence, say so explicitly and recommend the business audit its presence on relevant review platforms rather than implying on-page work alone is sufficient.
- "Information gain" beats restated consensus: original data, first-party statistics, and specific proprietary findings are what an LLM can't already synthesize from the rest of the web. Generic claims that just restate common knowledge are citation-neutral even if well-written.
- Citation displacement framing: you do not have live data on what Google AI Overviews, ChatGPT, or Perplexity are currently citing for this topic (that requires a paid SERP data feed this tool doesn't have) — never claim to know current citation status or name a specific competitor as "the current winner." Instead, reason from the evidence about what a generic AI-citable source in this space would need (a direct answer, named data, expert/clinical attribution, extractable structure) and frame recommendations as closing that gap, not as displacing a named source you haven't actually observed.
- When the evidence shows expert/clinical language, external citation links, or original-data signals already present, treat that as a real strength to call out by name in findings — don't undersell genuine authority signals just because the score isn't 100.
- Structure the selfHealingPlan phases to mirror the AI-answer format proven to get extracted: a phase for tightening the direct-answer opening, a phase for adding scannable structure (tables/lists) if missing, a phase for authority/citation signals if missing, and a phase for FAQ/schema if missing — skip any phase the evidence shows is already strong.

Never invent a score that contradicts the supplied analysis, and never invent a score for something the evidence doesn't cover. Respond with ONLY valid JSON, no markdown fences, no commentary, matching this shape:
{"summary": string, "findings": string[], "recommendations": string[], "selfHealingPlan": [{"phase": string, "description": string}]}`;

    let evidenceBlock;
    if (!vertConfig.measurable) {
      evidenceBlock = `No on-page evidence is available for this vertical: ${vertConfig.reason} Provide qualitative, general best-practice guidance only — do NOT invent or imply a numeric score, since none can be measured from a page crawl.`;
    } else if (!html) {
      evidenceBlock = `No page analysis is available — the page could not be fetched (it may block crawlers or be unreachable). Note this limitation explicitly in your summary and findings, and avoid inventing specific technical claims about the page.`;
    } else if (trimmedVertical === "all") {
      evidenceBlock = `Likely search moment behind this audit (Google's want-to-know / want-to-go / want-to-do / want-to-buy framework, heuristically classified — treat as a strong hint, not certain): ${microMoment}

Deterministic crawl analysis (ground truth — do not contradict these numbers):
${JSON.stringify({ seo: seoAnalysis, aeo: aeoAnalysis, geo: geoAnalysis, sentiment: sentimentAnalysis, local: localAnalysis }, null, 2)}`;
    } else {
      evidenceBlock = `Likely search moment behind this audit: ${microMoment}

Deterministic crawl analysis for the ${trimmedVertical} pillar (ground truth — do not contradict these numbers):
${JSON.stringify(ANALYSIS_BY_KEY[vertConfig.key], null, 2)}`;
    }

    const fetchUserPrompt = trimmedVertical === "all"
      ? `Audit focus: "${trimmedTopic}". URL: ${trimmedUrl}.\n\n${evidenceBlock}\n\nWrite findings that cite specific numbers/fields from the analysis above (e.g. "meta description is missing" or "only 1 internal link found"), and recommendations that directly address the weakest-scoring pillars. Tailor recommendations to the likely search moment above — e.g. want-to-go content needs different treatment than want-to-buy content.`
      : `Audit focus: "${trimmedTopic}", vertical: ${trimmedVertical}. URL: ${trimmedUrl}.\n\n${evidenceBlock}\n\nFocus your findings and recommendations specifically on the ${trimmedVertical} vertical, tailored to the likely search moment above.`;

    // Scores are authoritative from the deterministic crawl analysis whenever a real fetch succeeded.
    // Non-measurable verticals (ppc/social/email) never get a fabricated numeric score.
    const finalScores = {
      seoScore: seoAnalysis?.seoScore ?? null,
      aeoScore: aeoAnalysis?.aeoScore ?? null,
      geoScore: geoAnalysis?.geoScore ?? null,
      sentimentScore: sentimentAnalysis?.sentimentScore ?? null,
    };
    if (trimmedVertical !== "all") {
      // Single-vertical runs only report the one relevant pillar — the other three stay null
      // rather than implying a full 4-pillar audit ran.
      Object.keys(finalScores).forEach((field) => {
        if (SCORE_FIELD_BY_KEY[vertConfig.key] !== field) finalScores[field] = null;
      });
    }

    const verticalScore = vertConfig.measurable && vertConfig.key
      ? ANALYSIS_BY_KEY[vertConfig.key]?.[SCORE_FIELD_BY_KEY[vertConfig.key]] ?? null
      : null;

    // The narrative call (Claude synthesizing findings/recommendations/self-healing plan) is the slow
    // part of this request — for a full "all"-vertical audit, confirmed live (2026-08-12) it can take
    // ~90s, which exceeds Hostinger's ~60s reverse-proxy gateway timeout regardless of how large
    // max_tokens is set. Scores are already fully computed and don't need Claude at all, so they're
    // returned immediately here; the narrative is generated afterward and the client polls
    // GET /api/audit-status/:auditId for it, instead of one request having to survive the full
    // worst-case Claude generation time.
    const scoresOnlyResults = {
      twittenceScore: trimmedVertical === "all"
        ? computeUnifiedScore({
            seo: { seoScore: finalScores.seoScore },
            aeo: { aeoScore: finalScores.aeoScore },
            geo: { geoScore: finalScores.geoScore },
            sentiment: { sentimentScore: finalScores.sentimentScore },
          })
        : null,
      ...finalScores,
      vertical: trimmedVertical,
      verticalMeasurable: vertConfig.measurable,
      verticalScore,
      externalBenchmark: externalBenchmark || null,
      microMoment,
      narrativePending: true,
      summary: "",
      findings: [],
      recommendations: [],
      selfHealingPlan: [],
    };
    if (seoAnalysis) {
      scoresOnlyResults.seoChecks = seoAnalysis;
      scoresOnlyResults.aeoChecks = aeoAnalysis;
      scoresOnlyResults.geoChecks = geoAnalysis;
      scoresOnlyResults.sentimentChecks = sentimentAnalysis;
      scoresOnlyResults.contentChecks = contentAnalysis;
      scoresOnlyResults.localChecks = localAnalysis;
    }

    await auditRef.set({
      url: trimmedUrl,
      topic: trimmedTopic,
      vertical: trimmedVertical,
      results: scoresOnlyResults,
      twittenceScore: scoresOnlyResults.twittenceScore,
      seoScore: scoresOnlyResults.seoScore,
      aeoScore: scoresOnlyResults.aeoScore,
      geoScore: scoresOnlyResults.geoScore,
      sentimentScore: scoresOnlyResults.sentimentScore,
      verticalScore: scoresOnlyResults.verticalScore,
      verticalMeasurable: scoresOnlyResults.verticalMeasurable,
      status: "scoring",
      auditPhase: "narrative-pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      uid: uid,
    }, { merge: true });

    res.status(200).json({
      auditId: auditRef.id,
      results: scoresOnlyResults,
    });
    responseSent = true;

    // Everything below runs after the response has already been sent — this request is done from the
    // client's perspective. On Hostinger (a persistent Node process) this reliably completes. On
    // Firebase Cloud Functions 1st gen, post-response background work is best-effort, not guaranteed
    // (Google's own documented behavior) — acceptable here since Hostinger (twittence.com) is the
    // primary deployment and Firebase is the secondary/fallback; the audit doc's "scoring" status
    // means a client that polls and never sees "complete" can still see accurate scores.
    async function requestNarrative() {
      const message = await anthropic.messages.create({
        model: "claude-sonnet-5",
        // A full "all"-vertical audit synthesizes 6 analyses into findings + recommendations + a
        // multi-phase self-healing plan in one response — confirmed via production logs (2026-08-12)
        // that 4096 was insufficient: stop_reason consistently came back "max_tokens", truncating the
        // JSON mid-string on every attempt including the retry, wasting ~35-40s per failed call and
        // pushing total request time past Hostinger's ~60s gateway timeout.
        max_tokens: 8192,
        system: fetchSystemPrompt,
        messages: [
          { role: "user", content: fetchUserPrompt },
        ],
      });
      const textBlock = message.content.find((b) => b.type === "text");
      const rawContent = textBlock ? textBlock.text : "";
      if (process.env.DEBUG_NARRATIVE === "true") {
        console.error("DEBUG_NARRATIVE stop_reason=" + message.stop_reason + " output_tokens=" + message.usage?.output_tokens + " rawLength=" + rawContent.length + " last120=" + JSON.stringify(rawContent.slice(-120)));
      }
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      return JSON.parse(jsonMatch ? jsonMatch[0] : rawContent);
    }

    let narrative;
    let narrativePartial = false;
    try {
      narrative = await requestNarrative();
    } catch (firstError) {
      console.error("Narrative generation failed, retrying once:", firstError.message);
      try {
        narrative = await requestNarrative();
      } catch (secondError) {
        console.error("Narrative generation failed on retry:", secondError.message);
        narrativePartial = true;
        narrative = {
          summary: "Scores below are accurate, but the AI-generated narrative (findings, recommendations, self-healing plan) could not be produced this time. Please re-run the audit to get the full narrative.",
          findings: [],
          recommendations: [],
          selfHealingPlan: [],
        };
      }
    }

    const finalResults = {
      ...scoresOnlyResults,
      narrativePending: false,
      narrativePartial,
      summary: narrative.summary ?? "Audit completed.",
      findings: narrative.findings ?? [],
      recommendations: narrative.recommendations ?? [],
      selfHealingPlan: narrative.selfHealingPlan ?? [],
    };

    await auditRef.set({
      results: finalResults,
      status: "complete",
      auditPhase: "done",
    }, { merge: true });
  } catch (error) {
    console.error(responseSent ? "Narrative generation background error:" : "Audit execution error:", error);
    if (auditRef) {
      try {
        await auditRef.update({ status: "error", errorMessage: error.message, "results.narrativePending": false });
      } catch (_) { /* ignore */ }
    }
    // If the response already went out (error happened during background narrative generation), there
    // is nothing left to send — the client is polling /api/audit-status instead. Only an error before
    // that point still has a live response to reply to.
    if (!responseSent) {
      res.status(500).json({ error: "An internal error occurred while processing the audit" });
    }
  }
});

app.get("/api/output/schema/:auditId", verifyToken, async (req, res) => {
  try {
    const auditRef = db.collection("users").doc(req.user.uid).collection("audits").doc(req.params.auditId);
    const doc = await auditRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Audit not found" });

    const data = doc.data();
    if (!data.results) return res.status(404).json({ error: "No results available" });
    const topicLabel = data.topic && data.topic !== "all" ? data.topic : "Complete Audit";

    const schema = {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: "Twittence",
      description: "Self-Healing SEO / AEO / GEO & Sentiment Engine",
      url: data.url,
      applicationCategory: "SEO Audit Tool",
      offers: {
        "@type": "Offer",
        description: `Audit result for ${topicLabel}`,
      },
      audit: {
        "@type": "Thing",
        name: "Twittence Audit",
        score: data.twittenceScore,
        seoScore: data.seoScore,
        aeoScore: data.aeoScore,
        geoScore: data.geoScore,
        sentimentScore: data.sentimentScore,
        topic: data.topic,
        vertical: data.vertical,
        findings: data.results.findings || [],
        recommendations: data.results.recommendations || [],
      },
    };

    res.status(200).json({ auditId: req.params.auditId, schema: schema });
  } catch (error) {
    console.error("Schema generation error:", error);
    res.status(500).json({ error: "Failed to generate Schema.org output" });
  }
});

app.get("/api/output/aeo/:auditId", verifyToken, async (req, res) => {
  try {
    const auditRef = db.collection("users").doc(req.user.uid).collection("audits").doc(req.params.auditId);
    const doc = await auditRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Audit not found" });

    const data = doc.data();
    if (!data.results) return res.status(404).json({ error: "No results available" });

    const aeoBlock = {
      "@context": "https://schema.org",
      "@type": "Question",
      name: data.topic && data.topic !== "all" ? data.topic : "Complete Audit",
      acceptedAnswer: {
        "@type": "Answer",
        text: data.results.summary || "Analysis not available.",
      },
    };

    res.status(200).json({ auditId: req.params.auditId, aeoBlock: aeoBlock });
  } catch (error) {
    console.error("AEO block generation error:", error);
    res.status(500).json({ error: "Failed to generate AEO answer block" });
  }
});

app.get("/api/output/llms-txt/:auditId", verifyToken, async (req, res) => {
  try {
    const auditRef = db.collection("users").doc(req.user.uid).collection("audits").doc(req.params.auditId);
    const doc = await auditRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Audit not found" });

    const data = doc.data();
    if (!data.results) return res.status(404).json({ error: "No results available" });

    const topicLabel = data.topic && data.topic !== "all" ? data.topic : "Complete Audit";
    let llmsTxt = `# Twittence Audit Results\n`;
    llmsTxt += `# URL: ${data.url}\n`;
    llmsTxt += `# Topic: ${topicLabel}\n`;
    llmsTxt += `# Vertical: ${data.vertical}\n`;
    llmsTxt += `# Generated: ${(data.createdAt?.toDate?.() || new Date()).toISOString()}\n\n`;
    llmsTxt += `## Twittence Unified Score\n`;
    llmsTxt += `Overall: ${data.twittenceScore ?? 'N/A'}/100\n\n`;
    llmsTxt += `## Pillar Scores\n`;
    llmsTxt += `- SEO: ${data.seoScore ?? 'N/A'}/100 (30%)\n`;
    llmsTxt += `- AEO: ${data.aeoScore ?? 'N/A'}/100 (25%)\n`;
    llmsTxt += `- GEO: ${data.geoScore ?? 'N/A'}/100 (25%)\n`;
    llmsTxt += `- Sentiment: ${data.sentimentScore ?? 'N/A'}/100 (20%)\n\n`;
    llmsTxt += `## Key Findings\n`;
    (data.results.findings || []).forEach((f, i) => { llmsTxt += `${i + 1}. ${f}\n`; });
    llmsTxt += `\n## Recommendations\n`;
    (data.results.recommendations || []).forEach((r, i) => { llmsTxt += `${i + 1}. ${r}\n`; });
    llmsTxt += `\n## Self-Healing Plan\n`;
    (data.results.selfHealingPlan || []).forEach((step, i) => { llmsTxt += `${i + 1}. [${step.phase || 'step'}] ${step.description || step}\n`; });

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="llms.txt"`);
    res.status(200).send(llmsTxt);
  } catch (error) {
    console.error("llms.txt generation error:", error);
    res.status(500).json({ error: "Failed to generate llms.txt output" });
  }
});

// Polled by the frontend after /api/run-audit returns its fast scores-only response, until the
// background-generated narrative (findings/recommendations/self-healing plan) finishes and
// results.narrativePending flips to false. See /api/run-audit's comments for why this exists.
app.get("/api/audit-status/:auditId", verifyToken, async (req, res) => {
  try {
    const auditRef = db.collection("users").doc(req.user.uid).collection("audits").doc(req.params.auditId);
    const doc = await auditRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Audit not found" });
    const data = doc.data();
    res.status(200).json({ status: data.status, results: data.results || null, errorMessage: data.errorMessage || null });
  } catch (error) {
    console.error("Audit status polling error:", error);
    res.status(500).json({ error: "Failed to retrieve audit status" });
  }
});

app.get("/api/user/history", verifyToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const offset = (page - 1) * limit;

    const historyRef = db.collection("users").doc(uid).collection("audits");
    const snapshot = await historyRef
      .orderBy("createdAt", "desc")
      .limit(limit)
      .offset(offset)
      .get();

    const records = snapshot.docs.map((doc) => {
      const d = doc.data();
      return {
        auditId: doc.id,
        url: d.url,
        topic: d.topic,
        vertical: d.vertical,
        twittenceScore: d.twittenceScore ?? null,
        seoScore: d.seoScore ?? null,
        aeoScore: d.aeoScore ?? null,
        geoScore: d.geoScore ?? null,
        sentimentScore: d.sentimentScore ?? null,
        createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
      };
    });

    res.status(200).json({
      page: page,
      limit: limit,
      total: snapshot.size,
      records: records,
    });
  } catch (error) {
    console.error("History retrieval error:", error);
    res.status(500).json({ error: "An internal error occurred while retrieving history" });
  }
});

app.get("/api/output/history/:auditId", verifyToken, async (req, res) => {
  try {
    const auditRef = db.collection("users").doc(req.user.uid).collection("audits").doc(req.params.auditId);
    const doc = await auditRef.get();
    if (!doc.exists) return res.status(404).json({ error: "Audit not found" });

    const data = doc.data();
    res.status(200).json({ auditId: req.params.auditId, data: data });
  } catch (error) {
    console.error("Output history error:", error);
    res.status(500).json({ error: "Failed to retrieve audit data" });
  }
});

app.post("/api/site-wide-audit", verifyToken, async (req, res) => {
  try {
    const { url, topic } = req.body;
    const trimmedUrl = (url || "").trim();
    const trimmedTopic = (topic || "site-wide audit").trim();
    let auditRef;
    if (!trimmedUrl || !/^https?:\/\/.+/.test(trimmedUrl)) {
      return res.status(400).json({ error: "Valid site URL is required" });
    }
    const discovered = [];
    try {
      const sitemapUrl = trimmedUrl.replace(/\/$/, "") + "/sitemap.xml";
      const parsed = new URL(sitemapUrl);
      const opts = { hostname: parsed.hostname, port: parsed.port || 443, path: parsed.pathname + parsed.search, method: "GET", headers: { "User-Agent": "TwittenceBot/1.0", "Accept": "application/xml" }, timeout: 10000 };
      const sitemapXml = await new Promise((resolve, reject) => { let data = ""; const protocol = parsed.protocol === "https:" ? require("https") : require("http"); const req2 = protocol.request(opts, (res2) => { res2.on("data", (chunk) => { data += chunk; }); res2.on("end", () => resolve(data)); }); req2.on("error", reject); req2.on("timeout", () => { req2.destroy(); reject(new Error("timeout")); }); req2.end(); });
      const urlMatches = sitemapXml.match(/<loc[^>]*>(.*?)<\/loc>/gi);
      if (urlMatches) { for (const m of urlMatches) { const m2 = m.replace(/<[^>]+>/g, "").trim(); if (m2 && m2.startsWith("http") && discovered.length < 50) discovered.push(m2); } }
    } catch (_) { /* sitemap not available */ }
    if (discovered.length === 0) discovered.push(trimmedUrl);
    const results = [];
    for (const pageUrl of discovered) {
      try {
        const fetchResult = await fetchHtmlWithFallback(pageUrl);
        const $ = cheerio.load(fetchResult.html, { decodeEntities: false });
        const seoChecks = analyzeSeo($, fetchResult.html);
        const aeoChecks = analyzeAeo($, fetchResult.html);
        const geoChecks = analyzeGeo($, fetchResult.html, pageUrl, trimmedTopic);
        const sentimentChecks = analyzeSentiment(fetchResult.html);
        const message = await anthropic.messages.create({ model: "claude-sonnet-5", max_tokens: 2048, system: "You are an expert audit analyst. The pillar scores below are already computed from a real crawl — treat them as ground truth, do not re-estimate them. Explain what they mean and give a consolidated recommendation. Respond with ONLY valid JSON, no markdown fences: {\"summary\": string, \"findings\": string[], \"recommendations\": string[]}", messages: [{ role: "user", content: `Page: ${pageUrl}\nSEO score: ${seoChecks.seoScore}, AEO score: ${aeoChecks.aeoScore}, GEO score: ${geoChecks.geoScore}, Sentiment score: ${sentimentChecks.sentimentScore}.` }] });
        const textBlock = message.content.find((b) => b.type === "text");
        const rawContent = textBlock ? textBlock.text : "";
        let parsedResult;
        try {
          const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
          parsedResult = JSON.parse(jsonMatch ? jsonMatch[0] : rawContent);
        } catch (_) {
          parsedResult = { summary: rawContent, findings: [], recommendations: [], selfHealingPlan: [] };
        }
        results.push({ url: pageUrl, seoScore: seoChecks.seoScore, aeoScore: aeoChecks.aeoScore, geoScore: geoChecks.geoScore, sentimentScore: sentimentChecks.sentimentScore, summary: parsedResult.summary || "", findings: parsedResult.findings || [], recommendations: parsedResult.recommendations || [], selfHealingPlan: parsedResult.selfHealingPlan || [] });
      } catch (_) { results.push({ url: pageUrl, seoScore: null, aeoScore: null, geoScore: null, sentimentScore: null, summary: "", findings: [], recommendations: [], selfHealingPlan: [] }); }
    }
    const aggregated = { seo: 0, aeo: 0, geo: 0, sent: 0, count: 0 };
    const allFindings = [];
    const allRecommendations = [];
    const allSelfHealing = [];
    for (const r of results) {
      if (r.seoScore === null) continue;
      aggregated.count++;
      aggregated.seo += r.seoScore; aggregated.aeo += r.aeoScore; aggregated.geo += r.geoScore; aggregated.sent += r.sentimentScore;
      for (const f of (r.findings || [])) allFindings.push(r.url + " — " + f);
      for (const rec of (r.recommendations || [])) allRecommendations.push(r.url + " — " + rec);
      for (const item of (r.selfHealingPlan || [])) allSelfHealing.push({ phase: "Site-wide: " + (item.phase || "step"), description: item.description || item, url: r.url });
    }
    if (aggregated.count > 0) { aggregated.seo = Math.round(aggregated.seo / aggregated.count); aggregated.aeo = Math.round(aggregated.aeo / aggregated.count); aggregated.geo = Math.round(aggregated.geo / aggregated.count); aggregated.sent = Math.round(aggregated.sent / aggregated.count); }
    aggregated.tw = Math.round(aggregated.seo * 0.3 + aggregated.aeo * 0.25 + aggregated.geo * 0.25 + aggregated.sent * 0.2);
    auditRef = db.collection("users").doc(req.user.uid).collection("audits").doc();
    await auditRef.set({ url: trimmedUrl, topic: trimmedTopic, vertical: "all", results: aggregated, seoScore: aggregated.seo, aeoScore: aggregated.aeo, geoScore: aggregated.geo, sentimentScore: aggregated.sent, twittenceScore: aggregated.tw, findings: allFindings.slice(0, 20), recommendations: allRecommendations.slice(0, 10), selfHealingPlan: allSelfHealing.slice(0, 10), createdAt: new Date(), auditType: "site-wide", uid: req.user.uid });
    res.status(200).json({ auditId: auditRef.id, results: aggregated, pageSize: discovered.length, pagesAudited: results.length, findings: allFindings.slice(0, 20), recommendations: allRecommendations.slice(0, 10), selfHealingPlan: allSelfHealing.slice(0, 10) });
  } catch (error) {
    console.error("Site-wide audit error:", error);
    res.status(500).json({ error: "Site-wide audit failed: " + error.message });
  }
});

// --- Live citation tracking: hybrid BYOK / managed-credits model ---
// BYOK: the user's own DataForSEO or SerpApi key, encrypted at rest, never returned to the client
// after saving, never billed by Twittence. Managed: prepaid credits purchased via Stripe, consumed
// against Twittence's own provider account. Every route here requires a signed-in user (verifyToken)
// — there is no anonymous access to this feature, since it's either spending the user's own key or
// their paid balance.

app.get("/api/citation/status", verifyToken, async (req, res) => {
  try {
    const doc = await db.collection("users").doc(req.user.uid).get();
    const data = doc.exists ? doc.data() : {};
    res.status(200).json({
      hasByok: Boolean(data.citationApiKey),
      byokProvider: data.citationApiProvider || null,
      credits: data.citationCredits || 0,
      managedAvailable: Boolean(CITATION_PROVIDER_LOGIN && CITATION_PROVIDER_PASSWORD),
      billingConfigured: Boolean(stripe),
    });
  } catch (error) {
    console.error("Citation status error:", error);
    res.status(500).json({ error: "Failed to retrieve citation status" });
  }
});

app.post("/api/citation/key", verifyToken, async (req, res) => {
  if (!CITATION_ENCRYPTION_SECRET) {
    return res.status(503).json({ error: "This deployment has not configured key storage yet. Contact support." });
  }
  const { provider, apiKey, apiSecret } = req.body;
  if (!["dataforseo", "serpapi"].includes(provider)) {
    return res.status(400).json({ error: "provider must be 'dataforseo' or 'serpapi'" });
  }
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length < 8) {
    return res.status(400).json({ error: "A valid apiKey is required" });
  }
  if (provider === "dataforseo" && (!apiSecret || typeof apiSecret !== "string")) {
    return res.status(400).json({ error: "DataForSEO requires both apiKey (login) and apiSecret (password)" });
  }
  try {
    await db.collection("users").doc(req.user.uid).set(
      {
        citationApiProvider: provider,
        citationApiKey: encryptSecret(apiKey.trim()),
        citationApiSecret: apiSecret ? encryptSecret(apiSecret.trim()) : admin.firestore.FieldValue.delete(),
      },
      { merge: true }
    );
    res.status(200).json({ saved: true });
  } catch (error) {
    console.error("Citation key save error:", error);
    res.status(500).json({ error: "Failed to save API key" });
  }
});

app.delete("/api/citation/key", verifyToken, async (req, res) => {
  try {
    await db.collection("users").doc(req.user.uid).update({
      citationApiProvider: admin.firestore.FieldValue.delete(),
      citationApiKey: admin.firestore.FieldValue.delete(),
      citationApiSecret: admin.firestore.FieldValue.delete(),
    });
    res.status(200).json({ deleted: true });
  } catch (error) {
    console.error("Citation key delete error:", error);
    res.status(500).json({ error: "Failed to remove API key" });
  }
});

app.post("/api/credits/checkout", verifyToken, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Billing is not configured on this deployment yet." });
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: req.user.uid,
      customer_email: req.user.email || undefined,
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: Math.round(CREDIT_PACK_PRICE_USD * 100),
            product_data: { name: `Twittence — ${CREDIT_PACK_SIZE} live citation checks` },
          },
          quantity: 1,
        },
      ],
      metadata: { credits: String(CREDIT_PACK_SIZE), uid: req.user.uid },
      success_url: `${req.headers.origin || "https://twittence.com"}/?citation_purchase=success`,
      cancel_url: `${req.headers.origin || "https://twittence.com"}/?citation_purchase=cancelled`,
    });
    res.status(200).json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Stripe checkout creation error:", error);
    res.status(500).json({ error: "Failed to start checkout" });
  }
});

// Provider adapters — built against each provider's public API documentation. Marked explicitly as
// unverified: neither has been exercised against a real funded account, since Twittence does not
// hold one. BYOK users are the first real-world test; errors are surfaced to the user rather than
// silently swallowed so a broken adapter fails loudly instead of returning fabricated data.
async function fetchDataForSeoAiOverview(login, password, keyword) {
  const auth = Buffer.from(`${login}:${password}`).toString("base64");
  const body = JSON.stringify([{ keyword, language_code: "en", location_code: 2840, load_async_ai_overview: true }]);
  return new Promise((resolve, reject) => {
    const req2 = https.request(
      { hostname: "api.dataforseo.com", path: "/v3/serp/google/organic/live/advanced", method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res2) => {
        let data = "";
        res2.on("data", (c) => (data += c));
        res2.on("end", () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("DataForSEO returned invalid JSON")); }
        });
      }
    );
    req2.on("error", reject);
    req2.write(body);
    req2.end();
  });
}

async function fetchSerpApiAiOverview(apiKey, keyword) {
  const searchUrl = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(keyword)}&api_key=${apiKey}`;
  const searchResult = await new Promise((resolve, reject) => {
    https.get(searchUrl, (res2) => {
      let data = "";
      res2.on("data", (c) => (data += c));
      res2.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("SerpApi returned invalid JSON")); } });
    }).on("error", reject);
  });
  const pageToken = searchResult.ai_overview?.page_token;
  if (!pageToken) return { ai_overview: null, note: "No AI Overview present for this query." };
  // page_token expires ~1 minute after the initial search — fetched immediately, no delay introduced.
  const overviewUrl = `https://serpapi.com/search.json?engine=google_ai_overview&page_token=${encodeURIComponent(pageToken)}&api_key=${apiKey}`;
  return new Promise((resolve, reject) => {
    https.get(overviewUrl, (res2) => {
      let data = "";
      res2.on("data", (c) => (data += c));
      res2.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("SerpApi returned invalid JSON")); } });
    }).on("error", reject);
  });
}

app.post("/api/citation-check", verifyToken, async (req, res) => {
  const { keyword } = req.body;
  if (!keyword || typeof keyword !== "string" || !keyword.trim()) {
    return res.status(400).json({ error: "keyword is required" });
  }
  const userRef = db.collection("users").doc(req.user.uid);
  const userDoc = await userRef.get();
  const userData = userDoc.exists ? userDoc.data() : {};

  try {
    // Path 1: BYOK — the user's own key, no credit deduction, Twittence never sees the plaintext key
    // outside this request's memory.
    if (userData.citationApiKey && userData.citationApiProvider) {
      const apiKey = decryptSecret(userData.citationApiKey);
      const provider = userData.citationApiProvider;
      const result = provider === "dataforseo"
        ? await fetchDataForSeoAiOverview(apiKey, decryptSecret(userData.citationApiSecret), keyword.trim())
        : await fetchSerpApiAiOverview(apiKey, keyword.trim());
      return res.status(200).json({ source: "byok", provider, result });
    }

    // Path 2: managed credits — deducted atomically so two concurrent requests can't both succeed
    // against a balance of 1.
    if (!CITATION_PROVIDER_LOGIN || !CITATION_PROVIDER_PASSWORD) {
      return res.status(503).json({ error: "No API key on file, and this deployment has no managed provider configured yet." });
    }
    const deducted = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(userRef);
      const credits = (fresh.exists ? fresh.data().citationCredits : 0) || 0;
      if (credits < 1) return false;
      tx.update(userRef, { citationCredits: admin.firestore.FieldValue.increment(-1) });
      return true;
    });
    if (!deducted) {
      return res.status(402).json({ error: "No citation credits remaining and no personal API key on file.", checkoutRequired: true });
    }
    const result = await fetchDataForSeoAiOverview(CITATION_PROVIDER_LOGIN, CITATION_PROVIDER_PASSWORD, keyword.trim());
    res.status(200).json({ source: "managed", provider: "dataforseo", result });
  } catch (error) {
    console.error("Citation check error:", error);
    res.status(502).json({ error: "Citation lookup failed: " + error.message });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(hostingDir, "index.html"));
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Explicit opt-in, not environment auto-detection: Firebase Cloud Functions never calls listen()
// itself (it invokes the exported handler directly), and neither does the Firebase CLI's own local
// pre-deploy step that briefly requires this file to inspect its exports — but that CLI step doesn't
// set any Cloud Functions runtime env vars either, so it's indistinguishable from a real standalone
// host by environment alone. require.main === module isn't reliable either: some hosts (Hostinger's
// Node.js App manager) load this file via require() rather than executing it directly, so that check
// is never true there. Set STANDALONE_SERVER=true explicitly wherever this should actually listen
// (Hostinger's env vars, local dev, a VPS) — never in functions/.env, since that file ships with the
// Firebase deploy.
if (process.env.STANDALONE_SERVER === "true") {
  app.listen(PORT, () => {
    console.log(`Twittence API server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  });
}

// Explicit v1 subpath, not the bare "firebase-functions" entrypoint: v6 changed the default export
// to the v2 (Gen2/Cloud Run) API, which would silently redeploy this as a different function
// generation. Importing from firebase-functions/v1/https keeps the existing 1st-gen onRequest
// behavior exactly as before, regardless of the package's own default changing.
const { onRequest } = require("firebase-functions/v1/https");
exports.api = onRequest(app);