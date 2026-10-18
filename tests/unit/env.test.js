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

  it("flags a short JWT secret and a test Paystack key in production", () => {
    const result = validateEnv({
      ...complete,
      NODE_ENV: "production",
      JWT_SECRET: "short",
      PAYSTACK_SECRET_KEY: "sk_test_123",
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(2);
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
