#!/usr/bin/env node
/**
 * Generate the credentials for the /admin preload manager (see src/adminAuth.js).
 *
 * Two steps, in this order:
 *   1. `secret` prints a random 512-bit key for ADMIN_SESSION_SECRET. It signs
 *      the session cookie handed out after a successful sign-in.
 *   2. `password` hashes a password with scrypt and prints the ADMIN_USER and
 *      ADMIN_PASSWORD_HASH lines to put in .env. Those are what you type into
 *      the login form.
 *
 * /admin returns 404 until both are configured.
 */
const crypto = require('crypto');
const readline = require('readline');
const { Writable } = require('stream');
const adminAuth = require('../src/adminAuth');

// 512 bits, always: it is the strongest of the two algorithms the server
// accepts, and there is no reason to hand an operator a weaker choice.
const SECRET_BITS = 512;
const MIN_PASSWORD_LENGTH = 10;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function usage(code = 0) {
  const msg = [
    'Usage (run these inside the container so the CLI sees the same env):',
    '  docker compose exec favicon-api npm run admin:secret',
    '  docker compose exec favicon-api npm run admin:password -- [--user name]',
    '  docker compose exec favicon-api npm run admin:status',
    '',
    'Commands:',
    `  secret    Print a random ${SECRET_BITS}-bit key to put in ${adminAuth.SECRET_VAR}.`,
    '            It signs the session cookie; it is not a password.',
    '  password  Ask for a password twice (nothing is echoed) and print the',
    '            ADMIN_USER / ADMIN_PASSWORD_HASH lines for your .env. --user sets',
    `            the login name (default: ${adminAuth.ADMIN_USER}), and the password needs`,
    `            ${MIN_PASSWORD_LENGTH} characters or more. Piped stdin is read as the`,
    '            password, skipping the confirmation prompt.',
    '  status    Show whether the admin manager is enabled and how it is configured.',
    '',
    'Notes:',
    '  - Both values must be readable by the server process, so put them in .env and',
    '    restart the container. Generating them inside the container also means',
    '    neither touches your shell history on the host.',
    '  - Only the hash goes in .env; the password itself is never stored. Rotating',
    `    ${adminAuth.SECRET_VAR} signs everyone out at once.`,
    `  - ${adminAuth.LEGACY_SECRET_VAR} is the legacy name of the same key. It still`,
    '    works, with a deprecation warning at startup.',
    '',
  ].join('\n');
  process.stdout.write(msg);
  process.exit(code);
}

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

function cmdSecret() {
  const secret = crypto.randomBytes(SECRET_BITS / 8).toString('hex');
  process.stdout.write(`# ${SECRET_BITS}-bit secret (HS512). Add this line to your .env:\n`);
  process.stdout.write(`${adminAuth.SECRET_VAR}=${secret}\n`);
}

/** Ask on the terminal without echoing what is typed. */
function promptHidden(question) {
  return new Promise((resolve) => {
    const sink = new Writable({
      write(chunk, encoding, done) {
        if (!sink.muted) process.stdout.write(chunk, encoding);
        done();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: sink, terminal: true });
    process.stdout.write(question);
    sink.muted = true;
    rl.question('', (answer) => {
      sink.muted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

/** Read the password from piped stdin, so the command also works unattended. */
function readPipedPassword() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data.replace(/\r?\n[\s\S]*$/, '')));
  });
}

async function cmdPassword(args) {
  const user = args.user === undefined || args.user === true ? adminAuth.ADMIN_USER : String(args.user).trim();
  if (!user) fail('--user cannot be empty.');

  let password;
  if (process.stdin.isTTY) {
    password = await promptHidden(`Password for "${user}": `);
    const again = await promptHidden('Repeat password: ');
    if (password !== again) fail('The two passwords do not match. Nothing was written.');
  } else {
    password = await readPipedPassword();
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`The password must be at least ${MIN_PASSWORD_LENGTH} characters (got ${password.length}).`);
  }

  const hash = adminAuth.hashPassword(password);
  process.stdout.write(`# scrypt hash for "${user}". Add these lines to your .env and restart:\n`);
  process.stdout.write(`ADMIN_USER=${user}\n`);
  process.stdout.write(`ADMIN_PASSWORD_HASH=${hash}\n`);
}

function formatDuration(seconds) {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function cmdStatus() {
  const key = adminAuth.getSecret();
  const creds = adminAuth.getCredentials();

  if (!key || !creds) {
    process.stdout.write('Admin manager: disabled. /admin returns 404 until both are configured.\n');
    process.stdout.write(
      `  ${adminAuth.SECRET_VAR}: ${key ? `set (${key.length} bytes)` : 'not set, or shorter than 32 bytes'}\n`
    );
    process.stdout.write(`  ADMIN_PASSWORD_HASH:  ${creds ? 'set' : 'not set, or not a valid scrypt hash'}\n`);
    return;
  }

  const source = adminAuth.secretSource();
  const deprecated = source === adminAuth.LEGACY_SECRET_VAR ? ` [deprecated name, rename to ${adminAuth.SECRET_VAR}]` : '';

  const { N, r, p } = creds.params;
  process.stdout.write('Admin manager: enabled.\n');
  process.stdout.write(`Username:      ${creds.user}\n`);
  process.stdout.write(`Password:      scrypt (N=${N}, r=${r}, p=${p})\n`);
  process.stdout.write(`Secret:        ${key.length} bytes (${key.length * 8} bits) from ${source}${deprecated}\n`);
  process.stdout.write(`Signing alg:   ${adminAuth.defaultAlg()} (HS256 and HS512 are both accepted)\n`);
  process.stdout.write(`Idle timeout:  ${formatDuration(adminAuth.SESSION_TTL)}\n`);
  process.stdout.write(`Remembered:    ${formatDuration(adminAuth.REMEMBER_TTL)}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    usage(0);
  }
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);

  switch (cmd) {
    case 'secret':
      cmdSecret();
      break;
    case 'password':
      await cmdPassword(args);
      break;
    case 'status':
      cmdStatus();
      break;
    default:
      process.stderr.write('Unknown command: ' + cmd + '\n');
      usage(1);
  }
}

main().catch((err) => {
  process.stderr.write('Error: ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exit(1);
});
