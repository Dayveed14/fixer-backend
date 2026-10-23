-- =====================================================================
-- Fixer — base schema (before the 2026-10-18 migrations)
--
-- Reconstructed from the queries in this codebase so the app can be set
-- up from scratch (local development, CI integration tests, disaster
-- recovery). Column names and types match what the code reads and
-- writes. Before relying on it for production, compare with the live
-- database:  mysqldump --no-data <db> > live-schema.sql
--
-- Full setup:  db/schema.sql, then migrations/*.sql in filename order.
-- (scripts/db-setup.js does exactly that.)
-- =====================================================================

CREATE TABLE IF NOT EXISTS users (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  first_name  VARCHAR(80)  NOT NULL,
  last_name   VARCHAR(80)  NOT NULL,
  email       VARCHAR(160) NOT NULL,
  phone       VARCHAR(30)  NULL,
  password    VARCHAR(255) NOT NULL,
  role        ENUM('user', 'technician', 'admin') NOT NULL DEFAULT 'user',
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email)
);

CREATE TABLE IF NOT EXISTS tickets (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  ticket_code   VARCHAR(20)  NOT NULL,
  customer_id   INT          NULL,
  customer_name VARCHAR(160) NOT NULL,
  issue         TEXT         NOT NULL,
  device        VARCHAR(120) NULL,
  priority      VARCHAR(10)  NOT NULL DEFAULT 'Medium',
  technician_id INT          NULL,
  status        VARCHAR(20)  NOT NULL DEFAULT 'Open',
  amount        DECIMAL(12,2) NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_tickets_customer (customer_id),
  KEY idx_tickets_technician (technician_id, status)
);

CREATE TABLE IF NOT EXISTS bookings (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  booking_reference VARCHAR(20)  NOT NULL,
  user_id           INT          NOT NULL,
  support_type      ENUM('voice', 'video', 'remote_desktop') NOT NULL,
  booking_date      DATE         NOT NULL,
  booking_time      TIME         NOT NULL,
  duration          INT          NOT NULL DEFAULT 30,
  issue_summary     TEXT         NULL,
  device            VARCHAR(60)  NULL,
  amount            DECIMAL(12,2) NOT NULL,
  payment_status    VARCHAR(20)  NOT NULL DEFAULT 'paid',
  payment_reference VARCHAR(64)  NOT NULL,
  diagnosis_id      INT          NULL,
  technician_id     INT          NULL,
  ticket_id         INT          NULL,
  status            ENUM('pending', 'confirmed', 'completed', 'cancelled', 'missed') NOT NULL DEFAULT 'pending',
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_bookings_user (user_id),
  KEY idx_bookings_technician (technician_id),
  KEY idx_bookings_date (booking_date)
);

CREATE TABLE IF NOT EXISTS shipments (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  reference         VARCHAR(20)  NOT NULL,
  name              VARCHAR(120) NOT NULL,
  email             VARCHAR(160) NOT NULL,
  phone             VARCHAR(30)  NOT NULL,
  device            VARCHAR(60)  NOT NULL,
  brand             VARCHAR(120) NOT NULL,
  fault             VARCHAR(500) NOT NULL,
  address           VARCHAR(300) NOT NULL,
  city              VARCHAR(120) NOT NULL,
  notes             TEXT         NULL,
  pickup_date       DATE         NOT NULL,
  pickup_time       TIME         NOT NULL,
  fee_amount        DECIMAL(12,2) NOT NULL,
  payment_status    VARCHAR(20)  NOT NULL DEFAULT 'paid',
  payment_reference VARCHAR(64)  NOT NULL,
  status            VARCHAR(30)  NOT NULL DEFAULT 'pickup_scheduled',
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_shipments_email (email)
);

CREATE TABLE IF NOT EXISTS devices (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  customer_id      INT          NOT NULL,
  device_name      VARCHAR(120) NOT NULL,
  brand            VARCHAR(120) NULL,
  os               VARCHAR(60)  NULL,
  serial_number    VARCHAR(120) NULL,
  last_serviced_at DATETIME     NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_devices_customer (customer_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  user_id        INT          NULL,
  role           VARCHAR(20)  NOT NULL,
  type           VARCHAR(30)  NOT NULL,
  title          VARCHAR(160) NOT NULL,
  message        VARCHAR(500) NOT NULL,
  reference_id   INT          NULL,
  reference_type VARCHAR(30)  NULL,
  is_read        TINYINT(1)   NOT NULL DEFAULT 0,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notifications_user (user_id, is_read),
  KEY idx_notifications_role (role, is_read)
);

CREATE TABLE IF NOT EXISTS ratings (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  ticket_id     INT          NOT NULL,
  technician_id INT          NOT NULL,
  customer_id   INT          NOT NULL,
  rating        TINYINT      NOT NULL,
  comment       TEXT         NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ratings_ticket (ticket_id),
  KEY idx_ratings_technician (technician_id)
);

CREATE TABLE IF NOT EXISTS articles (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  title       VARCHAR(200) NOT NULL,
  slug        VARCHAR(200) NOT NULL,
  excerpt     TEXT         NULL,
  content     MEDIUMTEXT   NULL,
  hero_image  VARCHAR(500) NULL,
  image_alt   VARCHAR(300) NULL,
  category    VARCHAR(80)  NULL,
  tags        VARCHAR(300) NULL,
  featured    TINYINT(1)   NOT NULL DEFAULT 0,
  status      VARCHAR(20)  NULL DEFAULT 'draft',
  author_id   INT          NULL,
  views       INT          NOT NULL DEFAULT 0,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_articles_slug (slug)
);

CREATE TABLE IF NOT EXISTS diy_videos (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  title         VARCHAR(200) NOT NULL,
  slug          VARCHAR(200) NOT NULL,
  excerpt       TEXT         NULL,
  content       MEDIUMTEXT   NULL,
  video_url     VARCHAR(500) NULL,
  thumbnail_url VARCHAR(500) NULL,
  category      VARCHAR(80)  NULL,
  tags          VARCHAR(300) NULL,
  featured      TINYINT(1)   NOT NULL DEFAULT 0,
  status        VARCHAR(20)  NULL DEFAULT 'draft',
  author_id     INT          NULL,
  views         INT          NOT NULL DEFAULT 0,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_diy_videos_slug (slug)
);

CREATE TABLE IF NOT EXISTS known_issues (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  device_type       VARCHAR(50)  NOT NULL,
  primary_fault     VARCHAR(200) NOT NULL,
  keywords          VARCHAR(500) NULL,
  possible_cause    TEXT         NULL,
  repair_steps      TEXT         NULL,
  possible_causes   TEXT         NULL,
  recommended_steps TEXT         NULL,
  severity          VARCHAR(20)  NULL,
  estimated_repair  VARCHAR(100) NULL,
  KEY idx_known_issues_device (device_type)
);

CREATE TABLE IF NOT EXISTS diagnosis_requests (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT          NULL,
  device_type   VARCHAR(50)  NOT NULL,
  brand_model   VARCHAR(100) NULL,
  primary_fault VARCHAR(200) NOT NULL,
  symptoms      TEXT         NULL,
  description   TEXT         NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_diagnosis_user (user_id)
);
