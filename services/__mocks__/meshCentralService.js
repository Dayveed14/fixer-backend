module.exports = {
  generateInviteLink: jest
    .fn()
    .mockResolvedValue("https://mesh.test/invite/mock-token"),
};
