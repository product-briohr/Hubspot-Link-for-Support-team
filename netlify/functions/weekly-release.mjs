import { schedule } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Every Friday at 02:00 UTC = 10:00 AM MYT (UTC+8)
const CRON = "0 2 * * 5";

const JIRA_CLOUD_ID = "e38dd556-d5ba-4444-8e93-93420ba8123c";
const JIRA_PROJECT = "B2";
const SLACK_CHANNEL = "C03DV0K13ED"; // #team-support-product

const EXCLUDED_VERSION_PATTERNS = /mobile|rn|special/i;
// Matches X.XXX.0 — any major version, exactly 3-digit minor, patch = 0
const VALID_VERSION_PATTERN = /^\d+\.\d{3}\.0$/;

// ─── Structured logger ────────────────────────────────────────────────────────
function log(level, step, msg, data = {}) {
  const entry = { ts: new Date().toISOString(), level, step, msg, ...data };
  level === "ERROR" ? console.error(JSON.stringify(entry)) : console.log(JSON.stringify(entry));
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
// Runs Friday 02:00 UTC → yesterday (UTC) = Thursday → matches Jira release dates
function getYesterdayDateUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0]; // YYYY-MM-DD
}

// Today's UTC date — fallback in case someone marked the release date as Friday
function getTodayDateUTC() {
  return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
}

