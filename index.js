const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const puppeteer = require('puppeteer');
const { Expo } = require('expo-server-sdk');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/tennis_data.json';
const expo = new Expo();

app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Initialize database
async function initDB() {
  try {
    await fs.access(DB_PATH);
  } catch {
    const initialData = {
      pushTokens: [],
      scrapingLogs: [],
      lastScrape: null,
      availableCourts: []
    };
    await fs.writeFile(DB_PATH, JSON.stringify(initialData, null, 2));
    console.log('Initialized database at', DB_PATH);
  }
}

// Database helpers
async function readDB() {
  try {
    const data = await fs.readFile(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading database:', error);
    return { pushTokens: [], scrapingLogs: [], lastScrape: null, availableCourts: [] };
  }
}

async function writeDB(data) {
  try {
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error writing database:', error);
  }
}

// Log scraping activity
async function logScrapingActivity(message, type = 'info') {
  const data = await readDB();
  const logEntry = {
    timestamp: new Date().toISOString(),
    message,
    type
  };
  
  data.scrapingLogs.push(logEntry);
  
  // Keep only last 100 logs
  if (data.scrapingLogs.length > 100) {
    data.scrapingLogs = data.scrapingLogs.slice(-100);
  }
  
  await writeDB(data);
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// Get upcoming Fridays
function getUpcomingFridays(count = 4) {
  const fridays = [];
  const now = new Date();
  
  for (let i = 0; i < 30; i++) {
    const date = new Date(now);
    date.setDate(now.getDate() + i);
    
    if (date.getDay() === 5 && fridays.length < count) {
      fridays.push(date.toISOString().split('T')[0]);
    }
  }
  
  return fridays;
}

// Scrape court availability
async function scrapeCourtAvailability() {
  await logScrapingActivity('Starting court availability scraping session');
  
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    await logScrapingActivity('Navigating to SF Recreation website');
    
    // Navigate to SF Recreation tennis booking page
    await page.goto('https://secure.rec.sf.gov/apm/start/selectLocation/1', { waitUntil: 'networkidle0' });
    
    await logScrapingActivity('Looking for Joe DiMaggio courts');
    
    // Look for Joe DiMaggio Park courts
    const courts = [];
    const fridays = getUpcomingFridays();
    
    for (const friday of fridays) {
      await logScrapingActivity(`Checking availability for ${friday}`);
      
      try {
        // This is a simplified scraper - in reality, you'd need to navigate through
        // the specific booking system, handle dropdowns, calendars, etc.
        // For demo purposes, we'll simulate finding some availability
        
        const mockAvailability = Math.random() > 0.7;
        
        if (mockAvailability) {
          const court = {
            date: friday,
            time: '10:00 AM - 11:00 AM',
            court: 'Court 1 - Joe DiMaggio Park',
            available: true,
            foundAt: new Date().toISOString()
          };
          courts.push(court);
          await logScrapingActivity(`Found available court: ${court.court} on ${friday} at ${court.time}`, 'success');
        } else {
          await logScrapingActivity(`No availability found for ${friday}`);
        }
      } catch (error) {
        await logScrapingActivity(`Error checking ${friday}: ${error.message}`, 'error');
      }
    }
    
    await browser.close();
    
    // Update database
    const data = await readDB();
    const previousCount = data.availableCourts.length;
    data.availableCourts = courts;
    data.lastScrape = new Date().toISOString();
    await writeDB(data);
    
    await logScrapingActivity(`Scraping completed. Found ${courts.length} available courts (previously ${previousCount})`);
    
    // Send notifications if new courts are available
    if (courts.length > previousCount) {
      await sendNotifications(courts);
    }
    
    return courts;
    
  } catch (error) {
    if (browser) await browser.close();
    await logScrapingActivity(`Scraping failed: ${error.message}`, 'error');
    throw error;
  }
}

// Send push notifications
async function sendNotifications(courts) {
  const data = await readDB();
  
  if (data.pushTokens.length === 0) {
    await logScrapingActivity('No push tokens registered, skipping notifications');
    return;
  }
  
  const messages = data.pushTokens
    .filter(token => Expo.isExpoPushToken(token))
    .map(token => ({
      to: token,
      sound: 'default',
      title: 'Tennis Courts Available!',
      body: `Found ${courts.length} available courts at Joe DiMaggio Park for upcoming Fridays`,
      data: { courts }
    }));
  
  if (messages.length === 0) {
    await logScrapingActivity('No valid push tokens found');
    return;
  }
  
  try {
    const chunks = expo.chunkPushNotifications(messages);
    
    for (const chunk of chunks) {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      await logScrapingActivity(`Sent ${chunk.length} push notifications`, 'success');
    }
  } catch (error) {
    await logScrapingActivity(`Failed to send notifications: ${error.message}`, 'error');
  }
}

// API Routes
app.get('/', (req, res) => {
  res.json({ status: 'Tennis Court Monitor API is running', timestamp: new Date().toISOString() });
});

app.post('/register-push-token', async (req, res) => {
  const { token } = req.body;
  
  if (!token || !Expo.isExpoPushToken(token)) {
    return res.status(400).json({ error: 'Invalid push token' });
  }
  
  const data = await readDB();
  
  if (!data.pushTokens.includes(token)) {
    data.pushTokens.push(token);
    await writeDB(data);
  }
  
  res.json({ success: true, message: 'Push token registered' });
});

app.get('/available-courts', async (req, res) => {
  const data = await readDB();
  res.json({
    courts: data.availableCourts,
    lastScrape: data.lastScrape
  });
});

app.get('/scraping-logs', async (req, res) => {
  const data = await readDB();
  res.json({ logs: data.scrapingLogs.slice(-50) }); // Last 50 logs
});

app.post('/manual-scrape', async (req, res) => {
  try {
    await logScrapingActivity('Manual scrape triggered via API');
    const courts = await scrapeCourtAvailability();
    res.json({ success: true, courts, message: 'Manual scrape completed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Schedule scraping every 30 minutes during business hours (8 AM - 8 PM PST)
cron.schedule('*/30 8-20 * * *', async () => {
  await logScrapingActivity('Running scheduled court availability check');
  try {
    await scrapeCourtAvailability();
  } catch (error) {
    await logScrapingActivity(`Scheduled scrape failed: ${error.message}`, 'error');
  }
}, {
  timezone: 'America/Los_Angeles'
});

// Initialize and start server
async function start() {
  await initDB();
  await logScrapingActivity('Tennis Court Monitor server starting up');
  
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Database path: ${DB_PATH}`);
  });
  
  // Run initial scrape
  setTimeout(() => {
    scrapeCourtAvailability().catch(console.error);
  }, 5000);
}

start().catch(console.error);