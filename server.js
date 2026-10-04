const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { MongoClient, ObjectId } = require("mongodb");
const bcrypt = require("bcryptjs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL;

if (!MONGO_URL) {
  console.error("MONGO_URL topilmadi!");
  process.exit(1);
}

app.use(express.json({ limit: "1mb" }));

// Sayt ochilganda index.html ni korsatamiz
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

let usersCollection;
let messagesCollection;
let channelsCollection;

/* ================= MONGODB ================= */

async function connectMongo() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db("sinfchat");

  usersCollection = db.collection("users");
  messagesCollection = db.collection("messages");
  channelsCollection = db.collection("channels");

  await usersCollection.createIndex({ username: 1 }, { unique: true });
  await messagesCollection.createIndex({ createdAt: 1 });
  await messagesCollection.createIndex({ roomType: 1, roomId: 1, createdAt: 1 });
  await messagesCollection.createIndex({ from: 1, to: 1, createdAt: 1 });

  const general = await channelsCollection.findOne({ slug: "umumiy" });
  if (!general) {
    await channelsCollection.insertOne({
      name: "Umumiy chat",
      slug: "umumiy",
      description: "Barcha foydalanuvchilar uchun umumiy kanal",
      emoji: "🌐",
      createdAt: new Date()
    });
  }
  console.log("MongoDB ulandi.");
}

/* ================= YORDAMCHI ================= */

function cleanText(value, max = 2000) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function cleanUsername(value) {
  return cleanText(value, 20).toLowerCase().replace(/\s/g, "");
}

function publicUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    username: user.username,
    avatar: user.avatar || "",
    bio: user.bio || "",
    createdAt: user.createdAt
  };
}

async function getUserByToken(token) {
  if (!token || typeof token !== "string") return null;
  return (await usersCollection.findOne({ token })) || null;
}

function tokenFrom(req) {
  return req.headers.authorization
    ? req.headers.authorization.replace("Bearer ", "")
    : "";
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

function messageForClient(m) {
  return {
    id: m._id.toString(),
    roomType: m.roomType,
    roomId: m.roomId,
    from: m.from,
    fromName: m.fromName,
    fromAvatar: m.fromAvatar || "",
    to: m.to || null,
    text: m.text,
    createdAt: m.createdAt
  };
}

/* ================= REGISTER ================= */

app.post("/api/register", async (req, res) => {
  try {
    const name = cleanText(req.body.name, 40);
    const username = cleanUsername(req.body.username);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const avatar = cleanText(req.body.avatar, 10);

    if (!name) {
      return res.status(400).json({ success: false, message: "Ismingizni kiriting." });
    }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({
        success: false,
        message: "Username 3-20 ta harf, raqam yoki _ bo'lishi kerak."
      });
    }
    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Parol kamida 6 ta belgidan iborat bo'lsin."
      });
    }
    if (await usersCollection.findOne({ username })) {
      return res.status(409).json({ success: false, message: "Bu username allaqachon band." });
    }

    const token = newToken();
    const user = {
      name,
      username,
      password: await bcrypt.hash(password, 10),
      token,
      avatar: avatar || "👤",
      bio: "Sinf chat foydalanuvchisi",
      createdAt: new Date()
    };
    const result = await usersCollection.insertOne(user);
    user._id = result.insertedId;

    return res.json({ success: true, token, user: publicUser(user) });
  } catch (error) {
    console.error("REGISTER ERROR:", error);
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: "Bu username allaqachon band." });
    }
    return res.status(500).json({ success: false, message: "Server xatosi." });
  }
});

/* ================= LOGIN ================= */

app.post("/api/login", async (req, res) => {
  try {
    const username = cleanUsername(req.body.username);
    const password = typeof req.body.password === "string" ? req.body.password : "";

    const user = await usersCollection.findOne({ username });
    const ok = user && (await bcrypt.compare(password, user.password));
    if (!ok) {
      return res.status(401).json({
        success: false,
        message: "Username yoki parol noto'g'ri."
      });
    }

    const token = newToken();
    await usersCollection.updateOne({ _id: user._id }, { $set: { token } });
    return res.json({ success: true, token, user: publicUser(user) });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    return res.status(500).json({ success: false, message: "Server xatosi." });
  }
});

/* ================= ME / LOGOUT ================= */

app.get("/api/me", async (req, res) => {
  try {
    const user = await getUserByToken(tokenFrom(req));
    if (!user) return res.status(401).json({ success: false });
    return res.json({ success: true, user: publicUser(user) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false });
  }
});

