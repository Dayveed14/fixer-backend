const verifyTransaction = jest.fn().mockResolvedValue({
  status: "success",
  currency: "NGN",
  amount: 500000,
});

const verifyPayment = jest.fn().mockResolvedValue({
  status: "success",
  currency: "NGN",
  amount: 500000,
});

module.exports = { verifyTransaction, verifyPayment };
