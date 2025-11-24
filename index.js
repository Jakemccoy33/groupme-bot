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
function parseSalesMessage(text, senderName) {
  if (!text) return null;

  // Only treat messages with the 🛜 emoji as sales
  if (!text.includes('🛜')) {
    return null;
  }

  const trimmed = text.trim();
  const tokens = trimmed.split(/\s+/);

  // Expect at least: emoji, +1, name..., date, provider..., speed
  if (tokens.length < 5) return null;

  // Token 1 should be +1, +2, etc
  const countMatch = tokens[1].match(/([+-]?\d+)/);
  if (!countMatch) return null;

  const todayReported = parseInt(countMatch[1], 10);

  // Find install date (MM/DD)
  const dateRegex = /^\d{1,2}\/\d{1,2}$/;
  const dateIndex = tokens.findIndex((t) => dateRegex.test(t));
  if (dateIndex === -1) return null;

  // Speed = last token (1G, 500M, etc.)
  const speed = tokens[tokens.length - 1];

  // Provider = everything between date and last token
  const providerTokens = tokens.slice(dateIndex + 1, tokens.length - 1);
  const provider = providerTokens.join(' ') || '';

  // Customer name = tokens between +1 and install date
  const nameTokens = tokens.slice(2, dateIndex);
  const customerName = nameTokens.join(' ');

  // Sale date & timestamp
  const now = new Date();
  const saleDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const timestamp = now.toISOString();

  const repName = senderName; // GroupMe sender's display name

  return {
    repName,
    todayReported,
    customerName,
    installDate: tokens[dateIndex], // e.g. "11/25"
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
    let msg = '📊 Daily Leaderboard Update:\n';
    standings.forEach((row, idx) => {
      const [rep, today] = row;
      msg += `${idx + 1}. ${rep} – ${today}\n`;
    });
    msg += '\nHustlers eat first. Stay in motion.';

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
