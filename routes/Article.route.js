const express = require("express");

const router = express.Router();

const upload = require("../middleware/upload");
const uploadToCloudinary = require("../middleware/cloudinaryUpload");

const article = require("../controllers/Article.Controller");
const { verifyToken, authorize } = require("../middleware/auth");

router.post(
  "/",
  verifyToken,
  authorize("admin"),
  upload.single("hero_image"),
  uploadToCloudinary("fixer/articles"),
  article.createArticle,
);

// Public: published articles feed the blog
router.get("/published", article.getPublishedArticles);

router.get("/", verifyToken, authorize("admin"), article.getArticles);

router.get("/:slug", article.getArticle);

router.put(
  "/:id",
  verifyToken,
  authorize("admin"),
  upload.single("hero_image"),
  uploadToCloudinary("fixer/articles"),
  article.updateArticle,
);

router.delete("/:id", verifyToken, authorize("admin"), article.deleteArticle);

module.exports = router;
