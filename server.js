require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const { MongoClient } = require('mongodb');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const MAX_ATTEMPTS = 4;

if (!BOT_TOKEN || !ADMIN_PASSWORD) {
  console.error('BOT_TOKEN and ADMIN_PASSWORD must be set in .env');
  process.exit(1);
}

// MongoDB connection
let db;
let usersCollection;
let settingsCollection;

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('tg_bot_db');
  usersCollection = db.collection('users');
  settingsCollection = db.collection('settings');
  console.log('Connected to MongoDB');
  
  // Ensure indexes
  await usersCollection.createIndex({ chatId: 1 }, { unique: true });
  
  // Default settings
  const defaultSettings = {
    welcomeMessage: 'Welcome to the bot! 👋',
    broadcastMessage: 'Hello everyone! This is a broadcast message.'
  };
  await settingsCollection.updateOne(
    { _id: 'bot_settings' },
    { $setOnInsert: defaultSettings },
    { upsert: true }
  );
}

connectDB().catch(console.error);

// Telegram Bot
const bot = new Telegraf(BOT_TOKEN);

// Store active users
bot.command('start', async (ctx) => {
  const chatId = ctx.chat.id;
  const username = ctx.from.username || 'unknown';
  
  try {
    await usersCollection.updateOne(
      { chatId },
      { $set: { chatId, username, joinedAt: new Date() } },
      { upsert: true }
    );
    const settings = await settingsCollection.findOne({ _id: 'bot_settings' });
    await ctx.reply(settings.welcomeMessage || 'Welcome!');
    console.log(`New user started: ${chatId}`);
  } catch (error) {
    console.error('Error handling start:', error);
    await ctx.reply('Welcome!');
  }
});

// Broadcast command for admin? But mainly through web
bot.command('broadcast', async (ctx) => {
  // Optional, but since admin is web-based
  if (ctx.from.id.toString() !== process.env.ADMIN_USER_ID) return ctx.reply('Unauthorized');
  // Implementation can be added
});

// Web Admin Panel - simple HTML with JS
const adminHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bot Admin Panel</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    .login, .panel { border: 1px solid #ccc; padding: 20px; margin: 20px 0; border-radius: 8px; }
    input, textarea { width: 100%; padding: 10px; margin: 10px 0; }
    button { padding: 10px 20px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
    button:hover { background: #0056b3; }
    .message { color: green; }
    .error { color: red; }
    textarea { height: 150px; }
  </style>
</head>
<body>
  <h1>Telegram Bot Admin Panel</h1>
  
  <div id="loginForm" class="login">
    <h2>Login</h2>
    <input type="password" id="password" placeholder="Enter admin password" />
    <button onclick="login()">Login</button>
    <div id="loginStatus"></div>
  </div>
  
  <div id="adminPanel" class="panel" style="display: none;">
    <h2>Edit Messages</h2>
    <div>
      <label>Welcome Message:</label>
      <textarea id="welcomeMsg"></textarea>
    </div>
    <div>
      <label>Broadcast Message:</label>
      <textarea id="broadcastMsg"></textarea>
    </div>
    <button onclick="saveMessages()">Save Messages</button>
    <button onclick="sendBroadcast()">Send Broadcast to All Users</button>
    <div id="status"></div>
    <button onclick="logout()">Logout</button>
  </div>

  <script>
    let attempts = 0;
    let isLoggedIn = false;

    async function login() {
      const pass = document.getElementById('password').value;
      const status = document.getElementById('loginStatus');
      
      if (!pass) {
        status.innerHTML = '<span class="error">Password required</span>';
        return;
      }
      
      attempts++;
      if (attempts > 4) {
        status.innerHTML = '<span class="error">Too many attempts. Try again later.</span>';
        return;
      }
      
      try {
        const res = await fetch('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pass })
        });
        const data = await res.json();
        
        if (data.success) {
          isLoggedIn = true;
          document.getElementById('loginForm').style.display = 'none';
          document.getElementById('adminPanel').style.display = 'block';
          loadMessages();
        } else {
          status.innerHTML = '<span class="error">Invalid password. Attempts left: ' + (4 - attempts) + '</span>';
        }
      } catch (e) {
        status.innerHTML = '<span class="error">Error</span>';
      }
    }

    async function loadMessages() {
      try {
        const res = await fetch('/settings');
        const data = await res.json();
        document.getElementById('welcomeMsg').value = data.welcomeMessage || '';
        document.getElementById('broadcastMsg').value = data.broadcastMessage || '';
      } catch (e) {}
    }

    async function saveMessages() {
      const welcome = document.getElementById('welcomeMsg').value;
      const broadcast = document.getElementById('broadcastMsg').value;
      const status = document.getElementById('status');
      
      try {
        const res = await fetch('/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ welcomeMessage: welcome, broadcastMessage: broadcast })
        });
        const data = await res.json();
        status.innerHTML = data.success ? '<span class="message">Saved successfully!</span>' : '<span class="error">Error saving</span>';
      } catch (e) {
        status.innerHTML = '<span class="error">Error</span>';
      }
    }

    async function sendBroadcast() {
      if (!confirm('Send broadcast to ALL users?')) return;
      
      const broadcast = document.getElementById('broadcastMsg').value;
      const status = document.getElementById('status');
      
      try {
        const res = await fetch('/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: broadcast })
        });
        const data = await res.json();
        status.innerHTML = data.success ? '<span class="message">Broadcast sent to ' + data.count + ' users!</span>' : '<span class="error">Error broadcasting</span>';
      } catch (e) {
        status.innerHTML = '<span class="error">Error</span>';
      }
    }

    function logout() {
      isLoggedIn = false;
      document.getElementById('loginForm').style.display = 'block';
      document.getElementById('adminPanel').style.display = 'none';
      document.getElementById('password').value = '';
      attempts = 0;
    }

    // Allow enter key for login
    document.getElementById('password').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') login();
    });
  </script>
