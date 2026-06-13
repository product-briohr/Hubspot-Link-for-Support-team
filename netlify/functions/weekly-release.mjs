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

// Human-readable hints for the most common Slack API errors — printed in logs
// so a failure tells you exactly what to do, not just an opaque error code.
const SLACK_ERROR_HINTS = {
  account_inactive:
    "Token belongs to a deactivated/uninstalled app. Reinstall the Slack app and update SLACK_BOT_TOKEN.",
  invalid_auth: "Token is invalid or revoked. Generate a fresh Bot User OAuth Token (xoxb-...).",
  token_revoked: "Token was revoked. Reinstall the app and update SLACK_BOT_TOKEN.",
  not_authed: "No token sent. Check SLACK_BOT_TOKEN env var is set.",
  not_in_channel:
    "Bot is not a member of the channel. Run `/invite @Hubspot ticket for support team` in #team-support-product.",
  channel_not_found:
    "Channel ID is wrong, or the bot can't see it (private channel requires an invite).",
  missing_scope: "Token lacks a required OAuth scope (need `chat:write`). Reinstall the app with that scope.",
  is_archived: "The target channel is archived.",
  msg_too_long: "Message exceeded Slack's length limit. Consider splitting the message.",
  ratelimited: "Hit Slack rate limit. The function will fail this run; it retries next schedule.",
};

// ─── Structured logger ────────────────────────────────────────────────────────
// Module-scoped context bound at the start of each invocation. Scheduled
// functions run sequentially per container, so a shared context is safe and
// lets every helper emit runId + elapsedMs without threading args everywhere.
let CTX = { runId: "-", t0: 0 };

function log(level, step, msg, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    runId: CTX.runId,
    elapsedMs: CTX.t0 ? Date.now() - CTX.t0 : 0,
    level,
    step,
    msg,
    ...data,
  };
  level === "ERROR" ? console.error(JSON.stringify(entry)) : console.log(JSON.stringify(entry));
}

// Mask a secret so logs can confirm "a token is present and which one" without
// ever leaking it. xoxb-1234567890-... → "xoxb-123456...len=57"
function maskToken(t) {
  if (!t) return "(missing)";
  return `${t.slice(0, 10)}…(len=${t.length})`;
}

// ─── Date helper ──────────────────────────────────────────────────────────────
// Runs Friday 02:00 UTC → yesterday (UTC) = Thursday → matches Jira release dates
function getYesterdayDateUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0]; // YYYY-MM-DD
}

