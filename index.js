// Blog Crawler/index.js
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs-extra");
const path = require("path");
const dayjs = require("dayjs");
const cliProgress = require("cli-progress");
const { createObjectCsvWriter } = require("csv-writer");
const { wrapper } = require("axios-cookiejar-support");
const tough = require("tough-cookie");

const blogIndexUrl = "https://www.creativeresources.net/category/tech-blog";
// const blogIndexUrl = "https://creativeresources.preview.octanesites.com/blog";
const MAX_PAGES_TO_CRAWL = 10;

function extractRootDomain(url) {
  const hostname = new URL(url).hostname;
  const parts = hostname.split(".");
  const baseParts = parts.length > 2 ? parts.slice(1, -1) : parts.slice(0, -1);
  return baseParts.join("-");
}

async function extractAllNavLinksFromHomepage(homepageUrl) {
  try {
    const res = await axios.get(homepageUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const $ = cheerio.load(res.data);
    const navLinks = new Set();

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      try {
        const fullUrl = new URL(href, homepageUrl).toString().split("#")[0];
        navLinks.add(fullUrl);
      } catch (_) {}
    });

    return Array.from(navLinks);
  } catch (e) {
    console.warn(`⚠️ Failed to load homepage: ${homepageUrl}`);
    return [];
  }
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

    let res;

    try {
      if (currentUrl.includes(".preview.octanesites.com")) {
        const jar = new tough.CookieJar();
        const client = wrapper(axios.create({ jar }));
        const loginUrl = new URL(currentUrl).origin;

        await client.post(
          loginUrl,
          new URLSearchParams({ password: "takealook" }).toString(),
          {
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": "Mozilla/5.0",
            },
          }
        );

        res = await client.get(currentUrl);
        console.log(`🔓 Authenticated and loaded blog index: ${currentUrl}`);

        if (
          res.data.includes("Site Preview") &&
          res.data.includes("Password")
        ) {
          console.warn(
            `⚠️ Still seeing login page at index URL — may have failed auth: ${currentUrl}`
          );
        }
      } else {
        res = await axios.get(currentUrl, {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        console.log(`🌐 Publicly loaded blog index: ${currentUrl}`);
      }

      const $ = cheerio.load(res.data);

      $("a[href]").each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;

        const fullUrl = new URL(href, currentUrl).toString();
        if (fullUrl === blogIndexUrl || fullUrl === blogIndexUrl + "/") return;

        const isPaginationLink =
          /\?.*p=\d+/.test(href) || /\/blog\/page\/\d+\//.test(href);

        // Skip unwanted URLs unless they are pagination links
        if (
          fullUrl.includes("/category/") ||
          fullUrl.includes("/tag/") ||
          (/(\?.+)/.test(fullUrl) && !isPaginationLink)
        ) {
          return;
        }

        // Always enqueue pagination links
        if (isPaginationLink) {
          const pagedUrl = new URL(href, currentUrl).toString().split("#")[0];
          if (!visited.has(pagedUrl) && !toVisit.includes(pagedUrl)) {
            toVisit.push(pagedUrl);
          }
        }

        const isPreview = currentUrl.includes(".preview.octanesites.com");

        // Add valid blog post links
        if (isPreview) {
          if (/\/blog\//.test(fullUrl)) links.add(fullUrl);
        } else {
          if (
            !visited.has(fullUrl) &&
            !toVisit.includes(fullUrl) &&
            /^https?:\/\/.+\/.+/.test(fullUrl)
          ) {
            links.add(fullUrl);
          }
        }
      });
    } catch (e) {
      console.log(`⚠️ Failed to crawl page: ${currentUrl}`);
    }
  }

  return Array.from(links);
}

function extractHtmlContent($) {
  const contentSections = $("article, .content, .postcontent");
  if (!contentSections.length) return "";

  let html = "";
  contentSections.each((_, el) => {
    html += $(el).html();
  });

  return html.trim();
}

function extractFirstImageUrl($) {
  const firstImg = $("article img, .postcontent img, .content img").first();
  return firstImg.attr("src") || "";
}

function isNoIndexed($) {
  return $('meta[name="robots"]').attr("content")?.includes("noindex") || false;
}

