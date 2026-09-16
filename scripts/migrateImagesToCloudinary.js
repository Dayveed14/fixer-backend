// One-time migration: uploads every file currently in ./uploads/articles to
// Cloudinary, then updates each article row whose hero_image matches that
// filename to point at the new Cloudinary secure_url instead.
//
// Run once, locally, after filling in the Cloudinary + DB values in .env:
//   node scripts/migrateImagesToCloudinary.js
//
// Safe to re-run: articles whose hero_image is already a full https:// URL
// are skipped.

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const db = require("../config/db");
const cloudinary = require("../config/cloudinary");

const UPLOADS_DIR = path.join(__dirname, "..", "uploads", "articles");

async function migrate() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    console.log("No uploads/articles folder found — nothing to migrate.");
    process.exit(0);
  }

  const files = fs.readdirSync(UPLOADS_DIR);

  if (files.length === 0) {
    console.log("uploads/articles is empty — nothing to migrate.");
    process.exit(0);
  }

  console.log(`Found ${files.length} file(s) to check.`);

  let migrated = 0;
  let skipped = 0;

  for (const filename of files) {
    try {
      const [rows] = await db.query(
        "SELECT id, hero_image FROM articles WHERE hero_image=?",
        [filename],
      );

      if (rows.length === 0) {
        console.log(`- ${filename}: no matching article row, skipping.`);
        skipped++;
        continue;
      }

      const filePath = path.join(UPLOADS_DIR, filename);

      const result = await cloudinary.uploader.upload(filePath, {
        folder: "fixer/articles",
        resource_type: "auto",
      });

      for (const row of rows) {
        await db.query("UPDATE articles SET hero_image=? WHERE id=?", [
          result.secure_url,
          row.id,
        ]);

        console.log(`- ${filename}: article #${row.id} -> ${result.secure_url}`);
        migrated++;
      }
    } catch (err) {
      console.error(`- ${filename}: FAILED —`, err.message);
    }
  }

  console.log(`\nDone. Migrated ${migrated}, skipped ${skipped}.`);
  process.exit(0);
}

migrate();
