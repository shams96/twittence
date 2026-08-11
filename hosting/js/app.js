import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.10.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  query,
  orderBy,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.10.0/firebase-firestore.js";
import { firebaseConfig, API_BASE } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
let currentUser = null;

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  const authBtn = document.getElementById("authBtn");
  const userEmail = document.getElementById("userEmail");
  if (user) {
    authBtn.textContent = "Sign Out";
    userEmail.textContent = user.email;
    userEmail.classList.remove("hidden");
    loadHistory(user.uid);
  } else {
    authBtn.textContent = "Sign In";
    userEmail.classList.add("hidden");
  }
});

window.handleAuth = async () => {
  const btn = document.getElementById("authBtn");
  setButtonLoading(btn, true);
  try {
    if (currentUser) {
      await signOut(auth);
    } else {
      await signInWithPopup(auth, new GoogleAuthProvider());
    }
  } catch (err) {
    showToast("Auth failed: " + err.message, "error");
  } finally {
    setButtonLoading(btn, false);
  }
};

window.scrollToForm = () => {
  const el = document.getElementById("audit-section");
  if (el) el.scrollIntoView({ behavior: "smooth" });
};

const themeBtn = document.getElementById("themeBtn");
if (themeBtn) {
  themeBtn.addEventListener("click", () => {
    const root = document.documentElement;
    const current =
      root.getAttribute("data-theme") ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    root.setAttribute("data-theme", current === "dark" ? "light" : "dark");
  });
}

document.querySelectorAll(".dial-card .learn").forEach((btn) => {
  btn.addEventListener("click", () => {
    btn.closest(".dial-card").classList.toggle("open");
  });
});

function setHS(step, state) {
  const el = document.getElementById("hs-" + step);
  if (!el) return;
  el.classList.remove("active", "done");
  if (state === "active") el.classList.add("active");
  if (state === "done") el.classList.add("done");
}

window.runBackendLoop = async () => {
  const btn = document.getElementById("runAuditBtn");
  if (!currentUser) {
    showStatus(
      'Please sign in first. <button onclick="handleAuth()" style="background:#e8b667;color:#15110c;border:none;padding:0.3rem 0.7rem;border-radius:4px;cursor:pointer;margin-left:0.5rem;font-size:0.85rem;font-weight:600">Sign In</button>',
      "error",
      4000,
      true
    );
    scrollToForm();
    return;
  }

  const url = document.getElementById("url").value.trim();
  const topic = document.getElementById("topic").value.trim();
  const vertical = document.getElementById("vertical").value;
  if (!url || !topic || !vertical) {
    showStatus("Please fill in all fields.", "error");
    return;
  }

  setButtonLoading(btn, true);
  const loading = document.getElementById("loading");
  const statusMsg = document.getElementById("statusMessage");
  const resultsDiv = document.getElementById("results");
  loading.style.display = "block";
  resultsDiv.classList.add("hidden");
  statusMsg.innerHTML = "";
  setHS("audit", "active");
  setHS("research", "");
  setHS("fix", "");
  setHS("verify", "");

  try {
    const token = await currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/api/run-audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url, topic, vertical }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Audit request failed");

    setHS("audit", "done");
    showToast("Phase 1 — Audit: complete", "success", 2000);
    setTimeout(() => setHS("research", "active"), 300);
    setTimeout(() => {
      setHS("research", "done");
      setHS("fix", "active");
      showToast("Phase 2 — Research: complete", "success", 2000);
    }, 800);
    setTimeout(() => {
      setHS("fix", "done");
      setHS("verify", "active");
      showToast("Phase 3 — Fix: complete", "success", 2000);
    }, 1300);
    setTimeout(() => {
      setHS("verify", "done");
      showToast("Phase 4 — Verify: complete", "success", 2000);
      renderResults(data.results, url, topic);
    }, 1800);

    showStatus("Audit complete — see results below.", "success");
    loadHistory(currentUser.uid);
  } catch (err) {
    showStatus("Audit failed: " + err.message, "error");
    setHS("audit", "");
    setHS("research", "");
    setHS("fix", "");
    setHS("verify", "");
  } finally {
    setTimeout(() => {
      loading.style.display = "none";
      setButtonLoading(btn, false);
    }, 500);
  }
};

function showToast(msg, type, duration, isHtml) {
  const c = document.getElementById("toastContainer");
  const t = document.createElement("div");
  t.className = "toast toast-" + type;
  if (isHtml) t.innerHTML = msg;
  else t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => {
    t.style.animation = "toastOut 0.3s ease forwards";
    setTimeout(() => t.remove(), 300);
  }, duration || 4000);
}

