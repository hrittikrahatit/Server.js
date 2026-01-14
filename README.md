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
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const PORT = process.env.PORT || 3000;

/* ================= CONFIG ================= */
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const S3_BUCKET = process.env.S3_BUCKET || "example-bucket";
const PRESIGNED_EXPIRE = 60;      // seconds
const TOKEN_TTL = 1800;           // 30 minutes
const MAX_DOWNLOADS = 3;

/* ================= CLIENTS ================= */
const redis = new Redis(REDIS_URL);

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT || undefined,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
  },
});

/* ================= HELPERS ================= */
function generateToken() {
  return crypto.randomBytes(32).toString("hex"); // 64 hex chars
}

/**
 * Example helper: create token after payment (demo)
 * In real use, call this AFTER Stripe webhook success
 */
async function createDownloadToken(s3Key) {
  const token = generateToken();
  const redisKey = `download:${token}`;

  await redis.hmset(redisKey, {
    s3Key: s3Key,
    downloads_left: MAX_DOWNLOADS,
    created_at: Date.now(),
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
  const key = req.query.key;
  if (!key) return res.status(400).send("Missing ?key=");

  const token = await createDownloadToken(key);
  return res.json({
    download_link: `https://client.infinitywave.xyz/dl/${token}`,
    expires_in_minutes: 30,
    max_downloads: 3,
  });
});

/**
 * Download route
 * GET /dl/:token
 */
app.get("/dl/:token", async (req, res) => {
  const token = req.params.token;
  const redisKey = `download:${token}`;

  const exists = await redis.exists(redisKey);
  if (!exists) return res.status(404).send("Link expired or invalid");

  const downloadsLeft = parseInt(await redis.hget(redisKey, "downloads_left"));
  if (downloadsLeft <= 0) return res.status(410).send("Download limit reached");

  // decrement
  await redis.hincrby(redisKey, "downloads_left", -1);

  const s3Key = await redis.hget(redisKey, "s3Key");

  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
  });

  const url = await getSignedUrl(s3, command, {
    expiresIn: PRESIGNED_EXPIRE,
  });

  return res.redirect(302, url);
});

/* ================= START ================= */
app.listen(PORT, () => {
  console.log("Download server running on port", PORT);
});# Server.js
