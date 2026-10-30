const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const defaultData = {
  config: {
    ownerSecret: "47#Detect_Master_Vault!2026",
    appName: "47Detect",
    version: "4.0.0",
    secretOwnerRoute: "/vault-47-admin"
  },
  licenses: [
    {
      id: "lic-master-47",
      key: "47D-PRO-MASTER-SERVER",
      serverName: "DZ Roleplay Official",
      plan: "Pro",
      maxUsers: 20,
      maxStaff: 20,
      status: "active",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days default
      discordWebhook: "",
      totalChecks: 0
    }
  ],
  sessions: []
};

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      parsed.config = {
        ownerSecret: "47#Detect_Master_Vault!2026",
        appName: "47Detect",
        version: "4.0.0",
        secretOwnerRoute: "/vault-47-admin"
      };
      return parsed;
    }
  } catch (err) {
    console.error("Error loading db:", err.message);
  }
  saveDatabase(defaultData);
  return defaultData;
}

let db = loadDatabase();

function saveDatabase(dataToSave = db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8');
  } catch (err) {
    console.error("Error saving db:", err.message);
  }
}

module.exports = {
  getDb: () => db,
  saveDb: () => saveDatabase(db),
  
  // Licenses
  getLicenses: () => db.licenses,
  getLicenseByKey: (key) => db.licenses.find(l => l.key.toUpperCase() === key.toUpperCase()),
  createLicense: (licenseData) => {
    db.licenses.unshift(licenseData);
    saveDatabase();
    return licenseData;
  },
  updateLicense: (id, updates) => {
    const idx = db.licenses.findIndex(l => l.id === id);
    if (idx !== -1) {
      db.licenses[idx] = { ...db.licenses[idx], ...updates };
      saveDatabase();
      return db.licenses[idx];
    }
    return null;
  },
  deleteLicense: (id) => {
    db.licenses = db.licenses.filter(l => l.id !== id);
    saveDatabase();
  },

  // Sessions
  getSessions: () => db.sessions,
  getSessionByPin: (pin) => {
    const cleanPin = pin.replace(/\D/g, '');
    return db.sessions.find(s => s.pin.replace(/\D/g, '') === cleanPin);
  },
  getSessionById: (id) => db.sessions.find(s => s.id === id),
  createSession: (session) => {
    db.sessions.unshift(session);
    if (db.sessions.length > 300) {
      db.sessions = db.sessions.slice(0, 300);
    }
    saveDatabase();
    return session;
  },
  updateSession: (id, updates) => {
    const idx = db.sessions.findIndex(s => s.id === id);
    if (idx !== -1) {
      db.sessions[idx] = { ...db.sessions[idx], ...updates };
      saveDatabase();
      return db.sessions[idx];
    }
    return null;
  }
};
