// pm2 config for running the backend and the dashboard together:
//   pm2 start ecosystem.config.cjs
// Expects plaid-frontend checked out next to this repo (e.g. /home/childbold/plaid-backend
// and /home/childbold/plaid-frontend). Each app reads its own .env.
const path = require('node:path');

module.exports = {
  apps: [
    { name: 'plaid-backend',  cwd: __dirname,                                    script: 'src/server.js', node_args: '--env-file=.env' },
    { name: 'plaid-frontend', cwd: path.resolve(__dirname, '../plaid-frontend'), script: 'server.js',     node_args: '--env-file=.env' },
  ],
};
