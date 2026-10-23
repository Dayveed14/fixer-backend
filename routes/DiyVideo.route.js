const express = require("express");

const router = express.Router();

const { videoUpload: upload } = require("../middleware/upload");
const uploadToCloudinary = require("../middleware/cloudinaryUpload");

const diyVideo = require("../controllers/DiyVideo.Controller");
const { verifyToken, authorize } = require("../middleware/auth");

router.post(
  "/",
  verifyToken,
  authorize("admin"),
  upload.single("video"),
  uploadToCloudinary("fixer/diy"),
  diyVideo.createVideo,
);

// Public: published DIY videos feed the help center
router.get("/published", diyVideo.getPublishedVideos);

router.get("/", verifyToken, authorize("admin"), diyVideo.getVideos);

// Admin: any status, by id or slug — for viewing and editing.
router.get(
  "/manage/:idOrSlug",
  verifyToken,
  authorize("admin"),
  diyVideo.getVideoForAdmin,
);

// Public: published only.
router.get("/:slug", diyVideo.getVideo);

router.put(
  "/:id",
  verifyToken,
  authorize("admin"),
  upload.single("video"),
  uploadToCloudinary("fixer/diy"),
  diyVideo.updateVideo,
);

router.delete("/:id", verifyToken, authorize("admin"), diyVideo.deleteVideo);

module.exports = router;
