import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { MongoClient, ObjectId } from "mongodb";
import XLSX from "xlsx";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  MONGODB_URI,
  MONGODB_DB = "taipei_hotel",
  ADMIN_PASSWORD,
  SESSION_SECRET,
  ALLOWED_ORIGIN = "",
  PORT = "3000"
} = process.env;

for (const [name, value] of Object.entries({ MONGODB_URI, ADMIN_PASSWORD, SESSION_SECRET })) {
  if (!value) throw new Error(`缺少必要環境變數：${name}`);
}
if (!(/^\d{6}$/.test(ADMIN_PASSWORD) || ADMIN_PASSWORD.length >= 12)) {
  throw new Error("ADMIN_PASSWORD 必須是 6 位數字 PIN，或至少 12 個字元的密碼");
}
if (SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET 至少需要 32 個字元");

const client = new MongoClient(MONGODB_URI);
let collection;
async function getCollection() {
  if (!collection) {
    await client.connect();
    collection = client.db(MONGODB_DB).collection("stays");
    await collection.createIndex({ year: -1, month: -1 });
    await collection.createIndex({ hotel: 1 });
    if (await collection.estimatedDocumentCount() === 0) {
      const source = path.join(__dirname, "2020_台北飯店總表.xlsx");
      const workbook = XLSX.readFile(source, { cellDates: true });
      const seed = [];
      for (const sheetName of workbook.SheetNames) {
        const year = Number(sheetName);
        if (!Number.isInteger(year)) continue;
        const sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
        for (const row of sheetRows) {
          const values = Object.values(row);
          const hotel = String(values[1] ?? "").trim();
          if (!hotel) continue;
          seed.push({
            year,
            month: Number(values[0]) || null,
            hotel,
            date: String(values[2] ?? ""),
            nights: Math.max(0, Number(values[3]) || 0),
            spend: Math.max(0, Number(String(values[4] ?? "").replace(/[^\d.-]/g, "")) || 0),
            project: String(values[5] ?? "").trim(),
            createdAt: new Date(),
            updatedAt: new Date()
          });
        }
      }
      if (seed.length) await collection.insertMany(seed);
    }
  }
  return collection;
}

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true });
const recordSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12).nullable().optional(),
  date: z.string().trim().max(80).default(""),
  hotel: z.string().trim().min(1).max(200),
  nights: z.coerce.number().int().min(0).max(365),
  spend: z.coerce.number().int().min(0).max(100000000),
  project: z.string().trim().max(500).default("")
});

function safeEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function sessionToken(expiry) {
  const payload = String(expiry);
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

function isAuthenticated(req) {
  const token = req.cookies.hotel_admin;
  if (!token) return false;
  const [expiry, signature] = token.split(".");
  if (!expiry || !signature || Number(expiry) < Date.now()) return false;
  const expected = sessionToken(expiry);
  return safeEqual(token, expected);
}

function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: "請先登入" });
  next();
}

function requireTrustedOrigin(req, res, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (ALLOWED_ORIGIN && origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: "來源驗證失敗" });
  }
  next();
}

app.post("/api/login", loginLimiter, (req, res) => {
  if (!safeEqual(req.body?.password ?? "", ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "密碼錯誤" });
  }
  const expiry = Date.now() + 8 * 60 * 60 * 1000;
  res.cookie("hotel_admin", sessionToken(expiry), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/"
  });
  res.json({ ok: true });
});

app.post("/api/logout", requireTrustedOrigin, (_req, res) => {
  res.clearCookie("hotel_admin", { path: "/" });
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => res.json({ authenticated: isAuthenticated(req) }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/records", requireAuth, async (req, res, next) => {
  try {
    const search = String(req.query.search ?? "").trim();
    const year = Number(req.query.year);
    const query = {};
    if (Number.isInteger(year)) query.year = year;
    if (search) query.$or = [
      { hotel: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
      { project: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }
    ];
    const rows = await (await getCollection()).find(query).sort({ year: -1, month: -1, _id: -1 }).limit(1000).toArray();
    res.json(rows);
  } catch (error) { next(error); }
});

app.post("/api/records", requireAuth, requireTrustedOrigin, async (req, res, next) => {
  try {
    const data = recordSchema.parse(req.body);
    const result = await (await getCollection()).insertOne({ ...data, createdAt: new Date(), updatedAt: new Date() });
    res.status(201).json({ ...data, _id: result.insertedId });
  } catch (error) { next(error); }
});

app.put("/api/records/:id", requireAuth, requireTrustedOrigin, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "無效的資料 ID" });
    const data = recordSchema.parse(req.body);
    const result = await (await getCollection()).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { ...data, updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ error: "找不到資料" });
    res.json(result);
  } catch (error) { next(error); }
});

app.delete("/api/records/:id", requireAuth, requireTrustedOrigin, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "無效的資料 ID" });
    const result = await (await getCollection()).deleteOne({ _id: new ObjectId(req.params.id) });
    if (!result.deletedCount) return res.status(404).json({ error: "找不到資料" });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof z.ZodError) return res.status(400).json({ error: "欄位格式不正確", details: error.flatten() });
  res.status(500).json({ error: "伺服器發生錯誤" });
});

