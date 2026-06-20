#!/usr/bin/env node
const apiStore = require('../src/apiStore');

const VALID_PLANS = ['free', 'pro', 'enterprise'];

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
    'Usage:',
    '  node scripts/manage-keys.js create --label "customer A" --plan free|pro|enterprise',
    '  node scripts/manage-keys.js list [--all]',
    '  node scripts/manage-keys.js revoke --prefix fa_abcd1234',
    '  node scripts/manage-keys.js delete --prefix fa_abcd1234',
    '',
    'Notes:',
    '  - "list" shows only active keys by default; pass --all to include revoked ones.',
    '  - "revoke" marks the key as revoked but keeps it for audit history.',
    '  - "delete" permanently removes the key row and its usage counters.',
    '',
  ].join('\n');
  process.stdout.write(msg);
  process.exit(code);
}

function fmtCol(value, width) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}

function cmdCreate(args) {
  const plan = String(args.plan || 'free').toLowerCase();
  if (!VALID_PLANS.includes(plan)) {
    process.stderr.write(
      `Invalid plan "${plan}". Valid: ${VALID_PLANS.join(', ')}\n`
    );
    process.exit(1);
  }
  const label = args.label === true ? '' : String(args.label || '');
  const created = apiStore.createKey({ label, plan });

  process.stdout.write('New API key created.\n');
  process.stdout.write('  Label:        ' + (created.label || '(none)') + '\n');
  process.stdout.write('  Plan:         ' + created.plan + '\n');
  process.stdout.write(
    '  Monthly limit: ' +
      (created.monthlyLimit === 0 ? 'unlimited' : String(created.monthlyLimit)) +
      '\n'
  );
  process.stdout.write('  Prefix:       ' + created.prefix + '\n');
  process.stdout.write('\n');
  process.stdout.write('API key (store this NOW, it will not be shown again):\n');
  process.stdout.write('  ' + created.rawKey + '\n');
}

function cmdList(args) {
  const includeRevoked = args.all === true;
  const rows = apiStore.listKeys({ includeRevoked });
  if (rows.length === 0) {
    if (includeRevoked) {
      process.stdout.write('No API keys yet. Create one with: keys:create\n');
    } else {
      process.stdout.write(
        'No active API keys. Create one with: keys:create (or run with --all to also see revoked keys).\n'
      );
    }
    return;
  }
  const header =
    fmtCol('ID', 4) +
    fmtCol('PREFIX', 22) +
    fmtCol('PLAN', 12) +
    fmtCol('LIMIT', 10) +
    fmtCol('USED', 8) +
    fmtCol('STATUS', 10) +
    'LABEL';
  process.stdout.write(header + '\n');
  process.stdout.write('-'.repeat(header.length + 20) + '\n');
  for (const r of rows) {
    process.stdout.write(
      fmtCol(r.id, 4) +
        fmtCol(r.prefix, 22) +
        fmtCol(r.plan, 12) +
        fmtCol(r.monthlyLimit === 0 ? 'unlimited' : r.monthlyLimit, 10) +
        fmtCol(r.usageThisMonth, 8) +
        fmtCol(r.status, 10) +
        (r.label || '') +
        '\n'
    );
  }
}

function cmdRevoke(args) {
  const prefix = String(args.prefix || '').trim();
  if (!prefix) {
    process.stderr.write('Missing --prefix.\n');
    process.exit(1);
  }
  const changed = apiStore.revokeKey(prefix);
  if (changed === 0) {
    process.stderr.write('No active key found for prefix ' + prefix + '.\n');
    process.exit(1);
  }
  process.stdout.write('Revoked ' + changed + ' key(s) with prefix ' + prefix + '.\n');
}

function cmdDelete(args) {
  const prefix = String(args.prefix || '').trim();
  if (!prefix) {
    process.stderr.write('Missing --prefix.\n');
    process.exit(1);
  }
  const changed = apiStore.deleteKey(prefix);
  if (changed === 0) {
    process.stderr.write('No key found for prefix ' + prefix + '.\n');
    process.exit(1);
  }
  process.stdout.write(
    'Deleted ' + changed + ' key(s) with prefix ' + prefix + ' (usage history also removed).\n'
  );
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    usage(0);
  }
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);

  switch (cmd) {
    case 'create':
      cmdCreate(args);
      break;
    case 'list':
      cmdList(args);
      break;
    case 'revoke':
      cmdRevoke(args);
      break;
    case 'delete':
      cmdDelete(args);
      break;
    default:
      process.stderr.write('Unknown command: ' + cmd + '\n');
      usage(1);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write('Error: ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exit(1);
}
