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


const EVENT_TYPES = [
  "Donation",
  "Cleanup",
  "Plantation",
  "Winter Relief",
  "Food Drive",
  "Health Camp",
  "Education",
];

const validId = (id) => ObjectId.isValid(id) && String(new ObjectId(id)) === id;

const eventId = (id) => new ObjectId(id);

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");


const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const handleError = (res, error) => {
  console.error(error);
  res.status(500).json({ success: false, message: "Server error" });
};


const withParticipantsCount = [
  {
    $lookup: {
      from: "eventRegistrations",
      let: { id: "$_id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$eventId", "$$id"] }, status: "joined" } },
        { $project: { _id: 1 } },
      ],
      as: "participants",
    },
  },
  { $addFields: { participantsCount: { $size: "$participants" } } },
  { $project: { participants: 0 } },
];

function validateEvent(data, partial = false) {
  const fields = ["title", "description", "eventType", "thumbnail", "location", "eventDate"];
  const errors = [];

  if (!partial) {
    fields.forEach((field) => {
      if (!data[field] || !String(data[field]).trim()) {
        errors.push(`${field} is required`);
      }
    });
  }

  if (data.eventType !== undefined && !EVENT_TYPES.includes(data.eventType)) {
    errors.push("Invalid event type");
  }

  if (data.eventDate !== undefined) {
    const date = new Date(data.eventDate);

    if (isNaN(date.getTime()) || date < startOfToday()) {
      errors.push("Event date must be today or in the future");
    }
  }

  if (data.maxParticipants !== undefined) {
    const max = Number(data.maxParticipants);

    if (!Number.isInteger(max) || max < 1) {
      errors.push("Invalid participant limit");
    }
  }

  return errors;
}
