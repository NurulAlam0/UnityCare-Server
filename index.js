import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_URI = process.env.FRONTEND_URI;

app.use(cors({ origin: FRONTEND_URI, credentials: true }));
app.use(express.json());


const client = new MongoClient(process.env.MONGO_URI);
let events;
let registrations;

async function connectDB() {
  await client.connect();

  const db = client.db("UnityCare");
  events = db.collection("events");
  registrations = db.collection("eventRegistrations");

 
  await registrations.createIndex({ eventId: 1, userEmail: 1 }, { unique: true });
  await events.createIndex({ eventDate: 1 });
  await events.createIndex({ creatorEmail: 1 });

  console.log("MongoDB Connected");
}


const JWKS = createRemoteJWKSet(new URL(`${FRONTEND_URI}/api/auth/jwks`));

async function verifyToken(req, res, next) {
  try {
    const auth = req.headers.authorization;

    if (!auth?.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { payload } = await jwtVerify(auth.split(" ")[1], JWKS, {
      issuer: FRONTEND_URI,
      audience: FRONTEND_URI,
    });

    const email = payload.email || payload.user?.email;

    if (!email) {
      return res.status(401).json({ message: "Email missing in token" });
    }

    req.user = {
      email: String(email).toLowerCase(),
      name: payload.name || "",
    };

    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}
