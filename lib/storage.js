const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_IMAGE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB limit
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, "..", "public", "uploads");

// Ensure upload directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  try {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  } catch (e) {}
}

// Magic byte verification for image file signatures
function detectImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { ext: "jpg", mime: "image/jpeg" };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
    buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A
  ) {
    return { ext: "png", mime: "image/png" };
  }

  // WEBP: "RIFF" .... "WEBP"
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return { ext: "webp", mime: "image/webp" };
  }

  return null;
}

// Storage Interface (supports local disk or pluggable S3/Cloud Storage)
class StorageService {
  constructor() {
    this.provider = "disk";
    this.customProvider = null;
  }

  // Pluggable cloud storage provider: { save: async (key, buffer, mime) => url, delete: async (key) => {} }
  registerProvider(provider) {
    this.customProvider = provider;
  }

  async saveImage(buffer) {
    if (!buffer || !Buffer.isBuffer(buffer)) {
      throw new Error("Invalid file buffer.");
    }

    if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
      throw new Error("File exceeds maximum allowed size of 2 MB.");
    }

    const type = detectImageType(buffer);
    if (!type) {
      throw new Error("Unsupported image format. Allowed formats: JPEG, PNG, WEBP.");
    }

    const randomName = crypto.randomBytes(12).toString("hex") + "." + type.ext;

    if (this.customProvider && typeof this.customProvider.save === "function") {
      const url = await this.customProvider.save(randomName, buffer, type.mime);
      return { url, filename: randomName, size: buffer.length, mime: type.mime };
    }

    // Default: Local disk storage
    const filePath = path.join(UPLOADS_DIR, randomName);
    await fs.promises.writeFile(filePath, buffer);

    return {
      url: `/uploads/${randomName}`,
      filename: randomName,
      size: buffer.length,
      mime: type.mime
    };
  }

  async deleteImage(filename) {
    if (!filename || typeof filename !== "string") return;
    const sanitized = path.basename(filename);

    if (this.customProvider && typeof this.customProvider.delete === "function") {
      return this.customProvider.delete(sanitized);
    }

    const filePath = path.join(UPLOADS_DIR, sanitized);
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
    } catch (e) {}
  }
}

const storage = new StorageService();

module.exports = {
  storage,
  detectImageType,
  MAX_IMAGE_SIZE_BYTES,
  UPLOADS_DIR
};

