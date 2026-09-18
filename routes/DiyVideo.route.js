const express = require("express");

const router = express.Router();

const upload = require("../middleware/upload");
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

router.get("/:id", diyVideo.getVideo);

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
