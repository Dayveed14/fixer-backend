/* ===========================
   Small, shared input checks. Every controller that takes user input
   uses these so the rules (and messages) are the same everywhere.
=========================== */

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

const isText = (value) => typeof value === "string";

function isEmail(value) {
  return isText(value) && value.length <= 160 && EMAIL.test(value.trim());
}

/** Password rules: 8–72 characters (bcrypt only uses the first 72 bytes). */
function passwordProblem(password) {
  if (!isText(password)) return "Password is required.";
  if (password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
    return "Password must be between 8 and 72 characters.";
  }
  return null;
}

/**
 * Checks optional/required text fields. `rules` = { field: [maxLength, required] }.
 * Returns the first problem as a message, or null.
 */
function textProblem(body, rules) {
  for (const [field, [max, required]] of Object.entries(rules)) {
    const value = body?.[field];
    if (value === undefined || value === null || value === "") {
      if (required) return `${field} is required.`;
      continue;
    }
    if (!isText(value) && typeof value !== "number") return `${field} must be text.`;
    if (String(value).length > max) return `${field} must be at most ${max} characters.`;
  }
  return null;
}

/** ?limit= → an integer between 1 and max, or null when absent/invalid. */
function parseLimit(value, max = 100) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, max);
}

/** Positive integer id from a route param, or null. */
function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Normalises a slug ("My Post!" → "my-post"); null if nothing usable is left. */
function toSlug(value) {
  if (!isText(value)) return null;
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 180);
  return SLUG.test(slug) ? slug : null;
}

const PUBLISH_STATUSES = ["draft", "published"];

/**
 * Articles and DIY videos share the same editorial fields. Returns
 * { problem } or { values } with clean, normalised values. The author
 * always comes from the session, never the form.
 */
function publishable(body = {}, { slugFallbackToTitle = true } = {}) {
  const problem = textProblem(body, {
    title: [200, true],
    slug: [200, false],
    excerpt: [600, false],
    category: [80, false],
    tags: [500, false],
    image_alt: [200, false],
  });
  if (problem) return { problem };

  if (body.content !== undefined && body.content !== null && !isText(body.content)) {
    return { problem: "content must be text." };
  }
  if (isText(body.content) && body.content.length > 200000) {
    return { problem: "content is too long." };
  }

  const status = body.status || "draft";
  if (!PUBLISH_STATUSES.includes(status)) {
    return { problem: 'status must be "draft" or "published".' };
  }

  const slug = toSlug(body.slug || (slugFallbackToTitle ? body.title : ""));
  if (!slug) return { problem: "A valid slug is required (letters, numbers and dashes)." };

  // Left undefined when the form doesn't send it, so edits keep the
  // current setting (creates default to "not featured").
  const featured =
    body.featured === undefined || body.featured === ""
      ? undefined
      : [true, 1, "1", "true", "on"].includes(body.featured)
        ? 1
        : 0;

  return {
    values: {
      title: body.title.trim(),
      slug,
      excerpt: body.excerpt || null,
      content: body.content || null,
      category: body.category || null,
      tags: body.tags || null,
      image_alt: body.image_alt || null,
      featured,
      status,
    },
  };
}

module.exports = {
  isText,
  isEmail,
  passwordProblem,
  textProblem,
  parseLimit,
  parseId,
  toSlug,
  publishable,
  PUBLISH_STATUSES,
};
