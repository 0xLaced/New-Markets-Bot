# 🔵 New Markets — Discord Bot

A Discord bot that monitors [Polymarket](https://polymarket.com) and posts a rich embed every time a new prediction market is listed. Includes live odds, volume, liquidity, resolution date, and the market's image.

---

## Features

- Polls Polymarket's Gamma API every 60 seconds (configurable)
- Posts a beautiful `#4D8FFF` embed for each new market
- Embed includes:
  - Market title as a clickable hyperlink
  - Market description (cleaned of HTML)
  - Current Yes/No odds with visual progress bars
  - Volume, liquidity, and resolution date
  - Market image (when available)
  - Category tag
- Optionally mentions a user, `@everyone`, or `@here` outside the embed
- Seeds existing markets on startup — no spam when the bot first connects

---

## Setup

### 1. Create a Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → name it **New Markets**
3. Go to **Bot** → click **Add Bot**
4. Under **Token**, click **Reset Token** and copy it
5. Under **Privileged Gateway Intents**, enable **Server Members Intent** if you plan to use user mentions
6. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Embed Links`, `View Channel`
7. Copy the generated URL and invite the bot to your server

### 2. Get your Channel ID

1. In Discord, go to **User Settings → Advanced** and enable **Developer Mode**
2. Right-click the channel you want the bot to post in → **Copy Channel ID**

### 3. Deploy to Railway

#### Option A — Deploy from GitHub (recommended)

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Select your repo
4. Go to your service → **Variables** and add:

| Variable | Value |
|---|---|
| `DISCORD_TOKEN` | Your bot token |
| `CHANNEL_ID` | Your channel ID |
| `MENTION_USER_ID` | (optional) User ID, `@everyone`, or `@here` |
| `POLL_INTERVAL_MS` | `60000` (or your preferred interval) |

5. Railway will auto-detect Node.js and deploy. Done!

#### Option B — Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway variables set DISCORD_TOKEN=xxx CHANNEL_ID=yyy
```

### 4. Run locally (for testing)

```bash
cp .env.example .env
# Edit .env with your values

npm install
npm start
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | — | Discord bot token |
| `CHANNEL_ID` | ✅ | — | Channel to post in |
| `MENTION_USER_ID` | ❌ | (none) | User ID or `@everyone` / `@here` |
| `POLL_INTERVAL_MS` | ❌ | `60000` | Poll frequency in milliseconds |

---

## Embed Preview

```
@User

🔵 [Will the Fed cut rates in May 2025?](https://polymarket.com/event/...)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The Federal Reserve will decide whether to cut interest rates at...

📊 Current Odds
██████████░  Yes — 72%
░░░░░░████  No — 28%

💰 Volume    💧 Liquidity    ⏱️ Resolves
$1.2M        $340K           in 3 months

🏷️ Category: Politics
[Market Image]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
New Markets • Polymarket
```

---

## Notes

- The bot seeds all currently-active markets on first start, then only posts **newly created** ones going forward.
- Polymarket's Gamma API is public and requires no authentication.
- Railway's free tier runs 24/7 within monthly usage limits — more than enough for this bot.
