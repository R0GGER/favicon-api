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
  if (cluster.isWorker) {
    // libvips sizes its thread pool to the core count in every process, so
    // N workers would otherwise run N x cores image threads on N cores.
    const share = Math.max(1, Math.floor(os.cpus().length / WORKERS));
    require('sharp').concurrency(parseInt(process.env.SHARP_CONCURRENCY || String(share), 10));
  }
  require('./index.js');
}
