module.exports = {
  drachtio: {
    host: process.env.DRACHTIO_HOST || '127.0.0.1',
    port: parseInt(process.env.DRACHTIO_PORT || '9022'),
    secret: process.env.DRACHTIO_SECRET || 'cymru'
  },
  freeswitch: {
    host: process.env.FREESWITCH_HOST || '127.0.0.1',
    port: parseInt(process.env.FREESWITCH_PORT || '8021'),
    secret: process.env.FREESWITCH_SECRET || 'ClueCon'
  },
  claude: {
    apiUrl: process.env.CLAUDE_API_URL || 'http://127.0.0.1:3334',
    sessionPrefix: process.env.SESSION_PREFIX || 'call-'
  },
  bargeIn: {
    enabled: process.env.BARGE_IN_ENABLED === 'true',
    vadThreshold: parseFloat(process.env.VAD_THRESHOLD || '0.5')
  },
  session: {
    lockRetryCount: parseInt(process.env.SESSION_LOCK_RETRY_COUNT || '3'),
    lockRetryDelayMs: parseInt(process.env.SESSION_LOCK_RETRY_DELAY_MS || '500')
  },
  healthPort: parseInt(process.env.HEALTH_PORT || '3100'),
  logLevel: process.env.LOG_LEVEL || 'info'
};
