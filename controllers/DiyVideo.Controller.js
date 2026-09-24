const db = require("../config/db");
const { deleteAssetByUrl, getVideoThumbnail } = require("../config/cloudinary");

exports.createVideo = async (req, res) => {
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
    } = req.body;

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
    });
  } catch (err) {
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

exports.getVideo = async (req, res) => {
  try {
    const { slug } = req.params;

    const [result] = await db.query(
      "SELECT * FROM diy_videos WHERE slug=?",

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

exports.updateVideo = async (req, res) => {
  try {
    const { id } = req.params;

    const { title, slug, excerpt, content, category, tags, featured, status } =
      req.body;

    let sql = `
UPDATE diy_videos
SET

title=?,
slug=?,
excerpt=?,
content=?,
category=?,
tags=?,
featured=?,
status=?
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
