require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const { Resend } = require("resend");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const validator = require("validator");
const morgan = require("morgan");
const crypto = require("crypto");
const dns = require("dns");
const dnsPromises = dns.promises;

// Prefer IPv4 first to avoid SMTP failures on networks without IPv6 routing.
if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));
app.set("trust proxy", 1);

const feedbackRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
});

app.use("/send-feedback", feedbackRateLimiter);

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const sanitize = (value) => validator.escape(String(value ?? ""));
const parseReceiverEmails = (receiverEmail) =>
  Array.isArray(receiverEmail)
    ? receiverEmail.map((email) => String(email).trim()).filter(Boolean)
    : String(receiverEmail || "")
        .split(",")
        .map((email) => email.trim())
        .filter(Boolean);

const feedbackLinkTokens = new Map();
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
const smtpPort = Number(process.env.SMTP_PORT || 465);
const fallbackSmtpPort = smtpPort === 465 ? 587 : 465;
const resendApiKey = String(process.env.RESEND_API_KEY || "").trim();
const resendFromEmail = String(
  process.env.RESEND_FROM_EMAIL || process.env.EMAIL_USER || "onboarding@resend.dev"
).trim();
const resendClient = resendApiKey ? new Resend(resendApiKey) : null;

const resolveSmtpHosts = async () => {
  let resolvedHosts = [smtpHost];

  if (smtpHost === "smtp.gmail.com") {
    try {
      const ipv4Records = await dnsPromises.resolve4(smtpHost);
      if (ipv4Records.length) {
        resolvedHosts = ipv4Records;
      }
    } catch (error) {
      console.warn(`⚠️ SMTP IPv4 lookup failed, falling back to hostname: ${error.message}`);
    }
  }

  return resolvedHosts;
};

const createTransporter = async (host = smtpHost, port = smtpPort) => {
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    dnsTimeout: 10000,
    tls: {
      servername: smtpHost,
    },
  });
};

const sendWithFallback = async (mailOptions) => {
  const portsToTry = smtpPort === fallbackSmtpPort ? [smtpPort] : [smtpPort, fallbackSmtpPort];
  const hostsToTry = await resolveSmtpHosts();
  let lastError;

  for (const host of hostsToTry) {
    for (const port of portsToTry) {
      try {
        const transporter = await createTransporter(host, port);
        await transporter.sendMail(mailOptions);
        return;
      } catch (error) {
        lastError = error;
        const retryableError =
          ["ETIMEDOUT", "ESOCKET", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH"].includes(error.code) ||
          /timeout/i.test(error.message || "");

        if (!retryableError) {
          throw error;
        }

        console.warn(
          `⚠️ SMTP send failed on host ${host} port ${port}: ${error.message}`
        );
      }
    }
  }

  throw lastError;
};

const sendWithResend = async (mailOptions) => {
  if (!resendClient) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  const { error } = await resendClient.emails.send({
    from: `New Client Feedback <${resendFromEmail}>`,
    to: mailOptions.to,
    replyTo: mailOptions.replyTo,
    subject: mailOptions.subject,
    html: mailOptions.html,
    text: mailOptions.text,
  });

  if (error) {
    throw new Error(error.message || "Resend email send failed");
  }
};

const sendEmail = async (mailOptions) => {
  if (resendClient) {
    return sendWithResend(mailOptions);
  }

  return sendWithFallback(mailOptions);
};

// Test endpoint to verify email config
app.get("/test-email", async (req, res) => {
  try {
    if (resendClient) {
      if (!resendFromEmail) {
        return res.status(500).json({ message: "❌ RESEND_FROM_EMAIL is missing" });
      }

      return res.status(200).json({
        message: `✅ Resend configuration is valid (${resendFromEmail})`,
      });
    }

    const transporter = await createTransporter();
    await transporter.verify();
    res.status(200).json({ message: "✅ SMTP email configuration is valid" });
  } catch (error) {
    res
      .status(500)
      .json({ message: `❌ Email configuration error: ${error.message}` });
  }
});

app.post("/generate-feedback-link", (req, res) => {
  try {
    const token = String(req.body?.token || "").trim() || crypto.randomBytes(24).toString("hex");
    const receivers = parseReceiverEmails(req.body?.receiverEmail);

    if (!receivers.length) {
      return res.status(400).json({ message: "Receiver email is required" });
    }

    const invalidReceivers = receivers.filter((email) => !isValidEmail(email));
    if (invalidReceivers.length) {
      return res.status(400).json({
        message: `Invalid receiver email(s): ${invalidReceivers.join(", ")}`,
      });
    }

    const expiresAt = Date.now() + TOKEN_TTL_MS;

    feedbackLinkTokens.set(token, {
      receivers,
      expiresAt,
    });

    return res.status(200).json({
      token,
      expiresAt,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: `Failed to generate feedback link: ${error.message}` });
  }
});

// API Route
app.post("/send-feedback", async (req, res) => {
  try {
    const { receiverEmail, clientEmail, feedback: formData, token } = req.body;
    let receivers = [];
    const fallbackReceivers = parseReceiverEmails(receiverEmail);

    if (token) {
      const tokenEntry = feedbackLinkTokens.get(String(token));

      if (!tokenEntry) {
        if (fallbackReceivers.length) {
          receivers = fallbackReceivers;
        } else {
          console.warn("❌ Invalid feedback link token");
          return res.status(400).json({ message: "Invalid feedback link token" });
        }
      }

      if (!receivers.length && tokenEntry) {
        if (Date.now() > tokenEntry.expiresAt) {
          feedbackLinkTokens.delete(String(token));
          if (fallbackReceivers.length) {
            receivers = fallbackReceivers;
          } else {
            console.warn("❌ Expired feedback link token");
            return res.status(400).json({ message: "Feedback link token expired" });
          }
        } else {
          receivers = tokenEntry.receivers;
        }
      }
    } else {
      receivers = fallbackReceivers;
    }

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
    const currentRatingFields = [
      ["Collaboration", formData.collabRating],
      ["Delivery", formData.deliveryRating],
      ["Technical Skills", formData.technicalSkillsRating],
      ["Problem Solving", formData.problemSolvingRating],
      ["Initiative & Ownership", formData.initiativeRating],
    ];

    const ratingRowsHtml = currentRatingFields
      .map(
        ([label, value]) =>
          `<tr><td><b>${safe(label)}:</b></td><td>${safe(
            value
          )}</td></tr>`
      )
      .join("");

    // Email options
    const mailOptions = {
      to: receivers,
      from: `"Client Feedback" <${process.env.EMAIL_USER}>`,
      replyTo: clientEmail,
      subject: "Client Feedback",
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

      <!-- Improvements -->
      <h3 style="font-size:15px;color:#0b5e7e;margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">
        Areas of Improvement
      </h3>

      <div style="background:#fff7ed;border-left:4px solid #f97316;padding:14px;border-radius:4px;font-size:13px;color:#333;margin-bottom:24px;">
        ${safe(formData.improvements)}
      </div>

      <!-- Comments -->
      <h3 style="font-size:15px;color:#0b5e7e;margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">
        Comments
      </h3>

      <div style="background:#f9fafb;border-left:4px solid #0b5e7e;padding:14px;border-radius:4px;font-size:13px;color:#333;">
        ${safe(formData.comments)}
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

    await sendEmail(mailOptions);
    console.log("✅ Email sent successfully");

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
