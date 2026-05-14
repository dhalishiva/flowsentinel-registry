const crypto = require('crypto');

const HMAC_SECRET = process.env.LICENSE_HMAC_SECRET || 'PASTE_YOUR_SECRET_HERE';

const CONFIG = {
  customer_name:  'Test Organisation',
  license_type:   'trial',
  max_mailboxes:  5,
  duration_days:  3,
};

function toBase64Url(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function generate() {
  if (HMAC_SECRET === 'PASTE_YOUR_SECRET_HERE') {
    console.error('ERROR: Set your LICENSE_HMAC_SECRET before running.');
    process.exit(1);
  }

  const now     = new Date();
  const expires = new Date(now.getTime() + CONFIG.duration_days * 24 * 60 * 60 * 1000);

  const payload = {
    type:          CONFIG.license_type,
    max_mailboxes: CONFIG.max_mailboxes,
    issued_at:     now.toISOString(),
    expires_at:    expires.toISOString(),
  };

  const payloadJson = JSON.stringify(payload);
  const payloadB64  = toBase64Url(payloadJson);

  const sig = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(payloadB64)
    .digest('hex');

  // Combine with pipe separator (not in base64url alphabet)
  const combined = payloadB64 + '|' + sig;

  // Base64url encode the combined string for safe transport
  const encoded = toBase64Url(combined);

  // Format with dots every 6 chars for readability — dots are NOT in base64url
  // so we can safely strip them on the other side
  const chunks = encoded.match(/.{1,6}/g) || [];
  const key = 'FS.' + chunks.join('.');

  console.log('\n════════════════════════════════════════════════════');
  console.log('  FlowSentinel License Key');
  console.log('════════════════════════════════════════════════════');
  console.log(`  Customer:      ${CONFIG.customer_name}`);
  console.log(`  Type:          ${CONFIG.license_type}`);
  console.log(`  Max mailboxes: ${CONFIG.max_mailboxes}`);
  console.log(`  Issued:        ${now.toDateString()}`);
  console.log(`  Expires:       ${expires.toDateString()}`);
  console.log('────────────────────────────────────────────────────');
  console.log(`  KEY: ${key}`);
  console.log('════════════════════════════════════════════════════\n');
  console.log('Note: Key uses dots as separators. Copy the full key including dots.');
}

generate().catch(console.error);