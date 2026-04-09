const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- Setup Mongoose ---
// We read MONGO_URI from the environment variables set in Render
const mongoUri = process.env.MONGO_URI;

if (mongoUri) {
  mongoose.connect(mongoUri)
    .then(() => console.log("Connected to MongoDB Atlas"))
    .catch((err) => console.error("MongoDB Connection Error:", err));
} else {
  console.warn("WARNING: MONGO_URI is not set. Database will not connect.");
}

const DayStateSchema = new mongoose.Schema({
  daily: { type: Map, of: Boolean, default: {} },
  anchorDone: { type: Map, of: Boolean, default: {} }
}, { _id: false });

const HouseholdSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  language: { type: String, default: 'he' },
  streak: { type: Number, default: 0 },
  latestDate: { type: String },
  weekStartDate: { type: String },
  
  dailyTasks: { type: [String], default: ['dishwasher', 'kitchen', 'hallway', 'bottles'] },
  weeklyTasks: { 
    type: Map, 
    of: String, 
    default: {
      "0": "Laundry + fold",
      "1": "Floors throughout",
      "2": "Buffer day",
      "3": "Living room reset",
      "4": "Laundry + fold",
      "5": "Brush Nixi",
      "6": "Buffer day"
    } 
  },
  anchorTasks: { type: [String], default: ['recycling', 'sterilize'] },
  weeklyTasksDone: { type: Map, of: Boolean, default: {} },
  
  zoneTaskCarryover: {
    taskName: String,
    originalDate: String,
    daysCarried: Number
  },
  
  history: { type: Map, of: DayStateSchema, default: {} }
});

const Household = mongoose.model('Household', HouseholdSchema);

// Helper: Get today's date string in Asia/Jerusalem
const getTodayString = (dateObj = new Date()) => {
  return new Intl.DateTimeFormat('en-CA', { 
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(dateObj); // Returns YYYY-MM-DD
};

// Helper: Get Sunday of the current week (to reset weekly tasks)
const getWeekStart = (dateStr) => {
  const d = new Date(dateStr);
  const day = d.getDay();
  // subtract days to get Sunday
  d.setDate(d.getDate() - day);
  return getTodayString(d);
};

const diffInDays = (date1Str, date2Str) => {
  const d1 = new Date(date1Str);
  const d2 = new Date(date2Str);
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
};

const generateCode = () => Math.random().toString(36).substring(2, 6).toUpperCase();

// Initialize empty day
const createEmptyDayState = (household) => {
  const daily = {};
  household.dailyTasks.forEach(task => daily[task] = false);

  const anchorDone = {};
  household.anchorTasks.forEach(task => anchorDone[task] = false);

  return { daily, anchorDone };
};

const calculateRollover = async (household) => {
  const todayStr = getTodayString();
  const weekStart = getWeekStart(todayStr);

  // If a new week started, clear weekly tasks done
  if (household.weekStartDate !== weekStart) {
    household.weekStartDate = weekStart;
    household.weeklyTasksDone = {};
  }

  if (!household.history.has(todayStr)) {
    // New day! Calculate streak
    let currentStreak = household.streak || 0;
    
    // Convert history map to sorted array of previous days
    const passDays = Array.from(household.history.keys()).filter(d => d < todayStr).sort();
    
    if (passDays.length > 0) {
      const yesterdayStr = getTodayString(new Date(Date.now() - 86400000));
      const lastRecordedDayStr = passDays[passDays.length - 1];
      
      if (lastRecordedDayStr !== yesterdayStr) {
        currentStreak = 0; // missed yesterday entirely
      } else {
        const lastDayData = household.history.get(lastRecordedDayStr);
        let completedDailies = 0;
        if (lastDayData && lastDayData.daily) {
             completedDailies = Array.from(lastDayData.daily.values()).filter(Boolean).length;
        }
        
        const needed = Math.floor(household.dailyTasks.length * 0.75); // Needs 75% complete to keep streak
        
        if (completedDailies >= needed) {
            let realStreak = 0;
            for (let i = passDays.length - 1; i >= 0; i--) {
                if (i < passDays.length - 1 && diffInDays(passDays[i], passDays[i+1]) > 1) {
                  break;
                }
                const dayData = household.history.get(passDays[i]);
                const cCount = Array.from((dayData?.daily || new Map()).values()).filter(Boolean).length;
                if (cCount >= needed) realStreak++;
                else break;
            }
            currentStreak = realStreak;
        } else {
            currentStreak = 0;
        }
      }
    }
    
    household.streak = currentStreak;
    household.history.set(todayStr, createEmptyDayState(household));
    household.latestDate = todayStr;
  }
};

let sseClients = {};
const broadcast = (code, householdData) => {
  if (sseClients[code]) {
    sseClients[code].forEach(res => res.write(`data: ${JSON.stringify(householdData)}\n\n`));
  }
};

app.post('/api/household', async (req, res) => {
  let code = '';
  // Avoid infinite loops in case code generation hits collisions
  for (let i = 0; i < 100; i++) {
      code = generateCode();
      const exists = await Household.exists({ code });
      if (!exists) break;
  }
  
  const todayStr = getTodayString();
  const weekStart = getWeekStart(todayStr);
  
  const newHousehold = new Household({
    code,
    weekStartDate: weekStart,
    latestDate: todayStr,
    weeklyTasksDone: {}
  });
  
  newHousehold.history.set(todayStr, createEmptyDayState(newHousehold));

  try {
      await newHousehold.save();
      res.json(newHousehold);
  } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to create household" });
  }
});

app.get('/api/household/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const household = await Household.findOne({ code });
    if (!household) return res.status(404).json({ error: 'Not found' });
    
    await calculateRollover(household);
    await household.save();
    res.json(household);
  } catch(e) {
    res.status(500).json({ error: "Internal error" });
  }
});

app.post('/api/household/:code/update', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const household = await Household.findOne({ code });
    if (!household) return res.status(404).json({ error: 'Not found' });

    await calculateRollover(household);
    
    const todayStr = getTodayString();
    const updates = req.body;
    
    if (updates.daily) {
      const todayState = household.history.get(todayStr);
      for (const [k, v] of Object.entries(updates.daily)) {
          todayState.daily.set(k, v);
      }
    }
    if (updates.weeklyTasksDone) {
        for (const [k, v] of Object.entries(updates.weeklyTasksDone)) {
            household.weeklyTasksDone.set(k, v);
        }
    }
    if (updates.anchorDone) {
      const todayState = household.history.get(todayStr);
      for (const [k, v] of Object.entries(updates.anchorDone)) {
          todayState.anchorDone.set(k, v);
      }
    }
    
    // Custom task array updates
    if (updates.dailyTasks) household.dailyTasks = updates.dailyTasks;
    if (updates.weeklyTasks) {
        for (const [k, v] of Object.entries(updates.weeklyTasks)) {
            household.weeklyTasks.set(k, v);
        }
    }
    if (updates.anchorTasks) household.anchorTasks = updates.anchorTasks;
    if (updates.language) household.language = updates.language;
    
    await household.save();
    broadcast(code, household);
    res.json(household);
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: "Update failed" });
  }
});

app.get('/api/household/:code/events', (req, res) => {
  const code = req.params.code.toUpperCase();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!sseClients[code]) sseClients[code] = [];
  sseClients[code].push(res);

  req.on('close', () => {
    sseClients[code] = sseClients[code].filter(client => client !== res);
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
