/**
 * Google Calendar API integration — read & write events.
 * Uses a Service Account (same SA as Google TTS) for server-to-server auth.
 * Requires: calendar shared with the SA email, or domain-wide delegation.
 *
 * Also supports iCal URL as read-only fallback.
 */
const { google } = require('googleapis');
const fs = require('fs');
const logger = require('./logger');

let calendarClient = null;
let calendarId = 'primary';

/**
 * Initialize the Google Calendar client using the TTS service account.
 * @param {string} keyPath - path to Google SA JSON key file
 * @param {string} targetCalendarId - calendar ID (default: 'primary', or user email for domain-wide delegation)
 */
function init(keyPath, targetCalendarId) {
  if (!keyPath || !fs.existsSync(keyPath)) {
    logger.warn('Google Calendar: no service account key found', { keyPath });
    return false;
  }
  try {
    const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    calendarClient = google.calendar({ version: 'v3', auth });
    if (targetCalendarId) calendarId = targetCalendarId;
    logger.info('Google Calendar API initialized', { calendarId, sa: key.client_email });
    return true;
  } catch (err) {
    logger.error('Google Calendar init failed', { error: err.message });
    return false;
  }
}

/**
 * List upcoming events.
 * @param {number} daysAhead - how many days to look ahead
 * @returns {Array<{id, title, start, end, location, description}>}
 */
async function listEvents(daysAhead = 7) {
  if (!calendarClient) return [];
  const now = new Date();
  const timeMax = new Date(now.getTime() + daysAhead * 86400000);
  const res = await calendarClient.events.list({
    calendarId,
    timeMin: now.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  });
  return (res.data.items || []).map(e => ({
    id: e.id,
    title: e.summary || 'אירוע',
    start: e.start?.dateTime ? new Date(e.start.dateTime) : (e.start?.date ? new Date(e.start.date) : null),
    end: e.end?.dateTime ? new Date(e.end.dateTime) : (e.end?.date ? new Date(e.end.date) : null),
    location: e.location || '',
    description: e.description || '',
  }));
}

/**
 * Create a new calendar event.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.date - YYYY-MM-DD
 * @param {string} opts.time - HH:MM (24h)
 * @param {number} [opts.duration=60] - minutes
 * @param {string} [opts.location]
 * @param {string} [opts.description]
 * @returns {object} created event {id, htmlLink}
 */
async function createEvent({ title, date, time, duration = 60, location, description }) {
  if (!calendarClient) throw new Error('Google Calendar not initialized');
  const startDt = new Date(`${date}T${time}:00`);
  const endDt = new Date(startDt.getTime() + duration * 60000);
  // Detect timezone from system
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jerusalem';
  const event = {
    summary: title,
    start: { dateTime: startDt.toISOString(), timeZone },
    end: { dateTime: endDt.toISOString(), timeZone },
  };
  if (location) event.location = location;
  if (description) event.description = description;
  const res = await calendarClient.events.insert({ calendarId, resource: event });
  logger.info('Calendar event created', { id: res.data.id, title });
  return { id: res.data.id, htmlLink: res.data.htmlLink };
}

/**
 * Delete a calendar event by ID.
 */
async function deleteEvent(eventId) {
  if (!calendarClient) throw new Error('Google Calendar not initialized');
  await calendarClient.events.delete({ calendarId, eventId });
  logger.info('Calendar event deleted', { eventId });
}

/**
 * Check if Google Calendar API is available.
 */
function isAvailable() {
  return !!calendarClient;
}

module.exports = { init, listEvents, createEvent, deleteEvent, isAvailable };
