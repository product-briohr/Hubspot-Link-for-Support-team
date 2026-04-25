import { schedule } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Every Friday at 02:00 UTC = 10:00 AM MYT (UTC+8)
const CRON = "0 2 * * 5";

const JIRA_BASE_URL = "https://briohr.atlassian.net";
const JIRA_PROJECT = "B2";
const SLACK_CHANNEL = "C03DV0K13ED";

const EXCLUDED_VERSION_PATTERNS = /mobile|rn|special/i;
// Matches X.XXX.0 — any major version, exactly 3-digit minor, patch = 0
const VALID_VERSION_PATTERN = /^\d+\.\d{3}\.0$/;

function getYesterdayDate() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split("T")[0]; // YYYY-MM-DD
}

async function jiraFetch(path, env) {
  const token = Buffer.from(
    `${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`
  ).toString("base64");
  const res = await fetch(`${JIRA_BASE_URL}/rest/api/3${path}`, {
    headers: {
      Authorization: `Basic ${token}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Jira API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function findRelease(thursday, env) {
  // Search for any issue in a version released on thursday — grab the version from results
  const jql = encodeURIComponent(
    `project = ${JIRA_PROJECT} AND fixVersion in releasedVersions() ORDER BY updated DESC`
  );
  const data = await jiraFetch(
    `/search?jql=${jql}&fields=fixVersions&maxResults=50`,
    env
  );

  const seen = new Set();
  for (const issue of data.issues ?? []) {
    for (const v of issue.fields.fixVersions ?? []) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      if (
        v.releaseDate === thursday &&
        !EXCLUDED_VERSION_PATTERNS.test(v.name) &&
        VALID_VERSION_PATTERN.test(v.name)
      ) {
        return v.name;
      }
    }
  }
  return null;
}

async function getTicketsWithHubspotLinks(versionName, env) {
  const jql = encodeURIComponent(
    `project = ${JIRA_PROJECT} AND fixVersion = "${versionName}" AND issuetype in (Story, Task, Hotfix, "Off Cycle")`
  );
  const data = await jiraFetch(
    `/search?jql=${jql}&fields=summary,description&maxResults=100`,
    env
  );

  const hubspotRegex = /https:\/\/app\.hubspot\.com[^\s\])"<>]*/g;
  const seenUrls = new Set();
  const seenKeys = new Set();
  const results = [];

  for (const issue of data.issues ?? []) {
    // Skip duplicate Jira issues (defensive — Jira shouldn't return dupes)
    if (seenKeys.has(issue.key)) continue;
    seenKeys.add(issue.key);

    const description = extractTextFromAdf(issue.fields.description);
    const links = [...description.matchAll(hubspotRegex)]
      .map((m) => m[0].replace(/[.,]+$/, "").trim()); // strip trailing punctuation

    for (const url of links) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        results.push({ title: issue.fields.summary, url });
      }
    }
  }

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

async function sendSlackMessage(text, env) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL,
      text,
      mrkdwn: true,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack error: ${data.error}`);
  return data;
}

export const handler = schedule(CRON, async () => {
  const env = {
    JIRA_EMAIL: process.env.JIRA_EMAIL,
    JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
  };

  if (!env.JIRA_EMAIL || !env.JIRA_API_TOKEN || !env.SLACK_BOT_TOKEN) {
    console.error("Missing required environment variables");
    return { statusCode: 500 };
  }

  // Guard: only send once per Friday — prevents duplicate Slack messages
  // if Netlify fires the function more than once (e.g. redeploy on same day)
  const today = new Date().toISOString().split("T")[0];
  const store = getStore({ name: "sent-dates", consistency: "strong" });
  const alreadySent = await store.get(today);
  if (alreadySent) {
    console.log(`Already sent for ${today}, skipping.`);
    return { statusCode: 200 };
  }

  const thursday = getYesterdayDate();
  console.log(`Looking for release on ${thursday}`);

  const versionName = await findRelease(thursday, env);

  if (!versionName) {
    console.log(`No qualifying release found for ${thursday}`);
    await sendSlackMessage(
      `Hi team, no qualifying release found for yesterday (${thursday}).`,
      env
    );
    return { statusCode: 200 };
  }

  console.log(`Found release: ${versionName}`);
  const tickets = await getTicketsWithHubspotLinks(versionName, env);

  let message;
  if (tickets.length === 0) {
    message = `Hi team, no tickets with HubSpot links found in yesterday's release.`;
  } else {
    const lines = tickets.map(
      (t, i) => `${i + 1}. ${t.title}\n   ${t.url}`
    );
    message = [
      `Hi team, with yesterday's release, the following tickets have been updated to: Tech status = Deployed, Ticket Status: Re-engage client/support team clarification OR Resolved`,
      ``,
      ...lines,
    ].join("\n");
  }

  console.log("Sending Slack message:\n", message);
  await sendSlackMessage(message, env);
  await store.set(today, "sent");

  return { statusCode: 200 };
});
