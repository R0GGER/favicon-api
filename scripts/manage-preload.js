#!/usr/bin/env node
/**
 * Manage the preload domain list (see src/preloadStore.js).
 *
 * The list decides which domains `preload-top-sites.js --source db` warms, and
 * carries the per-domain icon overrides used at request time. CSV import/export
 * exists so the list can be bulk-edited in a spreadsheet while the database
 * stays the source of truth.
 */
const fs = require('fs');
const preloadStore = require('../src/preloadStore');
// Validation and CSV handling are shared with the web manager (src/adminRoutes.js)
// so both front ends apply the same rules to the same database.
const preloadAdmin = require('../src/preloadAdmin');
const { SERVICE_DOMAINS } = require('../src/serviceDomains');

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
    '  node scripts/manage-preload.js list [--all] [--disabled] [--failing] [--limit N]',
    '  node scripts/manage-preload.js add reddit.com [--rank 13] [--source traffic] [--icon-url URL]',
    '  node scripts/manage-preload.js enable ah.nl',
    '  node scripts/manage-preload.js disable ah.nl',
    '  node scripts/manage-preload.js set ah.nl [--icon-url URL] [--clear-icon-url] [--rank N]',
    '  node scripts/manage-preload.js remove ah.nl',
    '  node scripts/manage-preload.js block "*.gstatic.com" [--reason infra]',
    '  node scripts/manage-preload.js unblock "*.gstatic.com"',
    '  node scripts/manage-preload.js blocklist',
    '  node scripts/manage-preload.js seed-blocklist',
    '  node scripts/manage-preload.js import --file "export - preload_domains.csv"',
    '  node scripts/manage-preload.js export [--file out.csv] [--enabled-only]',
    '  node scripts/manage-preload.js recalc [--months 3]',
    '  node scripts/manage-preload.js stats',
    '',
    'Notes:',
    '  - "list" shows only enabled domains by default; --all includes disabled ones,',
    '    --disabled shows only those, --failing only domains with preload failures.',
    '  - "add", "enable", "disable" and "set" mark the row as manually managed, so',
    '    automated passes (hit counting, preload writeback) never flip it back.',
    '  - "block" patterns are an exact host or "*.example.com" (which also covers',
    '    the bare parent). Blocking disables any already-listed domain that matches,',
    '    and blocked domains are skipped on import, never created by the hit counter,',
    '    and never preloaded. Unblocking does not re-enable them; use "enable".',
    '  - "blocklist" shows the patterns; they are not part of "list", which only',
    '    shows the domain list itself.',
    '  - "import" reads domain, enabled, source, rank and alter_icon_url. The id and',
    '    last_* columns are ignored: domain is the key and the last_* values are',
    '    rewritten by the next preload run.',
    '  - "recalc" recomputes rank from the monthly hit buckets for every domain',
    '    whose rank is not pinned by hand. List position is stored separately and',
    '    is not mixed into rank. Run it from cron or just before a preload run.',
    '',
    `Database: ${preloadStore.DB_PATH} (override with PRELOAD_DB)`,
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

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

function requireDomain(args) {
  const domain = String(args._[0] || '').trim().toLowerCase();
  if (!domain) fail('Missing domain. See --help.');
  return domain;
}

function validateIconUrl(raw) {
  const parsed = preloadAdmin.parseIconUrl(raw);
  if (!parsed.ok) fail(parsed.error.replace('Icon URL', '--icon-url'));
  return parsed.href;
}

// --- commands ---------------------------------------------------------------

