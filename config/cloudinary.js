const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Cloudinary URLs look like:
//   https://res.cloudinary.com/<cloud>/image/upload/v169.../fixer/articles/abc123.jpg
// We only store the secure_url in the DB (no schema change needed), so when we
// need to delete an old asset we re-derive its public_id from the URL itself.
function getPublicIdFromUrl(url) {
  if (!url || typeof url !== "string") return null;

  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+$/);

  return match ? match[1] : null;
}

// Best-effort delete — never throws, just logs. A failed cleanup shouldn't
// turn a successful update/delete into a 500 for the user.
async function deleteAssetByUrl(url) {
  const publicId = getPublicIdFromUrl(url);

  if (!publicId) return;

  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
  } catch (err) {
    console.error("Cloudinary cleanup failed for", publicId, err.message);
  }
}

module.exports = cloudinary;
module.exports.getPublicIdFromUrl = getPublicIdFromUrl;
module.exports.deleteAssetByUrl = deleteAssetByUrl;
