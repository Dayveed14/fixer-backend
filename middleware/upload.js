const multer = require("multer");
const path = require("path");

// In-memory storage: multer just parses the multipart body into a buffer.
// The actual upload to Cloudinary happens in the cloudinaryUpload middleware
// that runs right after this one. Nothing touches disk.
const storage = multer.memoryStorage();

// Raster images only — SVG is excluded because it can carry scripts.
const IMAGE_TYPES = {
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".png": ["image/png"],
  ".webp": ["image/webp"],
  ".gif": ["image/gif"],
};

const VIDEO_TYPES = {
  ".mp4": ["video/mp4"],
  ".mov": ["video/quicktime"],
  ".webm": ["video/webm"],
};

function typeError(message) {
  const err = new Error(message);
  err.code = "INVALID_FILE_TYPE";
  return err;
}

// Both the extension and the declared type must match an allowed pair.
function filterFor(types, message) {
  return (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const allowed = Object.prototype.hasOwnProperty.call(types, ext) ? types[ext] : null;
    if (allowed && allowed.includes(file.mimetype)) return cb(null, true);
    return cb(typeError(message));
  };
}

const MB = 1024 * 1024;

const imageUpload = multer({
  storage,
  fileFilter: filterFor(IMAGE_TYPES, "Only JPG, PNG, WebP or GIF images are allowed."),
  limits: { fileSize: 10 * MB, files: 1 },
});

const videoUpload = multer({
  storage,
  fileFilter: filterFor(VIDEO_TYPES, "Only MP4, MOV or WebM videos are allowed."),
  limits: { fileSize: 150 * MB, files: 1 },
});

// Default export kept for any older import: images *or* videos.
const anyMedia = multer({
  storage,
  fileFilter: filterFor({ ...IMAGE_TYPES, ...VIDEO_TYPES }, "Only image or video files are allowed."),
  limits: { fileSize: 150 * MB, files: 1 },
});

module.exports = anyMedia;
module.exports.imageUpload = imageUpload;
module.exports.videoUpload = videoUpload;
module.exports.IMAGE_TYPES = IMAGE_TYPES;
module.exports.VIDEO_TYPES = VIDEO_TYPES;
