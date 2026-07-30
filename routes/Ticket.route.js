const express = require("express");

const router = express.Router();

const {
  createTicket,
  getTickets,
  getTicketById,
  updateTicketStatus,
  updateTicket,
  assignTechnician,
  deleteTicket,
  getActiveTicket,
} = require("../controllers/Ticket.Controller");

router.post("/", createTicket);

router.get("/", getTickets);

router.get("/active/:technicianId", getActiveTicket);

router.get("/:id", getTicketById);

router.patch("/:id/status", updateTicketStatus);

router.patch("/:id/assign", assignTechnician);

router.patch("/:id", updateTicket);

router.delete("/:id", deleteTicket);

module.exports = router;
