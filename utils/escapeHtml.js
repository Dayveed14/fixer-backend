// Escapes user-supplied text before it's dropped into an HTML email.
// Names, addresses and fault descriptions all come straight from form
// input, so without this a customer could inject markup/links into the
// emails we send to admins and technicians.
module.exports = function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};
