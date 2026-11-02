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



// Home
app.get("/", (req, res) => {
  res.send("UnityCare Server is Running!");
});

// Create Event
app.post("/events", verifyToken, async (req, res) => {
  try {
    const errors = validateEvent(req.body);

    if (errors.length) {
      return res.status(400).json({ errors });
    }

    const { title, description, eventType, thumbnail, location, eventDate, maxParticipants } =
      req.body;

    const newEvent = {
      title: String(title).trim(),
      description: String(description).trim(),
      eventType,
      thumbnail,
      location: String(location).trim(),
      eventDate: new Date(eventDate),
      creatorEmail: req.user.email,
      creatorName: req.user.name,
      status: "published",
      ...(maxParticipants !== undefined && {
        maxParticipants: Number(maxParticipants),
      }),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await events.insertOne(newEvent);

    res.status(201).json({
      success: true,
      message: "Event created successfully",
      event: { _id: result.insertedId, ...newEvent },
    });
  } catch (error) {
    handleError(res, error);
  }
});

// Get Upcoming Events  (?eventType=Cleanup&search=dhaka)
app.get("/events", async (req, res) => {
  try {
    const { eventType, search } = req.query;

    const query = { status: "published", eventDate: { $gte: startOfToday() } };

    if (eventType && eventType !== "All") {
      query.eventType = String(eventType);
    }

    if (search) {
      const regex = new RegExp(escapeRegex(String(search)), "i");
      query.$or = [{ title: regex }, { location: regex }, { description: regex }];
    }

    const result = await events
      .aggregate([{ $match: query }, { $sort: { eventDate: 1 } }, ...withParticipantsCount])
      .toArray();

    res.json({ success: true, events: result });
  } catch (error) {
    handleError(res, error);
  }
});

// Recent 6 Events
app.get("/recent-events", async (req, res) => {
  try {
    const result = await events
      .aggregate([
        { $match: { status: "published", eventDate: { $gte: startOfToday() } } },
        { $sort: { eventDate: 1 } },
        { $limit: 6 },
        ...withParticipantsCount,
      ])
      .toArray();

    res.json({ success: true, events: result });
  } catch (error) {
    handleError(res, error);
  }
});

// My Created Events (Manage Events)
app.get("/my-events", verifyToken, async (req, res) => {
  try {
    const result = await events
      .aggregate([
        { $match: { creatorEmail: req.user.email } },
        { $sort: { createdAt: -1 } },
        ...withParticipantsCount,
      ])
      .toArray();

    res.json({ success: true, events: result });
  } catch (error) {
    handleError(res, error);
  }
});

// Joined Events
app.get("/joined-events", verifyToken, async (req, res) => {
  try {
    const result = await registrations
      .aggregate([
        { $match: { userEmail: req.user.email, status: "joined" } },
        {
          $lookup: {
            from: "events",
            localField: "eventId",
            foreignField: "_id",
            as: "event",
          },
        },
        { $unwind: "$event" },
        { $sort: { "event.eventDate": 1 } },
        { $project: { joinedAt: 1, event: 1 } },
      ])
      .toArray();

    res.json({ success: true, joinedEvents: result });
  } catch (error) {
    handleError(res, error);
  }
});

// Event Details
app.get("/events/:id", async (req, res) => {
  try {
    if (!validId(req.params.id)) {
      return res.status(400).json({ message: "Invalid event ID" });
    }

    const [event] = await events
      .aggregate([
        { $match: { _id: eventId(req.params.id), status: "published" } },
        ...withParticipantsCount,
      ])
      .toArray();

    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    res.json({ success: true, event });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/events/:id/join-status", verifyToken, async (req, res) => {
  try {
    if (!validId(req.params.id)) {
      return res.status(400).json({ message: "Invalid event ID" });
    }

    const joined = await registrations.findOne({
      eventId: eventId(req.params.id),
      userEmail: req.user.email,
      status: "joined",
    });

    res.json({ success: true, joined: Boolean(joined) });
  } catch (error) {
    handleError(res, error);
  }
});


app.patch("/events/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!validId(id)) {
      return res.status(400).json({ message: "Invalid event ID" });
    }

    const allowed = [
      "title",
      "description",
      "eventType",
      "thumbnail",
      "location",
      "eventDate",
      "maxParticipants",
    ];

    const updateData = {};

    allowed.forEach((field) => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    const errors = validateEvent(updateData, true);

    if (errors.length || !Object.keys(updateData).length) {
      return res.status(400).json({ errors, message: "Invalid update data" });
    }

    if (updateData.title) updateData.title = String(updateData.title).trim();
    if (updateData.description) updateData.description = String(updateData.description).trim();
    if (updateData.location) updateData.location = String(updateData.location).trim();

    if (updateData.eventDate) {
      updateData.eventDate = new Date(updateData.eventDate);
    }

    if (updateData.maxParticipants !== undefined) {
      updateData.maxParticipants = Number(updateData.maxParticipants);


      const joinedCount = await registrations.countDocuments({
        eventId: eventId(id),
        status: "joined",
      });

      if (updateData.maxParticipants < joinedCount) {
        return res.status(400).json({
          message: `Limit cannot be less than current participants (${joinedCount})`,
        });
      }
    }

    updateData.updatedAt = new Date();

    const result = await events.updateOne(
      { _id: eventId(id), creatorEmail: req.user.email },
      { $set: updateData }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ message: "Event not found or not yours" });
    }

    res.json({ success: true, message: "Event updated successfully" });
  } catch (error) {
    handleError(res, error);
  }
});


