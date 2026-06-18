const cluster = require('cluster');
const os = require('os');

const WORKERS = parseInt(process.env.WORKERS || String(os.cpus().length), 10);

if (cluster.isPrimary && WORKERS > 1) {
  console.log(`Master ${process.pid} spawning ${WORKERS} workers`);
  for (let i = 0; i < WORKERS; i++) cluster.fork();
  cluster.on('exit', (worker, code, signal) => {
    console.warn(
      `Worker ${worker.process.pid} died (code=${code}, signal=${signal}); respawning`
    );
    cluster.fork();
  });
} else {
  require('./index.js');
}
