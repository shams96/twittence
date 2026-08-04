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
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(express.static(hostingDir, { extensions: ["html"] }));
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

function analyzeGeo($, html, url, topic) {
  const pageText = $("body").text() || "";
  const wordCount = pageText.split(/\s+/).filter((w) => w.length > 2).length;
  const pageTextLower = pageText.toLowerCase();

  let topicWords = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  // "all" (Run All — Complete Audit) is a UI meta-selection, not a real topic — matching against
  // the literal word "all" would unfairly zero out keyword coverage. Fall back to the page's own
  // title/H1 as the real signal of what it's actually about.
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

  let citationDensity = 0;
  topicWords.forEach((word) => {
    const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    const matches = pageTextLower.match(regex);
    if (matches) citationDensity += matches.length;
  });

  const density = wordCount > 0 ? (citationDensity / wordCount) * 100 : 0;

  const checks = {
    wordCount: wordCount,
    citationDensity: Math.round(density * 100) / 100,
    topicKeywordsPresent: topicWords.filter((w) => pageTextLower.includes(w)).length,
    totalTopicKeywords: topicWords.length,
    keywordCoverage: 0,
  };

  checks.keywordCoverage = Math.min(100, Math.round((checks.topicKeywordsPresent / Math.max(checks.totalTopicKeywords, 1)) * 100));

  let geoScore = 0;
  geoScore += Math.min(30, checks.keywordCoverage);
  geoScore += Math.min(25, Math.round(density * 500));
  geoScore += Math.min(20, checks.wordCount > 500 ? 15 : checks.wordCount > 200 ? 8 : 3);
  geoScore += Math.min(25, Math.round(checks.citationDensity * 20));
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
  const checks = { wordCount: 0, headingCount: 0, hasDatePublished: false, hasAuthor: false, internalLinkDepth: 0 };
  const bodyText = $("body").text() || "";
  checks.wordCount = bodyText.split(/\s+/).filter((w) => w.length > 2).length;
  checks.headingCount = $("h1, h2, h3, h4, h5, h6").length;
  checks.hasDatePublished = $("time, [datetime], meta[property='article:published_time']").length > 0;
  checks.hasAuthor = $("[rel='author'], [class*='author' i], meta[name='author']").length > 0;
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

function analyzeLocal($, html) {
  const bodyText = $("body").text() || "";
  const checks = {
    hasPhoneNumber: /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(bodyText),
    hasAddressPattern: /\d{1,5}\s+[\w\s]{2,30}\s+(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln)\b/i.test(bodyText),
    hasLocalBusinessSchema: false,
    hasMapEmbed: $("iframe[src*='google.com/maps'], iframe[src*='maps.google']").length > 0,
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

  let localScore = 0;
  if (checks.hasPhoneNumber) localScore += 25;
  if (checks.hasAddressPattern) localScore += 25;
  if (checks.hasLocalBusinessSchema) localScore += 35;
  if (checks.hasMapEmbed) localScore += 15;
  checks.localScore = Math.min(100, localScore);
  return checks;
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

app.post("/api/run-audit", verifyToken, async (req, res) => {
  let auditRef = null;

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
      fetchHtml(trimmedUrl).catch((fetchError) => {
        console.error("Page fetch failed:", fetchError.message);
        return null;
      }),
      seoRelevant ? fetchPageSpeedInsights(trimmedUrl) : Promise.resolve(null),
    ]);
    const html = fetchOutcome?.html || null;

    let seoAnalysis = null, aeoAnalysis = null, geoAnalysis = null, sentimentAnalysis = null, contentAnalysis = null, localAnalysis = null;
    let $ = null;

    if (html) {
      $ = cheerio.load(html, { decodeEntities: false });
      seoAnalysis = analyzeSeo($, html);
      aeoAnalysis = analyzeAeo($, html);
      geoAnalysis = analyzeGeo($, html, trimmedUrl, trimmedTopic);
      sentimentAnalysis = analyzeSentiment(html);
      contentAnalysis = analyzeContent($, html);
      localAnalysis = analyzeLocal($, html);

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

    const fetchSystemPrompt = `You are an expert AI-powered visibility auditor. You are given the results of a deterministic, rule-based crawl analysis of a real page — treat those numbers as ground truth, not as something to re-estimate. Your job is to explain what they mean, cite specific evidence from the analysis in your findings, and produce actionable, evidence-grounded recommendations and a self-healing plan. Never invent a score that contradicts the supplied analysis, and never invent a score for something the evidence doesn't cover. Respond with ONLY valid JSON, no markdown fences, no commentary, matching this shape:
{"summary": string, "findings": string[], "recommendations": string[], "selfHealingPlan": [{"phase": string, "description": string}]}`;

    let evidenceBlock;
    if (!vertConfig.measurable) {
      evidenceBlock = `No on-page evidence is available for this vertical: ${vertConfig.reason} Provide qualitative, general best-practice guidance only — do NOT invent or imply a numeric score, since none can be measured from a page crawl.`;
    } else if (!html) {
      evidenceBlock = `No page analysis is available — the page could not be fetched (it may block crawlers or be unreachable). Note this limitation explicitly in your summary and findings, and avoid inventing specific technical claims about the page.`;
    } else if (trimmedVertical === "all") {
      evidenceBlock = `Deterministic crawl analysis (ground truth — do not contradict these numbers):
${JSON.stringify({ seo: seoAnalysis, aeo: aeoAnalysis, geo: geoAnalysis, sentiment: sentimentAnalysis }, null, 2)}`;
    } else {
      evidenceBlock = `Deterministic crawl analysis for the ${trimmedVertical} pillar (ground truth — do not contradict these numbers):
${JSON.stringify(ANALYSIS_BY_KEY[vertConfig.key], null, 2)}`;
    }

    const fetchUserPrompt = trimmedVertical === "all"
      ? `Audit focus: "${trimmedTopic}". URL: ${trimmedUrl}.\n\n${evidenceBlock}\n\nWrite findings that cite specific numbers/fields from the analysis above (e.g. "meta description is missing" or "only 1 internal link found"), and recommendations that directly address the weakest-scoring pillars.`
      : `Audit focus: "${trimmedTopic}", vertical: ${trimmedVertical}. URL: ${trimmedUrl}.\n\n${evidenceBlock}\n\nFocus your findings and recommendations specifically on the ${trimmedVertical} vertical.`;

    const message = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4096,
      system: fetchSystemPrompt,
      messages: [
        { role: "user", content: fetchUserPrompt },
      ],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const rawContent = textBlock ? textBlock.text : "";

    let narrative;
    try {
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      narrative = JSON.parse(jsonMatch ? jsonMatch[0] : rawContent);
    } catch (parseError) {
      narrative = {
        summary: rawContent || "Audit completed, but the narrative could not be generated.",
        findings: [],
        recommendations: [],
        selfHealingPlan: [],
      };
    }

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

    const results = {
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
      summary: narrative.summary ?? "Audit completed.",
      findings: narrative.findings ?? [],
      recommendations: narrative.recommendations ?? [],
      selfHealingPlan: narrative.selfHealingPlan ?? [],
    };

    if (seoAnalysis) {
      results.seoChecks = seoAnalysis;
      results.aeoChecks = aeoAnalysis;
      results.geoChecks = geoAnalysis;
      results.sentimentChecks = sentimentAnalysis;
      results.contentChecks = contentAnalysis;
      results.localChecks = localAnalysis;
    }

    await auditRef.set({
      url: trimmedUrl,
      topic: trimmedTopic,
      vertical: trimmedVertical,
      results: results,
      twittenceScore: results.twittenceScore,
      seoScore: results.seoScore,
      aeoScore: results.aeoScore,
      geoScore: results.geoScore,
      sentimentScore: results.sentimentScore,
      verticalScore: results.verticalScore,
      verticalMeasurable: results.verticalMeasurable,
      status: "complete",
      auditPhase: "done",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      uid: uid,
    }, { merge: true });

    res.status(200).json({
      auditId: auditRef.id,
      results: results,
    });
  } catch (error) {
    console.error("Audit execution error:", error);
    if (auditRef) {
      try {
        await auditRef.update({ status: "error", errorMessage: error.message });
      } catch (_) { /* ignore */ }
    }
    res.status(500).json({ error: "An internal error occurred while processing the audit" });
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
        const fetchResult = await fetchHtml(pageUrl);
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