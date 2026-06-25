// Hostname validation shared by the public proxy routes (src/index.js) and
// the v1 API (src/apiRoutes.js). Rejects scanner paths like /wp-login.php
// that the catch-all /:domain route would otherwise treat as domains.

const SAFE_DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*$/i;

// File / config extensions seen in bot scans — not ICANN-style TLDs.
const BLOCKED_FILE_EXTENSIONS = new Set([  
  'amplifyrc',
  'asc',
  'asp',
  'aspx',
  'backup',
  'bak',
  'bat',
  'boto',
  'c',
  'catchall',
  'cer',
  'cgi',
  'class',
  'conf',
  'config',
  'cpp',
  'crt',
  'cs',
  'csv',
  'der',
  'development',
  'dist',
  'dll',
  'doc',
  'docker',
  'dockerignore',
  'env',
  'env-example',
  'env-sample',
  'example',
  'exe',
  'git',
  'git-credentials',
  'git-secret',
  'gitattributes',
  'gitignore',
  'gitlab',
  'gitlab-ci',
  'gitmodules',
  'go',
  'h',
  'hcl',
  'hpp',
  'htaccess',
  'htpasswd',
  'htm',
  'html',
  'ini',
  'jar',
  'jks',
  'js',
  'json',
  'jsp',
  'key',
  'keystore',
  'live',
  'local',
  'lock',
  'log',
  'md',
  'microsoft',
  'npmrc',
  'old',
  'optional',
  'orig',
  'p12',
  'pem',
  'pfx',
  'pgp',
  'php',
  'php7',
  'php73',
  'php8',
  'ppt',
  'prod',
  'production',
  'project',
  'properties',
  'pypirc',
  'py',
  'qa',
  'rb',
  'rmafdq',
  'rtf',
  'sample',
  'save',
  's3cfg',
  'secret',
  'sh',
  'sql',
  'staging',
  'stripe',
  'sum',
  'sv',
  'svelte',
  'swp',
  'terraform',
  'test',
  'testing',
  'tf',
  'tfstate',
  'tfvars',
  'tmb',
  'tmp',
  'ts',
  'txt',
  'vue',
  'war',
  'well-known',
  'xls',
  'xml',
  'yaml',
  'yml',
  'zip',
]);

function hostnameSuffix(host) {
  const dot = host.lastIndexOf('.');
  if (dot <= 0 || dot === host.length - 1) return '';
  return host.slice(dot + 1).toLowerCase();
}

function isBlockedFileExtension(host) {
  const suffix = hostnameSuffix(host);
  if (!suffix) return true;
  if (BLOCKED_FILE_EXTENSIONS.has(suffix)) return true;
  // php variants: .php, .php7, .PhP8, .php_
  if (suffix.startsWith('php')) return true;
  return false;
}

function isValidHostname(host) {
  if (!host || typeof host !== 'string') return false;
  const normalized = host.toLowerCase();
  if (!normalized.includes('.')) return false;
  if (!SAFE_DOMAIN_RE.test(normalized)) return false;
  if (isBlockedFileExtension(normalized)) return false;
  return true;
}

/** Strip protocol/path from a bare domain or hostname fragment. */
function normalizeDomainInput(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const host = raw
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim()
    .toLowerCase();
  return host || null;
}

function extractDomainFromInput(raw) {
  const host = normalizeDomainInput(raw);
  if (!isValidHostname(host)) return null;
  return host;
}

function extractDomainFromUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!isValidHostname(host)) return null;
  return host;
}

module.exports = {
  SAFE_DOMAIN_RE,
  BLOCKED_FILE_EXTENSIONS,
  isValidHostname,
  isBlockedFileExtension,
  normalizeDomainInput,
  extractDomainFromInput,
  extractDomainFromUrl,
};
