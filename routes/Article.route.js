const express = require("express");

const router = express.Router();

const upload = require("../middleware/upload");

const article = require("../controllers/Article.Controller");

router.post("/", upload.single("hero_image"), article.createArticle);

router.get("/published", article.getPublishedArticles);

router.get("/", article.getArticles);

router.get("/:id", article.getArticle);

router.put("/:id", upload.single("hero_image"), article.updateArticle);

router.delete("/:id", article.deleteArticle);

module.exports = router;
