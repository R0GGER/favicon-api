const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const { version: APP_VERSION } = require('../package.json');

const DOCS_CONTENT_DIR = path.join(__dirname, 'docs-content');
const README_PATH = path.join(DOCS_CONTENT_DIR, 'README.md');
const CHANGELOG_PATH = path.join(__dirname, '..', 'CHANGELOG.md');

/** URL slug → filename when they differ. */
const SLUG_ALIASES = {
  'custom-profile-urls': 'custom-profiles',
};

/** Primary Selfhosted nav — shown in the sidebar. */
const NAV_PAGES = [
  { slug: 'getting-started', title: 'Getting Started', label: 'Getting Started', file: 'getting-started.md' },
  { slug: 'tweaks', title: 'Tweaks', label: 'Tweaks', file: 'tweaks.md' },
  { slug: 'api-reference', title: 'API reference', label: 'API reference', file: 'api-reference.md' },
  { slug: `api-v1`, title: 'API v1', label: 'API v1', file: 'api-v1.md' },
  { slug: 'proxy', title: 'Proxy', label: 'Proxy', file: 'proxy.md' },
  { slug: 'tools', title: 'Tools', label: 'Tools', file: 'tools.md' },
  { slug: 'changelog', title: 'Changelog', label: 'Changelog', rootFile: CHANGELOG_PATH },
];

