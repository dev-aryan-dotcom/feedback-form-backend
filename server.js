require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const validator = require("validator");
const morgan = require("morgan");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

const feedbackRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
});

app.use("/send-feedback", feedbackRateLimiter);

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const sanitize = (value) => validator.escape(String(value ?? ""));

// Create transporter with connection pooling
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  pool: true, // Enable connection pooling
  maxConnections: 5,
  maxMessages: 100,
});

// Test endpoint to verify email config
app.get("/test-email", async (req, res) => {
  try {
    await transporter.verify();
    res.status(200).json({ message: "✅ Email configuration is valid" });
  } catch (error) {
    res
      .status(500)
      .json({ message: `❌ Email configuration error: ${error.message}` });
  }
});

// API Route
app.post("/send-feedback", async (req, res) => {
  try {
    const { receiverEmail, clientEmail, feedback: formData } = req.body;
    const receivers = Array.isArray(receiverEmail)
      ? receiverEmail.map((email) => String(email).trim()).filter(Boolean)
      : String(receiverEmail || "")
          .split(",")
          .map((email) => email.trim())
          .filter(Boolean);

    // Validation
    if (!receivers.length) {
      console.warn("❌ Missing receiverEmail");
      return res.status(400).json({ message: "Receiver email is required" });
    }

    const invalidReceivers = receivers.filter((email) => !isValidEmail(email));
    if (invalidReceivers.length) {
      console.warn("❌ Invalid receiverEmail format");
      return res.status(400).json({
        message: `Invalid receiver email(s): ${invalidReceivers.join(", ")}`,
      });
    }

    if (!clientEmail) {
      console.warn("❌ Missing clientEmail");
      return res.status(400).json({ message: "Client email is required" });
    }

    if (!isValidEmail(clientEmail)) {
      console.warn("❌ Invalid clientEmail format");
      return res.status(400).json({ message: "Invalid client email" });
    }

    if (!formData) {
      console.warn("❌ Missing feedback content");
      return res.status(400).json({ message: "Feedback content is required" });
    }

    if (typeof formData !== "object" || Array.isArray(formData)) {
      console.warn("❌ Invalid feedback format");
      return res
        .status(400)
        .json({ message: "Feedback must be a JSON object" });
    }

    console.log(
      `📤 Sending email from ${clientEmail} to ${receivers.join(", ")}`
    );

    const safe = (value) => {
      const escapedValue = sanitize(value).trim();
      return escapedValue || "Not Provided";
    };
    const details = formData.techCheckGroup?.length
      ? formData.techCheckGroup.map((item) => safe(item)).join(", ")
      : "Not Provided";
    const ratingRowsHtml = [
      {
        label: "Overall Rating",
        value: formData.overallRating
          ? `${formData.overallRating}/5`
          : "Not Provided",
      },
      { label: "Collaboration", value: formData.collabRating },
      { label: "Delivery", value: formData.deliveryRating },
      { label: "Technical Skills", value: formData.technicalSkillsRating },
      { label: "Communication", value: formData.communicationRating },
      { label: "Quality of Work", value: formData.qualityRating },
      { label: "Timeliness", value: formData.timelinessRating },
      { label: "Problem Solving", value: formData.problemSolvingRating },
      { label: "Team Collaboration", value: formData.teamCollaborationRating },
      { label: "Initiative & Ownership", value: formData.initiativeRating },
      {
        label: "Domain Understanding",
        value: formData.domainUnderstandingRating,
      },
    ]
      .map(
        (entry) =>
          `<tr><td><b>${safe(entry.label)}:</b></td><td>${safe(
            entry.value
          )}</td></tr>`
      )
      .join("");

    // Email options
    const mailOptions = {
      to: receivers,
      from: `"New Client Feedback" <${process.env.EMAIL_USER}>`,
      replyTo: clientEmail,
      subject: "New Client Feedback",
      html: `
<div style="margin:0;padding:0;background:#eef2f7;font-family:'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:760px;width:100%;margin:30px auto;background:#ffffff;border-radius:10px;box-shadow:0 6px 18px rgba(0,0,0,0.08);overflow:hidden;">

    <!-- Header -->
    <div style="background:#0b5e7e;padding:24px 32px;color:#ffffff;">
      <h2 style="margin:0;font-size:20px;font-weight:600;">
        Client Feedback Report
      </h2>
      <p style="margin:6px 0 0;font-size:13px;opacity:0.9;">
        A new feedback submission has been received
      </p>
    </div>

    <!-- Body -->
    <div style="padding:32px;">

      <!-- Employee Info -->
      <h3 style="font-size:15px;color:#0b5e7e;margin-bottom:14px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">
        Employee Information
      </h3>

      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px;">
        <tr>
          <td style="padding:10px 12px;color:#555;width:180px;"><strong>Name</strong></td>
          <td style="padding:10px 12px;color:#111;">${safe(
            formData.devName
          )}</td>
        </tr>
        <tr style="background:#f9fafb;">
          <td style="padding:10px 12px;color:#555;"><strong>Role</strong></td>
          <td style="padding:10px 12px;color:#111;">${safe(formData.role)}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;color:#555;"><strong>Client Location</strong></td>
          <td style="padding:10px 12px;color:#111;">${safe(
            formData.clientSite
          )}</td>
        </tr>
        <tr style="background:#f9fafb;">
          <td style="padding:10px 12px;color:#555;"><strong>Date</strong></td>
          <td style="padding:10px 12px;color:#111;">${safe(
            formData.feedbackDate
          )}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;color:#555;"><strong>Review Period</strong></td>
          <td style="padding:10px 12px;color:#111;">${safe(
            formData.period
          )}</td>
        </tr>
        <tr style="background:#f9fafb;">
          <td style="padding:10px 12px;color:#555;"><strong>Client Email</strong></td>
          <td style="padding:10px 12px;color:#111;">${safe(clientEmail)}</td>
        </tr>
      </table>

      <!-- Ratings -->
      <h3 style="font-size:15px;color:#0b5e7e;margin-bottom:14px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">
        Performance Ratings
      </h3>

      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px;">
        ${ratingRowsHtml}
      </table>

      <!-- Technical Strengths -->
      <h3 style="font-size:15px;color:#0b5e7e;margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">
        Technical Strengths
      </h3>

      <div style="background:#f3f6fa;border:1px solid #e2e8f0;padding:14px;border-radius:6px;font-size:13px;color:#333;margin-bottom:24px;">
        ${details}
      </div>

      <!-- Comments -->
      <h3 style="font-size:15px;color:#0b5e7e;margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">
        Comments
      </h3>

      <div style="background:#f9fafb;border-left:4px solid #0b5e7e;padding:14px;border-radius:4px;font-size:13px;color:#333;margin-bottom:24px;">
        ${safe(formData.comments)}
      </div>

      <!-- Improvements -->
      <h3 style="font-size:15px;color:#0b5e7e;margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">
        Areas of Improvement
      </h3>

      <div style="background:#fff7ed;border-left:4px solid #f97316;padding:14px;border-radius:4px;font-size:13px;color:#333;">
        ${safe(formData.improvements)}
      </div>

    </div>

    <!-- Footer -->
    <div style="background:#f1f5f9;padding:18px;text-align:center;font-size:12px;color:#6b7280;">
      This report was generated automatically by the Feedback System
    </div>

  </div>
</div>
`,
    };

    transporter
      .sendMail(mailOptions)
      .then(() => console.log("✅ Email sent successfully"))
      .catch((err) => console.error("❌ Error sending email:", err.message));

    res.status(200).json({ message: "Feedback received" });
  } catch (error) {
    console.error("❌ Error sending email:", error.message);
    res.status(500).json({ message: `Error sending email: ${error.message}` });
  }
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.error("❌ Missing EMAIL_USER or EMAIL_PASS in .env file");
  }
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📧 Email configured: ${process.env.EMAIL_USER}`);
});
