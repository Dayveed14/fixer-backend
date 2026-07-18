const express = require("express");

const router = express.Router();

const {
  createTicket,
  getTickets,
  updateTicketStatus,
  assignTechnician,
  deleteTicket,
  getActiveTicket,
} = require("../controllers/Ticket.Controller");

router.post("/", createTicket);

router.get("/", getTickets);

router.get("/active/:technicianId", getActiveTicket);

router.patch("/:id/status", updateTicketStatus);

router.patch("/:id/assign", assignTechnician);

router.delete("/:id", deleteTicket);

module.exports = router;
