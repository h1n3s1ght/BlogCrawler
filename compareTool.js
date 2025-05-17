// CompareTool.js
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const csv = require("csv-parser");
const { parse } = require("json2csv");

const csvDir = path.join(__dirname, "CSV Files");
const outputDir = path.join(__dirname, "Compared CSV");
const summaryDir = path.join(__dirname, "Comparison Summaries");

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
if (!fs.existsSync(summaryDir)) fs.mkdirSync(summaryDir);

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

function listCsvFiles() {
  return fs.readdirSync(csvDir)
    .filter(f => f.endsWith(".csv"))
    .map(f => ({
      name: f,
      fullPath: path.join(csvDir, f),
      time: fs.statSync(path.join(csvDir, f)).mtime.getTime(),
      isPreview: f.toLowerCase().includes("preview")
    }));
}

function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (data) => results.push(data))
      .on("end", () => resolve(results))
      .on("error", reject);
  });
}

function tokenize(title) {
  return title.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
}

function titlesAreSimilar(a, b) {
  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  const commonWords = wordsA.filter(word => wordsB.includes(word));
  const exactMatch = a.toLowerCase() === b.toLowerCase();
  const inRowMatch = wordsA.length >= 4 && wordsA.some((_, i) =>
    wordsA.slice(i, i + 4).join(" ") === wordsB.slice(i, i + 4).join(" ")
  );

  const lengthA = wordsA.length, lengthB = wordsB.length;
  const thresholdMatch =
    (lengthA >= 8 && lengthB >= 8 && commonWords.length >= 6) ||
    (lengthA >= 11 && lengthB >= 11 && commonWords.length >= 9) ||
    (lengthA >= 16 && lengthB >= 16 && commonWords.length >= 12);

  let reason = null;
  if (exactMatch) reason = "exact match";
  else if (inRowMatch) reason = "4 words in a row";
  else if (thresholdMatch) reason = `${commonWords.length} word threshold`;

  return reason;
}

async function selectFile(prompt, files) {
  console.log(prompt);
  files.forEach((f, i) => console.log(`${i + 1} - ${f.name}`));
  const index = parseInt(await ask("Choose a file number: ")) - 1;
  return files[index].fullPath;
}

(async () => {
  const allFiles = listCsvFiles();
  const previewFiles = allFiles.filter(f => f.isPreview).sort((a, b) => b.time - a.time);
  const nonPreviewFiles = allFiles.filter(f => !f.isPreview).sort((a, b) => b.time - a.time);

  if (previewFiles.length === 0 || nonPreviewFiles.length === 0) {
    console.error("❌ Make sure you have both 'preview' (new site) and non-preview (old site) CSVs.");
    process.exit(1);
  }

  const defaultNew = previewFiles[0];
  const defaultOld = nonPreviewFiles[0];

  console.log(`\n🆕 New Site CSV Default: ${defaultNew.name}`);
  console.log(`📜 Old Site CSV Default: ${defaultOld.name}`);

  const useDefault = (await ask("\nUse these files? (Enter to confirm, 'n' to select manually): ")) !== "n";

  let newSiteFile, oldSiteFile;
  if (useDefault) {
    newSiteFile = defaultNew.fullPath;
    oldSiteFile = defaultOld.fullPath;
  } else {
    newSiteFile = await selectFile("\n🆕 Select a New Site CSV:", previewFiles);
    oldSiteFile = await selectFile("\n📜 Select an Old Site CSV:", nonPreviewFiles);
  }

  const newData = await parseCSV(newSiteFile);
  const oldData = await parseCSV(oldSiteFile);

  const newTitles = newData.map(row => row.pagetitle.toLowerCase().trim());
  const oldTitles = oldData.map(row => row.pagetitle.toLowerCase().trim());

  const matchedTitles = [];
  const unmatchedTitles = [];

  for (const oldTitle of oldTitles) {
    let matched = false;
    for (const newTitle of newTitles) {
      const matchReason = titlesAreSimilar(oldTitle, newTitle);
      if (matchReason) {
        matchedTitles.push({ oldTitle, newTitle, reason: matchReason });
        matched = true;
        break;
      }
    }
    if (!matched) unmatchedTitles.push(oldTitle);
  }

  const newOnlyTitles = newTitles.filter(title =>
    !oldTitles.some(old => titlesAreSimilar(old, title))
  );

  const unmatchedRows = oldData.filter(row =>
    unmatchedTitles.includes(row.pagetitle.toLowerCase().trim())
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const csvFilename = `unmatched_oldsite_blogs_${timestamp}.csv`;
  const csvPath = path.join(outputDir, csvFilename);

  if (unmatchedRows.length > 0) {
    const output = parse(unmatchedRows, { fields: Object.keys(oldData[0]) });
    fs.writeFileSync(csvPath, output, "utf-8");
    console.log(`✅ Unmatched old site blogs written to: ${csvPath}`);
  } else {
    console.log("✅ All old site blog titles are present on the new site.");
  }

  console.log(`📊 Matched Titles: ${matchedTitles.length}`);
  console.log(`📄 Titles to Migrate: ${unmatchedTitles.length}`);
  console.log(`🆕 New Site Titles not found on Old Site: ${newOnlyTitles.length}`);

  const summaryLines = [
    `Comparison Summary - ${timestamp}`,
    "=========================================",
    `✅ Matched Titles (removed): ${matchedTitles.length}`,
    `❌ Unmatched Titles (to migrate): ${unmatchedTitles.length}`,
    `🆕 New Site Titles not found on Old Site: ${newOnlyTitles.length}`,
    "",
    "Matched Blog Titles:",
    "---------------------",
  ];

  for (const { oldTitle, newTitle, reason } of matchedTitles) {
    summaryLines.push(`"${oldTitle}" = "${newTitle}" ... These were found to be a match by "${reason}"`);
  }

  const summaryFilePath = path.join(summaryDir, csvFilename.replace(".csv", ".txt"));
  fs.writeFileSync(summaryFilePath, summaryLines.join("\n"), "utf-8");
  console.log(`📝 Summary written to: ${summaryFilePath}`);
})();
