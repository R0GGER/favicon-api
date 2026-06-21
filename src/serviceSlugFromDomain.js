const { iconTagForDomain, listDomainIconTags } = require('./domainIconTags');

const SERVICE_SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

// Parent labels where subdomains map to "{parent}-{subdomain}" service slugs
// (e.g. drive.google.com → google-drive) when not listed in domainIconTags.js.
const SUITE_PARENT_LABELS = new Set([
  'google',
  'microsoft',
  'amazon',
  'apple',
  'office',
  'live',
  'azure',
]);

function sanitizeLabel(label) {
  return label.replace(/[^a-z0-9._-]/g, '');
}

function serviceSlugFromDomainHeuristic(domain) {
  const labels = domain.toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) return null;

  const first = sanitizeLabel(labels[0]);
  if (!SERVICE_SLUG_RE.test(first)) return null;

  // Apex domain (example.com): first label is the service slug.
  if (labels.length === 2) return first;

  // Product subdomain (drive.google.com → google-drive).
  const parent = labels[1];
  if (SUITE_PARENT_LABELS.has(parent)) {
    const compound = sanitizeLabel(`${parent}-${first}`);
    if (SERVICE_SLUG_RE.test(compound)) return compound;
  }

  // Other subdomains: avoid ambiguous single-word slugs (e.g. "drive" → eu-drive).
  return null;
}

function serviceSlugFromDomain(domain) {
  const explicit = iconTagForDomain(domain);
  if (explicit && SERVICE_SLUG_RE.test(explicit)) return explicit;
  return serviceSlugFromDomainHeuristic(domain);
}

module.exports = {
  serviceSlugFromDomain,
  serviceSlugFromDomainHeuristic,
  listDomainIconTags,
  SERVICE_SLUG_RE,
};
