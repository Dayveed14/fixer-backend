const db = require("../config/db");
const { deleteAssetByUrl, getVideoThumbnail } = require("../config/cloudinary");
const { publishable } = require("../utils/validate");

async function discardUpload(req) {
  if (!req.file?.cloudinaryUrl) return;
  try {
    await deleteAssetByUrl(req.file.cloudinaryUrl);
  } catch (err) {
    console.error("Failed to remove rejected upload:", err.message);
  }
}

exports.createVideo = async (req, res) => {
  try {
    const { problem, values } = publishable(req.body);
    if (problem) {
      await discardUpload(req);
      return res.status(400).json({ message: problem });
    }

    const { title, slug, excerpt, content, category, tags, status } = values;
    const featured = values.featured ?? 0;
    const author_id = req.user.id;

    const video_url = req.file ? req.file.cloudinaryUrl : null;
    const thumbnail_url = video_url ? getVideoThumbnail(video_url) : null;

    if (!video_url) {
      return res.status(400).json({
        message: "A video file is required.",
      });
    }

    const sql = `
    INSERT INTO diy_videos
    (
    title,
    slug,
    excerpt,
    content,
    video_url,
    thumbnail_url,
    category,
    tags,
    featured,
    status,
    author_id
    )

    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `;

    await db.query(sql, [
      title,
      slug,
      excerpt,
      content,
      video_url,
      thumbnail_url,
      category,
      tags,
      featured,
      status,
      author_id,
    ]);

    res.status(201).json({
      message: "Video created.",
      slug,
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      await discardUpload(req);
      return res.status(409).json({ message: "A video with this slug already exists." });
    }
    console.log(err);

    res.status(500).json({
      message: "Server Error",
    });
  }
};

exports.getVideos = async (req, res) => {
  try {
    const [videos] = await db.query(
      `SELECT *
FROM diy_videos
ORDER BY created_at DESC`,
    );

    res.json(videos);
  } catch (err) {
    res.status(500).json({
      message: "Server Error",
    });
  }
};

/* Public — GET /api/diy-videos/:slug — published videos only. */
exports.getVideo = async (req, res) => {
  try {
    const { slug } = req.params;

    const [result] = await db.query(
      "SELECT * FROM diy_videos WHERE slug = ? AND status = 'published'",
      [slug],
    );

    if (result.length === 0) {
      return res.status(404).json({
        message: "Video not found",
      });
    }

    res.json(result[0]);
  } catch (err) {
    res.status(500).json({
      message: "Server Error",
    });
  }
};

/* Admin — GET /api/diy-videos/manage/:idOrSlug — any status. */
exports.getVideoForAdmin = async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const [result] = await db.query(
      "SELECT * FROM diy_videos WHERE id = ? OR slug = ?",
      [idOrSlug, idOrSlug],
    );

    if (result.length === 0) {
      return res.status(404).json({ message: "Video not found" });
    }

    res.json(result[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server Error" });
  }
};

exports.updateVideo = async (req, res) => {
  try {
    const { id } = req.params;

    // The edit form doesn't send the slug: keep the current one (it's the
    // public URL) unless a new slug is given explicitly.
    let currentSlug = null;
    if (!req.body?.slug) {
      const [rows] = await db.query("SELECT slug FROM diy_videos WHERE id = ?", [id]);
      if (!rows[0]) {
        await discardUpload(req);
        return res.status(404).json({ message: "Video not found." });
      }
      currentSlug = rows[0].slug;
    }

    const { problem, values: clean } = publishable({ ...req.body, slug: req.body?.slug || currentSlug });
    if (problem) {
      await discardUpload(req);
      return res.status(400).json({ message: problem });
    }
    const { title, slug, excerpt, content, category, tags, featured, status } = clean;

    let sql = `
UPDATE diy_videos
SET

title=?,
slug=?,
excerpt=?,
content=?,
category=?,
tags=?,
featured=COALESCE(?, featured),
status=?
`;

    const values = [
      title,
      slug,
      excerpt,
      content,
      category,
      tags,
      featured ?? null,
      status,
    ];

    let oldVideoUrl = null;

    if (req.file) {
      // Look up the video currently on this entry so we can delete it from
      // Cloudinary once the new one is safely saved.
      const [existing] = await db.query(
        "SELECT video_url FROM diy_videos WHERE id=?",
        [id],
      );

      oldVideoUrl = existing[0] ? existing[0].video_url : null;

      const newVideoUrl = req.file.cloudinaryUrl;

      sql += ", video_url=?, thumbnail_url=?";

      values.push(newVideoUrl, getVideoThumbnail(newVideoUrl));
    }

    sql += " WHERE id=?";

    values.push(id);

    await db.query(sql, values);

    if (oldVideoUrl) {
      await deleteAssetByUrl(oldVideoUrl);
    }

    res.json({
      message: "Video updated",
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      await discardUpload(req);
      return res.status(409).json({ message: "A video with this slug already exists." });
    }
    console.error(err);
    res.status(500).json({
      message: "Server Error",
    });
  }
};

exports.deleteVideo = async (req, res) => {
  try {
    const { id } = req.params;

    const [existing] = await db.query(
      "SELECT video_url FROM diy_videos WHERE id=?",
      [id],
    );

    const videoUrl = existing[0] ? existing[0].video_url : null;

    await db.query(
      "DELETE FROM diy_videos WHERE id=?",

      [id],
    );

    if (videoUrl) {
      await deleteAssetByUrl(videoUrl);
    }

    res.json({
      message: "Video deleted",
    });
  } catch (err) {
    res.status(500).json({
      message: "Server Error",
    });
  }
};

exports.getPublishedVideos = async (req, res) => {
  try {
    const [videos] = await db.query(`
      SELECT
        diy_videos.id,
        diy_videos.title,
        diy_videos.slug,
        diy_videos.excerpt,
        diy_videos.video_url,
        diy_videos.thumbnail_url,
        diy_videos.category,
        diy_videos.tags,
        diy_videos.views,
        diy_videos.created_at,
        users.first_name,
        users.last_name

      FROM diy_videos

      INNER JOIN users
        ON users.id = diy_videos.author_id

      WHERE diy_videos.status = 'published'

      ORDER BY diy_videos.created_at DESC

      LIMIT 4
    `);

    res.status(200).json(videos);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Server Error",
    });
  }
};
