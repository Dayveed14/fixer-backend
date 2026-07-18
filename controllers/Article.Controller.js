const db = require("../config/db");
exports.createArticle = async (req, res) => {
  try {
    const {
      title,
      slug,
      excerpt,
      content,
      category,
      tags,
      featured,
      status,
      author_id,
      image_alt,
    } = req.body;

    const hero_image = req.file ? req.file.filename : null;

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
    });
  } catch (err) {
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

exports.getArticle = async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await db.query(
      "SELECT * FROM articles WHERE id=?",

      [id],
    );

    if (result.length === 0) {
      return res.status(404).json({
        message: "Article not found",
      });
    }

    res.json(result[0]);
  } catch (err) {
    res.status(500).json({
      message: "Server Error",
    });
  }
};

exports.updateArticle = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      title,
      slug,
      excerpt,
      content,
      category,
      tags,
      featured,
      status,
      image_alt,
    } = req.body;

    let sql = `
UPDATE articles
SET

title=?,
slug=?,
excerpt=?,
content=?,
category=?,
tags=?,
featured=?,
status=?,
image_alt=?
`;

    const values = [
      title,
      slug,
      excerpt,
      content,
      category,
      tags,
      featured,
      status,
      image_alt,
    ];

    if (req.file) {
      sql += ", hero_image=?";

      values.push(req.file.filename);
    }

    sql += " WHERE id=?";

    values.push(id);

    await db.query(sql, values);

    res.json({
      message: "Article updated",
    });
  } catch (err) {
    res.status(500).json({
      message: "Server Error",
    });
  }
};

exports.deleteArticle = async (req, res) => {
  try {
    const { id } = req.params;

    await db.query(
      "DELETE FROM articles WHERE id=?",

      [id],
    );

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
        users.first_name,
        users.last_name

      FROM articles

      INNER JOIN users
        ON users.id = articles.author_id

      WHERE articles.status = 'published'

      ORDER BY articles.created_at DESC

      LIMIT 4
    `);

    res.status(200).json(articles);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Server Error",
    });
  }
};