function cmdList(args) {
  const limit = args.limit === undefined || args.limit === true ? 0 : parseInt(args.limit, 10) || 0;
  const rows = preloadStore.listAll({
    includeDisabled: args.all === true,
    disabledOnly: args.disabled === true,
    failingOnly: args.failing === true,
    limit,
  });
  if (rows.length === 0) {
    process.stdout.write(
      'No matching domains. Add one with: node scripts/manage-preload.js add example.com\n'
    );
    return;
  }
  const header =
    fmtCol('ID', 6) +
    fmtCol('DOMAIN', 34) +
    fmtCol('RANK', 8) +
    fmtCol('EN', 4) +
    fmtCol('SOURCE', 10) +
    fmtCol('FAILS', 7) +
    fmtCol('LAST PRELOAD', 26) +
    'OVERRIDE';
  process.stdout.write(header + '\n');
  process.stdout.write('-'.repeat(header.length + 4) + '\n');
  for (const r of rows) {
    // A trailing * marks a row whose enabled state was set by hand.
    const enabledTag = `${r.enabled ? 'y' : 'n'}${r.enabledSource === 'manual' ? '*' : ''}`;
    process.stdout.write(
      fmtCol(r.id, 6) +
        fmtCol(r.domain, 34) +
        fmtCol(r.rank, 8) +
        fmtCol(enabledTag, 4) +
        fmtCol(r.source, 10) +
        fmtCol(r.failCount, 7) +
        fmtCol(r.lastPreloadedAt || '-', 26) +
        (r.alterIconUrl ? 'yes' : '') +
        '\n'
    );
  }
}

function cmdAdd(args) {
  const domain = requireDomain(args);
  if (preloadStore.isBlocked(domain)) {
    fail(`${domain} matches a blocklist pattern. Unblock it first.`);
  }
  const rank = args.rank === undefined || args.rank === true ? null : parseInt(args.rank, 10);
  if (rank !== null && !Number.isFinite(rank)) fail('--rank must be a number.');
  const source = args.source === undefined || args.source === true ? null : String(args.source);
  const iconUrl =
    args['icon-url'] === undefined || args['icon-url'] === true
      ? null
      : validateIconUrl(args['icon-url']);

  const changed = preloadStore.upsertManual({
    domain,
    rank,
    source: source || 'manual',
    iconUrl,
    enabled: true,
    lockRank: rank !== null,
  });
  if (changed === 0) fail(`Could not add ${domain}.`);
  process.stdout.write(`Added/updated ${domain}.\n`);
}

function cmdEnable(args) {
  const domain = requireDomain(args);
  if (preloadStore.isBlocked(domain)) {
    fail(`${domain} matches a blocklist pattern. Unblock it first (see: blocklist).`);
  }
  const changed = preloadStore.setEnabled(domain, true);
  if (changed === 0) fail(`No domain found for ${domain}.`);
  process.stdout.write(`Enabled ${domain}.\n`);
}

function cmdDisable(args) {
  const domain = requireDomain(args);
  const changed = preloadStore.setEnabled(domain, false);
  if (changed === 0) fail(`No domain found for ${domain}.`);
  process.stdout.write(`Disabled ${domain} (kept in the list, skipped by preload).\n`);
}

function cmdSet(args) {
  const domain = requireDomain(args);
  if (!preloadStore.getDomain(domain)) fail(`No domain found for ${domain}.`);

  let touched = false;
  if (args['clear-icon-url'] === true) {
    preloadStore.setIconUrl(domain, null);
    process.stdout.write(`Cleared icon override for ${domain}.\n`);
    touched = true;
  } else if (args['icon-url'] !== undefined && args['icon-url'] !== true) {
    const url = validateIconUrl(args['icon-url']);
    preloadStore.setIconUrl(domain, url);
    process.stdout.write(`Icon override for ${domain} set to ${url}.\n`);
    touched = true;
  }
  if (args.rank !== undefined && args.rank !== true) {
    const rank = parseInt(args.rank, 10);
    if (!Number.isFinite(rank)) fail('--rank must be a number.');
    preloadStore.setRank(domain, rank);
    process.stdout.write(`Rank for ${domain} set to ${rank}.\n`);
    touched = true;
  }
  if (!touched) fail('Nothing to set. Pass --icon-url, --clear-icon-url or --rank.');
}

function cmdRemove(args) {
  const domain = requireDomain(args);
  const changed = preloadStore.removeDomain(domain);
  if (changed === 0) fail(`No domain found for ${domain}.`);
  process.stdout.write(`Removed ${domain} (hit history also removed).\n`);
}

function cmdBlock(args) {
  const pattern = requireDomain(args);
  const reason = args.reason === undefined || args.reason === true ? null : String(args.reason);
  const { disabled } = preloadStore.addBlock(pattern, reason);
  process.stdout.write(`Blocked ${pattern}.\n`);
  if (disabled > 0) {
    process.stdout.write(
      `Disabled ${disabled} already-listed domain${disabled === 1 ? '' : 's'} matching it (see: list --disabled).\n`
    );
  }
}