async function parseBlogPage(url, retryCount = 0, bar) {
  try {
    let res;
    const isPreview = url.includes(".preview.octanesites.com");

    if (isPreview) {
      const jar = new tough.CookieJar();
      const client = wrapper(axios.create({ jar }));

      const loginUrl = new URL(url).origin;

      await client.post(
        loginUrl,
        new URLSearchParams({ password: "takealook" }).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0",
          },
        }
      );

      res = await client.get(url);
    } else {
      res = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    }

    const $ = cheerio.load(res.data);

    const pagetitle =
      $('meta[property="og:title"]').attr("content") ||
      $("h1").first().text().trim();
    const titletag = $("title").text().trim();
    const metadesc = $('meta[name="description"]').attr("content") || "";
    const publishdate =
      $('meta[property="article:published_time"]').attr("content") ||
      $('meta[name="pubdate"]').attr("content") ||
      $("time").first().attr("datetime") ||
      $("time").first().text().trim() ||
      "";

    const imagefile = extractFirstImageUrl($);
    const slug = new URL(url).pathname.replace(/^\//, "");
    const pagedata = {
      title: pagetitle,
      "display-title": pagetitle,
      "article-author": "",
      "preview-image": { imagefile, alt: pagetitle },
      "hero-image": { imagefile, alt: pagetitle },
      content: extractHtmlContent($),
    };

    return {
      pageid: "",
      pageparent: 0,
      pagetitle,
      pagelive: "live",
      pageintrash: 0,
      titletag,
      metadesc,
      publishdate,
      oldurl: url,
      pagedata: JSON.stringify(pagedata),
      post_type: "post",
      published: "yes",
      fix_images: "TRUE",
      blogcategories: "blog/category/general",
      tags: "",
      overrideurl: slug,
      noindex: isNoIndexed($) ? "yes" : "no",
    };
  } catch (err) {
    if (retryCount < 3) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return parseBlogPage(url, retryCount + 1);
    }

    return {
      pageid: "",
      pageparent: 0,
      pagetitle: "",
      pagelive: "live",
      pageintrash: 0,
      titletag: "",
      metadesc: "",
      publishdate: "",
      oldurl: url,
      pagedata: "",
      post_type: "post",
      published: "no",
      fix_images: "FALSE",
      blogcategories: "",
      tags: "",
      overrideurl: "",
      noindex: "unknown",
    };
  }
}

async function runCrawler(indexUrl) {
  const blogUrls = await extractBlogLinks([indexUrl]);
  const uniqueUrls = Array.from(new Set(blogUrls)).sort();

  // 🧠 Get homepage nav links to filter out nav/footer/sidebar items
  const homepageUrl = blogIndexUrl.includes(".preview.")
    ? blogIndexUrl.split("/blog")[0]
    : new URL(blogIndexUrl).origin;

  const navLinks = await extractAllNavLinksFromHomepage(homepageUrl);
  const navLinkSet = new Set(navLinks);

  // 🔍 Remove links that are also found on the homepage
  const filteredUrls = uniqueUrls.filter((url) => !navLinkSet.has(url));

  const records = [];
  const seenTitles = new Set();
  const bar = new cliProgress.SingleBar(
    {
      format:
        "Crawling [{bar}] {percentage}% | ETA: {eta_formatted} | {value}/{total}",
      formatValue: (v, _, type) => {
        if (type === "eta_formatted") {
          const minutes = Math.floor(v / 60);
          const seconds = Math.floor(v % 60);
          return `${minutes}m ${seconds}s`;
        }
        return v;
      },
    },
    cliProgress.Presets.shades_classic
  );

  bar.start(filteredUrls.length, 0);
  for (let i = 0; i < filteredUrls.length; i++) {
    const data = await parseBlogPage(filteredUrls[i], 0, bar);

    if (!seenTitles.has(data.pagetitle) && data.pagetitle) {
      seenTitles.add(data.pagetitle);
      records.push(data);
    }
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    bar.update(i + 1);
  }

  bar.stop();

  const now = dayjs();
  const datePart = now.format("MM-DD-YY");
  const timePart = now.format("hh-mm-ss-A");

  const isPreview = indexUrl.includes("preview");
  const hostname = new URL(indexUrl).hostname;

  let clientName;
  if (hostname.includes("preview.octanesites.com")) {
    // e.g., creativeagency.preview.octanesites.com → "creativeagency"
    clientName = hostname.split(".")[0];
  } else {
    // e.g., www.creativeresources.net → "creativeresources"
    clientName = hostname.replace("www.", "").split(".").slice(0, 1)[0];
  }

  const filePrefix = isPreview ? "preview-" : "";
  const fileName = `${filePrefix}${clientName}_${datePart}_${timePart}_blogs.csv`;

  const outputDir = path.join(__dirname, "CSV Files");
  await fs.ensureDir(outputDir);

  const csvWriter = createObjectCsvWriter({
    path: path.join(outputDir, fileName),
    header: [
      { id: "pageid", title: "pageid" },
      { id: "pageparent", title: "pageparent" },
      { id: "pagetitle", title: "pagetitle" },
      { id: "pagelive", title: "pagelive" },
      { id: "pageintrash", title: "pageintrash" },
      { id: "titletag", title: "titletag" },
      { id: "metadesc", title: "metadesc" },
      { id: "publishdate", title: "publishdate" },
      { id: "oldurl", title: "oldurl" },
      { id: "pagedata", title: "pagedata" },
      { id: "post_type", title: "post_type" },
      { id: "published", title: "published" },
      { id: "fix_images", title: "fix_images" },
      { id: "blogcategories", title: "blogcategories" },
      { id: "tags", title: "tags" },
      { id: "overrideurl", title: "overrideurl" },
      { id: "noindex", title: "noindex" },
    ],
  });

  await csvWriter.writeRecords(records);
  console.log(`✅ Done! ${records.length} blog posts saved to CSV.`);
}

runCrawler(blogIndexUrl);
