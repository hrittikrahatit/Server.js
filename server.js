/**
 * server.js
 * Shareable paid-download link: /dl/<token>
 * - Token TTL: 30 minutes
 * - Max downloads: 3
 * - Storage: S3 / S3-compatible (R2)
 * - Token store: Redis (atomic via Lua)
 */

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const Redis = require("ioredis");
const fs = require("fs");
const path = require("path");

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const PORT = Number(process.env.PORT || 3000);

/* ================= CONFIG ================= */
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const S3_BUCKET = process.env.S3_BUCKET || "example-bucket";

const PRESIGNED_EXPIRE = Number(process.env.PRESIGNED_URL_EXPIRES || 60); // seconds
const TOKEN_TTL = Number(process.env.TOKEN_TTL || 1800);                 // seconds (30m)
const MAX_DOWNLOADS = Number(process.env.MAX_DOWNLOADS || 3);

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://client.infinitywave.xyz").replace(/\/+$/, "");

/* ================= CLIENTS ================= */
const redis = new Redis(REDIS_URL);

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || "") === "1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
  },
});

/* ================= LUA (Atomic decrement) =================
   Put this file in: scripts/decrement_and_get.lua
*/
const luaPath = path.join(__dirname, "scripts", "decrement_and_get.lua");
const luaScript = fs.existsSync(luaPath) ? fs.readFileSync(luaPath, "utf8") : null;

if (!luaScript) {
  console.warn("WARN: scripts/decrement_and_get.lua not found. /dl/:token will not be atomic until you add it.");
}

/* ================= HELPERS ================= */
function generateToken() {
  return crypto.randomBytes(32).toString("hex"); // 64 hex chars
}

/**
 * Create token after payment (demo function)
 * In real use, call this AFTER Stripe webhook success
 */
async function createDownloadToken(s3Key) {
  const token = generateToken();
  const redisKey = `download:${token}`;

  // HMSET is deprecated in redis docs, but ioredis still supports hmset.
  // Use hset with object for modern behavior.
  await redis.hset(redisKey, {
    s3Key: String(s3Key),
    downloads_left: String(MAX_DOWNLOADS),
    created_at: String(Date.now()),
  });

  await redis.expire(redisKey, TOKEN_TTL);
  return token;
}

/* ================= ROUTES ================= */

/**
 * DEMO route (for testing only)
 * Creates a token manually
 * GET /demo-create?key=path/to/file.pdf
 */
app.get("/demo-create", async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).send("Missing ?key=");

    const token = await createDownloadToken(key);
    return res.json({
      download_link: `${PUBLIC_BASE_URL}/dl/${token}`,
      expires_in_minutes: Math.floor(TOKEN_TTL / 60),
      max_downloads: MAX_DOWNLOADS,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).send("Server error");
  }
});

/**
 * Download route
 * GET /dl/:token
 * Atomic decrement via Lua, then 302 redirect to short-lived presigned URL
 */
app.get("/dl/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).send("Invalid token");

    const redisKey = `download:${token}`;

    // If Lua not present, fallback (NOT atomic) but still works for testing
    let s3Key;
    let remaining;

    if (luaScript) {
      const result = await redis.eval(luaScript, 1, redisKey);

      if (result === null) return res.status(404).send("Link expired or invalid");
      if (result === "NODL") return res.status(410).send("Download limit reached");

      // result is array: [s3Key, remaining_after_decrement]
      s3Key = result[0];
      remaining = Number(result[1]);
    } else {
      const exists = await redis.exists(redisKey);
      if (!exists) return res.status(404).send("Link expired or invalid");

      const downloadsLeft = Number(await redis.hget(redisKey, "downloads_left") || "0");
      if (downloadsLeft <= 0) return res.status(410).send("Download limit reached");

      remaining = await redis.hincrby(redisKey, "downloads_left", -1);
      s3Key = await redis.hget(redisKey, "s3Key");
    }

    if (!s3Key) return res.status(404).send("File mapping missing");

    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: String(s3Key),
    });

    const url = await getSignedUrl(s3, command, { expiresIn: PRESIGNED_EXPIRE });

    // Optional: you can log remaining downloads
    // console.log("token", token, "remaining", remaining);

    return res.redirect(302, url);
  } catch (e) {
    console.error(e);
    return res.status(500).send("Server error");
  }
});

/* ================= START ================= */
app.listen(PORT, () => {
  console.log("Download server running on port", PORT);
});
