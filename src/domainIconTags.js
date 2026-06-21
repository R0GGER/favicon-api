/**
 * Explicit domain → icon-tag (service slug) mappings.
 *
 * Used by service-icon fallbacks when scraping / external providers do not
 * yield a good favicon. Add one row per domain; iconTag must match a slug in
 * selfh.st / dashboardicons / lobehub (e.g. google-drive, microsoft-teams).
 *
 * Lookup runs before automatic rules in serviceSlugFromDomain.js.
 */
const DOMAIN_ICON_TAGS = [
  // Google Workspace
  { domain: 'drive.google.com', iconTag: 'google-drive' },
  { domain: 'docs.google.com', iconTag: 'google-docs' },
  { domain: 'sheets.google.com', iconTag: 'google-sheets' },
  { domain: 'slides.google.com', iconTag: 'google-slides' },
  { domain: 'mail.google.com', iconTag: 'gmail' },
  { domain: 'calendar.google.com', iconTag: 'google-calendar' },
  { domain: 'meet.google.com', iconTag: 'google-meet' },
  { domain: 'photos.google.com', iconTag: 'google-photos' },

  // Microsoft 365 (examples — extend as needed)
  { domain: 'outlook.office.com', iconTag: 'microsoft-outlook' },
  { domain: 'teams.microsoft.com', iconTag: 'microsoft-teams' },
  { domain: 'onedrive.live.com', iconTag: 'microsoft-onedrive' },
];

const DOMAIN_ICON_TAG_MAP = new Map(
  DOMAIN_ICON_TAGS.map(({ domain, iconTag }) => [domain.toLowerCase(), iconTag])
);

function iconTagForDomain(domain) {
  if (!domain || typeof domain !== 'string') return null;
  const key = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim().toLowerCase();
  return DOMAIN_ICON_TAG_MAP.get(key) || null;
}

function listDomainIconTags() {
  return DOMAIN_ICON_TAGS.map(({ domain, iconTag }) => ({ domain, iconTag }));
}

module.exports = {
  DOMAIN_ICON_TAGS,
  iconTagForDomain,
  listDomainIconTags,
};
