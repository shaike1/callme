const Srf = require('drachtio-srf');
const srf = new Srf();

console.log('✓ SRF created');

srf.connect({
  host: 'drachtio',
  port: 9022,
  secret: 'cymru'
});

console.log('✓ srf.connect() called');

srf.on('connect', (err, hostport) => {
  if (err) {
    console.error('✗ Connect error:', err.message);
    process.exit(1);
  }
  console.log('✓ Connected to drachtio at', hostport);
  process.exit(0);
});

srf.on('error', (err) => {
  console.error('✗ SRF error:', err.message);
});

setTimeout(() => {
  console.error('✗ Timeout - no connection after 10s');
  process.exit(1);
}, 10000);
