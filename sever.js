require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const { MongoClient } = require('mongodb');
const TelegramBot = require('node-telegram-bot-api');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const {
  BOT_TOKEN,
  MONGO_URI,
  MONGO_DB_NAME = 'tg_bot',
  ADMIN_PASSWORD,
  MAX_LOGIN_ATTEMPTS = 4,
  LOCKOUT_MINUTES = 15,
  SESSION_SECRET = 'dev-secret-change-me',
  PORT = 3000,
} = process.env;

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in .env');
  process.exit(1);
}
if (!MONGO_URI) {
  console.error('Missing MONGO_URI in .env');
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.error('Missing ADMIN_PASSWORD in .env');
  process.exit(1);
}

const MAX_ATTEMPTS = parseInt(MAX_LOGIN_ATTEMPTS, 10) || 4;
const LOCKOUT_MS = (parseInt(LOCKOUT_MINUTES, 10) || 15) * 60 * 1000;

// ---------------------------------------------------------------------------
// Mongo setup
// ---------------------------------------------------------------------------
const mongoClient = new MongoClient(MONGO_URI);
let db;
let usersCol;
let settingsCol;

async function initMongo() {
  await mongoClient.connect();
  db = mongoClient.db(MONGO_DB_NAME);
  usersCol = db.collection('users');
  settingsCol = db.collection('settings');

  await usersCol.createIndex({ chatId: 1 }, { unique: true });

  // Seed default messages if they don't exist yet
  const existing = await settingsCol.findOne({ _id: 'messages' });
  if (!existing) {
    await settingsCol.insertOne({
      _id: 'messages',
      welcomeMessage: 'Welcome! Thanks for starting this bot. 🎉',
      broadcastMessage: 'This is a broadcast message.',
      updatedAt: new Date(),
    });
  }

  console.log('MongoDB connected:', MONGO_DB_NAME);
}

async function getMessages() {
  const doc = await settingsCol.findOne({ _id: 'messages' });
  return {
    welcomeMessage: doc?.welcomeMessage || '',
    broadcastMessage: doc?.broadcastMessage || '',
  };
}

async function updateMessage(field, value) {
  await settingsCol.updateOne(
    { _id: 'messages' },
    { $set: { [field]: value, updatedAt: new Date() } },
    { upsert: true }
  );
}

async function upsertUser(chatId, meta = {}) {
  await usersCol.updateOne(
    { chatId },
    {
      $set: { ...meta, lastSeen: new Date() },
      $setOnInsert: { chatId, firstSeen: new Date() },
    },
    { upsert: true }
  );
}

async function getAllUserChatIds() {
  const docs = await usersCol.find({}, { projection: { chatId: 1 } }).toArray();
  return docs.map((d) => d.chatId);
}

// ---------------------------------------------------------------------------
// Telegram bot setup
// ---------------------------------------------------------------------------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await upsertUser(chatId, {
      username: msg.chat.username || null,
      firstName: msg.chat.first_name || null,
      lastName: msg.chat.last_name || null,
    });

    const { welcomeMessage } = await getMessages();
    await bot.sendMessage(chatId, welcomeMessage);
  } catch (err) {
    console.error('Error handling /start:', err);
  }
});

async function broadcastToAllUsers(text) {
  const chatIds = await getAllUserChatIds();
  let sent = 0;
  let failed = 0;

  for (const chatId of chatIds) {
    try {
      await bot.sendMessage(chatId, text);
      sent += 1;
    } catch (err) {
      failed += 1;
      console.error(`Failed to send to ${chatId}:`, err.message);
    }
    // Small delay to be gentle on Telegram's rate limits
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  return { total: chatIds.length, sent, failed };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 4, // 4 hour session
    },
  })
);

// In-memory login attempt tracker, keyed by IP.
// { count, lockedUntil }
const loginAttempts = new Map();

function getAttemptState(ip) {
  if (!loginAttempts.has(ip)) {
    loginAttempts.set(ip, { count: 0, lockedUntil: null });
  }
  return loginAttempts.get(ip);
}

function isLocked(state) {
  return state.lockedUntil && state.lockedUntil > Date.now();
}

// Auth guard for protected API routes
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  return res.status(401).json({ error: 'Not authenticated' });
}

// --- Auth routes ---

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const state = getAttemptState(ip);

  if (isLocked(state)) {
    const msLeft = state.lockedUntil - Date.now();
    const minsLeft = Math.ceil(msLeft / 60000);
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${minsLeft} minute(s).`,
    });
  }

  const { password } = req.body || {};

  if (password === ADMIN_PASSWORD) {
    // Success: reset attempts, create session
    loginAttempts.delete(ip);
    req.session.authenticated = true;
    return res.json({ success: true });
  }

  // Failure: increment attempts
  state.count += 1;
  const remaining = MAX_ATTEMPTS - state.count;

  if (state.count >= MAX_ATTEMPTS) {
    state.lockedUntil = Date.now() + LOCKOUT_MS;
    return res.status(429).json({
      error: `Too many failed attempts. Locked out for ${LOCKOUT_MINUTES} minute(s).`,
    });
  }

  return res.status(401).json({
    error: `Incorrect password. ${remaining} attempt(s) remaining.`,
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/session', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// --- Protected data routes ---

app.get('/api/messages', requireAuth, async (req, res) => {
  try {
    const messages = await getMessages();
    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

app.post('/api/messages/welcome', requireAuth, async (req, res) => {
  const { message } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message text is required' });
  }
  try {
    await updateMessage('welcomeMessage', message);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save welcome message' });
  }
});

app.post('/api/messages/broadcast', requireAuth, async (req, res) => {
  const { message } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message text is required' });
  }
  try {
    await updateMessage('broadcastMessage', message);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save broadcast message' });
  }
});

app.post('/api/broadcast/send', requireAuth, async (req, res) => {
  try {
    const { broadcastMessage } = await getMessages();
    if (!broadcastMessage || !broadcastMessage.trim()) {
      return res.status(400).json({ error: 'Broadcast message is empty' });
    }
    const result = await broadcastToAllUsers(broadcastMessage);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Broadcast failed' });
  }
});

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const count = await usersCol.countDocuments();
    res.json({ userCount: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// --- Static admin page ---
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  await initMongo();
  app.listen(PORT, () => {
    console.log(`Admin panel running at http://localhost:${PORT}`);
    console.log('Telegram bot is polling for messages...');
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
