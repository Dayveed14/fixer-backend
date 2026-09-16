const cloudinary = require("../config/cloudinary");

// Wraps Cloudinary's upload_stream in a Promise so it can be awaited.
function streamUpload(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "auto" }, // "auto" lets Cloudinary handle both images and video
      (error, result) => {
        if (result) resolve(result);
        else reject(error);
      },
    );

    stream.end(buffer);
  });
}

// Usage: router.post("/", upload.single("hero_image"), uploadToCloudinary("fixer/articles"), controller.fn)
// Must run AFTER multer (memoryStorage) has put the file on req.file.buffer.
// On success, attaches req.file.cloudinaryUrl and req.file.cloudinaryPublicId.
const uploadToCloudinary = (folder) => async (req, res, next) => {
  if (!req.file) return next();

  try {
    const result = await streamUpload(req.file.buffer, folder);

    req.file.cloudinaryUrl = result.secure_url;
    req.file.cloudinaryPublicId = result.public_id;

    next();
  } catch (err) {
    console.error("Cloudinary upload failed:", err);
    res.status(500).json({ message: "Image upload failed" });
  }
};

module.exports = uploadToCloudinary;
