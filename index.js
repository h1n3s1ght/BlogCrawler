// Blog Crawler/index.js
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const dayjs = require('dayjs');
const cliProgress = require('cli-progress');
const { createObjectCsvWriter } = require('csv-writer');

const blogIndexUrl = 'https://www.solveltd.com/blog';
const MAX_PAGES_TO_CRAWL = 10;

function extractRootDomain(url) {
  const hostname = new URL(url).hostname;
  const parts = hostname.split('.');
  const baseParts = parts.length > 2 ? parts.slice(1, -1) : parts.slice(0, -1);
  return baseParts.join('-');
}

async function extractBlogLinks(indexUrls) {
  const visited = new Set();
  const toVisit = [...indexUrls];
  const links = new Set();
  let pagesCrawled = 0;

  while (toVisit.length > 0 && pagesCrawled < MAX_PAGES_TO_CRAWL) {
    const currentUrl = toVisit.pop();
    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);
    pagesCrawled++;

    try {
      const res = await axios.get(currentUrl);
      const $ = cheerio.load(res.data);

      $('main a[href], #main a[href], article a[href], .post-list a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const fullUrl = new URL(href, currentUrl).toString();
        // Skip the index page itself
        if (fullUrl === blogIndexUrl || fullUrl === blogIndexUrl + '/') return;
        if (/\/blog\//.test(fullUrl)) links.add(fullUrl);
      });

      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && /page\/(\d+)/.test(href)) {
          const fullUrl = new URL(href, currentUrl).toString();
          if (!visited.has(fullUrl)) toVisit.push(fullUrl);
        }
      });
    } catch (e) {
      console.log(`⚠️ Failed to crawl page: ${currentUrl}`);
    }
  }

  return Array.from(links);
}

function extractHtmlContent($) {
  const contentSections = $('article, .content, .postcontent');
  if (!contentSections.length) return '';

  let html = '';
  contentSections.each((_, el) => {
    html += $(el).html();
  });

  return html.trim();
}

function extractFirstImageUrl($) {
  const firstImg = $('article img, .postcontent img, .content img').first();
  return firstImg.attr('src') || '';
}

function isNoIndexed($) {
  return $('meta[name="robots"]').attr('content')?.includes('noindex') || false;
}

async function parseBlogPage(url, retryCount = 0) {
  try {
    const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(res.data);

    const pagetitle = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim();
    const titletag = $('title').text().trim();
    const metadesc = $('meta[name="description"]').attr('content') || '';
    const publishdate =
      $('meta[property="article:published_time"]').attr('content') ||
      $('meta[name="pubdate"]').attr('content') ||
      $('time').first().attr('datetime') ||
      $('time').first().text().trim() || '';

    const imagefile = extractFirstImageUrl($);
    const slug = new URL(url).pathname.replace(/^\//, '');
    const pagedata = {
      title: pagetitle,
      'display-title': pagetitle,
      'article-author': '',
      'preview-image': { imagefile, alt: pagetitle },
      'hero-image': { imagefile, alt: pagetitle },
      content: extractHtmlContent($)
    };

    return {
      pageid: '',
      pageparent: 0,
      pagetitle,
      pagelive: 'live',
      pageintrash: 0,
      titletag,
      metadesc,
      publishdate,
      oldurl: url,
      pagedata: JSON.stringify(pagedata),
      post_type: 'post',
      published: 'yes',
      fix_images: 'TRUE',
      blogcategories: 'blog/category/general',
      tags: '',
      overrideurl: slug,
      noindex: isNoIndexed($) ? 'yes' : 'no'
    };
  } catch (err) {
    if (retryCount < 3) {
      console.warn(`⏳ Retry ${retryCount + 1}/3 for: ${url}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return parseBlogPage(url, retryCount + 1);
    }
    console.error(`❌ Failed to parse: ${url}`);
    return {
      pageid: '',
      pageparent: 0,
      pagetitle: '',
      pagelive: 'live',
      pageintrash: 0,
      titletag: '',
      metadesc: '',
      publishdate: '',
      oldurl: url,
      pagedata: '',
      post_type: 'post',
      published: 'no',
      fix_images: 'FALSE',
      blogcategories: '',
      tags: '',
      overrideurl: '',
      noindex: 'unknown'
    };
  }
}

async function runCrawler(indexUrl) {
  const blogUrls = await extractBlogLinks([indexUrl]);
  const uniqueUrls = Array.from(new Set(blogUrls)).sort();

  const records = [];
  const seenTitles = new Set();
  const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  bar.start(uniqueUrls.length, 0);

  for (let i = 0; i < uniqueUrls.length; i++) {
    const data = await parseBlogPage(uniqueUrls[i]);
    if (!seenTitles.has(data.pagetitle) && data.pagetitle) {
      seenTitles.add(data.pagetitle);
      records.push(data);
    }
    bar.update(i + 1);
  }

  bar.stop();

  const now = dayjs();
  const datePart = now.format('MM-DD-YY');
  const timePart = now.format('hh-mm-ss-A');
  const domainSlug = extractRootDomain(indexUrl);
  const fileName = `${domainSlug}_${datePart}_${timePart}_blogs.csv`;

  const outputDir = path.join(__dirname, 'CSV Files');
  await fs.ensureDir(outputDir);

  const csvWriter = createObjectCsvWriter({
    path: path.join(outputDir, fileName),
    header: [
      { id: 'pageid', title: 'pageid' },
      { id: 'pageparent', title: 'pageparent' },
      { id: 'pagetitle', title: 'pagetitle' },
      { id: 'pagelive', title: 'pagelive' },
      { id: 'pageintrash', title: 'pageintrash' },
      { id: 'titletag', title: 'titletag' },
      { id: 'metadesc', title: 'metadesc' },
      { id: 'publishdate', title: 'publishdate' },
      { id: 'oldurl', title: 'oldurl' },
      { id: 'pagedata', title: 'pagedata' },
      { id: 'post_type', title: 'post_type' },
      { id: 'published', title: 'published' },
      { id: 'fix_images', title: 'fix_images' },
      { id: 'blogcategories', title: 'blogcategories' },
      { id: 'tags', title: 'tags' },
      { id: 'overrideurl', title: 'overrideurl' },
      { id: 'noindex', title: 'noindex' }
    ]
  });

  await csvWriter.writeRecords(records);
  console.log(`✅ Done! ${records.length} blog posts saved to CSV.`);
}

runCrawler(blogIndexUrl);