</body>
</html>
`;

// Routes
app.get('/', (req, res) => {
  res.send(adminHTML);
});

let loginAttempts = new Map(); // In-memory for simplicity, IP based

app.post('/login', (req, res) => {
  const { password } = req.body;
  const ip = req.ip || 'unknown';
  
  if (!loginAttempts.has(ip)) {
    loginAttempts.set(ip, 0);
  }
  
  let attempts = loginAttempts.get(ip);
  
  if (attempts >= MAX_ATTEMPTS) {
    return res.json({ success: false, message: 'Too many attempts' });
  }
  
  if (password === ADMIN_PASSWORD) {
    loginAttempts.set(ip, 0); // Reset
    res.json({ success: true });
  } else {
    attempts++;
    loginAttempts.set(ip, attempts);
    res.json({ success: false });
  }
});

app.get('/settings', async (req, res) => {
  // Simple auth skip for demo, in prod use session/cookie
  try {
    const settings = await settingsCollection.findOne({ _id: 'bot_settings' });
    res.json({
      welcomeMessage: settings.welcomeMessage,
      broadcastMessage: settings.broadcastMessage
    });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/settings', async (req, res) => {
  const { welcomeMessage, broadcastMessage } = req.body;
  try {
    await settingsCollection.updateOne(
      { _id: 'bot_settings' },
      { $set: { welcomeMessage, broadcastMessage, updatedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

app.post('/broadcast', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ success: false });
  
  try {
    const users = await usersCollection.find({}).toArray();
    let successCount = 0;
    
    for (const user of users) {
      try {
        await bot.telegram.sendMessage(user.chatId, message);
        successCount++;
      } catch (err) {
        console.error(`Failed to send to ${user.chatId}:`, err.message);
      }
    }
    
    res.json({ success: true, count: successCount });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

// Launch bot and server
const start = async () => {
  await connectDB();
  
  // Start bot
  bot.launch().then(() => {
    console.log('Telegram bot started');
  }).catch(console.error);
  
  // Graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
  
  // Start Express
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Admin panel: http://localhost:' + PORT);
  });
};

start().catch(console.error);
