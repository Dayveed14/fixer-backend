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

// Open to any authenticated role, same reasoning as bookings above —
// a customer lists their own tickets (?customer_id=me) for their
// dashboard. Scoping happens in the controller.
router.get("/", verifyToken, getTickets);

router.get("/active/:technicianId", verifyToken, getActiveTicket);

router.get("/:id", verifyToken, getTicketById);

router.patch("/:id/status", verifyToken, authorize("admin", "technician"), updateTicketStatus);

router.patch("/:id/assign", verifyToken, authorize("admin"), assignTechnician);

router.patch("/:id", verifyToken, authorize("admin"), updateTicket);

router.delete("/:id", verifyToken, authorize("admin"), deleteTicket);

module.exports = router;
