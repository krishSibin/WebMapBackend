import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

// Configure Socket.io with robust CORS and large buffer size for GeoJSON
const allowedOrigins = [
    ...(process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(",") : []),
    "http://localhost:5173",
    "http://localhost:3000"
].map(u => u.trim()).filter(Boolean);

const io = new Server(httpServer, {
    maxHttpBufferSize: 1e8, // 100MB to handle large spatial data
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST", "DELETE"],
        credentials: true
    },
    allowEIO3: true,
    transports: ['websocket', 'polling']
});

app.set("trust proxy", 1);
app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
}));
app.use(express.json({ limit: "100mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin.html"));
});

/* ---------------- DATABASE ---------------- */

const MONGO_URI = process.env.MONGODB_URI;
mongoose.set("bufferCommands", false);

let mapLayers = {};
let isBooted = false; // ✅ Track if initial DB sync is done

const layerSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    geojson: { type: Object, required: true }
}, { timestamps: true });

const Layer = mongoose.model("Layer", layerSchema);

async function syncFromDB() {
    try {
        const layers = await Layer.find({});
        mapLayers = {
            taluk: { type: "FeatureCollection", features: [] },
            panchayat: { type: "FeatureCollection", features: [] },
            flood: { type: "FeatureCollection", features: [] }
        };

        if (layers.length > 0) {
            layers.forEach(l => {
                mapLayers[l.name] = l.geojson;
            });
        }

        const dataSize = JSON.stringify(mapLayers).length / (1024 * 1024);
        console.log(`✅ SYNC COMPLETE. Layers: ${Object.keys(mapLayers).join(", ")} (${dataSize.toFixed(2)} MB)`);
        isBooted = true;
        io.emit("geojson-update", mapLayers);
    } catch (err) {
        console.error("Sync error:", err);
    }
}

if (!MONGO_URI) {
    console.error("⚠️ MONGODB_URI missing. Running in in-memory mode.");
    mapLayers = {
        taluk: { type: "FeatureCollection", features: [] },
        panchayat: { type: "FeatureCollection", features: [] },
        flood: { type: "FeatureCollection", features: [] }
    };
    isBooted = true;
} else {
    mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
        .then(() => {
            console.log("✅ DATABASE CONNECTED: Synchronizing spatial data...");
            syncFromDB();
        })
        .catch(() => {
            console.log("⚠️ DATABASE UNAVAILABLE (In-Memory Mode Active)");
            console.log("👉 Tip: Check your .env credentials if you intended to use MongoDB.");
            isBooted = true;
            // Ensure mapLayers is initialized if sync failed
            if (Object.keys(mapLayers).length === 0) {
                mapLayers = {
                    taluk: { type: "FeatureCollection", features: [] },
                    panchayat: { type: "FeatureCollection", features: [] },
                    flood: { type: "FeatureCollection", features: [] }
                };
            }
        });
}

/* ---------------- API ---------------- */

app.get("/api/geojson", (req, res) => {
    if (!isBooted) {
        return res.status(503).json({ error: "Server is initializing spatial data core..." });
    }
    res.json(mapLayers);
});

app.post("/api/geojson", async (req, res) => {
    const { layer, geojson } = req.body;

    if (!layer || !geojson) {
        return res.status(400).json({ error: "Layer & GeoJSON required" });
    }

    if (!geojson.type || geojson.type.toLowerCase() !== "featurecollection") {
        return res.status(400).json({ error: "Invalid GeoJSON. Must be a FeatureCollection." });
    }

    // Deeply normalize GeoJSON types
    geojson.type = "FeatureCollection";
    if (Array.isArray(geojson.features)) {
        geojson.features = geojson.features.map(f => ({
            ...f,
            type: "Feature"
        }));
    }

    try {
        if (mongoose.connection.readyState === 1) {
            await Layer.findOneAndUpdate(
                { name: layer },
                { geojson },
                { upsert: true }
            );
        }

        mapLayers[layer] = geojson;
        console.log(`💾 LAYER UPDATED: ${layer} (${geojson.features?.length || 0} features)`);

        io.emit("geojson-update", mapLayers);

        res.json({ message: "Updated" });
    } catch (err) {
        console.error("Update error:", err);
        res.status(500).json({ error: "DB error" });
    }
});

app.delete("/api/geojson/:layer", async (req, res) => {
    const { layer } = req.params;

    try {
        if (mongoose.connection.readyState === 1) {
            await Layer.deleteOne({ name: layer });
        }
        delete mapLayers[layer];

        io.emit("geojson-update", mapLayers);

        res.json({ message: "Deleted" });
    } catch {
        res.status(500).json({ error: "Delete failed" });
    }
});

/* ---------------- SOCKET ---------------- */

io.on("connection", (socket) => {
    if (!isBooted) {
        console.log(`⏳ Client ${socket.id} connected, but server is still booting...`);
        return;
    }
    const size = JSON.stringify(mapLayers).length / (1024 * 1024);
    console.log(`Client connected: ${socket.id} | Sending ${size.toFixed(2)} MB`);
    socket.emit("geojson-update", mapLayers);
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server is live and listening on port ${PORT}`);
});