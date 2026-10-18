/**
 * Routes a mocked `query` function by SQL text instead of call order.
 * Payment flows issue many queries; matching on the statement keeps the
 * tests readable and robust to harmless reordering.
 *
 *   routeQueries(db.query, [
 *     [/FROM payment_transactions/, [[paymentRow]]],
 *     [/INSERT INTO bookings/, [{ insertId: 7 }]],
 *     [/INSERT INTO bookings/, () => { throw err }], // functions are called
 *   ]);
 *
 * Unmatched statements resolve to `[[]]` (mysql2's empty result).
 */
function routeQueries(queryMock, routes, fallback = [[]]) {
  queryMock.mockImplementation(async (sql, params) => {
    for (const [pattern, result] of routes) {
      if (pattern.test(sql)) {
        return typeof result === "function" ? result(sql, params) : result;
      }
    }
    return fallback;
  });
}

/** All [sql, params] calls whose SQL matches `pattern`. */
function callsMatching(queryMock, pattern) {
  return queryMock.mock.calls.filter(([sql]) => pattern.test(sql));
}

module.exports = { routeQueries, callsMatching };
