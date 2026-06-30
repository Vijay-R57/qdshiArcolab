require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const dns      = require('dns');
const path     = require('path');

if (!process.env.VERCEL) {
  try {
    dns.setServers(["1.1.1.1", "8.8.8.8"]);
  } catch (err) {
    console.warn("Failed to set DNS servers:", err.message);
  }
}

// ── Serverless-safe DB connection (Vercel cold-start fix) ────────────────────
// mongoose.connect() is async — on cold starts routes fire before it resolves.
// This middleware awaits the connection on every request; warm invocations
// short-circuit instantly via readyState check.
let _dbReady = false;
async function connectDB() {
  if (mongoose.connection.readyState === 1) return; // already connected
  await mongoose.connect(process.env.MONGO_URI);
  _dbReady = true;
}

const metricRoutes      = require('./routes/metricRoutes');
const userRoutes        = require('./routes/userRoutes');
const healthRoutes      = require('./routes/healthRoutes');
const ideationRoutes    = require('./routes/IdeationRoutes');
const ehsRoutes          = require('./routes/ehsRoutes');
const engineeringRoutes  = require('./routes/engineeringRoutes');
const hrRoutes           = require('./routes/hrRoutes');
const timeLockRoutes     = require('./routes/timeLockRoutes');
const loginLogRoutes     = require('./routes/loginLogRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const plantDashboardRoutes = require('./routes/plantDashboardRoutes');
const { startShiftAlertJob } = require('./jobs/shiftAlertJob');
const { initWatchdogScheduler } = require('./utils/watchdogScheduler');

const app = express();

const helmet = require('helmet');
app.use(helmet({ contentSecurityPolicy: false }));

// ✅ Vercel path-prefix rewriting middleware
app.use((req, res, next) => {
  if (process.env.VERCEL && !req.url.startsWith('/api')) {
    req.url = '/api' + req.url;
  }
  next();
});

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, etc.)
    if (!origin) return callback(null, true);
    const allowed = [
      process.env.FRONTEND_URL,
      'https://og-qdshi.vercel.app',
      'https://qdsharcolab.vercel.app',
      'https://arcolab-huddle.vercel.app',
      'http://localhost:3000',
      'http://localhost:8080',
    ].filter(Boolean);
    // Also allow any *.vercel.app subdomain for preview deployments
    if (allowed.includes(origin) || /\.vercel\.app$/.test(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json());

// ✅ Ensure DB is ready before every request (no-op on warm invocations)
app.use(async (req, res, next) => {
  try { await connectDB(); next(); }
  catch (err) {
    console.error('DB connect error:', err.message);
    res.status(503).json({ error: 'Database unavailable', detail: err.message });
  }
});

app.use('/api/metrics',      metricRoutes);
app.use('/api/users',        userRoutes);
app.use('/api/health',       healthRoutes);
app.use('/api/ideation',     ideationRoutes);
app.use('/api/ehs',          ehsRoutes);
app.use('/api/engineering',  engineeringRoutes);
app.use('/api/hr',           hrRoutes);
app.use('/api/timelock',     timeLockRoutes);
app.use('/api/loginlog',     loginLogRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/plant-dashboard', plantDashboardRoutes);


// ✅ CENTRAL CONFIG (IMPORTANT — SAME AS FRONTEND)
const DEPT_CONFIG = {
  fgmw: 'Finished Goods Warehouse',
  pmw: 'Packing Material Warehouse',
  rmw: 'Raw Material Warehouse',
  ppp: 'Primary Packing Production',
  pop: 'Post Production',
  qcmad: 'QC & Microbiology Lab',
  pro: 'Production',
  spp: 'Secondary Packing Production',
  fac: 'Facilities'
};

const LETTERS = ['Q', 'D', 'S', 'H', 'I'];

const TYPE_MAP = {
  Q: 'Quality',
  D: 'Delivery',
  S: 'Safety',
  H: 'Health',
  I: 'Improvement'
};

// ✅ SMART LABEL
const getLabel = (letter, dept) => {
  const deptName = DEPT_CONFIG[dept] || 'General';
  const isProduction = ['ppp', 'pro', 'spp'].includes(dept);

  const type =
    letter === 'D'
      ? (isProduction ? 'Production' : 'Dispatch')
      : TYPE_MAP[letter] || 'Metric';

  return `${deptName} ${type}`;
};

// 🔄 OLD → NEW DEPT MIGRATION MAP
const OLD_TO_NEW_DEPT = {
  fg: 'fgmw',
  pm: 'pmw',
  rm: 'rmw',
  pp: 'ppp'
};

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('✅ MongoDB Connected');

    const Metric = require('./models/Metrics');
    const Health = require('./models/Health');

    // ── 1. Drop old index ─────────────────────────────
    try {
      await Metric.collection.dropIndex('letter_1');
      console.log('✅ Dropped legacy index');
    } catch (_) {}

    // ── 2. MIGRATE OLD DEPT VALUES (SAFE MERGE) ───────
    for (const [oldDept, newDept] of Object.entries(OLD_TO_NEW_DEPT)) {
      for (const letter of LETTERS) {
        const oldDoc = await Metric.findOne({ letter, dept: oldDept });
        if (!oldDoc) continue;

        const newDoc = await Metric.findOne({ letter, dept: newDept });
        if (newDoc) {
          // Both exist, we must merge oldDoc into newDoc
          console.log(`Merging metrics for ${letter} in ${oldDept} -> ${newDept}`);
          const mergedShifts = JSON.parse(JSON.stringify(newDoc.shifts || { '1': {}, '2': {}, '3': {} }));
          const oldShifts = oldDoc.shifts || {};
          
          for (const shiftKey of ['1', '2', '3']) {
            if (!mergedShifts[shiftKey]) mergedShifts[shiftKey] = {};
            const oldShift = oldShifts[shiftKey] || {};
            const newShift = mergedShifts[shiftKey];
            
            newShift.alerts = (newShift.alerts || 0) + (oldShift.alerts || 0);
            newShift.success = (newShift.success || 0) + (oldShift.success || 0);
            
            if (oldShift.daysData && Array.isArray(oldShift.daysData)) {
              if (!newShift.daysData || !Array.isArray(newShift.daysData)) {
                newShift.daysData = oldShift.daysData;
              } else {
                const maxLen = Math.max(newShift.daysData.length, oldShift.daysData.length);
                for (let i = 0; i < maxLen; i++) {
                  const newVal = newShift.daysData[i];
                  const oldVal = oldShift.daysData[i];
                  if (!newVal || newVal === 'none') {
                    newShift.daysData[i] = oldVal || 'none';
                  }
                }
              }
            }
            
            const listFields = ['issueLogs', 'staffLogs', 'activityLogs'];
            for (const field of listFields) {
              if (oldShift[field] && Array.isArray(oldShift[field])) {
                if (!newShift[field] || !Array.isArray(newShift[field])) {
                  newShift[field] = oldShift[field];
                } else {
                  newShift[field] = [...newShift[field], ...oldShift[field]];
                }
              }
            }
          }
          
          await Metric.updateOne({ _id: newDoc._id }, { $set: { shifts: mergedShifts } });
          await Metric.deleteOne({ _id: oldDoc._id });
        } else {
          // Only old document exists, rename department safely
          await Metric.updateOne({ _id: oldDoc._id }, { $set: { dept: newDept, label: getLabel(letter, newDept) } });
        }
      }
    }

    // ── 3. FIX EMPTY / NULL DEPTS ─────────────────────
    await Metric.collection.updateMany(
      { $or: [{ dept: { $exists: false } }, { dept: null }, { dept: '' }] },
      { $set: { dept: 'fgmw' } }
    );

    // ── 4. UPDATE LABELS (FIXED TO PREVENT DUPLICATE KEY E11000 ERRORS) ──
    const allMetrics = await Metric.find();
    for (const m of allMetrics) {
      const newLabel = getLabel(m.letter, m.dept);
      if (m.label !== newLabel) {
        // Target updates via explicit updateOne to sidestep active unique validation rules on save hooks
        await Metric.updateOne({ _id: m._id }, { $set: { label: newLabel } });
      }
    }
    console.log('✅ Labels synced');

    // ── 5. INITIALISE ALL (LETTER × DEPT) - FIXED VIA EXPLICIT PRE-CHECK EXCLUSION ──
    let created = 0;
    for (const letter of LETTERS) {
      for (const dept of Object.keys(DEPT_CONFIG)) {
        // Run an active existence lookup to completely eliminate upsert index friction
        const alreadyExists = await Metric.exists({ letter, dept });
        
        if (!alreadyExists) {
          await Metric.create({
            letter,
            dept,
            label: getLabel(letter, dept),
            shifts: { '1': {}, '2': {}, '3': {} }
          });
          created++;
        }
      }
    }
    console.log(`✅ Initialised ${created} metric stubs`);

    // ── 6. HEALTH COLLECTION MIGRATION ────────────────
    await Health.collection.updateMany(
      { $or: [{ dept: 'COMMON' }, { dept: { $exists: false } }] },
      { $set: { dept: 'fgmw' } }
    );
    console.log('✅ Health migration done');

    // Start shift-missed-alert cron job
    startShiftAlertJob();

    // Start watchdog scheduler after DB is available
    initWatchdogScheduler();

  })
  .catch(err => console.error('❌ MongoDB error:', err.message));

// Serve static frontend in production (only when not running on Vercel)
if (!process.env.VERCEL) {
  // ── SERVE STATIC FRONTEND ON PRODUCTION ────────────────
  // Directs express to stream pre-compiled production UI layers
  app.use(express.static(path.join(__dirname, '../frontend/build')));

  // ✅ FIXED: Using a RegExp literal bypasses the strict string parsing constraints of path-to-regexp completely
  app.get(/^\/(?!api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
  });
}

// Graceful Shutdown
process.on('SIGINT', async () => {
  await mongoose.connection.close();
  console.log('🛑 MongoDB connection closed'); 
  process.exit(0);
});

// Local dev only (or standard Node hosting like Render/Heroku) — Vercel uses module.exports instead
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}

// ✅ Required for Vercel serverless deployment
module.exports = app;
