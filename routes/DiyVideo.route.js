const express = require("express");

const router = express.Router();

const upload = require("../middleware/upload");
const uploadToCloudinary = require("../middleware/cloudinaryUpload");

const diyVideo = require("../controllers/DiyVideo.Controller");

router.post(
  "/",
  upload.single("video"),
  uploadToCloudinary("fixer/diy"),
  diyVideo.createVideo,
);

router.get("/published", diyVideo.getPublishedVideos);

router.get("/", diyVideo.getVideos);

router.get("/:id", diyVideo.getVideo);

router.put(
  "/:id",
  upload.single("video"),
  uploadToCloudinary("fixer/diy"),
  diyVideo.updateVideo,
);

router.delete("/:id", diyVideo.deleteVideo);

module.exports = router;