const server = app.listen(Number(PORT), () => console.log(`http://localhost:${PORT}`));
async function shutdown() {
  server.close();
  await client.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { MongoClient, ObjectId } from "mongodb";
import XLSX from "xlsx";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  MONGODB_URI,
  MONGODB_DB = "taipei_hotel",
  ADMIN_PASSWORD,
  SESSION_SECRET,
  ALLOWED_ORIGIN = "",
  PORT = "3000"
} = process.env;

for (const [name, value] of Object.entries({ MONGODB_URI, ADMIN_PASSWORD, SESSION_SECRET })) {
  if (!value) throw new Error(`缺少必要環境變數：${name}`);
}
if (ADMIN_PASSWORD.length < 12) throw new Error("ADMIN_PASSWORD 至少需要 12 個字元");
if (SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET 至少需要 32 個字元");

const client = new MongoClient(MONGODB_URI);
let collection;
async function getCollection() {
  if (!collection) {
    await client.connect();
    collection = client.db(MONGODB_DB).collection("stays");
    await collection.createIndex({ year: -1, month: -1 });
    await collection.createIndex({ hotel: 1 });
    if (await collection.estimatedDocumentCount() === 0) {
      const source = path.join(__dirname, "2020_台北飯店總表.xlsx");
      const workbook = XLSX.readFile(source, { cellDates: true });
      const seed = [];
      for (const sheetName of workbook.SheetNames) {
        const year = Number(sheetName);
        if (!Number.isInteger(year)) continue;
        const sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
        for (const row of sheetRows) {
          const values = Object.values(row);
          const hotel = String(values[1] ?? "").trim();
          if (!hotel) continue;
          seed.push({
            year,
            month: Number(values[0]) || null,
            hotel,
            date: String(values[2] ?? ""),
            nights: Math.max(0, Number(values[3]) || 0),
            spend: Math.max(0, Number(String(values[4] ?? "").replace(/[^\d.-]/g, "")) || 0),
            project: String(values[5] ?? "").trim(),
            createdAt: new Date(),
            updatedAt: new Date()
          });
        }
      }
      if (seed.length) await collection.insertMany(seed);
    }
  }
  return collection;
}

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true });
const recordSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12).nullable().optional(),
  date: z.string().trim().max(80).default(""),
  hotel: z.string().trim().min(1).max(200),
  nights: z.coerce.number().int().min(0).max(365),
  spend: z.coerce.number().int().min(0).max(100000000),
  project: z.string().trim().max(500).default("")
});

function safeEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function sessionToken(expiry) {
  const payload = String(expiry);
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

function isAuthenticated(req) {
  const token = req.cookies.hotel_admin;
  if (!token) return false;
  const [expiry, signature] = token.split(".");
  if (!expiry || !signature || Number(expiry) < Date.now()) return false;
  const expected = sessionToken(expiry);
  return safeEqual(token, expected);
}

function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: "請先登入" });
  next();
}

function requireTrustedOrigin(req, res, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (ALLOWED_ORIGIN && origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: "來源驗證失敗" });
  }
  next();
}

app.post("/api/login", loginLimiter, (req, res) => {
  if (!safeEqual(req.body?.password ?? "", ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "密碼錯誤" });
  }
  const expiry = Date.now() + 8 * 60 * 60 * 1000;
  res.cookie("hotel_admin", sessionToken(expiry), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/"
  });
  res.json({ ok: true });
});

app.post("/api/logout", requireTrustedOrigin, (_req, res) => {
  res.clearCookie("hotel_admin", { path: "/" });
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => res.json({ authenticated: isAuthenticated(req) }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/records", requireAuth, async (req, res, next) => {
  try {
    const search = String(req.query.search ?? "").trim();
    const year = Number(req.query.year);
    const query = {};
    if (Number.isInteger(year)) query.year = year;
    if (search) query.$or = [
      { hotel: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
      { project: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }
    ];
    const rows = await (await getCollection()).find(query).sort({ year: -1, month: -1, _id: -1 }).limit(1000).toArray();
    res.json(rows);
  } catch (error) { next(error); }
});

app.post("/api/records", requireAuth, requireTrustedOrigin, async (req, res, next) => {
  try {
    const data = recordSchema.parse(req.body);
    const result = await (await getCollection()).insertOne({ ...data, createdAt: new Date(), updatedAt: new Date() });
    res.status(201).json({ ...data, _id: result.insertedId });
  } catch (error) { next(error); }
});

app.put("/api/records/:id", requireAuth, requireTrustedOrigin, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "無效的資料 ID" });
    const data = recordSchema.parse(req.body);
    const result = await (await getCollection()).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { ...data, updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ error: "找不到資料" });
    res.json(result);
  } catch (error) { next(error); }
});

app.delete("/api/records/:id", requireAuth, requireTrustedOrigin, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "無效的資料 ID" });
    const result = await (await getCollection()).deleteOne({ _id: new ObjectId(req.params.id) });
    if (!result.deletedCount) return res.status(404).json({ error: "找不到資料" });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof z.ZodError) return res.status(400).json({ error: "欄位格式不正確", details: error.flatten() });
  res.status(500).json({ error: "伺服器發生錯誤" });
});

const server = app.listen(Number(PORT), () => console.log(`http://localhost:${PORT}`));
async function shutdown() {
  server.close();
  await client.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