// ─── Jira helpers ─────────────────────────────────────────────────────────────
async function jiraFetch(path, env) {
  const token = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64");
  const url = `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}/rest/api/3${path}`;

  log("DEBUG", "JIRA_REQ", "GET", { url });
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${token}`, Accept: "application/json" },
  });
  log("DEBUG", "JIRA_RES", "GET response", { url, status: res.status });

  if (!res.ok) {
    throw new Error(`Jira API ${res.status} on GET ${path}: ${await res.text()}`);
  }
  return res.json();
}

async function jiraPost(path, body, env) {
  const token = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64");
  const url = `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}/rest/api/3${path}`;

  log("DEBUG", "JIRA_REQ", "POST", { url, jql: body.jql });
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  log("DEBUG", "JIRA_RES", "POST response", { url, status: res.status });

  if (!res.ok) {
    throw new Error(`Jira API ${res.status} on POST ${path}: ${await res.text()}`);
  }
  return res.json();
}

// Find the qualifying release version for a given date.
// Checks both unreleased and released versions — a version may still be marked
// "unreleased" in Jira on Friday morning even though its releaseDate is Thursday.
// Also checks today's date (Friday) as a fallback in case someone set the
// releaseDate to Friday when marking the version as released.
async function findRelease(thursday, friday, env) {
  log("INFO", "JIRA", "Searching for release version", { thursday, friday, project: JIRA_PROJECT });

  const unreleased = await jiraFetch(
    `/project/${JIRA_PROJECT}/version?status=unreleased&orderBy=-sequence&maxResults=50`,
    env
  );
  const unreleasedList = unreleased.values || unreleased;
  log("DEBUG", "JIRA", "Unreleased versions fetched", {
    count: unreleasedList.length,
    versions: unreleasedList.map((v) => ({ name: v.name, releaseDate: v.releaseDate })),
  });

  for (const v of unreleasedList) {
    if (v.releaseDate !== thursday && v.releaseDate !== friday) continue;
    if (EXCLUDED_VERSION_PATTERNS.test(v.name)) {
      log("DEBUG", "JIRA", "Version skipped (excluded pattern)", { name: v.name });
      continue;
    }
    if (!VALID_VERSION_PATTERN.test(v.name)) {
      log("DEBUG", "JIRA", "Version skipped (name pattern mismatch)", { name: v.name, expected: "X.XXX.0" });
      continue;
    }
    log("INFO", "JIRA", "Qualifying version found in unreleased", { name: v.name, releaseDate: v.releaseDate });
    return v.name;
  }

  log("DEBUG", "JIRA", "No match in unreleased — checking released versions");
  const released = await jiraFetch(
    `/project/${JIRA_PROJECT}/version?status=released&orderBy=-sequence&maxResults=20`,
    env
  );
  const releasedList = released.values || released;
  log("DEBUG", "JIRA", "Released versions fetched", {
    count: releasedList.length,
    versions: releasedList.slice(0, 10).map((v) => ({ name: v.name, releaseDate: v.releaseDate })),
  });

  for (const v of releasedList) {
    if (v.releaseDate !== thursday && v.releaseDate !== friday) continue;
    if (EXCLUDED_VERSION_PATTERNS.test(v.name)) continue;
    if (!VALID_VERSION_PATTERN.test(v.name)) continue;
    log("INFO", "JIRA", "Qualifying version found in released", { name: v.name, releaseDate: v.releaseDate });
    return v.name;
  }

  log("WARN", "JIRA", "No qualifying version found for date", { releaseDate: thursday });
  return null;
}

async function getTicketsWithHubspotLinks(versionName, env) {
  const jql = `project = ${JIRA_PROJECT} AND fixVersion = "${versionName}" AND issuetype in (Story, Task, Hotfix, "Off Cycle")`;
  log("INFO", "JIRA", "Fetching tickets for version", { versionName, jql });

  const data = await jiraPost(
    "/search/jql",
    { jql, fields: ["summary", "description", "issuetype"], maxResults: 100 },
    env
  );

  const issues = data.issues ?? [];
  log("INFO", "JIRA", "Tickets fetched", {
    versionName,
    total: data.total,
    returned: issues.length,
    issueKeys: issues.map((i) => i.key),
    issueTypes: [...new Set(issues.map((i) => i.fields?.issuetype?.name))],
  });

  const hubspotRegex = /https:\/\/app\.hubspot\.com[^\s\])"<>]*/g;
  const seenUrls = new Set();
  const seenKeys = new Set();
  const results = [];

  for (const issue of issues) {
    if (seenKeys.has(issue.key)) {
      log("DEBUG", "EXTRACT", "Duplicate Jira issue skipped", { key: issue.key });
      continue;
    }
    seenKeys.add(issue.key);

    const description = extractTextFromAdf(issue.fields.description);
    const links = [...description.matchAll(hubspotRegex)].map((m) =>
      m[0].replace(/[.,]+$/, "").trim()
    );

    if (links.length === 0) {
      log("DEBUG", "EXTRACT", "No HubSpot links in ticket", { key: issue.key, title: issue.fields.summary });
      continue;
    }

    let newLinks = 0;
    let dupLinks = 0;
    for (const url of links) {
      if (seenUrls.has(url)) {
        dupLinks++;
        log("DEBUG", "EXTRACT", "Duplicate URL skipped", { key: issue.key, url });
      } else {
        seenUrls.add(url);
        results.push({ title: issue.fields.summary, url });
        newLinks++;
      }
    }
    log("DEBUG", "EXTRACT", "Links extracted from ticket", { key: issue.key, title: issue.fields.summary, newLinks, dupLinks });
  }

  log("INFO", "EXTRACT", "HubSpot extraction complete", {
    ticketsScanned: issues.length,
    ticketsWithLinks: results.length > 0 ? [...new Set(results.map((r) => r.title))].length : 0,
    totalLinks: results.length,
    links: results.map((r) => ({ title: r.title, url: r.url })),
  });

  return results;
}

// Recursively extract plain text from Atlassian Document Format (ADF) JSON
function extractTextFromAdf(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  if (node.type === "inlineCard" || node.type === "blockCard") {
    return node.attrs?.url ?? "";
  }
  const children = node.content ?? [];
  return children.map(extractTextFromAdf).join(" ");
}

// ─── Slack sender ─────────────────────────────────────────────────────────────
async function sendSlackMessage(text, env) {
  log("DEBUG", "SLACK", "Posting message", { channel: SLACK_CHANNEL, messageLength: text.length });

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text, mrkdwn: true }),
  });

  const data = await res.json();
  log("DEBUG", "SLACK", "Slack API response", { ok: data.ok, error: data.error ?? null, ts: data.ts ?? null });

  if (!data.ok) throw new Error(`Slack error: ${data.error}`);
  return data;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export const handler = schedule(CRON, async () => {
  const runId = Math.random().toString(36).slice(2, 10);
  log("INFO", "START", "Function invoked", { runId, cron: CRON, utcNow: new Date().toISOString() });

  const env = {
    JIRA_EMAIL: process.env.JIRA_EMAIL,
    JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
  };

  // Step 1 — Validate env vars
  const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    log("ERROR", "ENV", "Missing required environment variables", { missing });
    return { statusCode: 500 };
  }
  log("INFO", "ENV", "All environment variables present");

  // Step 2 — Dedup guard: only send once per Friday
  const today = new Date().toISOString().split("T")[0];
  let store;
  try {
    store = getStore({ name: "sent-dates", consistency: "strong" });
    const alreadySent = await store.get(today);
    log("INFO", "DEDUP", "Dedup check", { today, alreadySent: !!alreadySent });
    if (alreadySent) {
      log("WARN", "DEDUP", "Already sent today — skipping to prevent duplicate", { today });
      return { statusCode: 200 };
    }
  } catch (err) {
    log("WARN", "DEDUP", "Dedup store unavailable — proceeding without guard", { error: err.message });
    store = null;
  }

  // Step 3 — Resolve dates to search (Thursday = yesterday, Friday = today as fallback)
  const thursday = getYesterdayDateUTC();
  const friday = getTodayDateUTC();
  log("INFO", "DATE", "Resolved search dates", { thursday, friday, utcNow: new Date().toISOString() });

  // Step 4 — Find the Jira release version
  let versionName;
  try {
    versionName = await findRelease(thursday, friday, env);
  } catch (err) {
    log("ERROR", "JIRA", "Failed to search for release version", { error: err.message, stack: err.stack });
    return { statusCode: 500 };
  }

  if (!versionName) {
    log("WARN", "JIRA", "No qualifying release — sending no-release notice to Slack");
    try {
      await sendSlackMessage(`Hi team, no qualifying release found for yesterday (${thursday}).`, env);
    } catch (err) {
      log("ERROR", "SLACK", "Failed to send no-release Slack message", { error: err.message });
    }
    return { statusCode: 200 };
  }

  // Step 5 — Fetch tickets and extract HubSpot links
  let tickets;
  try {
    tickets = await getTicketsWithHubspotLinks(versionName, env);
  } catch (err) {
    log("ERROR", "JIRA", "Failed to fetch tickets", { versionName, error: err.message, stack: err.stack });
    return { statusCode: 500 };
  }

  // Step 6 — Build and send Slack message
  let message;
  if (tickets.length === 0) {
    message = `Hi team, no tickets with HubSpot links found in yesterday's release (${versionName}).`;
    log("WARN", "SLACK", "No HubSpot links found — sending empty-release notice");
  } else {
    const lines = tickets.map((t, i) => `${i + 1}. ${t.title}\n   ${t.url}`);
    message = [
      `Hi team, with yesterday's release (${versionName}), the following tickets have been updated to: Tech status = Deployed, Ticket Status: Re-engage client/support team clarification OR Resolved`,
      ``,
      ...lines,
    ].join("\n");
  }

  log("INFO", "SLACK", "Sending Slack message", { versionName, linkCount: tickets.length, channel: SLACK_CHANNEL });
  try {
    await sendSlackMessage(message, env);
  } catch (err) {
    log("ERROR", "SLACK", "Failed to send Slack message", { error: err.message, stack: err.stack });
    return { statusCode: 500 };
  }

  // Step 7 — Record sent date for dedup
  if (store) {
    try {
      await store.set(today, "sent");
      log("INFO", "DEDUP", "Recorded sent date", { today });
    } catch (err) {
      log("WARN", "DEDUP", "Could not write dedup record — safe to continue", { error: err.message });
    }
  }

  log("INFO", "DONE", "Function completed successfully", { runId, versionName, linksSent: tickets.length });
  return { statusCode: 200 };
});
