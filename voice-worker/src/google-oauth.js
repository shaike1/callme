/**
 * Google OAuth2 per-tenant integration.
 * Each tenant connects their own Google account via OAuth consent flow.
 * Tokens are stored in the tenant's settings directory.
 */
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/contacts.readonly',
];

let clientId = '';
let clientSecret = '';
let redirectUri = '';

/**
 * Initialize OAuth config from env vars.
 */
function init() {
  clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
  clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
  redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || '';
  if (clientId && clientSecret) {
    logger.info('Google OAuth2 configured', { redirectUri });
    return true;
  }
  logger.info('Google OAuth2 not configured (missing GOOGLE_OAUTH_CLIENT_ID/SECRET)');
  return false;
}

/**
 * Check if OAuth is configured.
 */
function isConfigured() {
  return !!(clientId && clientSecret);
}

/**
 * Create a new OAuth2 client instance.
 */
function _createClient() {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Generate consent URL for a tenant.
 * @param {string} tenantId - passed as state parameter
 * @returns {string} authorization URL
 */
function getConsentUrl(tenantId) {
  const client = _createClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: tenantId || 'global',
  });
}

/**
 * Exchange authorization code for tokens.
 * @param {string} code - authorization code from callback
 * @returns {object} tokens { access_token, refresh_token, expiry_date }
 */
async function exchangeCode(code) {
  const client = _createClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

/**
 * Get token file path for a tenant (or global).
 */
function _tokenPath(tenantId, audioDir) {
  if (tenantId && tenantId !== 'global') {
    const tenantDir = path.join(audioDir, 'tenants', tenantId);
    if (!fs.existsSync(tenantDir)) fs.mkdirSync(tenantDir, { recursive: true });
    return path.join(tenantDir, 'google-oauth-tokens.json');
  }
  return path.join(audioDir, 'google-oauth-tokens.json');
}

/**
 * Save tokens for a tenant.
 */
function saveTokens(tenantId, tokens, audioDir) {
  const filePath = _tokenPath(tenantId, audioDir);
  fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2));
  logger.info('Google OAuth tokens saved', { tenantId, filePath });
}

/**
 * Load tokens for a tenant.
 * @returns {object|null} tokens or null if not found
 */
function loadTokens(tenantId, audioDir) {
  const filePath = _tokenPath(tenantId, audioDir);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    logger.warn('Failed to load OAuth tokens', { tenantId, error: err.message });
  }
  return null;
}

/**
 * Delete tokens for a tenant (disconnect).
 */
function deleteTokens(tenantId, audioDir) {
  const filePath = _tokenPath(tenantId, audioDir);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    logger.info('Google OAuth tokens deleted', { tenantId });
  } catch (err) {
    logger.warn('Failed to delete OAuth tokens', { tenantId, error: err.message });
  }
}

/**
 * Create an authenticated OAuth2 client for a tenant.
 * Auto-refreshes tokens and saves updated tokens.
 * @param {string} tenantId
 * @param {string} audioDir
 * @returns {google.auth.OAuth2|null}
 */
function getAuthClient(tenantId, audioDir) {
  const tokens = loadTokens(tenantId, audioDir);
  if (!tokens) return null;

  const client = _createClient();
  client.setCredentials(tokens);

  // Auto-save refreshed tokens
  client.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    saveTokens(tenantId, merged, audioDir);
  });

  return client;
}

/**
 * Get a Google Calendar client for a tenant via OAuth.
 * @param {string} tenantId
 * @param {string} audioDir
 * @returns {{ calendar, auth }|null}
 */
function getCalendarClient(tenantId, audioDir) {
  const auth = getAuthClient(tenantId, audioDir);
  if (!auth) return null;
  return {
    calendar: google.calendar({ version: 'v3', auth }),
    auth,
  };
}

/**
 * Check if a tenant has connected their Google account.
 */
function isConnected(tenantId, audioDir) {
  return !!loadTokens(tenantId, audioDir);
}

module.exports = {
  init,
  isConfigured,
  getConsentUrl,
  exchangeCode,
  saveTokens,
  loadTokens,
  deleteTokens,
  getAuthClient,
  getCalendarClient,
  isConnected,
};