// ─── Jira helpers ─────────────────────────────────────────────────────────────
async function jiraFetch(path, env) {
  const token = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64");
  const url = `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}/rest/api/3${path}`;

  log("DEBUG", "JIRA_REQ", "GET", { url });
  const started = Date.now();
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${token}`, Accept: "application/json" },
  });
  const durationMs = Date.now() - started;

  if (!res.ok) {
    const body = await res.text();
    log("ERROR", "JIRA_RES", "GET failed", {
      url,
      status: res.status,
      durationMs,
      rateLimit: res.headers.get("x-ratelimit-remaining"),
      retryAfter: res.headers.get("retry-after"),
      bodyPreview: body.slice(0, 500),
    });
    throw new Error(`Jira API ${res.status} on GET ${path}: ${body}`);
  }

  const json = await res.json();
  log("DEBUG", "JIRA_RES", "GET ok", {
    url,
    status: res.status,
    durationMs,
    rateLimit: res.headers.get("x-ratelimit-remaining"),
  });
  return json;
}

async function jiraPost(path, body, env) {
  const token = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64");
  const url = `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}/rest/api/3${path}`;

  log("DEBUG", "JIRA_REQ", "POST", { url, jql: body.jql });
  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const durationMs = Date.now() - started;

  if (!res.ok) {
    const respBody = await res.text();
    log("ERROR", "JIRA_RES", "POST failed", {
      url,
      status: res.status,
      durationMs,
      rateLimit: res.headers.get("x-ratelimit-remaining"),
      retryAfter: res.headers.get("retry-after"),
      bodyPreview: respBody.slice(0, 500),
    });
    throw new Error(`Jira API ${res.status} on POST ${path}: ${respBody}`);
  }

  const json = await res.json();
  log("DEBUG", "JIRA_RES", "POST ok", { url, status: res.status, durationMs });
  return json;
}

// Find the qualifying release version for a given date.
// Checks both unreleased and released versions — a version may still be marked
// "unreleased" in Jira on Friday morning even though its releaseDate is Thursday.
async function findRelease(thursday, env) {
  log("INFO", "JIRA", "Searching for release version", { releaseDate: thursday, project: JIRA_PROJECT });

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
    if (v.releaseDate !== thursday) continue;
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
    if (v.releaseDate !== thursday) continue;
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
  let ticketsWithLinks = 0;
  let ticketsWithoutLinks = 0;

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
      ticketsWithoutLinks++;
      log("DEBUG", "EXTRACT", "No HubSpot links in ticket", {
        key: issue.key,
        title: issue.fields.summary,
        descLength: description.length,
      });
      continue;
    }

    ticketsWithLinks++;
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
    log("DEBUG", "EXTRACT", "Links extracted from ticket", {
      key: issue.key,
      title: issue.fields.summary,
      matched: links.length,
      newLinks,
      dupLinks,
    });
  }

  log("INFO", "EXTRACT", "HubSpot extraction complete", {
    ticketsScanned: issues.length,
    ticketsWithLinks,
    ticketsWithoutLinks,
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

// ─── Slack helpers ────────────────────────────────────────────────────────────

// Generic Slack Web API caller with full request/response logging. On any
// failure it logs the HTTP status, the granted OAuth scopes (from headers),
// the full response body, and a human-readable hint for the error code.
async function slackApi(method, body, env, { httpMethod = "POST" } = {}) {
  const url = `https://slack.com/api/${method}`;
  log("DEBUG", "SLACK_REQ", method, { url, httpMethod });

  const started = Date.now();
  const res = await fetch(url, {
    method: httpMethod,
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: httpMethod === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const durationMs = Date.now() - started;

  const grantedScopes = res.headers.get("x-oauth-scopes");
  const acceptedScopes = res.headers.get("x-accepted-oauth-scopes");

  let data;
  try {
    data = await res.json();
  } catch (e) {
    const raw = await res.text().catch(() => "(unreadable)");
    log("ERROR", "SLACK_RES", `${method} returned non-JSON`, {
      httpStatus: res.status,
      durationMs,
      bodyPreview: raw.slice(0, 500),
    });
    throw new Error(`Slack ${method} non-JSON response (HTTP ${res.status})`);
  }

  if (!data.ok) {
    log("ERROR", "SLACK_RES", `${method} failed`, {
      slackError: data.error,
      hint: SLACK_ERROR_HINTS[data.error] || "See https://api.slack.com/methods/" + method,
      warning: data.warning ?? null,
      responseMetadata: data.response_metadata ?? null,
      httpStatus: res.status,
      durationMs,
      grantedScopes,
      acceptedScopes,
      needed: data.needed ?? null,
      provided: data.provided ?? null,
    });
    const err = new Error(`Slack ${method} error: ${data.error}`);
    err.slackError = data.error;
    throw err;
  }

  log("DEBUG", "SLACK_RES", `${method} ok`, { durationMs, grantedScopes });
  return data;
}

// Preflight: validate the token BEFORE doing any work. Logs the bot identity
// and granted scopes so a glance at the logs tells you which app/token is live.
// This is the check that surfaces account_inactive / invalid_auth immediately.
async function slackPreflight(env) {
  log("INFO", "SLACK_AUTH", "Validating Slack token (auth.test)", {
    token: maskToken(env.SLACK_BOT_TOKEN),
    targetChannel: SLACK_CHANNEL,
  });
  const auth = await slackApi("auth.test", {}, env);
  log("INFO", "SLACK_AUTH", "Slack token is valid", {
    botUser: auth.user,
    botUserId: auth.user_id,
    botId: auth.bot_id,
    team: auth.team,
    teamId: auth.team_id,
    url: auth.url,
  });
  return auth;
}

async function sendSlackMessage(text, env) {
  log("INFO", "SLACK", "Posting message", {
    channel: SLACK_CHANNEL,
    messageLength: text.length,
    lineCount: text.split("\n").length,
  });
  const data = await slackApi("chat.postMessage", { channel: SLACK_CHANNEL, text, mrkdwn: true }, env);
  log("INFO", "SLACK", "Message posted", { channel: data.channel, ts: data.ts });
  return data;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export const handler = schedule(CRON, async () => {
  CTX = { runId: Math.random().toString(36).slice(2, 10), t0: Date.now() };
  const summary = { version: null, ticketsScanned: 0, linksSent: 0, outcome: "unknown" };

  log("INFO", "START", "Function invoked", {
    cron: CRON,
    utcNow: new Date().toISOString(),
    mytNow: new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }),
    node: process.version,
  });

  try {
    const env = {
      JIRA_EMAIL: process.env.JIRA_EMAIL,
      JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    };

    // Step 1 — Validate env vars
    const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length > 0) {
      log("ERROR", "ENV", "Missing required environment variables", { missing });
      summary.outcome = "missing_env";
      return { statusCode: 500 };
    }
    log("INFO", "ENV", "All environment variables present", {
      jiraEmail: env.JIRA_EMAIL,
      jiraToken: maskToken(env.JIRA_API_TOKEN),
      slackToken: maskToken(env.SLACK_BOT_TOKEN),
    });

    // Step 2 — Slack preflight: fail fast with a clear error if the token is dead
    try {
      await slackPreflight(env);
    } catch (err) {
      log("ERROR", "SLACK_AUTH", "Slack token preflight FAILED — aborting before any work", {
        error: err.message,
        slackError: err.slackError ?? null,
        hint: SLACK_ERROR_HINTS[err.slackError] || "Fix the Slack token, then it resumes next schedule.",
      });
      summary.outcome = "slack_auth_failed";
      return { statusCode: 500 };
    }

    // Step 3 — Dedup guard: only send once per Friday
    const today = new Date().toISOString().split("T")[0];
    let store;
    try {
      store = getStore({ name: "sent-dates", consistency: "strong" });
      const alreadySent = await store.get(today);
      log("INFO", "DEDUP", "Dedup check", { today, alreadySent: !!alreadySent });
      if (alreadySent) {
        log("WARN", "DEDUP", "Already sent today — skipping to prevent duplicate", { today });
        summary.outcome = "already_sent";
        return { statusCode: 200 };
      }
    } catch (err) {
      log("WARN", "DEDUP", "Dedup store unavailable — proceeding without guard", { error: err.message });
      store = null;
    }

    // Step 4 — Resolve Thursday release date
    const thursday = getYesterdayDateUTC();
    log("INFO", "DATE", "Resolved Thursday date", { thursday, utcNow: new Date().toISOString() });

    // Step 5 — Find the Jira release version
    let versionName;
    try {
      versionName = await findRelease(thursday, env);
    } catch (err) {
      log("ERROR", "JIRA", "Failed to search for release version", { error: err.message, stack: err.stack });
      summary.outcome = "jira_version_error";
      return { statusCode: 500 };
    }

    if (!versionName) {
      log("WARN", "JIRA", "No qualifying release — sending no-release notice to Slack");
      try {
        await sendSlackMessage(`Hi team, no qualifying release found for yesterday (${thursday}).`, env);
        summary.outcome = "no_release_notice_sent";
      } catch (err) {
        log("ERROR", "SLACK", "Failed to send no-release Slack message", {
          error: err.message,
          slackError: err.slackError ?? null,
          stack: err.stack,
        });
        summary.outcome = "no_release_notice_failed";
      }
      return { statusCode: 200 };
    }
    summary.version = versionName;

    // Step 6 — Fetch tickets and extract HubSpot links
    let tickets;
    try {
      tickets = await getTicketsWithHubspotLinks(versionName, env);
      summary.linksSent = tickets.length;
    } catch (err) {
      log("ERROR", "JIRA", "Failed to fetch tickets", { versionName, error: err.message, stack: err.stack });
      summary.outcome = "jira_tickets_error";
      return { statusCode: 500 };
    }

    // Step 7 — Build and send Slack message
    let message;
    if (tickets.length === 0) {
      message = `Hi team, no tickets with HubSpot links found in yesterday's release (${versionName}).`;
      log("WARN", "SLACK", "No HubSpot links found — sending empty-release notice", { versionName });
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
      log("ERROR", "SLACK", "Failed to send Slack message", {
        error: err.message,
        slackError: err.slackError ?? null,
        hint: SLACK_ERROR_HINTS[err.slackError] || null,
        stack: err.stack,
      });
      summary.outcome = "slack_send_failed";
      return { statusCode: 500 };
    }

    // Step 8 — Record sent date for dedup
    if (store) {
      try {
        await store.set(today, "sent");
        log("INFO", "DEDUP", "Recorded sent date", { today });
      } catch (err) {
        log("WARN", "DEDUP", "Could not write dedup record — safe to continue", { error: err.message });
      }
    }

    summary.outcome = "sent";
    log("INFO", "DONE", "Function completed successfully", {
      ...summary,
      totalDurationMs: Date.now() - CTX.t0,
    });
    return { statusCode: 200 };
  } catch (err) {
    // Catch-all: any unexpected throw is logged with a full stack rather than
    // vanishing as a silent platform-level 500.
    log("ERROR", "UNHANDLED", "Unexpected error in handler", {
      error: err.message,
      stack: err.stack,
      summary,
      totalDurationMs: Date.now() - CTX.t0,
    });
    return { statusCode: 500 };
  }
});
