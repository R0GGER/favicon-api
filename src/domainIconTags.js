/**
 * Explicit domain → icon-tag (service slug) mappings.
 *
 * An explicit mapping is authoritative: the HTML scraper prefers the branded
 * catalog icon (selfh.st / dashboardicons / svgl) over the site's own — often
 * generic — favicon. E.g. azure.microsoft.com serves the plain Microsoft logo,
 * but the microsoft-azure catalog icon is the real Azure logo. The one
 * exception is when the scrape already found a specific Google product logo
 * (gstatic productlogos), which is the exact, current brand icon and is kept.
 *
 * Add one row per domain; iconTag must match a slug in selfh.st /
 * dashboardicons / lobehub (e.g. google-drive, microsoft-teams).
 *
 * Optional `source` pins which catalog serves the icon. When set, that catalog
 * is tried first and the remaining catalogs act as fallback (so a missing match
 * never drops the branded override). When omitted, the default order
 * (selfhst → dashboardicons → svgl) is used. Valid values: 'selfhst',
 * 'dashboardicons', 'svgl'; any other value is ignored and the default order
 * applies.
 * 
 * Optional: 
 * { domain: 'azure.microsoft.com', iconTag: 'microsoft-azure', source: 'selfhst' }
 * source: selfhst, dashboardicons, svgl, lobehub
 *
 * Lookup runs before automatic rules in serviceSlugFromDomain.js.
 */
const DOMAIN_ICON_TAGS = [
  // Google Workspace
  { domain: 'google.com', iconTag: 'google', source: 'selfhst' },
  { domain: 'drive.google.com', iconTag: 'google-drive' },
  { domain: 'docs.google.com', iconTag: 'google-docs' },
  { domain: 'sheets.google.com', iconTag: 'google-sheets' },
  { domain: 'slides.google.com', iconTag: 'google-slides' },
  { domain: 'mail.google.com', iconTag: 'gmail' },
  { domain: 'calendar.google.com', iconTag: 'google-calendar' },
  { domain: 'meet.google.com', iconTag: 'google-meet' },
  { domain: 'photos.google.com', iconTag: 'google-photos' },

  // Microsoft 365 (examples — extend as needed)
  { domain: 'microsoft.com', iconTag: 'microsoft' },
  { domain: 'office.com', iconTag: 'microsoft-office' },
  { domain: 'outlook.office.com', iconTag: 'microsoft-outlook' },
  { domain: 'teams.microsoft.com', iconTag: 'microsoft-teams' },
  { domain: 'onedrive.live.com', iconTag: 'microsoft-onedrive' },
  { domain: 'excel.cloud.microsoft.com', iconTag: 'microsoft-excel' },
  { domain: 'excel.office.com', iconTag: 'microsoft-excel' },
  { domain: 'powerpoint.cloud.microsoft.com', iconTag: 'microsoft-powerpoint' },
  { domain: 'powerpoint.office.com', iconTag: 'microsoft-powerpoint' },
  { domain: 'word.cloud.microsoft.com', iconTag: 'microsoft-word' },
  { domain: 'word.office.com', iconTag: 'microsoft-word' },
  { domain: 'onenote.com', iconTag: 'microsoft-onenote' },
  { domain: 'onenote.office.com', iconTag: 'microsoft-onenote' },
  { domain: 'project.office.com', iconTag: 'microsoft-project' },
  { domain: 'forms.office.com', iconTag: 'microsoft-forms' },
  
  // Microsoft Admin
  { domain: 'azure.microsoft.com', iconTag: 'microsoft-azure' },
  { domain: 'intune.microsoft.com', iconTag: 'microsoft-intune' },

  // Ksuite
  { domain: 'calendar.infomaniak.com', iconTag: 'ksuite-calendar' },
  { domain: 'chk.infomaniak.com', iconTag: 'ksuite-chk' },
  { domain: 'contacts.infomaniak.com', iconTag: 'ksuite-contacts' },
  { domain: 'kchat.infomaniak.com', iconTag: 'ksuite-kchat' },
  { domain: 'drive.infomaniak.com', iconTag: 'ksuite-kdrive' },
  { domain: 'kmeet.infomaniak.com', iconTag: 'ksuite-kmeet' },
  { domain: 'mail.infomaniak.com', iconTag: 'ksuite-kmail' },
  { domain: 'kpaste.infomaniak.com', iconTag: 'ksuite-kpaste' },

  // Proton
  { domain: 'proton.me', iconTag: 'proton' },
  { domain: 'protonmail.com', iconTag: 'proton-mail' },
  { domain: 'protoncalendar.com', iconTag: 'proton-calendar' },
  { domain: 'protondrive.com', iconTag: 'proton-drive' },
  { domain: 'protoncontacts.com', iconTag: 'proton-contacts' },
  { domain: 'protonpass.com', iconTag: 'proton-pass' },

  // Email providers
  { domain: 'gmail.com', iconTag: 'gmail' },
  { domain: 'outlook.com', iconTag: 'outlook' },
  { domain: 'yahoo.com', iconTag: 'yahoo' },
  { domain: 'hotmail.com', iconTag: 'outlook' },
  { domain: 'live.com', iconTag: 'outlook' },

  // Amazon
  { domain: 'amazon.com', iconTag: 'amazon' },
  { domain: 'amazon.co.uk', iconTag: 'amazon' },
  { domain: 'amazon.de', iconTag: 'amazon' },
  { domain: 'amazon.fr', iconTag: 'amazon' },
  { domain: 'amazon.it', iconTag: 'amazon' },
  { domain: 'amazon.es', iconTag: 'amazon' },
  { domain: 'amazon.com.br', iconTag: 'amazon' },
  { domain: 'amazon.com.mx', iconTag: 'amazon' },
  { domain: 'amazon.com.au', iconTag: 'amazon' },

  // Albert Heijn
  { domain: 'ah.nl', iconTag: 'albert-heijn' },
  { domain: 'www.ah.nl', iconTag: 'albert-heijn' },  
  
  
];

function normalizeDomainKey(domain) {
  return domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim().toLowerCase();
}

const DOMAIN_ICON_TAG_MAP = new Map(
  DOMAIN_ICON_TAGS.map(({ domain, iconTag }) => [domain.toLowerCase(), iconTag])
);

const DOMAIN_ICON_SOURCE_MAP = new Map(
  DOMAIN_ICON_TAGS
    .filter(({ source }) => source)
    .map(({ domain, source }) => [domain.toLowerCase(), source.toLowerCase()])
);

function iconTagForDomain(domain) {
  if (!domain || typeof domain !== 'string') return null;
  return DOMAIN_ICON_TAG_MAP.get(normalizeDomainKey(domain)) || null;
}

function iconSourceForDomain(domain) {
  if (!domain || typeof domain !== 'string') return null;
  return DOMAIN_ICON_SOURCE_MAP.get(normalizeDomainKey(domain)) || null;
}

function listDomainIconTags() {
  return DOMAIN_ICON_TAGS.map(({ domain, iconTag, source }) =>
    source ? { domain, iconTag, source } : { domain, iconTag }
  );
}

module.exports = {
  DOMAIN_ICON_TAGS,
  iconTagForDomain,
  iconSourceForDomain,
  listDomainIconTags,
};
