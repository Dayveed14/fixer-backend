// Sessions, password changes and authorization against the real users
// table, plus a smoke test that every list/stats query is valid SQL.
jest.mock("../../services/paystackService");
jest.mock("../../services/mailService");
jest.mock("../../services/meshCentralService");
jest.mock("../../services/gemini");

const request = require("supertest");
const app = require("../../app");
const { db, resetData, createUser, auth } = require("./helpers");

beforeEach(resetData);
afterAll(() => db.end());

const web = (req) => req.set("X-Fixer-Client", "web");

async function login(email, password) {
  const res = await web(request(app).post("/api/users/login")).send({ email, password });
  const cookie = (res.headers["set-cookie"] || []).find((c) => c.startsWith("fixer_token="));
  return { res, cookie: cookie && cookie.split(";")[0] };
}

it.each(["user", "technician", "admin"])("a %s changes their password: other sessions end, this one continues", async (role) => {
  const user = await createUser({ role, password: "old-password-1" });
  const laptop = await login(user.email, "old-password-1");
  const phone = await login(user.email, "old-password-1");
  expect(laptop.res.status).toBe(200);

  const change = await web(request(app).patch("/api/users/me/password"))
    .set("Cookie", laptop.cookie)
    .send({ current_password: "old-password-1", new_password: "new-password-2" });
  expect(change.status).toBe(200);
  const fresh = change.headers["set-cookie"].find((c) => c.startsWith("fixer_token=")).split(";")[0];

  // The other device is signed out…
  const phoneMe = await request(app).get("/api/users/me").set("Cookie", phone.cookie);
  expect(phoneMe.status).toBe(401);
  // …the browser that changed it keeps working with its new cookie…
  expect((await request(app).get("/api/users/me").set("Cookie", fresh)).status).toBe(200);
  // …and only the new password works.
  expect((await login(user.email, "old-password-1")).res.status).toBe(401);
  expect((await login(user.email, "new-password-2")).res.status).toBe(200);

  const [[row]] = await db.query("SELECT token_version, password_changed_at FROM users WHERE id = ?", [user.id]);
  expect(row.token_version).toBe(1);
  expect(row.password_changed_at).not.toBeNull();
});

it("a demoted admin loses admin access immediately", async () => {
  const admin = await createUser({ role: "admin" });
  const header = auth(admin);
  expect((await request(app).get("/api/users").set("Authorization", header)).status).toBe(200);

  await db.query("UPDATE users SET role = 'user' WHERE id = ?", [admin.id]);
  require("../../services/sessionService").invalidateSession(admin.id);

  expect((await request(app).get("/api/users").set("Authorization", header)).status).toBe(401);
});

it("a deleted account's token stops working", async () => {
  const user = await createUser();
  await db.query("DELETE FROM users WHERE id = ?", [user.id]);
  expect((await request(app).get("/api/users/me").set("Authorization", auth(user))).status).toBe(401);
});

it("login doesn't reveal which emails exist", async () => {
  const user = await createUser({ password: "right-password" });
  const wrong = await login(user.email, "wrong-password");
  const unknown = await login("nobody@example.com", "wrong-password");
  expect(wrong.res.status).toBe(401);
  expect(unknown.res.status).toBe(401);
  expect(wrong.res.body).toEqual(unknown.res.body);
});

describe("every dashboard query runs on the real schema", () => {
  const routes = {
    admin: [
      "/api/stats/dashboard",
      "/api/users",
      "/api/users/technicians",
      "/api/tickets?limit=5",
      "/api/bookings?limit=5",
      "/api/shipments",
      "/api/payments?status=success&unfulfilled=true",
      "/api/notifications",
      "/api/devices",
      "/api/articles",
      "/api/diy-videos",
      "/api/pricing",
      "/api/health/metrics",
    ],
    user: ["/api/tickets", "/api/bookings", "/api/devices", "/api/notifications", "/api/users/me"],
    technician: ["/api/tickets", "/api/bookings?today=true", "/api/shipments/assigned", "/api/notifications"],
  };

  it.each(Object.entries(routes).flatMap(([role, urls]) => urls.map((u) => [role, u])))("%s GET %s", async (role, url) => {
    const user = await createUser({ role });
    let path = url;
    const res = await request(app).get(path).set("Authorization", auth(user));
    expect(res.status).toBe(200);
  });

  it("customer and technician stats", async () => {
    const user = await createUser();
    const tech = await createUser({ role: "technician" });
    expect((await request(app).get(`/api/stats/user/${user.id}`).set("Authorization", auth(user))).status).toBe(200);
    expect((await request(app).get(`/api/stats/technician/${tech.id}`).set("Authorization", auth(tech))).status).toBe(200);
  });
});

it("admin edit/delete run on the real schema", async () => {
  const admin = await createUser({ role: "admin" });
  const tech = await createUser({ role: "technician" });
  const edit = await request(app)
    .patch(`/api/users/${tech.id}`)
    .set("Authorization", auth(admin))
    .send({ first_name: "New", last_name: "Name", phone: "0809", role: "technician" });
  expect(edit.status).toBe(200);
  expect((await request(app).get(`/api/users/${tech.id}`).set("Authorization", auth(admin))).body.first_name).toBe("New");

  // With history → kept.
  await db.query(
    "INSERT INTO bookings (booking_reference, user_id, support_type, booking_date, booking_time, technician_id, amount, payment_reference) VALUES ('#BK1', ?, 'voice', CURDATE(), '10:00', ?, 5000, 'FXB_HIST')",
    [admin.id, tech.id],
  );
  expect((await request(app).delete(`/api/users/${tech.id}`).set("Authorization", auth(admin))).status).toBe(409);

  const fresh = await createUser();
  expect((await request(app).delete(`/api/users/${fresh.id}`).set("Authorization", auth(admin))).status).toBe(200);
  expect((await request(app).get("/api/users/me").set("Authorization", auth(fresh))).status).toBe(401);
});