function slugify(text) {
  return String(text)
    .replace(/<[^>]+>/g, '')
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function resolveDocPath(slug) {
  const normalized = String(slug || '').trim().replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    return { filePath: README_PATH, slug: '', title: 'Overview' };
  }
  const resolvedSlug = SLUG_ALIASES[normalized] || normalized;
  if (!/^[a-z0-9-]+$/.test(resolvedSlug)) {
    return null;
  }
  const nav = NAV_PAGES.find((p) => p.slug === normalized || p.slug === resolvedSlug);
  if (nav?.rootFile) {
    if (!fs.existsSync(nav.rootFile)) {
      return null;
    }
    return { filePath: nav.rootFile, slug: normalized, title: nav.title };
  }
  const filePath = path.join(DOCS_CONTENT_DIR, `${resolvedSlug}.md`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const title = nav
    ? nav.title
    : normalized.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { filePath, slug: normalized, title };
}

function rewriteMarkdownLinks(markdown) {
  return markdown.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (match, text, href) => {
    if (/^(https?:|mailto:|#)/i.test(href)) {
      return match;
    }

    let newHref = href;

    if (/^\/faviconapi\/([a-z0-9-]+)(#.*)?$/i.test(href)) {
      const [, name, hashPart] = href.match(/^\/faviconapi\/([a-z0-9-]+)(#.*)?$/i);
      const slug = SLUG_ALIASES[name] || name;
      newHref = `/docs/${slug}${hashPart || ''}`;
    } else if (/^(?:\.\.\/)?README\.md(?:#(.*))?$/i.test(href) || /^overview\.md(?:#(.*))?$/i.test(href)) {
      const hash = href.includes('#') ? href.slice(href.indexOf('#')) : '';
      newHref = `/docs${hash}`;
    } else if (/^docs\/([a-z0-9-]+)\.md(?:#(.*))?$/i.test(href)) {
      const [, name, hashPart] = href.match(/^docs\/([a-z0-9-]+)\.md(?:#(.*))?$/i);
      newHref = `/docs/${SLUG_ALIASES[name] || name}${hashPart ? `#${hashPart}` : ''}`;
    } else if (/^([a-z0-9-]+)\.md(?:#(.*))?$/i.test(href)) {
      const [, name, hashPart] = href.match(/^([a-z0-9-]+)\.md(?:#(.*))?$/i);
      newHref = `/docs/${SLUG_ALIASES[name] || name}${hashPart ? `#${hashPart}` : ''}`;
    } else if (href === '.env.example') {
      newHref = 'https://github.com/R0GGER/maflplus-favicon-api/blob/main/.env.example';
    } else if (href.startsWith('docs/')) {
      newHref = `/docs/${href.slice(5).replace(/\.md(?=#|$)/, '')}`;
    }

    return `[${text}](${newHref})`;
  });
}

function extractHeadings(markdown) {
  const headings = [];
  for (const line of markdown.split('\n')) {
    const match = line.match(/^(#{2,3})\s+(.+)$/);
    if (!match) continue;
    const depth = match[1].length;
    const text = match[2]
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`/g, '')
      .replace(/\*\*/g, '')
      .trim();
    if (!text) continue;
    headings.push({ depth, text, id: slugify(text) });
  }
  return headings;
}

function buildTocHtml(headings, pageSlug) {
  if (!headings.length) {
    return '<p class="docs-toc-empty">No sections on this page.</p>';
  }

  const prefix = pageSlug ? `/docs/${pageSlug}` : '/docs';
  const items = headings
    .map(({ depth, text, id }) => {
      const cls = depth === 3 ? ' class="toc-h3"' : '';
      return `<li${cls}><a href="${prefix}#${id}">${escapeHtml(text)}</a></li>`;
    })
    .join('\n');

  return `<ul class="docs-toc-list">${items}</ul>`;
}

function buildNavHtml(activeSlug) {
  return NAV_PAGES.map(({ slug, label }) => {
    const href = slug ? `/docs/${slug}` : '/docs';
    const active = slug === activeSlug ? ' active' : '';
    return `<li><a href="${href}" class="docs-nav-link${active}">${escapeHtml(label)}</a></li>`;
  }).join('\n');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const BASE_KEYWORDS =
  'favicon api documentation, self-hosted favicon proxy, faviconapi docker, faviconapi configuration';

function stripMarkdownInline(text) {
  return String(text)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
}

function extractDescription(markdown) {
  const lines = markdown.split('\n');
  let seenTitle = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#\s+/.test(trimmed)) {
      seenTitle = true;
      continue;
    }
    if (!seenTitle) continue;
    if (!trimmed || trimmed === '---') continue;
    if (/^#{1,6}\s/.test(trimmed)) continue;
    if (/^[-*]\s/.test(trimmed)) continue;
    if (/^!\[/.test(trimmed)) continue;

    const description = stripMarkdownInline(trimmed);
    if (description) return description;
  }

  return 'Selfhosted documentation for FaviconAPI.';
}

function buildPageKeywords(title, slug) {
  const slugKeywords = slug ? slug.replace(/-/g, ' ') : 'overview';
  return `${BASE_KEYWORDS}, faviconapi ${slugKeywords}, ${title.toLowerCase()}`;
}

function buildJsonLd(title, description, canonicalPath) {
  const headline = `${title} \u2013 Selfhosted \u2013 FaviconAPI`;
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        headline,
        description,
        url: `__BASE_URL__${canonicalPath}`,
        image: '__BASE_URL__/logo.png',
        author: {
          '@type': 'Person',
          name: 'R0GGER',
          url: 'https://github.com/R0GGER',
        },
        isPartOf: {
          '@type': 'WebApplication',
          name: 'FaviconAPI',
          url: '__BASE_URL__/',
        },
        publisher: {
          '@type': 'Person',
          name: 'R0GGER',
        },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          {
            '@type': 'ListItem',
            position: 1,
            name: 'FaviconAPI',
            item: '__BASE_URL__/',
          },
          {
            '@type': 'ListItem',
            position: 2,
            name: 'Documentation',
            item: '__BASE_URL__/docs/getting-started',
          },
          {
            '@type': 'ListItem',
            position: 3,
            name: title,
            item: `__BASE_URL__${canonicalPath}`,
          },
        ],
      },
    ],
  };

  return JSON.stringify(data, null, 2);
}

marked.use({
  gfm: true,
  renderer: {
    heading(token) {
      const text = this.parser.parseInline(token.tokens);
      const id = slugify(text.replace(/<[^>]+>/g, ''));
      return `<h${token.depth} id="${id}">${text}</h${token.depth}>\n`;
    },
  },
});

function renderMarkdown(markdown) {
  return marked.parse(rewriteMarkdownLinks(markdown));
}

function stripMarkdownForSearch(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_#>|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSearchIndex() {
  const index = [];
  for (const page of NAV_PAGES) {
    const resolved = resolveDocPath(page.slug);
    if (!resolved) continue;
    let raw;
    try {
      raw = fs.readFileSync(resolved.filePath, 'utf8');
    } catch {
      continue;
    }

    const lines = raw.split('\n');
    let currentHeading = page.title;
    let currentId = '';
    let currentLines = [];
    let inCodeBlock = false;

    const flushSection = () => {
      const text = stripMarkdownForSearch(currentLines.join(' '));
      if (text || !currentId) {
        index.push({
          slug: page.slug,
          pageTitle: page.title,
          sectionId: currentId,
          sectionTitle: currentHeading,
          text: text.slice(0, 600),
        });
      }
      currentLines = [];
    };

    for (const line of lines) {
      if (line.trimStart().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        currentLines.push(line);
        continue;
      }
      if (inCodeBlock) {
        currentLines.push(line);
        continue;
      }
      const m = line.match(/^(#{1,3})\s+(.+)$/);
      if (m) {
        flushSection();
        const headingText = m[2]
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/[*_`]/g, '')
          .trim();
        currentHeading = headingText;
        currentId = slugify(headingText);
      } else {
        currentLines.push(line);
      }
    }
    flushSection();
  }
  return index;
}

function prepareMarkdown(markdown, slug) {
  if (!slug) {
    return markdown.replace(/^#\s+FaviconAPI\s*\n+/, '');
  }
  return markdown;
}

function renderDocPage(slug, template) {
  const resolved = resolveDocPath(slug);
  if (!resolved) {
    return null;
  }

  let markdown;
  try {
    markdown = fs.readFileSync(resolved.filePath, 'utf8');
  } catch {
    return null;
  }

  markdown = prepareMarkdown(markdown, resolved.slug);
  markdown = markdown.replace(/__VERSION__/g, APP_VERSION);
  const headings = extractHeadings(markdown);
  const contentHtml = renderMarkdown(markdown);
  const tocHtml = buildTocHtml(headings, resolved.slug);
  const navHtml = buildNavHtml(resolved.slug);
  const canonicalPath = resolved.slug ? `/docs/${resolved.slug}` : '/docs/getting-started';
  const description = extractDescription(markdown);
  const keywords = buildPageKeywords(resolved.title, resolved.slug);
  const jsonLd = buildJsonLd(resolved.title, description, canonicalPath);

  return template
    .replace(/__PAGE_TITLE__/g, escapeHtml(resolved.title))
    .replace(/__PAGE_DESCRIPTION__/g, escapeHtml(description))
    .replace(/__PAGE_KEYWORDS__/g, escapeHtml(keywords))
    .replace(/__JSON_LD__/g, jsonLd)
    .replace(/__CONTENT__/g, contentHtml)
    .replace(/__TOC__/g, tocHtml)
    .replace(/__NAV__/g, navHtml)
    .replace(/__CANONICAL_PATH__/g, canonicalPath);
}

module.exports = {
  NAV_PAGES,
  resolveDocPath,
  renderDocPage,
  buildSearchIndex,
};
