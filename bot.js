const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActivityType,
} = require("discord.js");
const axios = require("axios");

// ─── Config ──────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "60000");

const EMBED_COLOR = 0x4d8fff;
const GAMMA_API = "https://gamma-api.polymarket.com";
const POLYMARKET_BASE = "https://polymarket.com/event";

// ─── State ───────────────────────────────────────────────────────────────────
// We track at the EVENT level, not individual markets.
// Polymarket groups related markets (e.g. every exact score) under one event.
// Tracking events means "Everton vs Man City" posts once, not 50 times.
const seenEventIds = new Set();
let isFirstRun = true;

// ─── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ─── API ─────────────────────────────────────────────────────────────────────

/**
 * Fetch the latest EVENTS from Polymarket, sorted by creation date descending.
 * Each event contains one or more child markets.
 * We post once per event, not once per market.
 */
async function fetchLatestEvents(limit = 50) {
  const { data } = await axios.get(`${GAMMA_API}/events`, {
    params: {
      limit,
      order: "createdAt",   // true creation time, not start/activation date
      ascending: false,
      active: true,
      closed: false,
    },
    timeout: 10000,
  });
  return Array.isArray(data) ? data : data.data ?? [];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a mini 10-block progress bar */
function buildBar(pct) {
  const filled = Math.round(pct / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

/**
 * Parse odds from an event's markets array.
 * For binary markets: show Yes/No percentages.
 * For multi-outcome (e.g. soccer scores): show top 3 by probability.
 */
function parseOdds(event) {
  try {
    const markets = event.markets;
    if (!markets || markets.length === 0) return null;

    // Binary single-market event
    if (markets.length === 1) {
      const m = markets[0];
      const outcomes =
        typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes;
      const prices =
        typeof m.outcomePrices === "string"
          ? JSON.parse(m.outcomePrices)
          : m.outcomePrices;

      if (!outcomes || !prices || outcomes.length > 4) return null;

      return outcomes
        .map((label, i) => {
          const pct = Math.round(parseFloat(prices[i] ?? 0) * 100);
          return `${buildBar(pct)} **${label}** — ${pct}%`;
        })
        .join("\n");
    }

    // Multi-market event — show top 3 lines by probability
    const allOutcomes = [];
    for (const m of markets) {
      try {
        const outcomes =
          typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes;
        const prices =
          typeof m.outcomePrices === "string"
            ? JSON.parse(m.outcomePrices)
            : m.outcomePrices;
        if (!outcomes || !prices) continue;
        const label = m.groupItemTitle || m.question || outcomes[0];
        const pct = Math.round(parseFloat(prices[0] ?? 0) * 100);
        allOutcomes.push({ label, pct });
      } catch {
        continue;
      }
    }

    if (allOutcomes.length === 0) return null;

    allOutcomes.sort((a, b) => b.pct - a.pct);
    const top = allOutcomes.slice(0, 3);
    const lines = top.map(
      ({ label, pct }) => `${buildBar(pct)} **${label}** — ${pct}%`
    );
    if (allOutcomes.length > 3) {
      lines.push(`*+${allOutcomes.length - 3} more outcomes*`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

/** Format dollar amounts */
function fmt(n) {
  const num = parseFloat(n ?? 0);
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(0)}`;
}

/** Truncate string */
function trunc(str, max = 300) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

/** Strip HTML tags from Polymarket descriptions */
function cleanDescription(raw) {
  if (!raw) return null;
  return raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** Resolve market URL from event slug */
function eventUrl(event) {
  const slug = event.slug;
  if (!slug) return null;
  return `${POLYMARKET_BASE}/${slug}`;
}

/** Pick best image from event or its first market */
function resolveImage(event) {
  if (event.image) return event.image;
  if (event.icon) return event.icon;
  const firstMarket = event.markets?.[0];
  if (firstMarket?.image) return firstMarket.image;
  if (firstMarket?.icon) return firstMarket.icon;
  return null;
}

/** Discord relative timestamp */
function discordTs(dateStr) {
  if (!dateStr) return "N/A";
  const ts = Math.floor(new Date(dateStr).getTime() / 1000);
  return `<t:${ts}:R>`;
}

/** Sum volume/liquidity across all child markets of an event */
function sumField(event, field) {
  if (event[field] != null) return parseFloat(event[field]);
  return (event.markets ?? []).reduce(
    (acc, m) => acc + parseFloat(m[field] ?? 0),
    0
  );
}

// ─── Embed Builder ────────────────────────────────────────────────────────────

function buildEmbed(event) {
  const url = eventUrl(event);
  const odds = parseOdds(event);
  const description = cleanDescription(event.description);
  const image = resolveImage(event);

  const volume = fmt(sumField(event, "volume"));
  const liquidity = fmt(sumField(event, "liquidity"));

  const endDateRaw = event.endDate ?? event.markets?.[0]?.endDate ?? null;
  const endDate = endDateRaw ? discordTs(endDateRaw) : "N/A";

  const category =
    event.category ||
    event.tags?.[0]?.label ||
    event.markets?.[0]?.category ||
    null;

  const marketCount = event.markets?.length ?? 1;
  const marketLabel = marketCount > 1 ? `${marketCount} markets` : "1 market";

  let desc = "";
  if (description) desc += `${trunc(description, 260)}\n\n`;
  if (odds) desc += `**📊 Odds**\n${odds}\n\n`;

  const embed = new EmbedBuilder().setColor(EMBED_COLOR).setTimestamp();

  const title = trunc(event.title || event.question || "New Market", 256);
  if (url) {
    embed.setTitle(title).setURL(url);
  } else {
    embed.setTitle(title);
  }

  if (desc.trim()) embed.setDescription(desc.trim());

  embed.addFields(
    { name: "💰 Volume", value: volume, inline: true },
    { name: "💧 Liquidity", value: liquidity, inline: true },
    { name: "⏱️ Resolves", value: endDate, inline: true }
  );

  if (category) {
    embed.addFields(
      { name: "🏷️ Category", value: category, inline: true },
      { name: "📋 Lines", value: marketLabel, inline: true }
    );
  } else {
    embed.addFields({ name: "📋 Lines", value: marketLabel, inline: true });
  }

  if (image) embed.setImage(image);

  embed.setFooter({
    text: "New Markets • Powered by Polymarket",
    iconURL: "https://polymarket.com/favicon.ico",
  });

  return embed;
}

// ─── Core Polling Logic ───────────────────────────────────────────────────────

async function pollMarkets() {
  const channel = client.channels.cache.get(CHANNEL_ID);
  if (!channel) {
    console.error(`[NewMarkets] Channel ${CHANNEL_ID} not found.`);
    return;
  }

  let events;
  try {
    events = await fetchLatestEvents(50);
  } catch (err) {
    console.error("[NewMarkets] Failed to fetch events:", err.message);
    return;
  }

  if (isFirstRun) {
    events.forEach((e) => seenEventIds.add(e.id));
    isFirstRun = false;
    console.log(
      `[NewMarkets] Seeded ${seenEventIds.size} existing events. Watching for new ones...`
    );
    return;
  }

  const newEvents = events.filter((e) => {
    if (seenEventIds.has(e.id)) return false;

    // Filter out high-frequency crypto up/down contracts.
    // Slug pattern: btc-updown-5m-*, eth-updown-5m-*, sol-updown-5m-*, *-updown-15m-*, etc.
    const slug = (e.slug || "").toLowerCase();
    if (/-(updown|up-or-down)-\d+m?-\d+/.test(slug) || /updown-\d+m-/.test(slug)) {
      seenEventIds.add(e.id);
      return false;
    }

    // Title pattern: "Bitcoin Up or Down - April 19, 7:00PM-7:05PM ET"
    //               "Ethereum Up or Down - 15 min"
    const title = (e.title || e.question || "").toLowerCase();
    if (/up or down/.test(title) || /updown/.test(title)) {
      seenEventIds.add(e.id);
      return false;
    }

    // Catch any remaining short-window markets by duration (under 60 minutes)
    const endRaw = e.endDate ?? e.markets?.[0]?.endDate ?? null;
    const createdRaw = e.createdAt ?? null;
    if (endRaw && createdRaw) {
      const durationMs = new Date(endRaw) - new Date(createdRaw);
      if (durationMs > 0 && durationMs < 60 * 60 * 1000) {
        console.log("[NewMarkets] Skipping short-duration event: " + (e.title || e.id));
        seenEventIds.add(e.id);
        return false;
      }
    }

    return true;
  });
  if (newEvents.length === 0) return;

  console.log(`[NewMarkets] Found ${newEvents.length} new event(s).`);

  // Post oldest-first so Discord feed reads chronologically
  for (const event of newEvents.reverse()) {
    seenEventIds.add(event.id);
    try {
      const embed = buildEmbed(event);
      await channel.send({ embeds: [embed] });
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.error(
        `[NewMarkets] Failed to post event ${event.id}:`,
        err.message
      );
    }
  }
}

// ─── Bot Ready ────────────────────────────────────────────────────────────────

client.once("ready", () => {
  console.log(`[NewMarkets] Logged in as ${client.user.tag}`);
  client.user.setActivity("Polymarket", { type: ActivityType.Watching });
  pollMarkets();
  setInterval(pollMarkets, POLL_INTERVAL_MS);
});

client.on("error", (err) => {
  console.error("[NewMarkets] Discord client error:", err.message);
});

process.on("unhandledRejection", (err) => {
  console.error("[NewMarkets] Unhandled rejection:", err);
});

// ─── Start ────────────────────────────────────────────────────────────────────

if (!DISCORD_TOKEN) {
  console.error("[NewMarkets] Missing DISCORD_TOKEN environment variable.");
  process.exit(1);
}
if (!CHANNEL_ID) {
  console.error("[NewMarkets] Missing CHANNEL_ID environment variable.");
  process.exit(1);
}

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("[NewMarkets] Failed to login:", err.message);
  process.exit(1);
});