app.post("/api/logout", async (req, res) => {
  try {
    const token = tokenFrom(req);
    if (token) {
      await usersCollection.updateOne({ token }, { $set: { token: "" } });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

/* ================= USERLAR ================= */

app.get("/api/users", async (req, res) => {
  try {
    const me = await getUserByToken(tokenFrom(req));
    if (!me) return res.status(401).json({ success: false });

    const q = cleanText(req.query.q || "", 40).toLowerCase();
    const filter = { _id: { $ne: me._id } };

    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { username: { $regex: safe, $options: "i" } },
        { name: { $regex: safe, $options: "i" } }
      ];
    }

    const users = await usersCollection
      .find(filter)
      .project({ password: 0, token: 0 })
      .limit(50)
      .toArray();

    res.json({ success: true, users: users.map(publicUser) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Userlarni olishda xato." });
  }
});

/* ================= PROFIL ================= */

app.put("/api/profile", async (req, res) => {
  try {
    const me = await getUserByToken(tokenFrom(req));
    if (!me) return res.status(401).json({ success: false, message: "Avval kiring." });

    const name = cleanText(req.body.name, 40);
    const bio = cleanText(req.body.bio, 160);
    const avatar = cleanText(req.body.avatar, 10);

    if (!name) {
      return res.status(400).json({ success: false, message: "Ism bo'sh bo'lmasin." });
    }

    await usersCollection.updateOne(
      { _id: me._id },
      { $set: { name, bio, avatar: avatar || "👤" } }
    );
    const updated = await usersCollection.findOne({ _id: me._id });
    res.json({ success: true, user: publicUser(updated) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Profilni saqlashda xato." });
  }
});

/* ================= KANALLAR ================= */

app.get("/api/channels", async (req, res) => {
  try {
    const me = await getUserByToken(tokenFrom(req));
    if (!me) return res.status(401).json({ success: false });

    const channels = await channelsCollection.find({}).sort({ createdAt: 1 }).toArray();
    res.json({
      success: true,
      channels: channels.map((c) => ({
        id: c._id.toString(),
        name: c.name,
        slug: c.slug,
        description: c.description || "",
        emoji: c.emoji || "📢"
      }))
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
});

/* ================= CHAT TARIXI ================= */

app.get("/api/messages/:type/:id", async (req, res) => {
  try {
    const me = await getUserByToken(tokenFrom(req));
    if (!me) return res.status(401).json({ success: false });

    const type = req.params.type;
    const id = req.params.id;
    let filter = null;

    if (type === "channel") {
      filter = { roomType: "channel", roomId: id };
    }

    if (type === "dm") {
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: "Noto'g'ri chat." });
      }
      const other = await usersCollection.findOne({ _id: new ObjectId(id) });
      if (!other) {
        return res.status(404).json({ success: false, message: "User topilmadi." });
      }
      const meId = me._id.toString();
      const otherId = other._id.toString();
      filter = {
        roomType: "dm",
        $or: [
          { from: meId, to: otherId },
          { from: otherId, to: meId }
        ]
      };
    }

    if (!filter) {
      return res.status(400).json({ success: false, message: "Noto'g'ri chat." });
    }

    const messages = await messagesCollection
      .find(filter)
      .sort({ createdAt: 1 })
      .limit(500)
      .toArray();

    res.json({ success: true, messages: messages.map(messageForClient) });
  } catch (error) {
    console.error("MESSAGES ERROR:", error);
    res.status(500).json({ success: false, message: "Xabarlarni olishda xato." });
  }
});

/* ================= SOCKET.IO ================= */

const onlineUsers = new Map();

function emitOnline() {
  io.emit("online_users", Array.from(onlineUsers.keys()));
}

io.on("connection", (socket) => {
  socket.on("auth", async (token) => {
    try {
      const user = await getUserByToken(token);
      if (!user) {
        socket.emit("auth_error");
        return;
      }
      socket.user = user;
      const userId = user._id.toString();
      onlineUsers.set(userId, socket.id);
      socket.join("user:" + userId);
      emitOnline();
    } catch (error) {
      console.error(error);
    }
  });

  socket.on("join_channel", (channelId) => {
    if (!socket.user) return;
    socket.join("channel:" + channelId);
  });

  socket.on("channel_message", async (data) => {
    try {
      if (!socket.user || !data) return;

      const channelId = cleanText(data.channelId, 100);
      const text = cleanText(data.text, 2000);
      if (!channelId || !text || !ObjectId.isValid(channelId)) return;

      const channel = await channelsCollection.findOne({ _id: new ObjectId(channelId) });
      if (!channel) return;

      const message = {
        roomType: "channel",
        roomId: channelId,
        from: socket.user._id.toString(),
        fromName: socket.user.name,
        fromAvatar: socket.user.avatar || "",
        text,
        createdAt: new Date()
      };
      const result = await messagesCollection.insertOne(message);
      message._id = result.insertedId;

      io.to("channel:" + channelId).emit("new_message", messageForClient(message));
    } catch (error) {
      console.error("CHANNEL MESSAGE:", error);
    }
  });

  socket.on("dm_message", async (data) => {
    try {
      if (!socket.user || !data) return;

      const targetId = cleanText(data.to, 100);
      const text = cleanText(data.text, 2000);
      if (!targetId || !text || !ObjectId.isValid(targetId)) return;

      const target = await usersCollection.findOne({ _id: new ObjectId(targetId) });
      if (!target) return;

      const message = {
        roomType: "dm",
        roomId: "",
        from: socket.user._id.toString(),
        fromName: socket.user.name,
        fromAvatar: socket.user.avatar || "",
        to: target._id.toString(),
        text,
        createdAt: new Date()
      };
      const result = await messagesCollection.insertOne(message);
      message._id = result.insertedId;

      const output = messageForClient(message);
      socket.emit("new_message", output);
      io.to("user:" + target._id.toString()).emit("new_message", output);
    } catch (error) {
      console.error("DM MESSAGE:", error);
    }
  });

  socket.on("disconnect", () => {
    if (socket.user) {
      onlineUsers.delete(socket.user._id.toString());
      emitOnline();
    }
  });
});

/* ================= START ================= */

async function start() {
  try {
    await connectMongo();
    server.listen(PORT, "0.0.0.0", () => {
      console.log("Server ishga tushdi. PORT:", PORT);
    });
  } catch (error) {
    console.error("SERVER START ERROR:", error);
    process.exit(1);
  }
}

start();
