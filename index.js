const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const { updateLeaderboardAndGetStandings } = require('./sheets');

const app = express();
app.use(bodyParser.json());

const GROUPME_BOT_ID = process.env.GROUPME_BOT_ID;

// Simple health check
app.get('/', (req, res) => {
  res.send('Node.js GroupMe bot is running!');
});

// Helper: send a message back into the GroupMe group
async function sendGroupMeMessage(text) {
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

// Parse messages like "🛜 +1 Jane Doe 11/25 Kinetic 1G"
// but be forgiving about emoji, spacing, and extra words.
function parseSalesMessage(text, senderName) {
  if (!text) return null;

  const trimmed = text.trim();

  // Split into tokens on whitespace
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 3) return null;

  // Find the token that contains the first integer (e.g. "+1", "1", "+3")
  const numberRegex = /[+-]?\d+/;
  const countIndex = tokens.findIndex((t) => numberRegex.test(t));
  if (countIndex === -1) return null;

  const countMatch = tokens[countIndex].match(numberRegex);
  const todayReported = parseInt(countMatch[0], 10);
  if (Number.isNaN(todayReported)) return null;

  // Find install date token "MM/DD"
  const dateRegex = /^\d{1,2}\/\d{1,2}$/;
  const dateIndex = tokens.findIndex((t) => dateRegex.test(t));
  if (dateIndex === -1 || dateIndex <= countIndex + 0) {
    // Need a date after the count
    return null;
  }
  const installDate = tokens[dateIndex];

  // Speed = last token (1G, 2G, 500M, etc.)
  let speed = tokens[tokens.length - 1];

  // If last token is something like "max" or junk, try second to last
  if (!/^\d+([GMgm]|Mbps|mbps)?$/.test(speed)) {
    if (tokens.length >= 2) {
      const maybeSpeed = tokens[tokens.length - 2];
      if (/^\d+([GMgm]|Mbps|mbps)?$/.test(maybeSpeed)) {
        speed = maybeSpeed;
      }
    }
  }

  // Provider = tokens between date and speed
  const speedIndex = tokens.lastIndexOf(speed);
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

  // GroupMe sends a lot; we mainly care about:
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
    // Update Google Sheet (leaderboard + sales log) and get fresh standings
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

    // Build a simple scoreboard message
    let msg = 
`✨ *KA$H $UPPLY LIVE* ✨

${standings.map((row, idx) => {
  const [rep, today] = row;

  const medal = idx === 0 ? "🥇" :
                idx === 1 ? "🥈" :
                idx === 2 ? "🥉" :
                "▪️";

  return `${medal}  *${rep}* — ${today}`;
}).join("\n")}

———————————————
🔥 Who's Next!? Everybody Eats! 🔥`;

    await sendGroupMeMessage(msg);
  } catch (err) {
    console.error('Error updating leaderboard:', err);
  }

  return res.status(200).send('OK');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
