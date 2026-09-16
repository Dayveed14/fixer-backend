const multer = require("multer");
const path = require("path");

// In-memory storage: multer just parses the multipart body into a buffer.
// The actual upload to Cloudinary happens in the cloudinaryUpload middleware
// that runs right after this one. Nothing touches disk.
const storage = multer.memoryStorage();

const allowedExt = /jpg|jpeg|png|webp|gif|mp4|mov|webm/;

const fileFilter = (req, file, cb) => {
  const ext = allowedExt.test(path.extname(file.originalname).toLowerCase());
  const mime = /^image\/|^video\//.test(file.mimetype);

  if (ext && mime) {
    cb(null, true);
  } else {
    cb(new Error("Only image or video files are allowed"));
  }
};

module.exports = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB — generous headroom for video
});
