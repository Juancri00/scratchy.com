'use strict';

const http = require('node:http');
const { loadConfig } = require('./config');
const { openStore } = require('./store');
const { createApp } = require('./app');

function start(env = process.env) {
  const config = loadConfig(env);
  const store = openStore(config.dataDir);
  const server = http.createServer(createApp({ config, store }));
  server.headersTimeout = 15000;
  server.requestTimeout = 20000;
  return { config, store, server };
}

if (require.main === module) {
  let app;
  try {
    app = start();
  } catch (err) {
    console.error(`Startup failed: ${err.message}`);
    process.exit(1);
  }
  const { config, store, server } = app;
  server.listen(config.port, config.host, () => {
    console.log(`Otter Trivia running on http://localhost:${config.port}  (data: ${config.dataDir})`);
    if (config.generatedPassword) console.log(`No ADMIN_PASSWORD set. Temporary admin password for this run: ${config.adminPassword}`);
    if (config.generatedSecret) console.log('No SESSION_SECRET set: admin logins reset when the server restarts.');
    if (!config.publicUrl) console.log('PUBLIC_URL not set: the booth QR code will use the address you open the admin page from.');
  });
  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { start };
