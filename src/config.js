function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const list = (v, fallback) => (v || fallback).split(',').map(s => s.trim()).filter(Boolean);

export const config = {
  port: Number(process.env.PORT || 7600),
  dbPath: process.env.DB_PATH || './data/plaid.db',
  adminApiKey: required('ADMIN_API_KEY'),
  encryptionKey: required('TOKEN_ENCRYPTION_KEY'),
  corsOrigins: list(process.env.CORS_ORIGINS, ''),
  syncIntervalMinutes: Number(process.env.SYNC_INTERVAL_MINUTES ?? 60),
  plaid: {
    clientId: required('PLAID_CLIENT_ID'),
    secret: required('PLAID_SECRET'),
    env: process.env.PLAID_ENV || 'production',
    products: list(process.env.PLAID_PRODUCTS, 'transactions'),
    // Pulled on every sync when the bank supports them. "recurring" is /transactions/recurring/get;
    // the rest are also requested at Link via required_if_supported_products.
    // Unset: all four. Set but empty (PLAID_EXTRA_PRODUCTS=): transactions only.
    extraProducts: process.env.PLAID_EXTRA_PRODUCTS === undefined
      ? ['liabilities', 'investments', 'identity', 'recurring']
      : list(process.env.PLAID_EXTRA_PRODUCTS, ''),
    countryCodes: list(process.env.PLAID_COUNTRY_CODES, 'US'),
    webhookUrl: process.env.PLAID_WEBHOOK_URL || undefined,
    redirectUri: process.env.PLAID_REDIRECT_URI || undefined,
  },
};

if (config.adminApiKey.length < 24) throw new Error('ADMIN_API_KEY should be at least 24 characters');
