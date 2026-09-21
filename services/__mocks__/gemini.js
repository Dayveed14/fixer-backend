module.exports = jest.fn().mockResolvedValue({
  success: true,
  source: "ai",
  results: [
    {
      primary_fault: "Mock AI diagnosis",
      possible_cause: "Mock cause",
      repair_steps: "Mock steps",
      confidence: 50,
    },
  ],
});
