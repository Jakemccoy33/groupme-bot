const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const {
  updateLeaderboardAndGetStandings,
  getDailySummary,
  resetTodayAndMaybeWeek,
} = require('./sheets');

const app = express();
app.use(bodyParser.json());

const GROUPME_BOT_ID = process.env.GROUPME_BOT_ID;

// Simple health check
app.get('/', (req, res) => {
  res.send('Node.js GroupMe bot is running!');
});

// Helper: send a message back into the GroupMe group
async function sendGroupMeMessage(text) {
  if (!GROUPME_BOT_ID) {
    console.error('GROUPME_BOT_ID is not set; cannot send GroupMe message.');
    return;
  }

  try {
    await axios.post('https://api.groupme.com/v3/bots/post', {
      bot_id: GROUPME_BOT_ID,
      text,
    });
  } catch (err) {
    console.error(
      'Error sending GroupMe message:',
      err.response?.data || err.message
    );
  }
}

/**
 * Forgiving parser for sale callouts.
 * Handles formats like:
 *  "🛜 +1 Jane Doe 11/25 Kinetic 1G"
 *  "📶+2 Elliott Ezell 11/25 Kinetic 2G max 1-3"
 * Any emoji (or none), extra words after speed, etc.
 */
function parseSalesMessage(text, senderName) {
  if (!text) return null;

  const trimmed = text.trim();
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 3) return null;

  // Find the token with the first integer (e.g. "+1", "1", "+3")
  const numberRegex = /[+-]?\d+/;
  const countIndex = tokens.findIndex((t) => numberRegex.test(t));
  if (countIndex === -1) return null;

  const countMatch = tokens[countIndex].match(numberRegex);
  const todayReported = parseInt(countMatch[0], 10);
  if (Number.isNaN(todayReported)) return null;

  // Find install date token "MM/DD"
  const dateRegex = /^\d{1,2}\/\d{1,2}$/;
  const dateIndex = tokens.findIndex((t) => dateRegex.test(t));
  if (dateIndex === -1 || dateIndex <= countIndex) {
    // Need a date after the count
    return null;
  }
  const installDate = tokens[dateIndex];

  // Speed = last token that looks like "1G", "2G", "500M", etc.
  let speed = tokens[tokens.length - 1];

  const speedPattern = /^\d+([GMgm]|Mbps|mbps)?$/;
  if (!speedPattern.test(speed) && tokens.length >= 2) {
    const maybeSpeed = tokens[tokens.length - 2];
    if (speedPattern.test(maybeSpeed)) {
      speed = maybeSpeed;
    }
  }

  const speedIndex = tokens.lastIndexOf(speed);

  // Provider = tokens between date and speed
  let provider = '';
  if (speedIndex > dateIndex + 0) {
    const providerTokens = tokens.slice(dateIndex + 1, speedIndex);
    provider = providerTokens.join(' ');
  }

  // Customer name = everything between count token and date token
  const nameStart = countIndex + 1;
  const nameEnd = dateIndex;
  const nameTokens = tokens.slice(nameStart, nameEnd);
  const customerName = nameTokens.join(' ');

  // Sale date & timestamp
  const now = new Date();
  const saleDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const timestamp = now.toISOString();

  const repName = senderName;

  return {
    repName,
    todayReported,
    customerName,
    installDate,
    provider,
    speed,
    saleDate,
    timestamp,
  };
}

// Webhook endpoint for GroupMe
app.post('/groupme/webhook', async (req, res) => {
  const body = req.body;

  const { text, name, sender_type } = body;

  console.log('Incoming message:', { text, name, sender_type });

  // Ignore messages from bots (including ourselves)
  if (sender_type === 'bot') {
    return res.status(200).send('Ignored bot message');
  }

  const parsed = parseSalesMessage(text, name);
  if (!parsed) {
    // Not a sales update, just ignore
    return res.status(200).send('No sales data parsed');
  }

  const {
    repName,
    todayReported,
    customerName,
    installDate,
    provider,
    speed,
    saleDate,
    timestamp,
  } = parsed;

  console.log('Parsed sale:', parsed);

  try {
    const saleDetails = {
      customerName,
      installDate,
      provider,
      speed,
      saleDate,
      timestamp,
    };

    const standings = await updateLeaderboardAndGetStandings(
      repName,
      todayReported,
      saleDetails
    );

    // Kash Supply styled scoreboard message
    let msg =
`✨ *Kash Supply Live Leaderboard* ✨

${standings
  .map((row, idx) => {
    const [rep, today] = row;

    const medal =
      idx === 0 ? '🥇' :
      idx === 1 ? '🥈' :
      idx === 2 ? '🥉' :
      '▪️';

    return `${medal}  *${rep}* — ${today}`;
  })
  .join('\n')}

———————————————
🔥 Who's Next!? Everybody Eats! 🔥`;

    await sendGroupMeMessage(msg);
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }

  return res.status(200).send('OK');
});

// Nightly cron endpoint: daily recap + reset Today (and Week on Mondays).
// Set an external cron (e.g. cron-job.org) to hit this once per night.
app.get('/cron/daily', async (req, res) => {
  try {
    const now = new Date();

    // Recap yesterday
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yIso = yesterday.toISOString().split('T')[0];

    const { perRep, total } = await getDailySummary(yIso);

    let msg = `📆 *Daily Recap for ${yIso}*\n\n`;

    if (total === 0) {
      msg += `No installs recorded yesterday. Unacceptable. Fix it today.`;
    } else {
      msg += `Total installs: ${total}\n\n`;

      if (perRep.length > 0) {
        msg += `Top Closers:\n`;
        perRep.slice(0, 3).forEach((entry, idx) => {
          const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉';
          msg += `${medal} ${entry.rep} — ${entry.count}\n`;
        });

        if (perRep.length > 3) {
          msg += `\nEveryone else: scoreboard doesn’t lie.`;
        }
      }
    }

    await sendGroupMeMessage(msg);

    // Reset today's counters (for the new day)
    const todayIso = now.toISOString().split('T')[0];
    await resetTodayAndMaybeWeek(todayIso);

    res.send('Daily recap sent and counters reset.');
  } catch (err) {
    console.error('Error in /cron/daily:', err);
    res.status(500).send('Error running daily cron.');
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
