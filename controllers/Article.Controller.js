const db = require("../config/db");
const { deleteAssetByUrl } = require("../config/cloudinary");
const { publishable } = require("../utils/validate");

// Removes a just-uploaded file when the request is rejected afterwards,
// so failed saves don't leave orphans in Cloudinary.
async function discardUpload(req) {
  if (!req.file?.cloudinaryUrl) return;
  try {
    await deleteAssetByUrl(req.file.cloudinaryUrl);
  } catch (err) {
    console.error("Failed to remove rejected upload:", err.message);
  }
}

exports.createArticle = async (req, res) => {
  try {
    const { problem, values } = publishable(req.body);
    if (problem) {
      await discardUpload(req);
      return res.status(400).json({ message: problem });
    }

    const { title, slug, excerpt, content, category, tags, featured, status, image_alt } = values;
    const author_id = req.user.id;

    const hero_image = req.file ? req.file.cloudinaryUrl : null;

    const sql = `
    INSERT INTO articles
    (
    title,
    slug,
    excerpt,
    content,
    hero_image,
    category,
    tags,
    featured,
    status,
    author_id,
    image_alt
    )

    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `;

    await db.query(sql, [
      title,
      slug,
      excerpt,
      content,
      hero_image,
      category,
      tags,
      featured,
      status,
      author_id,
      image_alt,
    ]);

    res.status(201).json({
      message: "Article created.",
      slug,
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      await discardUpload(req);
      return res.status(409).json({ message: "An article with this slug already exists." });
    }
    console.log(err);

    res.status(500).json({
      message: "Server Error",
    });
  }
};

exports.getArticles = async (req, res) => {
  try {
    const [articles] = await db.query(
      `SELECT *
        FROM articles
        ORDER BY created_at DESC`,
            );

            res.json(articles);
          } catch (err) {
            res.status(500).json({
              message: "Server Error",
            });
          }
};

const ARTICLE_COLUMNS = `
        articles.id,
        articles.title,
        articles.slug,
        articles.excerpt,
        articles.content,
        articles.hero_image,
        articles.image_alt,
        articles.category,
        articles.tags,
        articles.status,
        articles.featured,
        articles.views,
        articles.created_at,
        CONCAT(users.first_name, ' ', users.last_name) AS author`;

/* ===========================
   GET ONE ARTICLE (public) — GET /api/articles/:slug
   Published articles only. Drafts and articles without a status are
   invisible to the public, even if someone guesses the slug.
=========================== */
exports.getArticle = async (req, res) => {
  try {
    const { slug } = req.params;

    const [result] = await db.query(
      `SELECT ${ARTICLE_COLUMNS}
      FROM articles
      INNER JOIN users
        ON users.id = articles.author_id
      WHERE articles.slug = ?
        AND articles.status = 'published'`,
      [slug],
    );

    if (result.length === 0) {
      return res.status(404).json({
        message: "Article not found",
      });
    }

    res.json(result[0]);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Server Error",
    });
  }
};

/* ===========================
   GET ONE ARTICLE (admin) — GET /api/articles/manage/:slug
   Any status: published, draft, or none. Used by the admin view and
   edit pages.
=========================== */
exports.getArticleForAdmin = async (req, res) => {
  try {
    const { slug } = req.params;

    const [result] = await db.query(
      `SELECT ${ARTICLE_COLUMNS}
      FROM articles
      LEFT JOIN users
        ON users.id = articles.author_id
      WHERE articles.slug = ?`,
      [slug],
    );

    if (result.length === 0) {
      return res.status(404).json({ message: "Article not found" });
    }

    res.json(result[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server Error" });
  }
};

exports.updateArticle = async (req, res) => {
  try {
    const { slug } = req.params;

    // The slug is permanent on edit (it's the URL); everything else is
    // validated like a new article.
    const { problem, values: clean } = publishable({ ...req.body, slug: slug });
    if (problem) {
      await discardUpload(req);
      return res.status(400).json({ message: problem });
    }
    const { title, excerpt, content, category, tags, featured, status, image_alt } = clean;

    // Find the existing article using its permanent slug.
    const [existing] = await db.query(
      "SELECT id, hero_image FROM articles WHERE slug = ?",
      [slug]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Article not found",
      });
    }

    const article = existing[0];

    let sql = `
      UPDATE articles
      SET
        title = ?,
        excerpt = ?,
        content = ?,
        category = ?,
        tags = ?,
        featured = ?,
        status = ?,
        image_alt = ?
    `;

    const values = [
      title,
      excerpt,
      content,
      category,
      tags,
      featured,
      status,
      image_alt,
    ];

    let oldImageUrl = null;

    // Update the image only if a new one was uploaded.
    if (req.file) {
      sql += ", hero_image = ?";
      values.push(req.file.cloudinaryUrl);

      oldImageUrl = article.hero_image;
    }

    sql += " WHERE id = ?";
    values.push(article.id);

    await db.query(sql, values);

    // Delete the old Cloudinary image after the database update succeeds.
    if (oldImageUrl) {
      try {
        await deleteAssetByUrl(oldImageUrl);
      } catch (deleteError) {
        console.error(
          "Failed to delete old Cloudinary image:",
          deleteError
        );
      }
    }

    return res.json({
      success: true,
      message: "Article updated successfully",
    });
  } catch (err) {
    console.error("Update article error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to update article",
    });
  }
};


exports.deleteArticle = async (req, res) => {
  try {
    const { id } = req.params;

    const [existing] = await db.query(
      "SELECT hero_image FROM articles WHERE id=?",
      [id],
    );

    const imageUrl = existing[0] ? existing[0].hero_image : null;

    await db.query(
      "DELETE FROM articles WHERE id=?",

      [id],
    );

    if (imageUrl) {
      await deleteAssetByUrl(imageUrl);
    }

    res.json({
      message: "Article deleted",
    });
  } catch (err) {
    res.status(500).json({
      message: "Server Error",
    });
  }
};

exports.getPublishedArticles = async (req, res) => {
  try {
    const [articles] = await db.query(`
      SELECT
        articles.id,
        articles.title,
        articles.slug,
        articles.excerpt,
        articles.hero_image,
        articles.image_alt,
        articles.category,
        articles.tags,
        articles.views,
        articles.created_at,
        CONCAT(users.first_name, ' ', users.last_name) AS author

      FROM articles

      INNER JOIN users
        ON users.id = articles.author_id

      WHERE articles.status = 'published'

      ORDER BY articles.created_at DESC
    `);

    res.status(200).json(articles);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Server Error",
    });
  }
};
