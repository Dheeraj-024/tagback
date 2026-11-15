const express = require("express");
const router = express.Router();
const { requireUploadAuth } = require("../middleware/auth");
const { storage, MAX_IMAGE_SIZE_BYTES } = require("../lib/storage");
const { limit } = require("../middleware/rateLimit");
const { fail } = require("../lib/utils");

// Raw binary parser middleware specifically for direct binary uploads
const rawParser = express.raw({
  type: ["image/jpeg", "image/png", "image/webp", "application/octet-stream"],
  limit: "3mb"
});

// POST /api/upload - Upload an image (auth required: user, owner, or room finder)
router.post("/", requireUploadAuth, rawParser, async (req, res) => {
  // Rate limit: 20 uploads per 10 minutes per user/owner/room/IP
  const rKey = req.user ? ("upld:u:" + req.user.id) : (req.o ? ("upld:o:" + req.o.id) : (req.room ? ("upld:r:" + req.room.id) : ("upld:ip:" + req.ip)));
  if (!limit(rKey, 20, 600e3)) {
    return fail(res, 429, "Upload rate limit reached. Please wait a few minutes.");
  }

  let buffer = null;

  if (Buffer.isBuffer(req.body) && req.body.length > 0) {
    buffer = req.body;
  } else if (req.body && (req.body.image || req.body.base64)) {
    const rawB64 = String(req.body.image || req.body.base64);
    const cleaned = rawB64.replace(/^data:image\/[a-z]+;base64,/, "");
    try {
      buffer = Buffer.from(cleaned, "base64");
    } catch (e) {
      return fail(res, 400, "Invalid base64 image data.");
    }
  }

  if (!buffer || buffer.length === 0) {
    return fail(res, 400, "No image file provided.");
  }

  if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
    return fail(res, 400, `Image exceeds size limit of 2 MB (received ${(buffer.length / 1024 / 1024).toFixed(2)} MB).`);
  }

  try {
    const saved = await storage.saveImage(buffer);
    res.json({
      ok: true,
      url: saved.url,
      filename: saved.filename,
      size: saved.size,
      mime: saved.mime
    });
  } catch (err) {
    console.error("POST /api/upload error:", err.message);
    fail(res, 400, err.message || "Failed to process image upload.");
  }
});

module.exports = router;

