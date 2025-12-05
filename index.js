const { google } = require('googleapis');
require('dotenv').config();

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// Leaderboard: A:Rep, B:Today, C:Week, D:Month, E:Lifetime, F:LastUpdate
const LEADERBOARD_RANGE = 'Leaderboard!A:F';

// Sales log: A:Timestamp, B:Rep, C:Customer, D:SaleDate, E:InstallDate, F:Provider, G:Speed, H:TodayReported
const SALESLOG_RANGE = 'SalesLog!A:H';

const auth = new google.auth.GoogleAuth({
  keyFile: 'service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function getSheetsClient() {
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

/**
 * Main update: adjust Today/Week/Month/Lifetime for a rep, and append to SalesLog.
 */
async function updateLeaderboardAndGetStandings(repName, todayReported, saleDetails) {
  const sheets = await getSheetsClient();

  // ---- 1) Read current leaderboard ----
  const getRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: LEADERBOARD_RANGE,
  });

  let values = getRes.data.values || [];

  if (values.length === 0) {
    values = [['Rep', 'Today', 'Week', 'Month', 'Lifetime', 'LastUpdate']];
  }

  const header = values[0];
  let rows = values.slice(1);

  const nowIso = new Date().toISOString();
  const currentDate = saleDetails.saleDate; // 'YYYY-MM-DD'

  // Find rep row
  let repIndex = rows.findIndex(
    (r) => r[0] && r[0].toLowerCase() === repName.toLowerCase()
  );

  if (repIndex === -1) {
    // New rep: treat todayReported as Today/Week/Month/Lifetime
    rows.push([
      repName,
      todayReported.toString(),
      todayReported.toString(),
      todayReported.toString(),
      todayReported.toString(),
      nowIso,
    ]);
  } else {
    const row = rows[repIndex];

    let today = parseInt(row[1] || '0', 10);
    let week = parseInt(row[2] || '0', 10);
    let month = parseInt(row[3] || '0', 10);
    let lifetime = parseInt(row[4] || '0', 10);

    const prevLastUpdate = row[5] || '';
    const prevDate = prevLastUpdate ? prevLastUpdate.slice(0, 10) : null; // 'YYYY-MM-DD'

    // If this is a new day for this rep, reset today's baseline
    if (prevDate && prevDate !== currentDate) {
      today = 0;
    }

    const prevToday = today;

    // delta = how many NEW sales since last update
    let delta = todayReported - prevToday;

    // If delta goes negative (rep typed a smaller number), treat todayReported as fresh sales
    if (delta < 0) {
      delta = todayReported;
    }

    today = todayReported;
    week += delta;
    month += delta;
    lifetime += delta;

    rows[repIndex] = [
      row[0],
      today.toString(),
      week.toString(),
      month.toString(),
      lifetime.toString(),
      nowIso,
    ];
  }

  // Sort rows by Today desc
  rows.sort(
    (a, b) => parseInt(b[1] || '0', 10) - parseInt(a[1] || '0', 10)
  );

  const newValues = [header, ...rows];

  // ---- 2) Write leaderboard back ----
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: LEADERBOARD_RANGE,
    valueInputOption: 'RAW',
    requestBody: {
      values: newValues,
    },
  });

  // ---- 3) Append to SalesLog ----
  const { customerName, installDate, provider, speed, saleDate, timestamp } =
    saleDetails;

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: SALESLOG_RANGE,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [
        [
          timestamp,
          repName,
          customerName,
          saleDate,
          installDate,
          provider,
          speed,
          todayReported.toString(),
        ],
      ],
    },
  });

  // Return [Rep, Today] pairs for scoreboard
  return rows.map((r) => [r[0], r[1]]);
}

/**
 * Get per-rep totals for a given date (YYYY-MM-DD) from SalesLog (for nightly recap).
 */
async function getDailySummary(dateIso) {
  const sheets = await getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SALESLOG_RANGE,
  });

  const values = res.data.values || [];
  if (values.length <= 1) return { perRep: [], total: 0 };

  const rows = values.slice(1); // skip header

  const counts = new Map();
  let total = 0;

  for (const row of rows) {
    const rep = row[1] || '';
    const saleDate = row[3] || ''; // D: SaleDate
    if (!rep || !saleDate) continue;

    if (saleDate === dateIso) {
      const current = counts.get(rep) || 0;
      counts.set(rep, current + 1);
      total += 1;
    }
  }

  const perRep = Array.from(counts.entries())
    .map(([rep, count]) => ({ rep, count }))
    .sort((a, b) => b.count - a.count);

  return { perRep, total };
}

/**
 * Reset Today for all reps; if it's Monday, also reset Week.
 */
async function resetTodayAndMaybeWeek(currentDateIso) {
  const sheets = await getSheetsClient();

  const getRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: LEADERBOARD_RANGE,
  });

  let values = getRes.data.values || [];
  if (values.length === 0) {
    values = [['Rep', 'Today', 'Week', 'Month', 'Lifetime', 'LastUpdate']];
  }

  const header = values[0];
  let rows = values.slice(1);

  const nowIso = new Date().toISOString();
  const isMonday = new Date(currentDateIso).getDay() === 1; // 1 = Monday

  rows = rows.map((row) => {
    const rep = row[0] || '';
    if (!rep) return row;

    let today = 0; // always reset Today
    let week = parseInt(row[2] || '0', 10);
    let month = parseInt(row[3] || '0', 10);
    let lifetime = parseInt(row[4] || '0', 10);

    if (isMonday) {
      week = 0;
    }

    return [
      rep,
      today.toString(),
      week.toString(),
      month.toString(),
      lifetime.toString(),
      nowIso,
    ];
  });

  const newValues = [header, ...rows];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: LEADERBOARD_RANGE,
    valueInputOption: 'RAW',
    requestBody: { values: newValues },
  });
}

module.exports = {
  updateLeaderboardAndGetStandings,
  getDailySummary,
  resetTodayAndMaybeWeek,
};
