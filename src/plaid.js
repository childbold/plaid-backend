import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { config } from './config.js';

if (!PlaidEnvironments[config.plaid.env]) {
  throw new Error(`PLAID_ENV must be one of: ${Object.keys(PlaidEnvironments).join(', ')}`);
}

export const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[config.plaid.env],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': config.plaid.clientId,
      'PLAID-SECRET': config.plaid.secret,
      'Plaid-Version': '2020-09-14',
    },
  },
}));

// Pull the useful part out of Plaid's axios errors without leaking request bodies/tokens.
export function plaidError(err) {
  const d = err?.response?.data;
  return d
    ? { error_code: d.error_code, error_type: d.error_type, message: d.error_message, request_id: d.request_id }
    : { message: err?.message || String(err) };
}
