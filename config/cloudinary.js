const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Cloudinary URLs look like:
//   https://res.cloudinary.com/<cloud>/image/upload/v169.../fixer/articles/abc123.jpg
//   https://res.cloudinary.com/<cloud>/video/upload/v169.../fixer/diy/abc123.mp4
// We only store the secure_url in the DB (no separate public_id/resource_type
// columns), so when we need to delete an old asset we re-derive both from the
// URL itself.
function getPublicIdFromUrl(url) {
  if (!url || typeof url !== "string") return null;

  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+$/);

  return match ? match[1] : null;
}

function getResourceTypeFromUrl(url) {
  if (typeof url === "string" && url.includes("/video/upload/")) {
    return "video";
  }

  return "image";
}

// Best-effort delete — never throws, just logs. A failed cleanup shouldn't
// turn a successful update/delete into a 500 for the user.
async function deleteAssetByUrl(url) {
  const publicId = getPublicIdFromUrl(url);

  if (!publicId) return;

  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: getResourceTypeFromUrl(url),
    });
  } catch (err) {
    console.error("Cloudinary cleanup failed for", publicId, err.message);
  }
}

// Cloudinary can render any frame of a stored video as a still image just by
// requesting the same URL with an image extension — no separate upload or
// storage needed. Handy for list/thumbnail views of DIY videos.
function getVideoThumbnail(videoUrl) {
  if (!videoUrl || typeof videoUrl !== "string") return null;

  return videoUrl
    .replace("/video/upload/", "/video/upload/so_0/")
    .replace(/\.[a-zA-Z0-9]+$/, ".jpg");
}

module.exports = cloudinary;
module.exports.getPublicIdFromUrl = getPublicIdFromUrl;
module.exports.deleteAssetByUrl = deleteAssetByUrl;
module.exports.getVideoThumbnail = getVideoThumbnail;
