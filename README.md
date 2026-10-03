# plaid-backend

One backend that owns your Plaid connections. Frontends call this API with their own keys and never see Plaid credentials or access tokens, so every app shares the same Items.

```
frontends ──(client API key)──▶ /api/*        read-only, served from SQLite
admin page ─(admin key)───────▶ /api/admin/*  link banks, sync, manage clients
Plaid ─────(signed webhooks)──▶ /webhooks/plaid
```

## Quick start (local, sandbox)

```bash
npm install
cp .env.example .env
npm run gen-key            # paste output into TOKEN_ENCRYPTION_KEY
openssl rand -base64 32    # paste into ADMIN_API_KEY
# fill in PLAID_CLIENT_ID and your sandbox PLAID_SECRET
npm run dev
```

Then either:

- **Browser:** open http://localhost:8080/admin, enter the admin key, click "Link a bank", and log in with `user_good` / `pass_good`.
- **No browser:** `npm run sandbox-item` creates a sandbox Item directly and runs the first sync. Pass an institution id to pick another bank, e.g. `npm run sandbox-item -- ins_109511`.

Create a key for each frontend from the admin page, or:

```bash
npm run create-client -- budget-app
```

## Docker (ZimaOS)

```bash
sudo mkdir -p /DATA/AppData/plaid-backend
sudo chown 1000:1000 /DATA/AppData/plaid-backend   # container runs as the non-root "node" user
docker compose up -d --build
docker compose logs -f
```

Run CLI scripts inside the container with `docker compose exec plaid-backend node scripts/create-client.js budget-app`.

## API

All requests need `Authorization: Bearer <key>` (or `X-API-Key`).

| Method | Path | Key | Notes |
|---|---|---|---|
| GET | `/api/institutions` | client | Linked banks, status, logo/colour, Plaid products, per-product sync status |
| GET | `/api/accounts` | client | Accounts with last-synced balances |
| GET | `/api/transactions` | client | `start`, `end` (YYYY-MM-DD), `account_id` (comma-separated), `pending`, `q`, `category` (comma-separated primary categories), `min_amount`, `max_amount`, `limit` (max 1000), `offset`. Includes logos, location, channel, counterparties |
| GET | `/api/balances/history` | client | One snapshot per account per day a sync ran. `start`, `end`, `account_id` |
| GET | `/api/liabilities` | client | Cards (APRs, minimum, due date, statement), mortgages, student loans |
| GET | `/api/holdings` | client | Holdings joined with their security |
| GET | `/api/investments/transactions` | client | Last 24 months of trades, dividends, fees. `start`, `end`, `account_id` |
| GET | `/api/recurring` | client | Subscriptions, bills and income streams Plaid detected |
| GET | `/api/identity` | client | Account owners: names, emails, phones, addresses |
| POST | `/api/admin/link/token` | admin | `{}` for a new bank, `{ "item_id": "…" }` for re-auth (update mode) |
| POST | `/api/admin/link/exchange` | admin | `{ public_token, institution }`, rejects duplicate banks |
| GET | `/api/admin/items` | admin | |
| POST | `/api/admin/items/:id/sync` | admin | |
| POST | `/api/admin/sync` | admin | Sync everything |
| DELETE | `/api/admin/items/:id` | admin | Calls `/item/remove` to free the slot |
| GET/POST/DELETE | `/api/admin/clients[/:id]` | admin | Create returns the key once; delete revokes |
| POST | `/webhooks/plaid` | Plaid JWT | Signature verified |
| GET | `/healthz` | none | |

Amounts follow Plaid's convention: positive means money left the account.

### Frontend example

```js
const res = await fetch('https://pi-or-zima.your-tailnet.ts.net/api/transactions?start=2026-09-01', {
  headers: { Authorization: `Bearer ${import.meta.env.VITE_PLAID_API_KEY}` },
});
const { transactions } = await res.json();
```

Browser frontends on a different origin must be listed in `CORS_ORIGINS`. Server-side frontends don't need CORS.

## What gets pulled

Every sync fetches accounts and transactions, then each product in `PLAID_EXTRA_PRODUCTS` (default `liabilities,investments,identity,recurring`) on its own, so one the bank doesn't offer never blocks the rest. The result for each lands in `product_status` on `/api/institutions` and on the admin page:

- `ok`: synced
- `unsupported`: the bank doesn't offer it
- `consent_required`: the Item was linked without it. Click **Grant access** on the admin page to approve it in Link (update mode with `additional_consented_products`)
- `pending`: Plaid is still preparing it
- `error`: something went wrong; see the logs

New links request the extras through `required_if_supported_products`, so they don't hide banks that lack them. In production each of these products is billed per Item; trim `PLAID_EXTRA_PRODUCTS` to what you use. Auth (account and routing numbers) is not pulled, so the read API never exposes them.

## Syncing and webhooks

Data refreshes three ways: on link, every `SYNC_INTERVAL_MINUTES`, and when Plaid sends a new-data webhook (transactions, recurring, holdings, investment transactions or liabilities). Webhooks only arrive if `PLAID_WEBHOOK_URL` is a public HTTPS URL (Tailscale Funnel on the `/webhooks/plaid` path works). Without one, the scheduled sync covers you.

In sandbox, you can trigger a webhook on demand with Plaid's `/sandbox/item/fire_webhook`.

## Security notes

- Keep this on your tailnet. Only expose `/webhooks/plaid` publicly if you use webhooks.
- `TOKEN_ENCRYPTION_KEY` encrypts access tokens at rest. Back it up separately from the database. Losing it means re-linking every bank.
- Back up `/data/plaid.db` (WAL mode, so copy `plaid.db*` or use `sqlite3 plaid.db ".backup out.db"`).
- Client keys are stored as SHA-256 hashes and can be revoked individually.

## Moving to production

`.env.example` is already set to `PLAID_ENV=production` with no extra products. Put your production secret in `.env` and link real banks from the admin page. To go back to fake test banks, set `PLAID_ENV=sandbox` with the sandbox secret.

1. Set `PLAID_ENV=production` and swap in the production secret.
2. Set `PLAID_REDIRECT_URI` to an HTTPS URL registered in the Plaid dashboard (needed for OAuth banks).
3. Start with a fresh database. Sandbox Items don't carry over.
4. Link each real bank once. Re-auth with the "Re-auth" button rather than linking again.
