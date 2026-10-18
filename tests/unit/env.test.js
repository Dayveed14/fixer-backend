const { validateEnv, assertEnv } = require("../../config/env");

const complete = {
  JWT_SECRET: "x".repeat(40),
  DB_HOST: "h",
  DB_USER: "u",
  DB_PASSWORD: "p",
  DB_NAME: "n",
  PAYSTACK_SECRET_KEY: "sk_live_abc",
  RESEND_API_KEY: "re_123",
};

describe("environment validation", () => {
  it("passes with every required variable", () => {
    expect(validateEnv(complete).ok).toBe(true);
  });

  it("lists missing required variables", () => {
    const { ok, missing } = validateEnv({ ...complete, JWT_SECRET: "", DB_HOST: undefined });
    expect(ok).toBe(false);
    expect(missing).toEqual(["JWT_SECRET", "DB_HOST"]);
  });

  it("flags a short JWT secret in production", () => {
    const result = validateEnv({ ...complete, NODE_ENV: "production", JWT_SECRET: "short" });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.stringMatching(/JWT_SECRET/)]);
  });

  it("allows a Paystack test key in production but warns (test mode on the live site)", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const result = validateEnv({ ...complete, NODE_ENV: "production", PAYSTACK_SECRET_KEY: "sk_test_123" });
    expect(result.ok).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/PAYSTACK TEST MODE/));
    warn.mockRestore();
  });

  it("rejects a Paystack key in the wrong format", () => {
    const result = validateEnv({ ...complete, PAYSTACK_SECRET_KEY: "pk_live_oops" });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.stringMatching(/valid-format/)]);
  });

  it("throws at startup in production when misconfigured", () => {
    const logger = { warn: jest.fn() };
    expect(() => assertEnv({ NODE_ENV: "production" }, logger)).toThrow(/Missing required env vars/);
  });

  it("only warns outside production", () => {
    const logger = { warn: jest.fn() };
    expect(() => assertEnv({}, logger)).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });
});