function cmdUnblock(args) {
  const pattern = requireDomain(args);
  const changed = preloadStore.removeBlock(pattern);
  if (changed === 0) fail(`No blocklist entry for ${pattern}.`);
  process.stdout.write(`Unblocked ${pattern}.\n`);
}

function cmdBlocklist() {
  const rows = preloadStore.listBlocks();
  if (rows.length === 0) {
    process.stdout.write('Blocklist is empty. Seed the defaults with: seed-blocklist\n');
    return;
  }
  const header = fmtCol('PATTERN', 34) + 'REASON';
  process.stdout.write(header + '\n');
  process.stdout.write('-'.repeat(header.length + 10) + '\n');
  for (const r of rows) {
    process.stdout.write(fmtCol(r.pattern, 34) + (r.reason || '') + '\n');
  }
}

function cmdSeedBlocklist() {
  let added = 0;
  let disabled = 0;
  for (const domain of SERVICE_DOMAINS) {
    const result = preloadStore.addBlock(`*.${domain}`, 'service/infra domain');
    added += result.added;
    disabled += result.disabled;
  }
  process.stdout.write(`Seeded ${added} blocklist patterns from the built-in service-domain set.\n`);
  if (disabled > 0) {
    process.stdout.write(`Disabled ${disabled} already-listed domain${disabled === 1 ? '' : 's'} matching them.\n`);
  }
}

function cmdImport(args) {
  const file = args.file === undefined || args.file === true ? null : String(args.file);
  if (!file) fail('Missing --file PATH.');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(`Could not read ${file}: ${err.message}`);
  }

  const result = preloadAdmin.importCsv(text);
  if (result.total === 0) fail(`No rows found in ${file}.`);
  for (const domain of result.blocked) {
    process.stderr.write(`Skipped ${domain}: matches a blocklist pattern.\n`);
  }

  process.stdout.write(
    `imported ${result.imported}, skipped ${result.skipped} (blocked), invalid ${result.invalid}\n`
  );
}

function cmdExport(args) {
  const rows = preloadStore.listAll({ includeDisabled: args['enabled-only'] !== true });
  const csv = preloadAdmin.toCsv(rows);
  const file = args.file === undefined || args.file === true ? null : String(args.file);
  if (!file) {
    process.stdout.write(csv);
    return;
  }
  fs.writeFileSync(file, csv, 'utf8');
  process.stdout.write(`Exported ${rows.length} domains to ${file}.\n`);
}

function cmdRecalc(args) {
  const months =
    args.months === undefined || args.months === true
      ? preloadStore.RANK_MONTHS
      : parseInt(args.months, 10);
  if (!Number.isFinite(months) || months < 1) fail('--months must be 1 or higher.');
  const changed = preloadStore.recalcRanks({ months });
  process.stdout.write(`Recalculated rank for ${changed} domains (${months} month window).\n`);
}

function cmdStats() {
  const s = preloadStore.stats();
  process.stdout.write(`Database:  ${preloadStore.DB_PATH}\n`);
  process.stdout.write(`Domains:   ${s.total} (${s.enabled} enabled)\n`);
  process.stdout.write(`Overrides: ${s.overrides}\n`);
  process.stdout.write(`Blocklist: ${s.blocked} patterns\n`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    usage(0);
  }
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);

  switch (cmd) {
    case 'list':
      cmdList(args);
      break;
    case 'add':
      cmdAdd(args);
      break;
    case 'enable':
      cmdEnable(args);
      break;
    case 'disable':
      cmdDisable(args);
      break;
    case 'set':
      cmdSet(args);
      break;
    case 'remove':
      cmdRemove(args);
      break;
    case 'block':
      cmdBlock(args);
      break;
    case 'unblock':
      cmdUnblock(args);
      break;
    case 'blocklist':
      cmdBlocklist();
      break;
    case 'seed-blocklist':
      cmdSeedBlocklist();
      break;
    case 'import':
      cmdImport(args);
      break;
    case 'export':
      cmdExport(args);
      break;
    case 'recalc':
      cmdRecalc(args);
      break;
    case 'stats':
      cmdStats();
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
