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
const { verifyToken, authorize } = require("../middleware/auth");

router.post("/", verifyToken, authorize("admin", "technician"), createTicket);

router.get("/", verifyToken, authorize("admin", "technician"), getTickets);

router.get("/active/:technicianId", verifyToken, getActiveTicket);

router.get("/:id", verifyToken, getTicketById);

router.patch("/:id/status", verifyToken, authorize("admin", "technician"), updateTicketStatus);

router.patch("/:id/assign", verifyToken, authorize("admin"), assignTechnician);

router.patch("/:id", verifyToken, authorize("admin"), updateTicket);

router.delete("/:id", verifyToken, authorize("admin"), deleteTicket);

module.exports = router;
