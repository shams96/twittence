# Twittence Scoring Methodology

This documents exactly how each pillar score is computed, sourced directly from the scoring
functions in [`functions/index.js`](../functions/index.js) — not a marketing description, the real
weights and thresholds as implemented. If this drifts from the code, the code is authoritative;
update this file to match, not the other way around.

All pillar scores are **deterministic**: given the same HTML, the same score comes back every time.
Only the narrative (summary/findings/recommendations/self-healing plan) is produced by Claude, and
it's instructed to treat these scores as ground truth, never to re-estimate them.

---

## SEO (`analyzeSeo`) — 100 points

| Signal | Points | Condition |
|---|---|---|
| Title length | 12 | 30–60 characters |
| Meta description | 10 | 50–160 characters (2 pts if simply absent, to distinguish "missing" from "present but wrong length") |
| Has exactly one H1 | 8 (H1 presence) + 12 (single-H1 structure) | |
| Canonical tag | 6 | present |
| Open Graph tags | 4 | any `og:*` meta tag present |
| Structured data | 6 | any JSON-LD block present |
| Internal links | 8 | more than 3 |
| External links | 6 | more than 1 |
| Image alt-text ratio | up to 14 | scaled by `(images with alt) / (total images)` |

---

## AEO — Answer Engine Optimization (`analyzeAeo`) — 100 points

| Signal | Points |
|---|---|
| `FAQPage` schema present | 25 |
| `HowTo` schema present | 20 |
| FAQ schema has ≥1 question | 15 |
| Voice readability (avg paragraph length) | up to 24 (30% weight on an 80-point scale: <15 words/sentence avg = 80, ≤20 = 60, else 40) |
| Direct-answer likelihood | up to 30 (30% weight; % of paragraphs sized 40–300 characters) |

---

## GEO — Generative Engine Optimization (`analyzeGeo`) — 100 points, 7 dimensions

Rebuilt around AI-citation research rather than keyword density — ranking #1 on Google only
correlates with ~31% AI-citation odds, dropping to ~2.6% by rank #4, so this does **not** score
primarily on keyword presence the way it originally did.

| Dimension | Points | What it measures |
|---|---|---|
| A. Direct Answer & Structure | 16 | Does a substantive paragraph (15+ words) appear in the first 5 content blocks after stripping nav/header/footer (10 pts)? What fraction of H2–H4 headings are phrased as literal questions (up to 6 pts)? |
| B. Information Gain | 12 | Original/proprietary data language ("we surveyed...", "our research found...") — distinct from citing someone else's data (8 pts). Density of specific stats/figures (up to 4 pts). |
| C. Schema Clarity | 12 | `FAQPage` (5), `HowTo` (3), `Article`/`BlogPosting`/`NewsArticle` (2) schema present; bonus for FAQ answers sized 40–160 words (up to 2). |
| D. Authority, Citations & Entity Presence | 16 | Named author (3) + author links to an external profile (2); external links to `.gov`/`.edu`/PubMed/DOI/Google Scholar (up to 4); expert/clinical language ("Dr.", "peer-reviewed", "clinical trial") (3); **Wikipedia page exists** (2); **Wikidata entry exists** (2) — see below. |
| E. Scannability | 12 | Has a `<table>` (5); list-item density ≥30% of paragraph count (5); page exceeds 300 words (2). |
| F. Freshness | 12 | Has a published date (6); date is within 18 months (6). |
| G. AI Crawler Access | 20 | See below — a hard gate, not a soft signal. |

### G. AI Crawler Access (new — the crawler-blocking check)

Fetches the audited domain's `robots.txt` and checks whether five Tier-1 AI crawlers are blocked,
either by an explicit `Disallow: /` in their own named block or inherited from a `User-agent: *`
block: **GPTBot** (OpenAI/ChatGPT), **OAI-SearchBot** (ChatGPT search), **ChatGPT-User** (user-invoked
browsing), **ClaudeBot** (Anthropic), **PerplexityBot** (Perplexity AI).

- No `robots.txt` at all → full 20 points. Absence is the standard "everything allowed" default, not
  a penalty — this matches how the crawlers themselves treat a missing file.
- Each blocked Tier-1 crawler costs 4 points (`20 - blocked_count × 4`, floored at 0).

**This is deliberately weighted as a gate, not just another signal**: a page can score perfectly on
every other GEO dimension and still be completely invisible to AI systems if its own `robots.txt`
blocks the crawler. When any crawler is found blocked, the Claude narrative is explicitly instructed
to make it the #1 finding and the first self-healing phase — no other GEO work matters until it's
fixed. **There is no bypass to recommend.** OpenAI, Anthropic, and Perplexity all publicly commit to
honoring `robots.txt`; the only real fix is the site owner editing their own file. This does not
affect Twittence's own ability to audit the page — Twittence's fetcher doesn't identify as any of
these bots, so a blocked `robots.txt` has zero effect on whether the audit itself can run.

