const { google } = require('googleapis');
require('dotenv').config();

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// Leaderboard: A:Rep, B:Today, C:Week, D:Month, E:Lifetime, F:LastUpdate
const LEADERBOARD_RANGE = 'Leaderboard!A:F';

// Sales log: A:Timestamp, B:Rep, C:Customer, D:SaleDate, E:InstallDate, F:Provider, G:Speed, H:TodayReported
const SALESLOG_RANGE = 'SalesLog!A:H';

// Auth with service account
const auth = new google.auth.GoogleAuth({
  keyFile: 'service-account.json', // must exist in project root
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function getSheetsClient() {
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

/**
 * Update leaderboard + append one row to SalesLog.
 *
 * repName        = GroupMe sender (rep)
 * todayReported  = number after + in the message (their total today)
 * saleDetails    = { customerName, installDate, provider, speed, saleDate, timestamp }
 */
async function updateLeaderboardAndGetStandings(repName, todayReported, saleDetails) {
  const sheets = await getSheetsClient();

  // ---- 1) Read current leaderboard ----
  const getRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: LEADERBOARD_RANGE,
  });

  let values = getRes.data.values || [];

  // Ensure header row exists
  if (values.length === 0) {
    values = [['Rep', 'Today', 'Week', 'Month', 'Lifetime', 'LastUpdate']];
  }

  const header = values[0];
  let rows = values.slice(1);

  // Find existing rep row (case-insensitive)
  let repIndex = rows.findIndex(
    (r) => r[0] && r[0].toLowerCase() === repName.toLowerCase()
  );

  const nowIso = new Date().toISOString();

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

    // LastUpdate from sheet (ISO string or blank)
    const prevLastUpdate = row[5] || '';
    const prevDate = prevLastUpdate ? prevLastUpdate.slice(0, 10) : null; // 'YYYY-MM-DD'
    const currentDate = saleDetails.saleDate; // also 'YYYY-MM-DD'

    // If this is a new calendar day, reset today's count
    if (prevDate && prevDate !== currentDate) {
      today = 0;
    }

    const prevToday = today;

    // delta = how many NEW sales since last update
    let delta = todayReported - prevToday;

    // If delta goes negative (rep typed a smaller number) fall back to treating
    // todayReported as fresh sales for the day.
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
      nowIso, // update LastUpdate to this event
    ];


  // Sort by Today descending
  rows.sort(
    (a, b) => parseInt(b[1] || '0', 10) - parseInt(a[1] || '0', 10)
  );

  const newValues = [header, ...rows];

  // ---- 2) Write updated leaderboard back to sheet ----
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: LEADERBOARD_RANGE,
    valueInputOption: 'RAW',
    requestBody: {
      values: newValues,
    },
  });

  // ---- 3) Append a new row to SalesLog ----
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

module.exports = { updateLeaderboardAndGetStandings };
