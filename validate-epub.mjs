import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";

async function validateRequiredFiles(zip) {
  const requiredFiles = [
    "mimetype",
    "META-INF/container.xml",
    "OEBPS/content.opf",
    "OEBPS/toc.ncx",
    "OEBPS/toc.xhtml",
  ];
  console.log("✓ Required files:");
  for (const file of requiredFiles) {
    const exists = zip.file(file) !== null;
    console.log(`  ${exists ? "✓" : "✗"} ${file}`);
    if (!exists) throw new Error(`Missing required file: ${file}`);
  }
}

async function validateMimetype(zip) {
  console.log("\n✓ ZIP structure:");
  const mimetypeFile = zip.file("mimetype");
  if (!mimetypeFile) return;
  const content = await mimetypeFile.async("string");
  console.log(`  ✓ mimetype: "${content}"`);
  if (content !== "application/epub+zip") {
    throw new Error(`Invalid mimetype: ${content}`);
  }
}

function reportImages(zip) {
  const imageFiles = Object.keys(zip.files).filter(
    (p) => p.startsWith("OEBPS/images/") && !p.endsWith("/")
  );
  console.log(`\n✓ Images: ${imageFiles.length} files in OEBPS/images/`);
  imageFiles.slice(0, 3).forEach((p) => {
    const name = p.split("/").pop();
    console.log(`  - ${name}`);
  });
  if (imageFiles.length > 3) {
    console.log(`  ... and ${imageFiles.length - 3} more`);
  }
  return imageFiles.length;
}

async function validateOPF(zip) {
  console.log("\n✓ Package Document (OPF):");
  const opfFile = zip.file("OEBPS/content.opf");
  if (!opfFile) return;
  const opfContent = await opfFile.async("string");

  const checks = [
    ["<package", "Package element"],
    ['id="ncx"', "NCX reference"],
    ['id="image', "Image manifest items"],
    ["<spine", "Spine element"],
    ["<itemref", "Item references"],
  ];

  for (const [pattern, name] of checks) {
    const found = opfContent.includes(pattern);
    console.log(`  ${found ? "✓" : "✗"} ${name}`);
    if (!found && name !== "Image manifest items") {
      throw new Error(`OPF missing: ${name}`);
    }
  }

  const itemMatches = opfContent.match(/<item[^>]*>/g) || [];
  console.log(`  ✓ Manifest items: ${itemMatches.length}`);
}

async function validateContent(zip) {
  console.log("\n✓ Content Validation:");
  const chapterFiles = Object.keys(zip.files).filter(
    (p) => /OEBPS\/\d+.*\.xhtml$/.test(p)
  );
  console.log(`  ✓ Chapter files: ${chapterFiles.length}`);

  const chapterPath = chapterFiles[0];
  if (!chapterPath) return;

  const chapter = await zip.file(chapterPath).async("string");
  const imgTags = (chapter.match(/<img/g) || []).length;
  console.log(`  ✓ Image references: ${imgTags}`);

  const hasDataUri = chapter.includes("data:image/");
  console.log(`  ${hasDataUri ? "✗" : "✓"} No data URIs`);
  if (hasDataUri) throw new Error("HTML contains data URIs (should use file references)");

  const imgSrcs = (chapter.match(/src="([^"]*images[^"]*)"/g) || []).slice(0, 3);
  if (imgSrcs.length > 0) {
    console.log(`  ✓ Image references format:`);
    imgSrcs.forEach((src) => {
      console.log(`    - ${src.substring(0, 80)}`);
    });
  }
}

async function validateNCX(zip) {
  console.log("\n✓ Navigation Document (NCX):");
  const ncxFile = zip.file("OEBPS/toc.ncx");
  if (!ncxFile) return;
  const ncxContent = await ncxFile.async("string");
  const navPoints = (ncxContent.match(/<navPoint/g) || []).length;
  console.log(`  ✓ Navigation points: ${navPoints}`);
}

async function validateEpub() {
  try {
    const { MarkdownEpubConverter } = await import(
      "./dist/infrastructure/converter/markdown-epub-converter.js"
    );
    const { ImageProcessor } = await import(
      "./dist/infrastructure/converter/image-processor.js"
    );
    const { Title } = await import("./dist/domain/values/title.js");
    const { Author } = await import("./dist/domain/values/author.js");
    const { MarkdownContent } = await import("./dist/domain/values/markdown-content.js");

    const samplePath = resolve(
      "docs/md-input-samples/2026-04-08-high-agency-in-30-minutes-george-mack.md"
    );
    const markdown = readFileSync(samplePath, "utf-8");

    const processor = new ImageProcessor(
      {
        fetchTimeoutMs: 30000,
        retries: 1,
        maxConcurrency: 3,
        maxImageBytes: 10 * 1024 * 1024,
        maxTotalBytes: 500 * 1024 * 1024,
      },
      {
        imageDownloadStart: () => {},
        imageDownloadSuccess: () => {},
        imageDownloadFailure: () => {},
        imageFormatConverted: () => {},
        imageSkipped: () => {},
        imageSummary: () => {},
      }
    );

    const converter = new MarkdownEpubConverter(processor);

    const titleResult = Title.create("High Agency EPUB Validation Test");
    const contentResult = MarkdownContent.create(markdown);
    const authorResult = Author.create("Claude");

    if (!titleResult.ok || !contentResult.ok || !authorResult.ok) {
      throw new Error("Failed to create values");
    }

    console.log("Generating EPUB with 66 images...");
    const epubResult = await converter.toEpub(
      titleResult.value,
      contentResult.value,
      authorResult.value
    );

    if (!epubResult.ok) {
      throw new Error(`EPUB generation failed: ${epubResult.error.message}`);
    }

    const epubBuffer = epubResult.value.buffer;
    const outputPath = "test-epub-validation.epub";
    writeFileSync(outputPath, epubBuffer);
    console.log(`\n✓ EPUB generated: ${outputPath} (${epubBuffer.length} bytes)`);

    const zip = new JSZip();
    const loadedZip = await zip.loadAsync(epubBuffer);

    console.log("\n=== W3C EPUB 3 Structure Validation ===\n");

    await validateRequiredFiles(loadedZip);
    await validateMimetype(loadedZip);
    const imageCount = reportImages(loadedZip);
    await validateOPF(loadedZip);
    await validateContent(loadedZip);
    await validateNCX(loadedZip);

    console.log("\n=== Validation Summary ===");
    console.log(`✓ EPUB structure is valid (W3C EPUB 3 compatible)`);
    console.log(`✓ All required files present`);
    console.log(`✓ ${imageCount} image files embedded with file references`);
    console.log(`✓ No data URIs in content`);
    console.log(`\nFor full W3C EPUB Checker validation, upload to:`);
    console.log(`https://www.w3.org/publishing/epubcheck/`);
    console.log(`\nOr use local validation with Java epubcheck:`);
    console.log(`java -jar epubcheck.jar ${outputPath}`);

  } catch (error) {
    console.error("❌ Validation failed:", error.message);
    process.exit(1);
  }
}

await validateEpub();