app.delete("/events/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!validId(id)) {
      return res.status(400).json({ message: "Invalid event ID" });
    }

    const result = await events.deleteOne({
      _id: eventId(id),
      creatorEmail: req.user.email,
    });

    if (!result.deletedCount) {
      return res.status(404).json({ message: "Event not found or not yours" });
    }

    await registrations.deleteMany({ eventId: eventId(id) });

    res.json({ success: true, message: "Event deleted successfully" });
  } catch (error) {
    handleError(res, error);
  }
});

// Join Event
app.post("/events/:id/join", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!validId(id)) {
      return res.status(400).json({ message: "Invalid event ID" });
    }

    const event = await events.findOne({
      _id: eventId(id),
      status: "published",
      eventDate: { $gte: startOfToday() },
    });

    if (!event) {
      return res.status(404).json({ message: "Event not found or already passed" });
    }

    if (event.creatorEmail === req.user.email) {
      return res.status(400).json({ message: "Cannot join your own event" });
    }

    const existing = await registrations.findOne({
      eventId: eventId(id),
      userEmail: req.user.email,
    });

    if (existing) {
      return res.status(409).json({ message: "Already joined" });
    }

    if (event.maxParticipants !== undefined) {
      const count = await registrations.countDocuments({
        eventId: eventId(id),
        status: "joined",
      });

      if (count >= event.maxParticipants) {
        return res.status(400).json({ message: "Event is full" });
      }
    }

    await registrations.insertOne({
      eventId: eventId(id),
      userEmail: req.user.email,
      userName: req.user.name,
      status: "joined",
      joinedAt: new Date(),
    });

    res.status(201).json({
      success: true,
      message: "Joined successfully",
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Already joined" });
    }

    handleError(res, error);
  }
});

// Leave Event
app.delete("/events/:id/leave", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!validId(id)) {
      return res.status(400).json({ message: "Invalid event ID" });
    }

    const result = await registrations.deleteOne({
      eventId: eventId(id),
      userEmail: req.user.email,
      status: "joined",
    });

    if (!result.deletedCount) {
      return res.status(404).json({ message: "You have not joined" });
    }

    res.json({ success: true, message: "Left event successfully" });
  } catch (error) {
    handleError(res, error);
  }
});
// 404 Handler
app.use((req, res) => {
  res.status(404).json({ message: "API route not found" });
});


async function startServer() {
  try {
    await connectDB();

    app.listen(PORT, () => {
      console.log(`UnityCare server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

startServer();