### Wikipedia / Wikidata entity presence

Real API calls, not an instruction for a human to go search manually: `en.wikipedia.org`'s public
search API and `www.wikidata.org`'s entity search API, both free and requiring no authentication. A
brand name is derived automatically from the audited domain (e.g. `twittence.com` → `Twittence`) — no
extra form field required. This is a genuinely different signal from the on-page citation-link check
above: citing an external source shows the *page* references authoritative material; a Wikipedia/
Wikidata entry shows the *subject itself* is independently verifiable in the knowledge graph AI
systems draw entity facts from. Most small or new businesses legitimately won't have one yet — this
is scored as a real, addressable gap and framed as an opportunity, not a defect.

---

## Sentiment (`analyzeSentiment`) — 0–100, unbounded-then-clamped

Base score is a **trust ratio**: `trustSignals / (trustSignals + skepticismTriggers) × 100`, defaults
to 50 if no trust signals found at all. Trust keywords: verified, trusted, secure, certified,
guaranteed, award, testimonial, review, privacy, compliant, gdpr, ssl, encryption, disclaimer (word-
boundary matched, so "about" doesn't false-positive on "but"). Skepticism keywords: free trial,
cancel anytime, no commitment, limited time, act now, hurry, scarcity, guaranteed results, risk-free.

Then adjusted: +5 has a contact page link, +5 privacy policy link, +5 terms of service link, +10
testimonials/reviews/case-study language present, +10 trust-badge language (SSL, verified, BBB,
Norton, McAfee, etc.), **−10 if zero trust signals were found at all**.

---

## Content Strategy (`analyzeContent`) — 100 points

| Signal | Points |
|---|---|
| Word count | 35 (>1200 words), 22 (>600), 10 (>200), 3 (≤200) |
| Heading count | up to 25 (4 pts each) |
| Published date present | 15 |
| Author present | 10 |
| Internal link depth | up to 15 (1 pt per internal/absolute link, capped) |

---

## Local SEO (`analyzeLocal`) — 100 points, two models

The engine is business-agnostic, so "local" can't assume a business has its own physical storefront —
a plumber's local relevance and a DTC brand's are structurally different signals, scored
independently and summed:

| Bucket | Points | Signals |
|---|---|---|
| Own-location (has a storefront people travel to) | 35 | Phone number pattern (10), street-address pattern (10), `LocalBusiness`/`Organization` schema (10), Google Maps iframe embed (5) |
| Retail availability (DTC/product brand — "find it near you" via a retailer) | 35 | Stockist/store-locator link or nav text (15), `Offer.availableAtOrFrom` schema — the mechanism behind Google's Local Inventory Ads (12), multi-seller `Offer` array (3), "carried at"/"authorized retailer" language (5) |
| Attribute-rich "trust content" | 30 | Pricing specifics (10), fit guidance — "who this is/isn't for" (8), specific problem/symptom content (7), comparison content (5) — reflects the shift from proximity-based "near me" ranking toward attribute-matching |

A DTC brand with zero physical-location signals can still score well via retail findability instead
of being penalized for a storefront it was never going to have.

---

## Unified Twittence Score (`computeUnifiedScore`)

Only computed for a full "all-vertical" audit — never fabricated for a single-vertical run.

```
twittenceScore = 0.30 × seoScore + 0.25 × aeoScore + 0.25 × geoScore + 0.20 × sentimentScore
```

## Non-measurable verticals

PPC, Social Media, and Email Marketing are never assigned a numeric score, under any circumstances —
they require ad-platform account data, social API data, or ESP data that a page crawl cannot access.
The narrative is explicitly instructed to give qualitative guidance only for these and never imply a
score exists.

---

## Caveats, stated plainly

- **Weights are opinionated**, not derived from a controlled study — they reflect the current
  understanding of what correlates with AI citation likelihood as of when each pillar was last
  revised, and are expected to change as the field does.
- **Deterministic ≠ correct.** A page can satisfy every regex/structural check here and still not be
  cited by any given AI system — model behavior depends on training data, query phrasing, and
  competitor content, none of which this tool can observe.
- **No live citation status is claimed anywhere in scoring or narrative.** Twittence does not know
  what Google AI Overviews, ChatGPT, or Perplexity are *currently* citing for any query — that would
  require a paid SERP data feed (see the separate Live Citation Tracking feature, which is opt-in and
  explicitly separate from this deterministic scoring).
