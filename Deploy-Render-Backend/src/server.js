const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '35mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Set up WebSocket connections for live real-time check feedback
const activeClients = new Map(); // ws -> { sessionId, licenseKey }

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.action === 'subscribe_session') {
        activeClients.set(ws, { sessionId: data.sessionId });
      } else if (data.action === 'subscribe_license') {
        activeClients.set(ws, { licenseKey: data.licenseKey });
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    activeClients.delete(ws);
  });
});

function broadcastToSession(sessionId, event, payload) {
  const msg = JSON.stringify({ event, sessionId, payload });
  for (const [ws, info] of activeClients.entries()) {
    if (info && info.sessionId === sessionId && ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

function broadcastToLicense(licenseKey, event, payload) {
  const msg = JSON.stringify({ event, licenseKey, payload });
  for (const [ws, info] of activeClients.entries()) {
    if (info && info.licenseKey === licenseKey && ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

// -------------------------------------------------------------
// DOWNLOAD ENDPOINT FOR 47DETECT.EXE
// -------------------------------------------------------------
app.get('/download', (req, res) => {
  const scannerPath = path.join(__dirname, '..', 'public', 'downloads', '47Detect.exe');
  if (fs.existsSync(scannerPath)) {
    return res.download(scannerPath, '47Detect.exe');
  }

  res.status(404).send(`
    <body style="font-family:sans-serif;background:#09090b;color:#f4f4f5;padding:50px;text-align:center;">
      <h2 style="color:#ef4444;">47Detect Client Executable Ready Shortly</h2>
      <p>Building client package. Please try again in 30 seconds.</p>
      <a href="/" style="color:#f87171;">Return to Homepage</a>
    </body>
  `);
});

// -------------------------------------------------------------
// HIDDEN OWNER (SUPER ADMIN) VAULT
// -------------------------------------------------------------
function ownerAuth(req, res, next) {
  const secret = req.headers['x-owner-secret'] || req.query.secret;
  const currentDb = db.getDb();
  if (!secret || secret !== currentDb.config.ownerSecret) {
    return res.status(401).json({ error: "Unauthorized access to 47Detect Master Vault." });
  }
  next();
}

app.get('/api/owner/stats', ownerAuth, (req, res) => {
  const licenses = db.getLicenses();
  const sessions = db.getSessions();
  const activeLicenses = licenses.filter(l => l.status === 'active').length;
  const totalChecks = sessions.length;
  const flaggedChecks = sessions.filter(s => s.results && s.results.OverallStatus === 'DETECTED').length;

  res.json({
    totalLicenses: licenses.length,
    activeLicenses,
    totalChecks,
    flaggedChecks,
    recentLicenses: licenses.slice(0, 5),
    recentSessions: sessions.slice(0, 10)
  });
});

app.get('/api/owner/licenses', ownerAuth, (req, res) => {
  res.json(db.getLicenses());
});

app.post('/api/owner/licenses', ownerAuth, (req, res) => {
  const { serverName, plan, durationDays, maxUsers, discordWebhook } = req.body;
  if (!serverName) return res.status(400).json({ error: "Server name is required" });

  const randomCode = Math.random().toString(36).substring(2, 6).toUpperCase() + "-" +
                     Math.random().toString(36).substring(2, 6).toUpperCase();
  const key = `47D-${(plan || 'PRO').toUpperCase()}-${randomCode}`;

  const days = parseInt(durationDays) || 30;
  const expiresAt = days === 9999 ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const newLicense = {
    id: "lic-" + Date.now(),
    key,
    serverName,
    plan: plan || "Pro",
    maxUsers: parseInt(maxUsers) || 10,
    maxStaff: parseInt(maxUsers) || 10,
    status: "active",
    createdAt: new Date().toISOString(),
    expiresAt,
    discordWebhook: discordWebhook || "",
    totalChecks: 0
  };

  db.createLicense(newLicense);
  res.json(newLicense);
});

app.put('/api/owner/licenses/:id', ownerAuth, (req, res) => {
  const { status, plan, discordWebhook, addDays, maxUsers } = req.body;
  const license = db.getLicenses().find(l => l.id === req.params.id);
  if (!license) return res.status(404).json({ error: "License not found" });

  const updates = {};
  if (status) updates.status = status;
  if (plan) updates.plan = plan;
  if (maxUsers) { updates.maxUsers = parseInt(maxUsers); updates.maxStaff = parseInt(maxUsers); }
  if (discordWebhook !== undefined) updates.discordWebhook = discordWebhook;
  if (addDays) {
    const currentExpiry = license.expiresAt ? new Date(license.expiresAt).getTime() : Date.now();
    updates.expiresAt = new Date(Math.max(currentExpiry, Date.now()) + addDays * 24 * 60 * 60 * 1000).toISOString();
  }

  const updated = db.updateLicense(req.params.id, updates);
  res.json(updated);
});

app.delete('/api/owner/licenses/:id', ownerAuth, (req, res) => {
  db.deleteLicense(req.params.id);
  res.json({ success: true });
});

// -------------------------------------------------------------
// DEDICATED CUSTOMER PORTAL API
// -------------------------------------------------------------
function customerAuth(req, res, next) {
  const key = req.headers['x-license-key'] || req.query.key;
  if (!key) return res.status(401).json({ error: "Missing customer license key" });

  const license = db.getLicenseByKey(key);
  if (!license) return res.status(401).json({ error: "Invalid license key" });
  if (license.status !== 'active') return res.status(403).json({ error: "This subscription is currently suspended." });
  if (license.expiresAt && new Date(license.expiresAt) < new Date()) {
    return res.status(403).json({ error: "This license has expired. Please renew with the provider." });
  }

  req.license = license;
  next();
}

app.post('/api/customer/login', (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: "License key is required" });

  const license = db.getLicenseByKey(key);
  if (!license) return res.status(404).json({ error: "License key not found" });
  if (license.status !== 'active') return res.status(403).json({ error: "This subscription is suspended." });
  if (license.expiresAt && new Date(license.expiresAt) < new Date()) {
    return res.status(403).json({ error: "Subscription has expired. Contact support to renew." });
  }

  res.json({
    valid: true,
    serverName: license.serverName,
    plan: license.plan,
    expiresAt: license.expiresAt,
    maxUsers: license.maxUsers || license.maxStaff || 10,
    totalChecks: license.totalChecks || 0,
    discordWebhook: license.discordWebhook
  });
});

app.post('/api/customer/create-session', customerAuth, (req, res) => {
  const { targetPlayer, staffName, notes } = req.body;
  if (!targetPlayer) return res.status(400).json({ error: "Target player name or Discord ID required" });

  let pin;
  do {
    pin = Math.floor(100000 + Math.random() * 900000).toString();
  } while (db.getSessionByPin(pin));

  const session = {
    id: "sess-" + Date.now() + "-" + Math.random().toString(36).substring(2, 6),
    pin,
    licenseKey: req.license.key,
    serverName: req.license.serverName,
    staffName: staffName || "Staff",
    targetPlayer: targetPlayer.trim(),
    notes: notes || "",
    status: "pending",
    progress: { step: "Awaiting suspect to launch 47Detect and enter PIN...", percent: 0 },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    results: null
  };

  db.createSession(session);
  db.updateLicense(req.license.id, { totalChecks: (req.license.totalChecks || 0) + 1 });

  res.json(session);
});

app.get('/api/customer/sessions', customerAuth, (req, res) => {
  const sessions = db.getSessions().filter(s => s.licenseKey === req.license.key);
  res.json(sessions);
});

app.get('/api/customer/sessions/:id', customerAuth, (req, res) => {
  const session = db.getSessionById(req.params.id);
  if (!session || session.licenseKey !== req.license.key) {
    return res.status(404).json({ error: "Session record not found" });
  }
  res.json(session);
});

app.post('/api/customer/settings', customerAuth, (req, res) => {
  const { discordWebhook } = req.body;
  db.updateLicense(req.license.id, { discordWebhook });
  res.json({ success: true });
});

// -------------------------------------------------------------
// SCANNER API (Used strictly by 47Detect.exe on Suspect PC)
// -------------------------------------------------------------
app.post('/api/scanner/verify-pin', (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: "PIN is required" });

  const session = db.getSessionByPin(pin);
  if (!session) {
    return res.status(404).json({ error: "Invalid PIN code. Contact staff." });
  }

  if (new Date(session.expiresAt) < new Date() && session.status === 'pending') {
    db.updateSession(session.id, { status: 'expired' });
    return res.status(400).json({ error: "This inspection session has expired." });
  }

  if (session.status === 'completed') {
    return res.status(400).json({ error: "This inspection has already been completed." });
  }

  db.updateSession(session.id, {
    status: 'scanning',
    progress: { step: "Player connected. Running 47Detect deep inspection...", percent: 5 }
  });

  broadcastToSession(session.id, 'status_change', { status: 'scanning', percent: 5 });
  broadcastToLicense(session.licenseKey, 'session_update', { sessionId: session.id, status: 'scanning' });

  res.json({
    valid: true,
    sessionId: session.id,
    serverName: session.serverName,
    targetPlayer: session.targetPlayer
  });
});

app.post('/api/scanner/progress', (req, res) => {
  const { sessionId, step, percent } = req.body;
  if (!sessionId) return res.status(400).json({ error: "Session ID required" });

  const session = db.getSessionById(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  db.updateSession(sessionId, {
    progress: { step: step || "Scanning...", percent: parseInt(percent) || 0 }
  });

  broadcastToSession(sessionId, 'progress', { step, percent });
  broadcastToLicense(session.licenseKey, 'session_progress', { sessionId, step, percent });
  res.json({ success: true });
});

app.post('/api/scanner/submit', async (req, res) => {
  const { sessionId, results } = req.body;
  if (!sessionId || !results) return res.status(400).json({ error: "Session ID and results required" });

  const session = db.getSessionById(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const updatedSession = db.updateSession(sessionId, {
    status: 'completed',
    progress: { step: "Inspection Completed", percent: 100 },
    completedAt: new Date().toISOString(),
    results
  });

  broadcastToSession(sessionId, 'completed', updatedSession);
  broadcastToLicense(session.licenseKey, 'session_completed', updatedSession);

  // Send to Discord Webhook
  const license = db.getLicenseByKey(session.licenseKey);
  if (license && license.discordWebhook) {
    try {
      await sendDiscordWebhook(license.discordWebhook, updatedSession);
    } catch (e) {
      console.error("Discord webhook dispatch error:", e.message);
    }
  }

  res.json({ success: true, message: "Forensic report securely uploaded." });
});

// Helper for sending 47Detect Discord Webhook
async function sendDiscordWebhook(webhookUrl, session) {
  if (!webhookUrl || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) return;

  const isDetected = session.results?.OverallStatus === 'DETECTED';
  const isWarning = session.results?.OverallStatus === 'WARNING';

  const statusColor = isDetected ? 0xdc2626 : isWarning ? 0xf59e0b : 0x10b981;
  const statusEmoji = isDetected ? '🚨 CHEAT DETECTED' : isWarning ? '⚠️ SUSPICIOUS ANOMALY' : '✅ CLEAN';

  const flags = session.results?.Flags || [];
  const flagsList = flags.length > 0 
    ? flags.map(f => `• **${f.Message}**\n  _${f.Details}_`).join('\n')
    : "No unauthorized software or anti-forensic tampering detected.";

  const payload = {
    username: "47Detect Forensic Engine",
    avatar_url: "https://raw.githubusercontent.com/favicon.ico",
    embeds: [
      {
        title: `${statusEmoji} — 47Detect PC-Check Inspection`,
        description: `**Server:** ${session.serverName}\n**Player:** \`${session.targetPlayer}\`\n**Staff:** \`${session.staffName}\`\n**Session ID:** \`${session.id}\``,
        color: statusColor,
        fields: [
          {
            name: "💻 Target Hardware",
            value: `**PC:** ${session.results?.SystemInfo?.PcName || 'Unknown'}\n**User:** ${session.results?.SystemInfo?.Username || 'Unknown'}\n**OS:** ${session.results?.SystemInfo?.OS || 'Windows'}\n**CPU:** ${session.results?.SystemInfo?.Cpu || 'N/A'}\n**RAM:** ${session.results?.SystemInfo?.Ram || 'N/A'}`,
            inline: true
          },
          {
            name: "📁 Telemetry Stats",
            value: `**Total Audited:** ${session.results?.TotalItemsAudited || 0} items\n**FiveM Installed:** ${session.results?.FiveM?.Installed ? 'Yes' : 'No'}\n**Citizen Mods:** ${session.results?.FiveM?.CitizenMods?.length || 0}`,
            inline: true
          },
          {
            name: "🚩 Detection Flags & Telemetry",
            value: flagsList.substring(0, 1024),
            inline: false
          }
        ],
        footer: {
          text: `47Detect Forensic Engine v4.0 • Complete Forensic Audit`
        },
        timestamp: new Date().toISOString()
      }
    ]
  };

  try {
    if (typeof globalThis.fetch === 'function') {
      await globalThis.fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
  } catch (err) {}
}

// -------------------------------------------------------------
// WEB ROUTES
// -------------------------------------------------------------
// Secret Vault Owner Page
app.get('/vault-47-admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'owner.html'));
});

// Dedicated Customer Portal (Link for buyers/server owners)
app.get('/portal', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'portal.html'));
});

// Standalone Public/Staff Forensic Dossier Report Route
app.get('/report/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'report.html'));
});

// Report Data API
app.get('/api/public/report/:id', (req, res) => {
  const session = db.getSessionById(req.params.id);
  if (!session) {
    return res.status(404).json({ error: "Inspection report not found or expired." });
  }
  res.json(session);
});

// Public Showcase Landing Page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'landing.html'));
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🎯  47Detect Forensic Engine Server Started!`);
  console.log(`🌐  Public Showcase:    http://localhost:${PORT}/`);
  console.log(`📥  Client Download:    http://localhost:${PORT}/download`);
  console.log(`🎮  Customer Portal:    http://localhost:${PORT}/portal`);
  console.log(`📑  Forensic Reports:   http://localhost:${PORT}/report/:id`);
  console.log(`🔐  Secret Owner Vault: http://localhost:${PORT}/vault-47-admin`);
  console.log(`====================================================`);
});
