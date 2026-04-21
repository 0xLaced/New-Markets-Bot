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
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "60000"); // default 60s

const EMBED_COLOR = 0x4d8fff;
const GAMMA_API = "https://gamma-api.polymarket.com";
const POLYMARKET_BASE = "https://polymarket.com/event";

// ─── State ───────────────────────────────────────────────────────────────────
const seenMarketIds = new Set();
let isFirstRun = true;

// ─── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch the latest markets from Polymarket Gamma API, sorted newest first.
 */
async function fetchLatestMarkets(limit = 50) {
  const { data } = await axios.get(`${GAMMA_API}/markets`, {
    params: {
      limit,
      order: "startDate",
      ascending: false,
      active: true,
      closed: false,
    },
    timeout: 10000,
  });
  return Array.isArray(data) ? data : data.data ?? [];
}

/**
 * Parse outcome prices into a readable string.
 * outcomePrices is a JSON string like '["0.72","0.28"]'
 * outcomes is a JSON string like '["Yes","No"]'
 */
function parseOdds(market) {
  try {
    const outcomes =
      typeof market.outcomes === "string"
        ? JSON.parse(market.outcomes)
        : market.outcomes;
    const prices =
      typeof market.outcomePrices === "string"
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices;

    if (!outcomes || !prices) return null;

    return outcomes
      .map((label, i) => {
        const pct = Math.round(parseFloat(prices[i] ?? 0) * 100);
        const bar = buildBar(pct);
        return `${bar} **${label}** — ${pct}%`;
      })
      .join("\n");
  } catch {
    return null;
  }
}

/** Build a mini progress bar */
function buildBar(pct) {
  const filled = Math.round(pct / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

/** Format large numbers */
function fmt(n) {
  const num = parseFloat(n ?? 0);
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(0)}`;
}

/** Truncate a string to max length */
function trunc(str, max = 300) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

/** Pull a clean description — Polymarket description field is sometimes HTML */
function cleanDescription(raw) {
  if (!raw) return null;
  // Strip HTML tags
  return raw.replace(/<[^>]+>/g, "").trim();
}

/** Resolve the market URL using the event slug */
function marketUrl(market) {
  const slug = market.slug || market.marketSlug || market.conditionId;
  if (!slug) return null;
  return `${POLYMARKET_BASE}/${slug}`;
}

/** Resolve image: prefer event image → market image → icon */
function resolveImage(market) {
  return market.image || market.icon || null;
}

/** Format a date string to Discord timestamp */
function discordTs(dateStr) {
  if (!dateStr) return "N/A";
  const ts = Math.floor(new Date(dateStr).getTime() / 1000);
  return `<t:${ts}:R>`;
}

// ─── Embed Builder ────────────────────────────────────────────────────────────

function buildEmbed(market) {
  const url = marketUrl(market);
  const odds = parseOdds(market);
  const description = cleanDescription(market.description);
  const image = resolveImage(market);

  const volume = fmt(market.volume);
  const liquidity = fmt(market.liquidity);
  const endDate = market.endDate
    ? discordTs(market.endDate)
    : "No end date";

  // Category tag
  const category =
    market.category ||
    market.eventCategory ||
    market.tags?.[0]?.label ||
    null;

  // Build embed description block
  let desc = "";
  if (description) {
    desc += `${trunc(description, 280)}\n\n`;
  }
  if (odds) {
    desc += `**📊 Current Odds**\n${odds}\n\n`;
  }

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTimestamp();

  // Title as hyperlink
  const title = trunc(market.question || "New Market", 256);
  if (url) {
    embed.setTitle(title).setURL(url);
  } else {
    embed.setTitle(title);
  }

  if (desc.trim()) embed.setDescription(desc.trim());

  // Stats fields
  embed.addFields(
    {
      name: "💰 Volume",
      value: volume,
      inline: true,
    },
    {
      name: "💧 Liquidity",
      value: liquidity,
      inline: true,
    },
    {
      name: "⏱️ Resolves",
      value: endDate,
      inline: true,
    }
  );

  if (category) {
    embed.addFields({ name: "🏷️ Category", value: category, inline: true });
  }

  if (image) {
    embed.setImage(image);
  }

  embed.setFooter({
    text: "New Markets • Polymarket",
    iconURL:
      "https://polymarket.com/favicon.ico",
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

  let markets;
  try {
    markets = await fetchLatestMarkets(50);
  } catch (err) {
    console.error("[NewMarkets] Failed to fetch markets:", err.message);
    return;
  }

  if (isFirstRun) {
    // Seed the seen set without posting — avoids spamming on startup
    markets.forEach((m) => seenMarketIds.add(m.id));
    isFirstRun = false;
    console.log(
      `[NewMarkets] Initialized with ${seenMarketIds.size} existing markets. Watching for new ones...`
    );
    return;
  }

  // Find markets we haven't seen before (newest first from API)
  const newMarkets = markets.filter((m) => !seenMarketIds.has(m.id));

  if (newMarkets.length === 0) return;

  console.log(`[NewMarkets] Found ${newMarkets.length} new market(s).`);

  // Post oldest-first so the feed reads chronologically
  for (const market of newMarkets.reverse()) {
    seenMarketIds.add(market.id);

    try {
      const embed = buildEmbed(market);

      await channel.send({ embeds: [embed] });

      // Small delay between posts to avoid rate limits
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.error(
        `[NewMarkets] Failed to post market ${market.id}:`,
        err.message
      );
    }
  }
}

// ─── Bot Ready ────────────────────────────────────────────────────────────────

client.once("ready", () => {
  console.log(`[NewMarkets] Logged in as ${client.user.tag}`);

  client.user.setActivity("Polymarket", {
    type: ActivityType.Watching,
  });

  // Run immediately then on interval
  pollMarkets();
  setInterval(pollMarkets, POLL_INTERVAL_MS);
});

// ─── Error Handling ───────────────────────────────────────────────────────────

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