function showStatus(msg, type, duration, isHtml) {
  showToast(msg, type, duration, isHtml);
}

function setButtonLoading(btn, loading) {
  if (loading) {
    btn.classList.add("loading");
    btn.disabled = true;
  } else {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
}

function scoreClass(s) {
  if (s === null || s === undefined) return "";
  return s >= 70 ? "score-high" : s >= 40 ? "score-med" : "score-low";
}

function stripeClass(s) {
  if (s === null || s === undefined) return "warn";
  return s >= 70 ? "ok" : s >= 40 ? "warn" : "crit";
}

const VERTICAL_LABELS = {
  all: "Twittence signal",
  technical: "Technical SEO score",
  seo: "SEO score",
  aeo: "AEO score",
  geo: "GEO score",
  sentiment: "Sentiment score",
  content: "Content Strategy score",
  local: "Local SEO score",
  ppc: "PPC / Paid Search",
  social: "Social Media",
  email: "Email Marketing",
};

const MICRO_MOMENT_LABELS = {
  "want-to-know": "Moment: Want-to-know",
  "want-to-go": "Moment: Want-to-go",
  "want-to-do": "Moment: Want-to-do",
  "want-to-buy": "Moment: Want-to-buy",
};

function renderResults(r, url, topic) {
  const d = document.getElementById("results");
  d.classList.remove("hidden");
  const vertical = r.vertical || "all";
  const s = {
    tw: r.twittenceScore ?? null,
    seo: r.seoScore ?? null,
    aeo: r.aeoScore ?? null,
    geo: r.geoScore ?? null,
    sent: r.sentimentScore ?? null,
  };

  let h = "";

  if (vertical === "all") {
    h +=
      '<div class="gauge-hero-wrap"><div class="gauge-hero" style="--gauge-pct:' +
      (s.tw ?? 0) +
      '"><div class="gauge-hero-face"><div class="gauge-hero-num">' +
      (s.tw !== null ? s.tw : "N/A") +
      '</div><div class="gauge-hero-label">Twittence signal</div></div></div></div><div class="pillars" style="margin-top:1.5rem">';

    ["seo", "aeo", "geo", "sent"].forEach((k) => {
      const label = k === "seo" ? "SEO" : k === "aeo" ? "AEO" : k === "geo" ? "GEO" : "Sentiment";
      const gaugeColor =
        k === "seo" ? "var(--brass)" : k === "aeo" ? "var(--ok)" : k === "geo" ? "var(--warn)" : "var(--crit)";
      const weight = k === "seo" ? "30%" : k === "aeo" ? "25%" : k === "geo" ? "25%" : "20%";
      const benchmark = k === "seo" && r.externalBenchmark?.seoScore != null
        ? `<div class="p-weight" style="margin-top:.5rem">Google Lighthouse: <b style="color:var(--text)">${r.externalBenchmark.seoScore}</b></div>`
        : "";
      h += `<div class="dial-card"><h4>${label}</h4><div class="p-weight">${weight} of signal</div><div class="mini-gauge" style="--gauge-color:${gaugeColor};--gauge-pct:${
        s[k] ?? 0
      }"><span>${s[k] !== null ? s[k] : "N/A"}</span></div>${benchmark}</div>`;
    });
    h += "</div>";
  } else if (r.verticalMeasurable === false) {
    h += `<div class="status status-info" style="margin-bottom:1rem"><strong>${
      VERTICAL_LABELS[vertical] || vertical
    } can't be measured from a page crawl</strong> — this vertical needs data from an external platform (ad account, social API, or email service) that this tool doesn't connect to. The guidance below is qualitative, not a score.</div>`;
  } else {
    const vs = r.verticalScore ?? null;
    h +=
      '<div class="gauge-hero-wrap"><div class="gauge-hero" style="--gauge-pct:' +
      (vs ?? 0) +
      '"><div class="gauge-hero-face"><div class="gauge-hero-num">' +
      (vs !== null ? vs : "N/A") +
      `</div><div class="gauge-hero-label">${VERTICAL_LABELS[vertical] || vertical}</div></div></div></div>`;
    if (r.externalBenchmark?.seoScore != null) {
      h += `<p style="text-align:center;color:var(--text-dim);font-size:.85rem;margin-top:.5rem">Google Lighthouse SEO score for comparison: <b style="color:var(--text)">${r.externalBenchmark.seoScore}</b></p>`;
    }
  }

  const topicDisplay = topic && topic !== "all" ? topic : "Complete audit";
  const momentBadge = r.microMoment && MICRO_MOMENT_LABELS[r.microMoment]
    ? `<span class="chip warn" title="Google's want-to-know / want-to-go / want-to-do / want-to-buy framework — the search moment this audit's recommendations are tailored to">${MICRO_MOMENT_LABELS[r.microMoment]}</span>`
    : "";
  const partialBanner = r.narrativePartial
    ? `<div class="status status-error" style="margin-bottom:1rem"><strong>AI narrative unavailable this run</strong> — the scores above are accurate (they come from the deterministic page crawl, not the AI), but findings, recommendations, and the self-healing plan couldn't be generated. Re-run the audit to get the full report.</div>`
    : "";

  h += partialBanner + '<div class="report-shell"><div class="report-top"><span class="url">' +
    (url || "") +
    " — " + topicDisplay +
    `</span><span style="display:flex;gap:.4rem;flex-wrap:wrap">${momentBadge}<span class="chip ok">Scan complete</span></span></div><div class="report-body">`;

  h += '<div><h4>Fix first</h4><ul class="punch-list">';
  if (r.findings?.length) {
    h += r.findings
      .map((f, i) => `<li><span class="stripe ${i === 0 ? "crit" : stripeClass(s.tw)}"></span>${f}</li>`)
      .join("");
  } else {
    h += '<li><span class="stripe ok"></span>No findings returned.</li>';
  }
  h += "</ul>";
  if (r.recommendations?.length) {
    h += '<h4 style="margin-top:1.25rem">Recommendations</h4><ul class="punch-list">';
    h += r.recommendations.map((rec) => `<li><span class="stripe warn"></span>${rec}</li>`).join("");
    h += "</ul>";
  }
  h += "</div>";

  const reportFileBase = (url || "audit").replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
  window.__lastReport = { url, topic, vertical, generatedAt: new Date().toISOString(), ...r };

  h += '<div><h4>Share your score</h4><div class="share-card"><div class="plate">' +
    (s.tw !== null ? s.tw : "—") +
    '</div><div class="meta"><div class="site">' +
    (url || "") +
    `</div><div style="display:flex;gap:.5rem;margin-top:.5rem;flex-wrap:wrap"><button class="btn-ghost-sm" onclick="downloadReport('${reportFileBase}')">&#8681; Download Full Report</button></div></div></div>`;
  if (r.selfHealingPlan?.length) {
    h += '<h4 style="margin-top:1.25rem">Self-Healing Plan</h4><div class="heal-steps">' +
      r.selfHealingPlan
        .map((step) => `<div class="heal-step"><div class="hl">${step.phase || "Step"}</div><div>${step.description || step}</div></div>`)
        .join("") +
      "</div>";
  }
  h += "</div></div>";

  if (r.summary) h += `<div style="margin:1.25rem 0"><strong>Summary</strong><p>${r.summary}</p></div>`;

  h += `<div class="outputs"><div class="output-card"><h4>Schema.org JSON-LD</h4><pre id="schemaOut">${JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: "Twittence Audit",
      url: url || "",
      description: r.summary || "",
      score: r.twittenceScore,
      seoScore: r.seoScore,
      aeoScore: r.aeoScore,
      geoScore: r.geoScore,
      sentimentScore: r.sentimentScore,
      findings: r.findings || [],
      recommendations: r.recommendations || [],
    },
    null,
    2
  )}</pre><button class="copy-btn" onclick="copyOut('schemaOut')">&#128203; Copy</button><button class="copy-btn" onclick="downloadOut('schemaOut','${reportFileBase}-schema.json','application/json')">&#8681; Download</button></div><div class="output-card"><h4>AEO Direct Answer Block</h4><pre id="aeoOut">${JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "Question",
      name: topic && topic !== "all" ? topic : "Complete Audit",
      acceptedAnswer: { "@type": "Answer", text: r.summary || "No answer available." },
    },
    null,
    2
  )}</pre><button class="copy-btn" onclick="copyOut('aeoOut')">&#128203; Copy</button><button class="copy-btn" onclick="downloadOut('aeoOut','${reportFileBase}-aeo.json','application/json')">&#8681; Download</button></div><div class="output-card"><h4>/llms.txt</h4><pre id="llmsOut"># Twittence Audit Results
# URL: ${url || "N/A"}
# Topic: ${topic && topic !== "all" ? topic : "Complete Audit"}
# Score: ${r.twittenceScore ?? "N/A"}/100
# SEO:${r.seoScore ?? "N/A"} AEO:${r.aeoScore ?? "N/A"} GEO:${r.geoScore ?? "N/A"} Sent:${r.sentimentScore ?? "N/A"}

## Findings
${(r.findings || []).map((f, i) => `${i + 1}. ${f}`).join("\n")}

## Recommendations
${(r.recommendations || []).map((rec, i) => `${i + 1}. ${rec}`).join("\n")}</pre><button class="copy-btn" onclick="copyOut('llmsOut')">&#128203; Copy</button><button class="copy-btn" onclick="downloadOut('llmsOut','${reportFileBase}-llms.txt','text/plain')">&#8681; Download</button></div></div>`;

  d.innerHTML = h;
}

window.copyOut = (id) => {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard
    .writeText(el.textContent)
    .then(() => showToast("Copied!", "success", 2000))
    .catch(() => showToast("Copy failed", "error", 3000));
};

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime || "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

window.downloadOut = (id, filename, mime) => {
  const el = document.getElementById(id);
  if (!el) return;
  downloadFile(filename, el.textContent, mime);
  showToast("Downloaded " + filename, "success", 2000);
};

window.downloadReport = (fileBase) => {
  if (!window.__lastReport) return;
  downloadFile(
    (fileBase || "audit") + "-full-report.json",
    JSON.stringify(window.__lastReport, null, 2),
    "application/json"
  );
  showToast("Full report downloaded", "success", 2000);
};

window.downloadHistoryReport = async (auditId, urlLabel) => {
  if (!currentUser) return;
  try {
    const token = await currentUser.getIdToken();
    const res = await fetch(`${API_BASE}/api/output/history/${auditId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not retrieve that audit");
    const fileBase = (urlLabel || "audit").replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
    downloadFile(fileBase + "-history.json", JSON.stringify(data.data, null, 2), "application/json");
    showToast("Report downloaded", "success", 2000);
  } catch (err) {
    showToast("Download failed: " + err.message, "error", 3000);
  }
};

async function loadHistory(uid) {
  const ref = collection(db, "users", uid, "audits");
  const q = query(ref, orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  const list = document.getElementById("historyList");
  const noH = document.getElementById("noHistory");
  if (snap.empty) {
    list.innerHTML = "";
    noH.style.display = "block";
    return;
  }
  noH.style.display = "none";
  list.innerHTML = snap.docs
    .map((doc) => {
      const d = doc.data();
      const topicLabel = d.topic && d.topic !== "all" ? d.topic : "Complete audit";
      const verticalLabel = d.vertical && d.vertical !== "all" ? d.vertical : "all 4 pillars";
      const score = d.twittenceScore ?? d.verticalScore ?? null;
      const tier = score == null ? "" : score >= 70 ? "tier-high" : score >= 40 ? "tier-med" : "tier-low";
      const scoreClass = score == null ? "" : score >= 70 ? "score-high" : score >= 40 ? "score-med" : "score-low";
      const dateLabel = formatHistoryDate(d.createdAt);
      const badges = [
        d.seoScore != null ? `<span class="badge">SEO ${d.seoScore}</span>` : "",
        d.aeoScore != null ? `<span class="badge">AEO ${d.aeoScore}</span>` : "",
        d.geoScore != null ? `<span class="badge">GEO ${d.geoScore}</span>` : "",
        d.sentimentScore != null ? `<span class="badge">Sent ${d.sentimentScore}</span>` : "",
      ].join("");
      return `<div class="history-card ${tier}">
        <div class="history-score ${scoreClass}">${score != null ? score : "—"}</div>
        <div class="history-main">
          <span class="url">${d.url || ""}</span>
          <div class="history-meta"><span>${topicLabel}</span><span class="dot">&middot;</span><span>${verticalLabel}</span>${dateLabel ? `<span class="dot">&middot;</span><span>${dateLabel}</span>` : ""}</div>
        </div>
        <div class="history-badges">${badges}<button class="btn-ghost-sm" onclick="downloadHistoryReport('${doc.id}', '${(d.url || "").replace(/'/g, "\\'")}')" title="Download this report">&#8681;</button></div>
      </div>`;
    })
    .join("");
}

function formatHistoryDate(ts) {
  if (!ts || typeof ts.toDate !== "function") return "";
  const d = ts.toDate();
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}
