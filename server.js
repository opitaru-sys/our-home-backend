const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'data.json');

// Helper: Get today's date string in Asia/Jerusalem
const getTodayString = (dateObj = new Date()) => {
  return new Intl.DateTimeFormat('en-CA', { 
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(dateObj); // Returns YYYY-MM-DD
};

// Helper: Get Day of week (0-6)
const getDayOfWeek = (dateObj = new Date()) => {
  const dateStr = dateObj.toLocaleString("en-US", {timeZone: "Asia/Jerusalem"});
  return new Date(dateStr).getDay();
};

const diffInDays = (date1Str, date2Str) => {
  const d1 = new Date(date1Str);
  const d2 = new Date(date2Str);
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
};

// State functions
const readData = () => {
  if (!fs.existsSync(DATA_FILE)) return { households: {} };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } 
  catch(e) { return { households: {} }; }
};
const writeData = (data) => fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

// Generate a specific 4-6 char code
const generateCode = () => {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
};

const DEFAULT_SCHEDULE = {
  // Sunday = 0, Monday = 1... Saturday = 6
  0: "Laundry + fold",
  1: "Floors throughout",
  2: "Buffer day",
  3: "Living room reset",
  4: "Laundry + fold",
  5: "Brush Nixi",
  6: "Buffer day"
};

const DAILY_TASKS = ['dishwasher', 'emma', 'hallway', 'bottles'];
const ANCHOR_TASKS = ['recycling', 'sterilize'];

// Initialize a day's state
const createEmptyDayState = () => ({
  daily: { dishwasher: false, emma: false, hallway: false, bottles: false },
  zoneTaskDone: false,
  anchorDone: { recycling: false, sterilize: false }
});

const calculateRollover = (householdObj) => {
  const todayStr = getTodayString();
  if (!householdObj.history) householdObj.history = {};
  if (!householdObj.history[todayStr]) {
    // We are on a new day! Calculate streak from previous dates
    let currentStreak = householdObj.streak || 0;
    
    // Find the latest day we have recorded before today
    const pastDays = Object.keys(householdObj.history).filter(d => d < todayStr).sort();
    if (pastDays.length > 0) {
      const yesterdayStr = getTodayString(new Date(Date.now() - 86400000));
      const lastRecordedDayStr = pastDays[pastDays.length - 1];
      
      if (lastRecordedDayStr !== yesterdayStr) {
        // Missed yesterday entirely -> streak 0
        currentStreak = 0;
      } else {
        const lastDayData = householdObj.history[lastRecordedDayStr];
        const completedDailies = Object.values(lastDayData.daily).filter(Boolean).length;
        if (completedDailies >= 3) {
          // Already added to streak? Wait, streak should be recalculated from scratch or just maintained?
          // Since we check daily, if yesterday was successful and streak hasn't broken, it's fine.
          // Note: we can just recalculate the streak retroactively to be sure.
          let realStreak = 0;
          for (let i = pastDays.length - 1; i >= 0; i--) {
            const dStr = pastDays[i];
            // if difference is > 1 day from previous check, break
            if (i < pastDays.length - 1 && diffInDays(pastDays[i], pastDays[i+1]) > 1) {
              break;
            }
            const count = Object.values(householdObj.history[dStr].daily).filter(Boolean).length;
            if (count >= 3) realStreak++;
            else break; // broken streak
          }
          currentStreak = realStreak;
        } else {
          currentStreak = 0; // yesterday failed
        }
      }
    }
    
    householdObj.streak = currentStreak;
    householdObj.history[todayStr] = createEmptyDayState();
    
    // Handle carryover zone task here if it hasn't expired.
    if (householdObj.zoneTaskCarryover) {
       // if daysCarried >= 3, drop it
       householdObj.zoneTaskCarryover.daysCarried += diffInDays(householdObj.latestDate, todayStr);
       if (householdObj.zoneTaskCarryover.daysCarried > 3) {
           householdObj.zoneTaskCarryover = null; // expired
       }
    }
    
    householdObj.latestDate = todayStr;
  }
};

let sseClients = {};

const broadcast = (code, householdData) => {
  if (sseClients[code]) {
    sseClients[code].forEach(res => res.write(`data: ${JSON.stringify(householdData)}\n\n`));
  }
};

app.post('/api/household', (req, res) => {
  const data = readData();
  let code = generateCode();
  while (data.households[code]) code = generateCode();
  
  const todayStr = getTodayString();
  const newHousehold = {
    code,
    language: 'he',
    weeklyZoneSchedule: DEFAULT_SCHEDULE,
    streak: 0,
    latestDate: todayStr,
    history: { [todayStr]: createEmptyDayState() },
    zoneTaskCarryover: null // { taskName, originalDate, daysCarried }
  };
  
  data.households[code] = newHousehold;
  writeData(data);
  res.json(newHousehold);
});

app.get('/api/household/:code', (req, res) => {
  const data = readData();
  const code = req.params.code.toUpperCase();
  const household = data.households[code];
  if (!household) return res.status(404).json({ error: 'Not found' });
  
  // Ensure up to date for today
  calculateRollover(household);
  writeData(data);
  
  res.json(household);
});

app.post('/api/household/:code/update', (req, res) => {
  const data = readData();
  const code = req.params.code.toUpperCase();
  const household = data.households[code];
  if (!household) return res.status(404).json({ error: 'Not found' });

  calculateRollover(household); // ensure today is fresh
  
  const todayStr = getTodayString();
  
  // req.body should have partial updates directly on the history object for today
  // Example: { daily: { dishwasher: true }, zoneTaskDone: true, anchorDone: { recycling: false }}
  
  const updates = req.body;
  if (updates.daily) {
    household.history[todayStr].daily = { ...household.history[todayStr].daily, ...updates.daily };
  }
  if (updates.zoneTaskDone !== undefined) {
    household.history[todayStr].zoneTaskDone = updates.zoneTaskDone;
  }
  if (updates.anchorDone) {
    // If they checked an anchor task, we only apply it to today if today is Friday (5) or Saturday (6)
    // Actually, checking it on Friday means it shouldn't be required on Saturday. 
    household.history[todayStr].anchorDone = { ...household.history[todayStr].anchorDone, ...updates.anchorDone };
    // also propagate backwards to yesterday if today is Saturday? 
    // They can just view it as "weekly anchor is done". We will handle the check logic on frontend.
  }
  if (updates.zoneTaskCarryover !== undefined) {
      household.zoneTaskCarryover = updates.zoneTaskCarryover;
  }
  
  if (updates.language) {
      household.language = updates.language;
  }
  
  writeData(data);
  broadcast(code, household);
  res.json(household);
});

app.get('/api/household/:code/events', (req, res) => {
  const code = req.params.code.toUpperCase();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // flush the headers to establish SSE

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
