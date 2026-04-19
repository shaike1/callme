// dashboard-helpers.js — stub implementations for missing helper functions

function buildLiveCallsList(sessions, activeCalls, now, engine) {
  // Build list of active calls from sessions + 3CX active calls
  const calls = [];
  
  // Add sessions
  if (sessions && typeof sessions.getAllSessions === 'function') {
    const allSessions = sessions.getAllSessions();
    for (const [callId, session] of Object.entries(allSessions)) {
      calls.push({
        callId,
        status: 'active',
        duration: Math.floor((now - (session.startTime || now)) / 1000),
        engine: session.engine || engine,
        from: session.from || 'unknown',
        to: session.to || 'unknown',
      });
    }
  }
  
  // Add 3CX active calls
  if (Array.isArray(activeCalls)) {
    for (const call of activeCalls) {
      if (!calls.find(c => c.callId === call.id)) {
        calls.push({
          callId: call.id,
          status: call.status || 'ringing',
          from: call.from,
          to: call.to,
          duration: call.duration || 0,
        });
      }
    }
  }
  
  return calls;
}

function evaluateCallFilter(botSettings, callerNumber) {
  if (!botSettings || !botSettings.callFilterMode || botSettings.callFilterMode === 'none') {
    return { allowed: true };
  }
  
  const { callFilterMode, callFilterList = [] } = botSettings;
  const normalized = normalizeCallFilterList(callFilterList);
  
  for (const entry of normalized) {
    const matches = matchesFilterEntry(callerNumber, entry);
    if (matches) {
      if (callFilterMode === 'blacklist') {
        return { allowed: false, reason: `Blocked by blacklist: ${entry.pattern}` };
      }
      if (callFilterMode === 'whitelist') {
        return { allowed: true, reason: `Allowed by whitelist: ${entry.pattern}` };
      }
    }
  }
  
  // Whitelist mode: if no match, block
  if (callFilterMode === 'whitelist') {
    return { allowed: false, reason: 'Not in whitelist' };
  }
  
  return { allowed: true };
}

function isWithinBusinessHoursAt(settings, dateTime) {
  if (!settings || !settings.businessHoursEnabled) return true;
  
  const { businessHoursStart = '09:00', businessHoursEnd = '18:00', businessHoursDays = [0,1,2,3,4] } = settings;
  const date = new Date(dateTime);
  const day = date.getDay();
  const hour = date.getHours();
  const minute = date.getMinutes();
  const time = hour * 60 + minute;
  
  const [startH, startM] = businessHoursStart.split(':').map(Number);
  const [endH, endM] = businessHoursEnd.split(':').map(Number);
  const startTime = startH * 60 + startM;
  const endTime = endH * 60 + endM;
  
  return businessHoursDays.includes(day) && time >= startTime && time < endTime;
}

function maskApiKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const masked = { ...obj };
  const sensitiveKeys = ['apiKey', 'token', 'secret', 'password', 'pass', 'key'];
  
  for (const key of Object.keys(masked)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
      if (masked[key]) masked[key] = '✓ set';
    }
  }
  return masked;
}

function matchesAllowedPath(reqPath, allowedPath) {
  return reqPath === allowedPath || reqPath.startsWith(allowedPath + '/');
}

function normalizeCallFilterEntry(entry) {
  if (typeof entry === 'string') {
    return { pattern: entry, type: 'exact' };
  }
  return entry;
}

function normalizeCallFilterList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeCallFilterEntry);
}

function matchesFilterEntry(phone, entry) {
  if (!phone || !entry) return false;
  const { pattern, type = 'exact' } = entry;
  
  if (type === 'exact') {
    return phone === pattern;
  }
  if (type === 'prefix') {
    return phone.startsWith(pattern);
  }
  if (type === 'regex') {
    try {
      return new RegExp(pattern).test(phone);
    } catch {
      return false;
    }
  }
  return false;
}

function parseCallRating(value) {
  const rating = parseInt(value, 10);
  return !isNaN(rating) && rating >= 1 && rating <= 5 ? rating : null;
}

function resolveRequestRole(headers, options) {
  const { adminCreds, users = [], apiKeys = [], onApiKeyUsed } = options;
  
  // Check Basic Auth
  const auth = headers.authorization || headers.Authorization || '';
  if (auth.startsWith('Basic ')) {
    const b64 = auth.slice(6);
    const decoded = Buffer.from(b64, 'base64').toString();
    const [username, password] = decoded.split(':');
    
    // Admin
    if (username === adminCreds.user && password === adminCreds.pass) {
      return { role: 'admin', username };
    }
    
    // Users
    const user = users.find(u => u.username === username && u.password === password);
    if (user) {
      return { role: user.role || 'viewer', username };
    }
  }
  
  // Check API Key
  if (auth.startsWith('Bearer ')) {
    const key = auth.slice(7);
    const apiKey = apiKeys.find(k => k.key === key);
    if (apiKey) {
      if (onApiKeyUsed) onApiKeyUsed(apiKey);
      return { role: 'api', username: apiKey.name };
    }
  }
  
  return null;
}

function touchApiKeyUsage(apiKey, saveFn) {
  if (!apiKey) return;
  apiKey.lastUsed = Date.now();
  if (typeof saveFn === 'function') saveFn();
}

module.exports = {
  buildLiveCallsList,
  evaluateCallFilter,
  isWithinBusinessHoursAt,
  maskApiKeys,
  matchesAllowedPath,
  normalizeCallFilterEntry,
  normalizeCallFilterList,
  parseCallRating,
  resolveRequestRole,
  touchApiKeyUsage,
};
