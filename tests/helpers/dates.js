// Dates relative to "today" in Abuja, so route tests don't go stale.
const { nowInBusinessTz } = require("../../utils/schedule");

function addDays(dateString, days) {
  const [y, m, d] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

const today = () => nowInBusinessTz().date;
const tomorrow = () => addDays(today(), 1);
const yesterday = () => addDays(today(), -1);
const daysFromNow = (n) => addDays(today(), n);

module.exports = { addDays, today, tomorrow, yesterday, daysFromNow };
